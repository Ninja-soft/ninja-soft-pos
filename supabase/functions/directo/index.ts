// =============================================================================
// Edge Function: directo · crédito Directo por QR + link (F8 · ADR-181, API
// Ecommerce 2.0; reemplaza la API inferida de ADR-041). Login con usuario y
// contraseña del comercio (Bearer), host fijo por ambiente (switch Sandbox =
// QA).
//
// Actions (body.action):
//   * create {amount, title?, buyer?: {dni, last_name, first_name},
//     customer_id?} → intent local (mp_payment_intents, provider_key='directo',
//     mp_env por el switch) + POST create_order con fullName
//     "APELLIDOS,NOMBRES", dni, price = total, notifyUrl por intent (dominio
//     de hooks) y regreso a /pagar/listo. Sin `buyer`, el comprador sale del
//     cliente de la venta (customers: name + DNI o CUIT/CUIL de persona). El
//     merchantOrderId de Directo queda en preference_id y el redirectUrl es
//     el init_point que el POS muestra como QR y link.
//   * status {intent_id} → re-consulta get_order_status y sincroniza (respaldo
//     del webhook): Success + merchantOrderId propio → approved; Cancel →
//     cancelled; Pending → sigue.
//   * cancel {intent_id} → baja local del intent (el documento no describe
//     cómo anular una orden). Si el cliente igual saca el crédito, el webhook
//     lo registra como approved y queda en la conciliación.
//   * offer {buyer, sex, amount} → "Consultar oferta": rating (+ deadlines con
//     el monto si entra en el rango). Sólo por acción explícita del cajero y
//     con tope de 20 consultas por hora por negocio (el documento advierte
//     que el uso excesivo bloquea al comercio).
//
// Gating real: tenant_has_feature_for(tenant,'directo') en create y offer (y
// el trigger de payments vía payment_method_plan_key('directo')).
// Credencial: payment_secrets provider 'directo' (set_payment_secret). Nunca
// sale del servidor ni se loguea.
// =============================================================================
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.47.10";
import {
  buildFullName,
  classifyError,
  dniFromDocument,
  normalizeDni,
  sexTypeId,
  splitCustomerName,
} from "../_shared/directo.ts";
import {
  INTENT_COLS,
  clientFor,
  hooksBase,
  intentEnvValue,
  loadCredsScoped,
  loadEnv,
  syncIntent,
  type IntentRow,
} from "../_shared/directo_server.ts";
import { bodyStoreId, insertIntentWithScope, intentSecretScope } from "../_shared/paymentSecrets.ts";

const cors = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type, x-ninja-scope",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};
const json = (b: unknown, s = 200) =>
  new Response(JSON.stringify(b), {
    status: s,
    headers: { ...cors, "Content-Type": "application/json" },
  });

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
// Tope de "Consultar oferta" por negocio (scoring a demanda, nunca masivo).
const OFFER_MAX_PER_HOUR = 20;

const maskDni = (dni: string) => `***${dni.slice(-3)}`;

type Buyer = { dni: string; fullName: string };

function buyerFromBody(v: unknown): Buyer | null {
  if (typeof v !== "object" || v === null) return null;
  const b = v as Record<string, unknown>;
  const dni = normalizeDni(b.dni);
  const fullName = buildFullName(b.last_name, b.first_name);
  return dni && fullName ? { dni, fullName } : null;
}

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });
  if (req.method !== "POST") return json({ error: "method_not_allowed" }, 405);

  const url = Deno.env.get("SUPABASE_URL")!;
  const serviceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
  const anonKey = Deno.env.get("SUPABASE_ANON_KEY")!;

  const userClient = createClient(url, anonKey, {
    global: { headers: { Authorization: req.headers.get("Authorization") ?? "" } },
    auth: { persistSession: false },
  });
  const {
    data: { user },
    error,
  } = await userClient.auth.getUser();
  if (error || !user) return json({ error: "unauthorized" }, 401);
  const tenantId = (user.app_metadata as { current_tenant_id?: string } | null)
    ?.current_tenant_id;
  if (!tenantId) return json({ error: "no_tenant" }, 400);

  let b: Record<string, unknown>;
  try {
    b = await req.json();
  } catch {
    return json({ error: "invalid_json" }, 400);
  }
  const action = String(b.action ?? "");

  const admin = createClient(url, serviceKey, { auth: { persistSession: false } });

  const { data: mem } = await admin
    .from("tenant_users")
    .select("role")
    .eq("tenant_id", tenantId)
    .eq("user_id", user.id)
    .eq("status", "active")
    .maybeSingle();
  if (!mem) return json({ error: "forbidden" }, 403);

  // ADR-057: al crear (o consultar oferta), la conexión de la sucursal del
  // POS si tiene; sobre un intent, la misma con la que se creó.
  const fresh = action === "create" || action === "offer";
  const conn = await loadCredsScoped(
    admin,
    tenantId,
    fresh ? { storeId: bodyStoreId(b) } : { scopeStoreId: await intentSecretScope(admin, String(b.intent_id ?? "")) },
  );
  if (!conn) return json({ error: "not_connected" }, 400);
  const creds = conn.creds;

  const allowed = async () => {
    const { data } = await admin.rpc("tenant_has_feature_for", { p_tenant: tenantId, p_key: "directo" });
    return data === true;
  };

  // ── offer ("Consultar oferta") ─────────────────────────────────────────────
  if (action === "offer") {
    if (!(await allowed())) return json({ error: "payment_method_not_allowed" }, 403);
    const buyer = buyerFromBody(b.buyer);
    if (!buyer) return json({ error: "directo_buyer_required" }, 400);
    const sex = sexTypeId(b.sex);
    if (!sex) return json({ error: "directo_sex_required" }, 400);
    const amount = Math.round(Number(b.amount) * 100) / 100;

    const since = new Date(Date.now() - 3600_000).toISOString();
    const { count } = await admin
      .from("audit_logs")
      .select("id", { count: "exact", head: true })
      .eq("tenant_id", tenantId)
      .eq("action", "directo_offer_checked")
      .gte("created_at", since);
    if ((count ?? 0) >= OFFER_MAX_PER_HOUR) return json({ error: "directo_rate_limited" }, 429);

    const env = await loadEnv(admin, tenantId);
    // Se registra ANTES de llamar: cuenta para el tope aunque falle.
    await admin.from("audit_logs").insert({
      tenant_id: tenantId,
      actor_user_id: user.id,
      entity_type: "payment_providers",
      entity_id: null,
      action: "directo_offer_checked",
      after_data: { dni: maskDni(buyer.dni), amount: Number.isFinite(amount) ? amount : null, env },
    });

    const client = clientFor(creds, env);
    const rating = await client.rating({ fullName: buyer.fullName, dni: buyer.dni, sex });
    if (!rating.ok) return json({ error: classifyError(rating.httpStatus, rating.detail) }, 200);

    const o = rating.value;
    const inRange =
      Number.isFinite(amount) &&
      amount > 0 &&
      o.offers.some(
        (x) => (x.minimumAmount === null || amount >= x.minimumAmount) && (x.maximumAmount === null || amount <= x.maximumAmount),
      );
    let plans: unknown[] = [];
    let plansError: string | null = null;
    if (inRange) {
      const d = await client.deadlines(amount, o.pendingRequestId);
      if (d.ok) plans = d.value;
      else plansError = classifyError(d.httpStatus, d.detail);
    }
    return json({
      offers: o.offers,
      campaign_message: o.campaignMessage,
      amount_in_range: inRange,
      plans,
      plans_error: plansError,
    });
  }

  // ── create ─────────────────────────────────────────────────────────────────
  if (action === "create") {
    if (!(await allowed())) return json({ error: "payment_method_not_allowed" }, 403);

    const amount = Math.round(Number(b.amount) * 100) / 100;
    if (!Number.isFinite(amount) || amount <= 0) return json({ error: "invalid_amount" }, 400);

    // Comprador: lo que confirmó el cajero o, si no, el cliente de la venta.
    let buyer = buyerFromBody(b.buyer);
    if (!buyer && typeof b.customer_id === "string" && UUID_RE.test(b.customer_id)) {
      const { data: c } = await admin
        .from("customers")
        .select("name, document_type, document_number")
        .eq("id", b.customer_id)
        .eq("tenant_id", tenantId)
        .is("deleted_at", null)
        .maybeSingle();
      const row = c as { name?: string; document_type?: string; document_number?: string } | null;
      if (row) {
        const dni = dniFromDocument(row.document_type, row.document_number);
        const parts = splitCustomerName(row.name);
        const fullName = buildFullName(parts.lastName, parts.firstName);
        if (dni && fullName) buyer = { dni, fullName };
      }
    }
    if (!buyer) return json({ error: "directo_buyer_required" }, 400);

    const env = await loadEnv(admin, tenantId);
    const { data: intent, error: intErr } = await insertIntentWithScope(
      admin,
      { tenant_id: tenantId, amount, provider_key: "directo", mp_env: intentEnvValue(env) },
      conn.scopeStoreId,
    );
    if (intErr || !intent) return json({ error: "intent_failed" }, 500);
    const intentId = (intent as { id: string }).id;

    const appUrl = (Deno.env.get("APP_URL") ?? "https://pos.soft.ninja").replace(/\/+$/, "");
    // Marca del negocio para la pantalla de regreso (dato público: nombre y logo).
    const { data: br } = await admin.from("tenant_branding").select("trade_name, logo_url").eq("tenant_id", tenantId).maybeSingle();
    const { data: tn } = await admin.from("tenants").select("name").eq("id", tenantId).maybeSingle();
    const shopName = String((br as { trade_name?: string } | null)?.trade_name || (tn as { name?: string } | null)?.name || "").trim().slice(0, 80);
    const shopLogo = String((br as { logo_url?: string } | null)?.logo_url ?? "").trim();
    const brandQs =
      (shopName ? `&n=${encodeURIComponent(shopName)}` : "") +
      (/^https:\/\//.test(shopLogo) && shopLogo.length < 600 ? `&l=${encodeURIComponent(shopLogo)}` : "");

    const created = await clientFor(creds, env).createOrder({
      amount,
      fullName: buyer.fullName,
      dni: buyer.dni,
      notifyUrl: `${hooksBase()}/directo?intent=${intentId}`,
      returnUrlSuccess: `${appUrl}/pagar/listo?estado=ok&medio=directo${brandQs}`,
      returnUrlError: `${appUrl}/pagar/listo?estado=error&medio=directo${brandQs}`,
    });
    if (!created.ok) {
      await admin.from("mp_payment_intents").update({ status: "rejected" }).eq("id", intentId);
      return json({ error: classifyError(created.httpStatus, created.detail) }, 502);
    }

    const { error: upErr } = await admin
      .from("mp_payment_intents")
      .update({ init_point: created.value.redirectUrl, preference_id: created.value.merchantOrderId })
      .eq("id", intentId);
    if (upErr) return json({ error: "intent_failed" }, 500);

    await admin.from("audit_logs").insert({
      tenant_id: tenantId,
      actor_user_id: user.id,
      entity_type: "mp_payment_intents",
      entity_id: intentId,
      action: "directo_order_created",
      after_data: {
        amount,
        env,
        merchant_order_id: created.value.merchantOrderId,
        dni: maskDni(buyer.dni),
        policy_product: creds.policyProduct,
      },
    });

    return json({ intent_id: intentId, init_point: created.value.redirectUrl });
  }

  // ── status / cancel ─────────────────────────────────────────────────────────
  const intentId = String(b.intent_id ?? "");
  if (!UUID_RE.test(intentId)) return json({ error: "invalid_intent" }, 400);
  const { data: rowData } = await admin
    .from("mp_payment_intents")
    .select(INTENT_COLS)
    .eq("id", intentId)
    .eq("tenant_id", tenantId)
    .eq("provider_key", "directo")
    .maybeSingle();
  const row = rowData as IntentRow | null;
  if (!row) return json({ error: "intent_not_found" }, 404);

  const resync = async () =>
    row.status === "pending" && row.preference_id ? await syncIntent(admin, row, creds, "status", user.id) : null;

  if (action === "status") {
    const res = await resync();
    if (!res) return json({ status: row.status, mp_payment_id: row.mp_payment_id });
    if ("error" in res) return json(res, 502);
    return json({ status: res.status, mp_payment_id: res.mp_payment_id });
  }

  if (action === "cancel") {
    if (row.status !== "pending") return json({ ok: true, status: row.status });
    // Última verificación: si el cliente justo sacó el crédito, gana el pago.
    const res = await resync();
    if (res && !("error" in res) && res.status !== "pending") return json({ ok: true, status: res.status });
    const { data: changed } = await admin
      .from("mp_payment_intents")
      .update({ status: "cancelled" })
      .eq("id", row.id)
      .eq("status", "pending")
      .select("id");
    if (changed && changed.length > 0) {
      await admin.from("audit_logs").insert({
        tenant_id: tenantId,
        actor_user_id: user.id,
        entity_type: "mp_payment_intents",
        entity_id: row.id,
        action: "directo_order_cancelled",
        after_data: { amount: Number(row.amount), merchant_order_id: row.preference_id },
      });
    }
    return json({ ok: true, status: "cancelled" });
  }

  return json({ error: "invalid_action" }, 400);
});
