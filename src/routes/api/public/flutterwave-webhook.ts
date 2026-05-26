import { createFileRoute } from "@tanstack/react-router";
import { supabaseAdmin } from "@/integrations/supabase/client.server";

const PLAN_DURATIONS: Record<string, number | null> = {
  "pro-month": 30,
  "pro-year": 365,
  "pro-life": null,
};

type FlwData = {
  id: number | string;
  tx_ref: string;
  status: string;
  amount: number;
  currency: string;
  meta?: {
    plan_id?: string;
    user_id?: string;
    track_id?: string;
    kind?: string;
    amount_xof?: number;
  };
};

function timingSafeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let r = 0;
  for (let i = 0; i < a.length; i++) r |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return r === 0;
}

export const Route = createFileRoute("/api/public/flutterwave-webhook")({
  server: {
    handlers: {
      POST: async ({ request }) => {
        const expected = process.env.FLUTTERWAVE_WEBHOOK_HASH;
        const got = request.headers.get("verif-hash");
        // Signature obligatoire si configurée — comparaison constante.
        if (!expected || !got || !timingSafeEqual(expected, got)) {
          return new Response("Invalid signature", { status: 401 });
        }

        const bodyText = await request.text();
        let payload: { event?: string; data?: FlwData };
        try {
          payload = JSON.parse(bodyText);
        } catch {
          return new Response("Bad payload", { status: 400 });
        }

        const data = payload.data;
        const flwTxId = data?.id ? String(data.id) : null;

        // Idempotence : si on a déjà traité ce flw_tx_id, on retourne ok.
        if (flwTxId) {
          const { data: existing } = await supabaseAdmin
            .from("payment_events")
            .select("id, processed")
            .eq("flw_tx_id", flwTxId)
            .eq("processed", true)
            .maybeSingle();
          if (existing) return new Response("ok");
        }

        // Persist raw event (insert avec ON CONFLICT pour éviter doublon).
        const { error: insertEvtErr } = await supabaseAdmin.from("payment_events").insert({
          provider: "flutterwave",
          event_type: payload.event ?? "unknown",
          flw_tx_ref: data?.tx_ref ?? null,
          flw_tx_id: flwTxId,
          payload: JSON.parse(bodyText),
          signature: got,
        });
        // 23505 = unique_violation → déjà reçu, on continue (ack 200) sans re-traiter
        if (insertEvtErr && (insertEvtErr as { code?: string }).code === "23505") {
          return new Response("ok");
        }

        if (!data?.id || !data?.tx_ref) return new Response("ok");

        const secret = process.env.FLUTTERWAVE_SECRET_KEY;
        if (!secret) return new Response("ok");

        const res = await fetch(
          `https://api.flutterwave.com/v3/transactions/${encodeURIComponent(String(data.id))}/verify`,
          { headers: { Authorization: `Bearer ${secret}` } },
        );
        const verified = (await res.json()) as { status: string; data?: FlwData };
        const ok = verified.status === "success" && verified.data?.status === "successful";
        if (!ok || !verified.data) {
          await supabaseAdmin
            .from("payment_events")
            .update({
              processed: true,
              processed_at: new Date().toISOString(),
              processing_error: "verification_failed",
            })
            .eq("flw_tx_ref", data.tx_ref);
          return new Response("ok");
        }

        const meta = verified.data.meta;
        const now = new Date();

        if (meta?.kind === "track" && meta.track_id && meta.user_id) {
          await supabaseAdmin
            .from("purchases")
            .update({
              status: "paid",
              flw_tx_id: String(verified.data.id),
              paid_at: now.toISOString(),
              updated_at: now.toISOString(),
            })
            .eq("flw_tx_ref", verified.data.tx_ref);

          // Idempotent grâce à l'unique (user_id, track_id, source).
          await supabaseAdmin
            .from("track_access")
            .upsert(
              {
                user_id: meta.user_id,
                track_id: meta.track_id,
                source: "purchase",
              },
              { onConflict: "user_id,track_id,source", ignoreDuplicates: true },
            );
        } else if (meta?.kind === "wallet_credit" && meta.user_id) {
          // Recharge wallet : flip pending → succeeded + applique le solde
          const amount = Number(meta.amount_xof ?? verified.data.amount);
          const txRef = verified.data.tx_ref;
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          const dbAny = supabaseAdmin as any;

          // Update tx (idempotent : si déjà succeeded, no-op grâce au filtre status)
          const { data: updatedTx } = await dbAny
            .from("wallet_transactions")
            .update({
              status: "succeeded",
              settled_at: now.toISOString(),
            })
            .eq("flw_tx_ref", txRef)
            .eq("status", "pending")
            .select("id")
            .maybeSingle();

          // N'applique le solde QUE si la tx vient de passer pending → succeeded
          if (updatedTx) {
            await dbAny.rpc("wallet_apply_settled", {
              _user_id: meta.user_id,
              _kind: "credit",
              _amount: amount,
            });
          }
        } else {
          const planId = meta?.plan_id;
          const days = planId ? PLAN_DURATIONS[planId] : undefined;
          const periodEnd = days
            ? new Date(now.getTime() + days * 24 * 60 * 60 * 1000)
            : null;

          await supabaseAdmin
            .from("subscriptions")
            .update({
              status: "active",
              flw_tx_id: String(verified.data.id),
              current_period_start: now.toISOString(),
              current_period_end: periodEnd ? periodEnd.toISOString() : null,
              updated_at: now.toISOString(),
            })
            .eq("flw_tx_ref", verified.data.tx_ref);
        }

        await supabaseAdmin
          .from("payment_events")
          .update({ processed: true, processed_at: now.toISOString() })
          .eq("flw_tx_ref", verified.data.tx_ref);

        return new Response("ok");
      },
    },
  },
});
