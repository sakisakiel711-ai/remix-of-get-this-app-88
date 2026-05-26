import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";
import { getRequestHost } from "@tanstack/react-start/server";
import { supabaseAdmin } from "@/integrations/supabase/client.server";

type Plan = { name: string; amount: number; currency: string; durationDays: number | null };

const PLANS: Record<string, Plan> = {
  "pro-month": { name: "PRO Monthly", amount: 7, currency: "USD", durationDays: 30 },
  "pro-year": { name: "PRO Yearly", amount: 60, currency: "USD", durationDays: 365 },
  "pro-life": { name: "PRO Lifetime", amount: 199, currency: "USD", durationDays: null },
};

export const createFlutterwavePayment = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d: { planId: string }) =>
    z.object({ planId: z.string().min(1).max(64) }).parse(d)
  )
  .handler(async ({ data, context }) => {
    const plan = PLANS[data.planId];
    if (!plan) throw new Error("Invalid plan");

    const secret = process.env.FLUTTERWAVE_SECRET_KEY;
    if (!secret) throw new Error("Flutterwave is not configured");

    const { userId, supabase } = context;
    const { data: userData } = await supabase.auth.getUser();
    const email = userData.user?.email ?? `user-${userId}@vinasound.local`;

    // SECURITY: server-derived host only (no client-supplied origin) to
    // prevent open redirects after a successful payment.
    const host = `https://${getRequestHost()}`;
    const tx_ref = `pro-${data.planId}-${userId}-${Date.now()}`;

    const res = await fetch("https://api.flutterwave.com/v3/payments", {
      method: "POST",
      headers: { Authorization: `Bearer ${secret}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        tx_ref,
        amount: plan.amount,
        currency: plan.currency,
        redirect_url: `${host}/payment/callback`,
        customer: { email },
        customizations: { title: "VinaSound PRO", description: plan.name },
        meta: { user_id: userId, plan_id: data.planId },
      }),
    });

    const json = (await res.json()) as { status: string; message?: string; data?: { link: string } };
    if (!res.ok || json.status !== "success" || !json.data?.link) {
      console.error("Flutterwave init failed:", json);
      throw new Error(json.message || "Failed to create payment");
    }

    // Pre-record a pending subscription so we can match the webhook later.
    await supabaseAdmin.from("subscriptions").insert({
      user_id: userId,
      plan: data.planId,
      status: "pending",
      amount: plan.amount,
      currency: plan.currency,
      flw_tx_ref: tx_ref,
    });

    return { link: json.data.link, tx_ref };
  });

export const verifyFlutterwavePayment = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d: { transactionId: string }) =>
    z.object({ transactionId: z.string().min(1).max(64) }).parse(d)
  )
  .handler(async ({ data, context }) => {
    const secret = process.env.FLUTTERWAVE_SECRET_KEY;
    if (!secret) throw new Error("Flutterwave is not configured");

    const res = await fetch(
      `https://api.flutterwave.com/v3/transactions/${encodeURIComponent(data.transactionId)}/verify`,
      { headers: { Authorization: `Bearer ${secret}` } }
    );
    const json = (await res.json()) as {
      status: string;
      data?: {
        status: string;
        amount: number;
        currency: string;
        tx_ref: string;
        id?: number | string;
        meta?: Record<string, unknown>;
      };
    };

    const ok = json.status === "success" && json.data?.status === "successful";
    const meta = (json.data?.meta ?? {}) as { plan_id?: string; track_id?: string; kind?: string };
    const planId = meta.plan_id;
    const plan = planId ? PLANS[planId] : undefined;
    const trackId = meta.track_id;
    const isTrack = meta.kind === "track" || (!!trackId && !planId);

    let kind: "subscription" | "track" | null = null;

    if (ok && json.data) {
      const now = new Date();

      if (isTrack && trackId) {
        kind = "track";
        // Idempotent : marque la purchase payée + grant access même si webhook
        // n'a pas encore tourné. Restore-friendly.
        await supabaseAdmin
          .from("purchases")
          .update({
            status: "paid",
            flw_tx_id: String(json.data.id ?? data.transactionId),
            paid_at: now.toISOString(),
            updated_at: now.toISOString(),
          })
          .eq("flw_tx_ref", json.data.tx_ref)
          .eq("user_id", context.userId);

        // Upsert idempotent (unique sur user_id,track_id,source).
        await supabaseAdmin
          .from("track_access")
          .upsert(
            {
              user_id: context.userId,
              track_id: trackId,
              source: "purchase",
            },
            { onConflict: "user_id,track_id,source", ignoreDuplicates: true },
          );
      } else if (plan) {
        kind = "subscription";
        const periodEnd = plan.durationDays
          ? new Date(now.getTime() + plan.durationDays * 24 * 60 * 60 * 1000)
          : null;

        await supabaseAdmin
          .from("subscriptions")
          .update({
            status: "active",
            flw_tx_id: String(json.data.id ?? data.transactionId),
            current_period_start: now.toISOString(),
            current_period_end: periodEnd ? periodEnd.toISOString() : null,
            updated_at: now.toISOString(),
          })
          .eq("flw_tx_ref", json.data.tx_ref)
          .eq("user_id", context.userId);
      }
    }

    return {
      success: ok,
      kind,
      amount: json.data?.amount,
      currency: json.data?.currency,
      tx_ref: json.data?.tx_ref,
      plan: planId,
      trackId: trackId ?? null,
    };
  });
