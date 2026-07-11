// =============================================================================
// Edge Function: payway_checkout — backend del CHECKOUT PROPIO de NinjaPos
// para Payway (F8 · H17b). verify_jwt = false: lo consume la página pública
// /pagar/[intent] que abre el CLIENTE al escanear el QR del POS (sin sesión).
//
// El cliente carga la tarjeta y elige cuotas EN LA PÁGINA DE LA TIENDA (logo y
// acento del negocio). PCI: el PAN viaja del NAVEGADOR directo a Payway
// (POST {v2}/tokens con la API Key PÚBLICA) — este server nunca ve datos de
// tarjeta; acá solo llega el token de un solo uso.
//
// Actions (body.action):
//   * info {intent_id} → datos para pintar el checkout: monto base, marca del
//     negocio (tenant_branding), planes de cuotas payway activos (brand,
//     installments, surcharge_pct), public_apikey y base URL de tokens según
//     sandbox. Solo intents payway PENDIENTES (si no, devuelve el estado).
//   * pay {intent_id, token, bin, brand, installments} → cobra con la API Key
//     PRIVADA: POST {v2}/payments con monto RECALCULADO SERVER-SIDE (base +
//     recargo del plan elegido, en CENTAVOS — nunca se confía en el cliente),
//     payment_method_id derivado de la marca. approved → intent approved con
//     el monto final (el POS registra la venta por ese total, con el recargo
//     como extra). Rechazo → el intent QUEDA pendiente para reintentar con
//     otra tarjeta (se marca rejected recién si el cajero cancela).
//
// Dialecto del SDK oficial payway-ar/sdk-node-ventaonline (tokens/payments v2,
// amount entero en centavos, payment_type single).
// =============================================================================
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.47.10";

const cors = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers":
    "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};
const json = (b: unknown, s = 200) =>
  new Response(JSON.stringify(b), {
    status: s,
    headers: { ...cors, "Content-Type": "application/json" },
  });

const V2 = {
  sandbox: "https://developers.decidir.com/api/v2",
  prod: "https://ventasonline.payway.com.ar/api/v2",
};

// payment_method_id de Decidir/Payway por marca (ids públicos de su doc).
const BRAND_METHOD: Record<string, number> = {
  visa: 1,
  master: 104,
  maestro: 106,
  cabal: 63,
  amex: 65,
  naranja: 24,
  diners: 8,
};

const round2 = (n: number) => Math.round(n * 100) / 100;

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });
  if (req.method !== "POST") return json({ error: "method_not_allowed" }, 405);

  const url = Deno.env.get("SUPABASE_URL")!;
  const serviceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
  const admin = createClient(url, serviceKey, { auth: { persistSession: false } });

  let b: Record<string, unknown>;
  try {
    b = await req.json();
  } catch {
    return json({ error: "invalid_json" }, 400);
  }
  const action = String(b.action ?? "");
  const intentId = String(b.intent_id ?? "");
  if (!/^[0-9a-f-]{36}$/.test(intentId)) return json({ error: "invalid_intent" }, 400);

  const { data: row } = await admin
    .from("mp_payment_intents")
    .select("id, tenant_id, status, amount, mp_payment_id")
    .eq("id", intentId)
    .eq("provider_key", "payway")
    .maybeSingle();
  if (!row) return json({ error: "intent_not_found" }, 404);

  const { data: methodRow } = await admin
    .from("tenant_payment_methods")
    .select("sandbox")
    .eq("tenant_id", row.tenant_id)
    .eq("provider_key", "payway")
    .maybeSingle();
  const sandbox = Boolean(methodRow?.sandbox);
  const base = sandbox ? V2.sandbox : V2.prod;

  const { data: secretRow } = await admin
    .from("payment_secrets")
    .select("secrets")
    .eq("tenant_id", row.tenant_id)
    .eq("provider_key", "payway")
    .maybeSingle();
  const sec = (secretRow?.secrets ?? {}) as {
    public_apikey?: string;
    private_apikey?: string;
    site?: string;
  };
  if (!sec.public_apikey || !sec.private_apikey || !sec.site) {
    return json({ error: "not_connected" }, 400);
  }

  // ── info: datos públicos del checkout ───────────────────────────────────────
  if (action === "info") {
    const [{ data: tenant }, { data: branding }, { data: plans }] =
      await Promise.all([
        admin.from("tenants").select("name").eq("id", row.tenant_id).maybeSingle(),
        admin
          .from("tenant_branding")
          .select("logo_url, accent, legal_name")
          .eq("tenant_id", row.tenant_id)
          .maybeSingle(),
        admin
          .from("payment_plans")
          .select("brand, installments, label, surcharge_pct, sort")
          .eq("tenant_id", row.tenant_id)
          .eq("provider_key", "payway")
          .eq("is_active", true)
          .order("sort"),
      ]);
    return json({
      status: row.status,
      amount: Number(row.amount),
      tenant_name: branding?.legal_name || tenant?.name || "Tu compra",
      logo_url: branding?.logo_url ?? null,
      accent: branding?.accent ?? null,
      plans: (plans ?? []).map((p) => ({
        brand: p.brand ?? null,
        installments: Number(p.installments) || 1,
        label: p.label,
        surcharge_pct: Number(p.surcharge_pct) || 0,
      })),
      brands: Object.keys(BRAND_METHOD),
      public_apikey: sec.public_apikey,
      tokens_url: `${base}/tokens`,
    });
  }

  // ── pay: cobro server-side con el token de un solo uso ──────────────────────
  if (action === "pay") {
    if (row.status !== "pending") {
      return json({ error: "intent_not_pending", status: row.status }, 409);
    }
    const token = String(b.token ?? "");
    const bin = String(b.bin ?? "").slice(0, 6);
    const brand = String(b.brand ?? "").toLowerCase();
    const installments = Math.min(36, Math.max(1, Math.trunc(Number(b.installments)) || 1));
    if (token.length < 20) return json({ error: "invalid_token" }, 400);
    const methodId = BRAND_METHOD[brand];
    if (!methodId) return json({ error: "invalid_brand" }, 400);

    // Monto final SERVER-SIDE: base + recargo del plan (tenant/brand/cuotas).
    // Cuotas sin plan cargado solo se aceptan para 1 cuota (sin recargo).
    let surchargePct = 0;
    if (installments > 1 || brand) {
      const { data: plan } = await admin
        .from("payment_plans")
        .select("surcharge_pct")
        .eq("tenant_id", row.tenant_id)
        .eq("provider_key", "payway")
        .eq("is_active", true)
        .eq("installments", installments)
        .or(`brand.eq.${brand},brand.is.null`)
        .order("brand", { ascending: false, nullsFirst: false })
        .limit(1)
        .maybeSingle();
      if (plan) surchargePct = Number(plan.surcharge_pct) || 0;
      else if (installments > 1) return json({ error: "plan_not_available" }, 400);
    }
    const finalAmount = round2(Number(row.amount) * (1 + surchargePct / 100));

    const r = await fetch(`${base}/payments`, {
      method: "POST",
      headers: {
        apikey: sec.private_apikey,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        site_transaction_id: row.id,
        token,
        payment_method_id: methodId,
        bin,
        // Payway v2: entero en CENTAVOS.
        amount: Math.round(finalAmount * 100),
        currency: "ARS",
        installments,
        description: "Venta NinjaPos",
        payment_type: "single",
        sub_payments: [],
      }),
    });
    const pay = (await r.json().catch(() => ({}))) as {
      id?: number | string;
      status?: string;
      status_details?: { error?: unknown };
    };
    const state = String(pay.status ?? "").toLowerCase();

    if (r.ok && (state === "approved" || state === "accredited")) {
      await admin
        .from("mp_payment_intents")
        .update({
          status: "approved",
          amount: finalAmount,
          mp_payment_id: pay.id != null ? String(pay.id) : null,
        })
        .eq("id", row.id)
        .eq("status", "pending");
      return json({ ok: true, status: "approved", amount: finalAmount });
    }

    // Rechazo del emisor / token inválido: el intent sigue pendiente para que
    // el cliente reintente con otra tarjeta (el POS puede cancelar).
    return json(
      {
        ok: false,
        status: "rejected_attempt",
        detail: JSON.stringify(pay?.status_details ?? pay?.status ?? "").slice(0, 200),
      },
      402,
    );
  }

  return json({ error: "invalid_action" }, 400);
});
