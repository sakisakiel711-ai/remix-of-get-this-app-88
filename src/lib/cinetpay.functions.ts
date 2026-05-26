import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";
import { getRequestHost } from "@tanstack/react-start/server";
import { supabaseAdmin } from "@/integrations/supabase/client.server";

type Plan = { name: string; amount: number; durationDays: number | null };

// Montants en unité entière (XOF). Modifie librement.
const PLANS: Record<string, Plan> = {
  "pro-month": { name: "PRO Starter", amount: 10000, durationDays: 365 },
  "pro-year": { name: "PRO Ambassadeur", amount: 20000, durationDays: 365 },
  "pro-life": { name: "PRO Légende", amount: 30000, durationDays: 365 },
};

type SettingsRow = {
  api_key: string | null;
  site_id: string | null;
  secret_key: string | null;
  api_url: string;
  currency: string;
  mode: string;
  enabled: boolean;
};

async function loadSettings(): Promise<SettingsRow> {
  const { data, error } = await supabaseAdmin
    .from("payment_settings")
    .select("api_key, site_id, secret_key, api_url, currency, mode, enabled")
    .eq("provider", "cinetpay")
    .order("created_at", { ascending: true })
    .limit(1)
    .maybeSingle();
  if (error) throw new Error(error.message);
  if (!data) throw new Error("CinetPay non configuré");
  if (!data.enabled) throw new Error("Paiements CinetPay désactivés");
  if (!data.api_key || !data.site_id) throw new Error("Clé API ou Site ID manquant");
  return data as unknown as SettingsRow;
}

// ============================================================
// ADMIN — settings
// ============================================================

const adminGuard = async (userId: string) => {
  const { data, error } = await supabaseAdmin
    .from("user_roles")
    .select("role")
    .eq("user_id", userId)
    .eq("role", "admin")
    .maybeSingle();
  if (error) throw new Error(error.message);
  if (!data) throw new Error("Accès réservé aux administrateurs");
};

export const getCinetPaySettings = createServerFn({ method: "GET" })
  .middleware([requireSupabaseAuth])
  .handler(async ({ context }) => {
    await adminGuard(context.userId);
    const { data, error } = await supabaseAdmin
      .from("payment_settings")
      .select("*")
      .eq("provider", "cinetpay")
      .order("created_at", { ascending: true })
      .limit(1)
      .maybeSingle();
    if (error) throw new Error(error.message);
    return { settings: data };
  });

export const updateCinetPaySettings = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d: unknown) =>
    z.object({
      api_key: z.string().trim().max(200).optional().nullable(),
      site_id: z.string().trim().max(60).optional().nullable(),
      secret_key: z.string().trim().max(200).optional().nullable(),
      api_url: z.string().url().max(300),
      currency: z.string().trim().min(3).max(5),
      mode: z.enum(["test", "prod"]),
      enabled: z.boolean(),
    }).parse(d)
  )
  .handler(async ({ data, context }) => {
    await adminGuard(context.userId);
    const { data: existing } = await supabaseAdmin
      .from("payment_settings")
      .select("id")
      .eq("provider", "cinetpay")
      .order("created_at", { ascending: true })
      .limit(1)
      .maybeSingle();

    if (existing) {
      const { error } = await supabaseAdmin
        .from("payment_settings")
        .update({
          api_key: data.api_key || null,
          site_id: data.site_id || null,
          secret_key: data.secret_key || null,
          api_url: data.api_url,
          currency: data.currency,
          mode: data.mode,
          enabled: data.enabled,
        })
        .eq("id", existing.id);
      if (error) throw new Error(error.message);
    } else {
      const { error } = await supabaseAdmin.from("payment_settings").insert({
        provider: "cinetpay",
        ...data,
      });
      if (error) throw new Error(error.message);
    }
    return { ok: true };
  });

// ============================================================
// USER — init payment
// ============================================================

const PurposeSchema = z.enum(["pro-month", "pro-year", "pro-life", "track", "album"]);

export const initCinetPayPayment = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d: unknown) =>
    z.object({
      purpose: PurposeSchema,
      target_id: z.string().uuid().optional(),
      origin: z.string().url().optional(),
    }).parse(d)
  )
  .handler(async ({ data, context }) => {
    const settings = await loadSettings();
    const { userId } = context;

    // Calcule montant + description
    let amount = 0;
    let description = "";
    if (data.purpose.startsWith("pro-")) {
      const plan = PLANS[data.purpose];
      if (!plan) throw new Error("Plan inconnu");
      amount = plan.amount;
      description = `VinaSound ${plan.name}`;
    } else if (data.purpose === "track") {
      if (!data.target_id) throw new Error("ID de la piste requis");
      const { data: t } = await supabaseAdmin
        .from("tracks")
        .select("price_amount, title")
        .eq("id", data.target_id)
        .maybeSingle();
      if (!t || !t.price_amount) throw new Error("Piste non payante");
      amount = t.price_amount;
      description = `Achat: ${t.title}`;
    } else if (data.purpose === "album") {
      if (!data.target_id) throw new Error("ID de l'album requis");
      const { data: a } = await supabaseAdmin
        .from("albums")
        .select("title")
        .eq("id", data.target_id)
        .maybeSingle();
      if (!a) throw new Error("Album introuvable");
      amount = 5000;
      description = `Achat album: ${a.title}`;
    }
    if (amount <= 0) throw new Error("Montant invalide");

    const host = data.origin ?? `https://${getRequestHost()}`;
    const transaction_id = `mango_${data.purpose}_${userId.slice(0, 8)}_${Date.now()}`;
    const return_url = `${host}/payment/cinetpay-callback?tx=${encodeURIComponent(transaction_id)}`;
    const notify_url = `${host}/api/public/cinetpay-webhook`;

    // Pré-enregistre la commande
    if (data.purpose.startsWith("pro-")) {
      await supabaseAdmin.from("subscriptions").insert({
        user_id: userId,
        plan: data.purpose,
        status: "pending",
        amount,
        currency: settings.currency,
        provider: "cinetpay",
        transaction_id,
      });
    } else {
      await supabaseAdmin.from("purchases").insert({
        user_id: userId,
        track_id: data.purpose === "track" ? data.target_id : null,
        album_id: data.purpose === "album" ? data.target_id : null,
        amount,
        currency: settings.currency,
        status: "pending",
        provider: "cinetpay",
        transaction_id,
      });
    }

    const res = await fetch(settings.api_url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        apikey: settings.api_key,
        site_id: settings.site_id,
        transaction_id,
        amount: Math.round(amount),
        currency: settings.currency,
        description: description.slice(0, 100),
        return_url,
        notify_url,
        channels: "ALL",
      }),
    });

    const json = (await res.json()) as {
      code?: string;
      message?: string;
      data?: { payment_url?: string; payment_token?: string };
    };

    if (!res.ok || json.code !== "201" || !json.data?.payment_url) {
      console.error("CinetPay init failed:", json);
      throw new Error(json.message || "Échec d'initialisation du paiement");
    }

    const payment_url = json.data.payment_url;

    // Stocke payment_url
    const table = data.purpose.startsWith("pro-") ? "subscriptions" : "purchases";
    await supabaseAdmin.from(table).update({ payment_url, raw_response: json }).eq("transaction_id", transaction_id);

    return { payment_url, transaction_id };
  });

// ============================================================
// USER — verify (called from callback page)
// ============================================================

export const verifyCinetPayPayment = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d: unknown) =>
    z.object({ transaction_id: z.string().min(1).max(200) }).parse(d)
  )
  .handler(async ({ data, context }) => {
    const result = await verifyAndApply(data.transaction_id);
    return { ...result, userId: context.userId };
  });

// Shared verify+apply helper (used by webhook too)
export async function verifyAndApply(transaction_id: string) {
  const settings = await loadSettings();
  const checkUrl = settings.api_url.replace(/\/+$/, "") + "/check";

  const res = await fetch(checkUrl, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      apikey: settings.api_key,
      site_id: settings.site_id,
      transaction_id,
    }),
  });

  const json = (await res.json()) as {
    code?: string;
    message?: string;
    data?: { amount?: number; currency?: string; status?: string };
  };

  const success = json.code === "00" && json.message === "SUCCES";

  // Try subscription first
  const { data: sub } = await supabaseAdmin
    .from("subscriptions")
    .select("id, user_id, plan, status")
    .eq("transaction_id", transaction_id)
    .maybeSingle();

  if (sub) {
    if (sub.status === "active") return { success: true, kind: "subscription" as const, alreadyApplied: true };
    if (success) {
      const plan = PLANS[sub.plan];
      const now = new Date();
      const end = plan?.durationDays
        ? new Date(now.getTime() + plan.durationDays * 86400000)
        : null;
      await supabaseAdmin.from("subscriptions").update({
        status: "active",
        current_period_start: now.toISOString(),
        current_period_end: end ? end.toISOString() : null,
        raw_response: json,
      }).eq("id", sub.id);

      // Marque l'artiste comme PRO si existe
      await supabaseAdmin
        .from("artists")
        .update({ pro_badge: "pro" })
        .eq("user_id", sub.user_id);
    } else {
      await supabaseAdmin.from("subscriptions").update({ status: "failed", raw_response: json }).eq("id", sub.id);
    }
    return { success, kind: "subscription" as const };
  }

  const { data: pur } = await supabaseAdmin
    .from("purchases")
    .select("id, status, track_id, album_id")
    .eq("transaction_id", transaction_id)
    .maybeSingle();

  if (pur) {
    if (pur.status === "completed") return { success: true, kind: "purchase" as const, alreadyApplied: true };
    if (success) {
      await supabaseAdmin.from("purchases").update({
        status: "completed",
        paid_at: new Date().toISOString(),
        raw_response: json,
      }).eq("id", pur.id);
    } else {
      await supabaseAdmin.from("purchases").update({ status: "failed", raw_response: json }).eq("id", pur.id);
    }
    return { success, kind: "purchase" as const };
  }

  return { success, kind: null };
}
