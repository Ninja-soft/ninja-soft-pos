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
//     payment_method_id derivado de la marca (tabla PAYWAY_BRANDS de
//     _shared/payway.ts). Resultado (validado en el sandbox público):
//       - 201 approved con eco del monto EXACTO en centavos → intent approved
//         con el monto final y el id de pago (200).
//       - status 'rejected' (402) → rechazo del emisor: el intent QUEDA
//         pendiente para reintentar con otra tarjeta (402 rejected_attempt).
//       - 400/404 {error_type, validation_errors} o api_error → NO es rechazo:
//         502 payway_error con reason/detail (el intent sigue pendiente).
//       - approved con monto distinto → intent rejected + 502 amount_mismatch.
//       - 2xx con estado intermedio (review) → se guarda el id y el intent
//         sigue pendiente; el poll del POS (Edge payway status) lo resuelve y
//         no se acepta otro pago mientras tanto (409 payment_in_review).
//
// Dialecto del SDK oficial payway-ar/sdk-node-ventaonline (tokens/payments v2,
// amount entero en centavos, payment_type single).
// =============================================================================
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.47.10";
import {
  PAYWAY_BRANDS,
  buildPaymentBody,
  classifyPayResponse,
  finalAmountWithSurcharge,
  payHttpResponse,
  paywayBrand,
  paywayPaymentId,
  paywayV2Base,
  toCents,
} from "../_shared/payway.ts";

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
  const base = paywayV2Base(methodRow?.sandbox);

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
      brands: PAYWAY_BRANDS.map((x) => x.key),
      debit_brands: PAYWAY_BRANDS.filter((x) => x.debit).map((x) => x.key),
      public_apikey: sec.public_apikey,
      tokens_url: `${base}/tokens`,
    });
  }

  // ── pay: cobro server-side con el token de un solo uso ──────────────────────
  if (action === "pay") {
    if (row.status !== "pending") {
      return json({ error: "intent_not_pending", status: row.status }, 409);
    }
    // Un pago anterior quedó en revisión: no se cobra otra vez.
    if (paywayPaymentId(row.mp_payment_id)) {
      return json({ error: "payment_in_review" }, 409);
    }
    const token = String(b.token ?? "");
    const bin = String(b.bin ?? "").slice(0, 6);
    const brandInfo = paywayBrand(b.brand);
    const installments = Math.min(36, Math.max(1, Math.trunc(Number(b.installments)) || 1));
    if (token.length < 20) return json({ error: "invalid_token" }, 400);
    if (!brandInfo) return json({ error: "invalid_brand" }, 400);
    const brand = brandInfo.key;
    // Débito: siempre 1 pago.
    if (brandInfo.debit && installments > 1) return json({ error: "plan_not_available" }, 400);

    // Monto final SERVER-SIDE: base + recargo del plan (tenant/brand/cuotas).
    // Cuotas sin plan cargado solo se aceptan para 1 cuota (sin recargo).
    let surchargePct = 0;
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
    const finalAmount = finalAmountWithSurcharge(Number(row.amount), surchargePct);

    let r: Response;
    try {
      r = await fetch(`${base}/payments`, {
        method: "POST",
        headers: {
          apikey: sec.private_apikey,
          "Content-Type": "application/json",
        },
        body: JSON.stringify(
          buildPaymentBody({
            siteTransactionId: row.id,
            token,
            methodId: brandInfo.methodId,
            bin,
            finalAmount,
            installments,
          }),
        ),
      });
    } catch {
      return json({ ok: false, error: "payway_error", reason: "gateway", detail: "unreachable" }, 502);
    }
    const body = await r.json().catch(() => null);
    const outcome = classifyPayResponse(r.status, body, toCents(finalAmount));

    if (outcome.kind === "approved") {
      await admin
        .from("mp_payment_intents")
        .update({
          status: "approved",
          amount: finalAmount,
          mp_payment_id: outcome.paymentId,
        })
        .eq("id", row.id)
        .eq("status", "pending");
    } else if (outcome.kind === "amount_mismatch") {
      // Payway confirmó un monto distinto al calculado: no se acredita.
      console.error("[payway_checkout] amount_mismatch", {
        intent: row.id,
        expected: outcome.expectedCents,
        got: outcome.gotCents,
      });
      await admin
        .from("mp_payment_intents")
        .update({ status: "rejected", mp_payment_id: outcome.paymentId })
        .eq("id", row.id)
        .eq("status", "pending");
    } else if (outcome.kind === "pending" && outcome.paymentId) {
      // En revisión: guardamos el id (con el monto final) para que el poll del
      // POS lo re-verifique contra GET /payments.
      await admin
        .from("mp_payment_intents")
        .update({ amount: finalAmount, mp_payment_id: outcome.paymentId })
        .eq("id", row.id)
        .eq("status", "pending");
    } else if (outcome.kind === "error") {
      console.error("[payway_checkout] payway_error", {
        intent: row.id,
        http: outcome.httpStatus,
        detail: outcome.detail,
      });
    }
    // Rechazo del emisor / error: el intent sigue pendiente para que el
    // cliente reintente con otra tarjeta (el POS puede cancelar).
    const res = payHttpResponse(outcome, finalAmount);
    return json(res.body, res.status);
  }

  return json({ error: "invalid_action" }, 400);
});
