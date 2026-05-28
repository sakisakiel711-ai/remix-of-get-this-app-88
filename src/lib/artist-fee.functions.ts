import { createServerFn } from "@tanstack/react-start";
import { getRequestHost } from "@tanstack/react-start/server";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";
import { supabaseAdmin } from "@/integrations/supabase/client.server";
import type { SupabaseClient } from "@supabase/supabase-js";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const dbAdmin = supabaseAdmin as unknown as SupabaseClient<any, "public", any>;

export const ARTIST_FEE_XOF = 3000;

/**
 * Returns whether the current user has paid the artist creation fee.
 */
export const getArtistFeeStatus = createServerFn({ method: "GET" })
  .middleware([requireSupabaseAuth])
  .handler(async ({ context }) => {
    const { userId } = context;
    const { data } = await dbAdmin
      .from("artist_creation_fees")
      .select("status, method, amount_xof, paid_at, flw_payment_link")
      .eq("user_id", userId)
      .maybeSingle();
    return {
      hasPaid: data?.status === "paid",
      amountXof: ARTIST_FEE_XOF,
      pendingLink: data?.status === "pending" ? data.flw_payment_link ?? null : null,
    };
  });

/**
 * Create (or reuse) a Flutterwave checkout link for the 3000 XOF artist fee.
 */
export const createArtistFeePayment = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .handler(async ({ context }) => {
    const secret = process.env.FLUTTERWAVE_SECRET_KEY;
    if (!secret) throw new Error("Le système de paiement n'est pas configuré.");

    const { userId, supabase } = context;

    // Already paid?
    const { data: existing } = await dbAdmin
      .from("artist_creation_fees")
      .select("id, status, flw_payment_link, flw_tx_ref, created_at")
      .eq("user_id", userId)
      .maybeSingle();

    if (existing?.status === "paid") {
      return { alreadyPaid: true, link: null as string | null, tx_ref: null as string | null };
    }

    // Reuse pending link < 30 min old
    if (
      existing?.status === "pending" &&
      existing.flw_payment_link &&
      existing.flw_tx_ref &&
      new Date(existing.created_at).getTime() > Date.now() - 30 * 60 * 1000
    ) {
      return { alreadyPaid: false, link: existing.flw_payment_link, tx_ref: existing.flw_tx_ref };
    }

    const { data: userData } = await supabase.auth.getUser();
    const email = userData.user?.email ?? `user-${userId}@vinasound.local`;
    const host = `https://${getRequestHost()}`;
    const tx_ref = `artistfee-${userId}-${Date.now()}`;

    const res = await fetch("https://api.flutterwave.com/v3/payments", {
      method: "POST",
      headers: { Authorization: `Bearer ${secret}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        tx_ref,
        amount: ARTIST_FEE_XOF,
        currency: "XOF",
        redirect_url: `${host}/payment/callback`,
        customer: { email },
        customizations: {
          title: "VinaSound — Création profil artiste",
          description: `Frais de création de profil artiste (${ARTIST_FEE_XOF} XOF)`,
        },
        meta: { user_id: userId, kind: "artist_fee", amount_xof: ARTIST_FEE_XOF },
      }),
    });

    const json = (await res.json()) as { status: string; message?: string; data?: { link: string } };
    if (!res.ok || json.status !== "success" || !json.data?.link) {
      console.error("Flutterwave artist-fee init failed:", json);
      throw new Error(json.message || "Échec de la création du paiement");
    }

    await dbAdmin
      .from("artist_creation_fees")
      .upsert(
        {
          user_id: userId,
          status: "pending",
          amount_xof: ARTIST_FEE_XOF,
          method: "flutterwave",
          flw_tx_ref: tx_ref,
          flw_payment_link: json.data.link,
          updated_at: new Date().toISOString(),
        },
        { onConflict: "user_id" },
      );

    return { alreadyPaid: false, link: json.data.link, tx_ref };
  });

/**
 * Pay the artist fee from the user's wallet balance (atomic via RPC).
 */
export const payArtistFeeWithWallet = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .handler(async ({ context }) => {
    const { userId } = context;
    const { data, error } = await dbAdmin.rpc("pay_artist_fee_with_wallet", {
      _user_id: userId,
    });
    if (error) {
      if (error.message?.includes("INSUFFICIENT_WALLET")) {
        throw new Error("Solde du wallet insuffisant. Recharge-le ou paie par Flutterwave.");
      }
      if (error.message?.includes("ALREADY_PAID")) {
        return { alreadyPaid: true };
      }
      throw new Error(error.message);
    }
    const row = Array.isArray(data) ? data[0] : data;
    return {
      alreadyPaid: false,
      newBalanceXof: row?.new_balance_xof ?? 0,
      amountXof: row?.amount_xof ?? ARTIST_FEE_XOF,
    };
  });
