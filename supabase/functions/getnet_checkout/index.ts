// =============================================================================
// Edge Function: getnet_checkout · backend del CHECKOUT PROPIO de NinjaPos con
// la Checkout API de Getnet (ADR-069). verify_jwt = false: lo consume la
// página pública /pagar/[intent]?p=getnet que abre el CLIENTE (sin sesión).
//
// Igual que payway_checkout: marca del negocio, tarjeta y cuotas de los Planes
// del negocio con su interés, y el monto lo fija SIEMPRE el servidor.
//
// PCI: Getnet no ofrece tokenización desde el navegador (su endpoint de
// tokens pide el Bearer del comercio y no habilita CORS), así que la tarjeta
// pasa por esta Edge, se tokeniza en Getnet en el mismo request y se descarta:
// no se guarda, no se loguea y nunca vuelve en una respuesta. Eso deja a
// NinjaSoft dentro del alcance PCI DSS: por eso `pay` queda APAGADO hasta
// que el secret GETNET_CHECKOUT_API_PCI_ATTESTED=true lo habilite.
//
// Actions (body.action):
//   * info {intent_id} → datos para pintar el checkout: monto base, marca del
//     negocio, planes de cuotas getnet activos, marcas y si el cobro está
//     disponible. Sólo intents getnet del checkout propio.
//   * pay {intent_id, brand, installments, card:{number, exp_month, exp_year,
//     cvv, holder, dni}} → token de la Checkout API → tokeniza la tarjeta →
//     (cuotas: cotización AR obligatoria) → POST /payments con monto
//     RECALCULADO acá (base + recargo del plan, en centavos). Idempotencia:
//     el payment_id lo generamos nosotros y se reserva en el intent ANTES de
//     cobrar (update condicional), así dos clics o un reintento no cobran dos
//     veces y un corte de red se re-consulta por ese id.
//       - APPROVED/CAPTURED con monto exacto → intent approved (200).
//       - DENIED → rechazo del emisor; el intent sigue pendiente (402).
//       - error del gateway / datos → 502 getnet_error (sigue pendiente).
//       - otro estado → 202 pending_review; el poll del POS lo resuelve.
// =============================================================================
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.47.10";
import {
  API_INFO_PATH,
  API_PAYMENTS_PATH,
  API_QUOTES_PATH,
  API_TOKENIZE_PATH,
  apiBrand,
  apiCredsOf,
  apiHeaders,
  apiPayHttpResponse,
  buildApiPaymentBody,
  buildQuotesBody,
  buildTokenizeBody,
  classifyApiPayResponse,
  cleanCard,
  decideApiPaymentInfo,
  finalAmountWithSurcharge,
  GETNET_API_BRANDS,
  isApiPaymentId,
  isOwnCheckoutIntent,
  makeAttempt,
  parseQuotes,
  pickQuote,
  requestApiToken,
  toCents,
} from "../_shared/getnet_api.ts";
import { getnetPanRelayEnabled, loadGetnetSlot } from "../_shared/getnet_server.ts";
import { intentSecretScope } from "../_shared/paymentSecrets.ts";

const cors = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};
const json = (b: unknown, s = 200) =>
  new Response(JSON.stringify(b), { status: s, headers: { ...cors, "Content-Type": "application/json" } });

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
    .select("id, tenant_id, status, amount, mp_payment_id, init_point")
    .eq("id", intentId)
    .eq("provider_key", "getnet")
    .maybeSingle();
  if (!row || !isOwnCheckoutIntent(row.init_point)) return json({ error: "intent_not_found" }, 404);

  const scope = await intentSecretScope(admin, row.id);
  const secretRow = await loadGetnetSlot(admin, row.tenant_id, "checkout_api", { scopeStoreId: scope });
  const creds = apiCredsOf(secretRow?.secrets);
  if (!creds) return json({ error: "not_connected" }, 400);
  const available = getnetPanRelayEnabled();

  // ── info: datos públicos del checkout ───────────────────────────────────────
  if (action === "info") {
    const [{ data: tenant }, { data: branding }, { data: plans }] = await Promise.all([
      admin.from("tenants").select("name").eq("id", row.tenant_id).maybeSingle(),
      admin.from("tenant_branding").select("logo_url, accent, legal_name").eq("tenant_id", row.tenant_id).maybeSingle(),
      admin
        .from("payment_plans")
        .select("brand, installments, label, surcharge_pct, sort")
        .eq("tenant_id", row.tenant_id)
        .eq("provider_key", "getnet")
        .eq("is_active", true)
        .order("sort"),
    ]);
    return json({
      provider: "getnet",
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
      brands: GETNET_API_BRANDS.map((x) => x.key),
      debit_brands: GETNET_API_BRANDS.filter((x) => x.debit).map((x) => x.key),
      // La tarjeta viaja a esta Edge (no hay tokenización desde el navegador).
      tokenize: "server",
      available,
    });
  }

  if (action !== "pay") return json({ error: "invalid_action" }, 400);

  // ── pay ─────────────────────────────────────────────────────────────────────
  if (!available) return json({ error: "checkout_api_unavailable" }, 503);
  if (row.status !== "pending") return json({ error: "intent_not_pending", status: row.status }, 409);

  // Gating real (la UI no es la barrera): el medio y el checkout propio.
  for (const key of ["getnet", "getnet_checkout_propio"]) {
    const { data: allowed } = await admin.rpc("tenant_has_feature_for", { p_tenant: row.tenant_id, p_key: key });
    if (allowed !== true) return json({ error: "payment_method_not_allowed" }, 403);
  }

  const brandInfo = apiBrand(b.brand);
  if (!brandInfo) return json({ error: "invalid_brand" }, 400);
  const installments = Math.min(36, Math.max(1, Math.trunc(Number(b.installments)) || 1));
  if (brandInfo.debit && installments > 1) return json({ error: "plan_not_available" }, 400);
  const cardRes = cleanCard(b.card);
  if (!cardRes.ok) return json({ ok: false, error: cardRes.error }, 400);
  const card = cardRes.card;

  // Monto final SERVER-SIDE: base + recargo del plan (tenant / marca / cuotas).
  let surchargePct = 0;
  const { data: plan } = await admin
    .from("payment_plans")
    .select("surcharge_pct")
    .eq("tenant_id", row.tenant_id)
    .eq("provider_key", "getnet")
    .eq("is_active", true)
    .eq("installments", installments)
    .or(`brand.eq.${brandInfo.key},brand.is.null`)
    .order("brand", { ascending: false, nullsFirst: false })
    .limit(1)
    .maybeSingle();
  if (plan) surchargePct = Number(plan.surcharge_pct) || 0;
  else if (installments > 1) return json({ error: "plan_not_available" }, 400);
  const finalAmount = finalAmountWithSurcharge(Number(row.amount), surchargePct);
  const cents = toCents(finalAmount);

  const auth = await requestApiToken(creds);
  if (!auth.ok) {
    console.error(JSON.stringify({ fn: "getnet_checkout", step: "token", intent: row.id, attempts: auth.attempts }));
    return json({ ok: false, error: "getnet_error", reason: "credentials" }, 502);
  }
  const sellerId = creds.sellerId ?? auth.claims.sellerId;
  const headers = apiHeaders(auth.token, { sellerId, channelEntry: creds.channelEntry });
  const secrets = [creds.clientId, creds.clientSecret, card.number, card.cvv];

  // Un intento anterior quedó en curso: se re-consulta antes de cobrar otra vez.
  if (isApiPaymentId(row.mp_payment_id)) {
    const infoUrl = `${auth.host}${API_INFO_PATH}/${row.mp_payment_id}`;
    const r = await fetch(infoUrl, { headers }).catch(() => null);
    if (r && r.ok) {
      const d = decideApiPaymentInfo(await r.json().catch(() => null), Number(row.amount));
      if (d.status === "approved") {
        const paid = (d.amountCents ?? toCents(Number(row.amount))) / 100;
        await admin
          .from("mp_payment_intents")
          .update({ status: "approved", amount: paid })
          .eq("id", row.id)
          .eq("status", "pending");
        return json({ ok: true, status: "approved", amount: paid });
      }
      if (d.status === "pending") return json({ error: "payment_in_review" }, 409);
    } else if (!r || r.status !== 404) {
      return json({ error: "payment_in_review" }, 409);
    }
    // Rechazado, anulado o inexistente: se libera para el reintento.
    await admin
      .from("mp_payment_intents")
      .update({ mp_payment_id: null })
      .eq("id", row.id)
      .eq("status", "pending")
      .eq("mp_payment_id", row.mp_payment_id);
  }

  // 1) Tokenizar la tarjeta en Getnet (el PAN no se guarda ni se loguea).
  const tokUrl = `${auth.host}${API_TOKENIZE_PATH}`;
  let numberToken: string | null = null;
  try {
    const r = await fetch(tokUrl, { method: "POST", headers, body: JSON.stringify(buildTokenizeBody(card.number, row.id)) });
    const text = await r.text().catch(() => "");
    if (r.ok) {
      try {
        numberToken = (JSON.parse(text) as { number_token?: string }).number_token ?? null;
      } catch {
        numberToken = null;
      }
    }
    if (!numberToken) {
      const a = makeAttempt("tokenize", tokUrl, r.status, text, secrets);
      console.error(JSON.stringify({ fn: "getnet_checkout", intent: row.id, ...a }));
      return json(
        { ok: false, error: "getnet_error", reason: r.status === 403 ? "not_enabled" : r.status === 400 ? "card_data" : "token" },
        502,
      );
    }
  } catch {
    return json({ ok: false, error: "getnet_error", reason: "gateway", detail: "unreachable" }, 502);
  }

  // 2) Cuotas: cotización de Getnet (obligatoria en Argentina).
  let quote = null;
  if (installments > 1) {
    const qUrl = `${auth.host}${API_QUOTES_PATH}`;
    const r = await fetch(qUrl, {
      method: "POST",
      headers,
      body: JSON.stringify(buildQuotesBody({ amountCents: cents, bin: card.number.slice(0, 9), numberToken })),
    }).catch(() => null);
    const text = r ? await r.text().catch(() => "") : "";
    if (!r || !r.ok) {
      const a = makeAttempt("quotes", qUrl, r?.status ?? 0, text, secrets);
      console.error(JSON.stringify({ fn: "getnet_checkout", intent: row.id, ...a }));
      return json({ ok: false, error: "plan_not_available" }, 400);
    }
    let parsed: unknown = null;
    try {
      parsed = JSON.parse(text);
    } catch {
      parsed = null;
    }
    quote = pickQuote(parseQuotes(parsed), installments, cents);
    if (!quote) return json({ ok: false, error: "plan_not_available" }, 400);
  }

  // 3) Reservar el intento en el intent (idempotencia) y cobrar.
  const paymentId = crypto.randomUUID();
  const idempotencyKey = crypto.randomUUID();
  const { data: claimed } = await admin
    .from("mp_payment_intents")
    .update({ mp_payment_id: paymentId })
    .eq("id", row.id)
    .eq("status", "pending")
    .is("mp_payment_id", null)
    .select("id");
  if (!claimed || claimed.length === 0) return json({ error: "payment_in_review" }, 409);

  const payUrl = `${auth.host}${API_PAYMENTS_PATH}`;
  let res: Response;
  try {
    res = await fetch(payUrl, {
      method: "POST",
      headers,
      body: JSON.stringify(
        buildApiPaymentBody({
          intentId: row.id,
          paymentId,
          idempotencyKey,
          amountCents: cents,
          installments,
          debit: brandInfo.debit,
          brand: brandInfo.brand,
          numberToken,
          card,
          quote,
        }),
      ),
    });
  } catch {
    // Sin respuesta: el payment_id queda reservado y el poll del POS lo resuelve.
    return json({ ok: false, status: "pending_review", state: "NO_RESPONSE" }, 202);
  }
  const text = await res.text().catch(() => "");
  let body: unknown = null;
  try {
    body = JSON.parse(text);
  } catch {
    body = null;
  }
  const outcome = classifyApiPayResponse(res.status, body, cents);

  if (outcome.kind === "approved") {
    await admin
      .from("mp_payment_intents")
      .update({ status: "approved", amount: finalAmount, mp_payment_id: outcome.paymentId ?? paymentId })
      .eq("id", row.id)
      .eq("status", "pending");
    await admin.from("audit_logs").insert({
      tenant_id: row.tenant_id,
      actor_user_id: null,
      entity_type: "mp_payment_intents",
      entity_id: row.id,
      action: "getnet_payment_approved",
      after_data: {
        payment_id: outcome.paymentId ?? paymentId,
        amount: finalAmount,
        base: Number(row.amount),
        installments,
        brand: brandInfo.brand,
        authorization_code: outcome.authCode,
        channel: "checkout_api",
        via: "checkout",
      },
    });
  } else if (outcome.kind === "amount_mismatch") {
    console.error(JSON.stringify({ fn: "getnet_checkout", step: "amount_mismatch", intent: row.id, expected: outcome.expectedCents, got: outcome.gotCents }));
    await admin
      .from("mp_payment_intents")
      .update({ status: "rejected" })
      .eq("id", row.id)
      .eq("status", "pending");
  } else if (outcome.kind === "rejected" || outcome.kind === "error") {
    // El cliente puede reintentar con otra tarjeta: se libera la reserva.
    await admin
      .from("mp_payment_intents")
      .update({ mp_payment_id: null })
      .eq("id", row.id)
      .eq("status", "pending")
      .eq("mp_payment_id", paymentId);
    if (outcome.kind === "error") {
      const a = makeAttempt("pay", payUrl, res.status, text, secrets);
      console.error(JSON.stringify({ fn: "getnet_checkout", intent: row.id, ...a }));
    }
  }
  // pending: queda reservado con el payment_id para que el POS lo verifique.
  const out = apiPayHttpResponse(outcome, finalAmount);
  return json(out.body, out.status);
});
