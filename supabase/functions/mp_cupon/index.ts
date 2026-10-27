// =============================================================================
// Edge Function: mp_cupon · cupón de pago en efectivo (Rapipago / Pago Fácil)
// con la Orders API de Mercado Pago (F8 · ADR-180). Usa la conexión de Mercado
// Pago que el negocio ya tiene (OAuth o token, switch Sandbox = token de
// prueba) y la misma regla de acreditación que el QR de la caja: la order se
// RE-LEE de la API y sólo vale processed + monto exacto + external_reference
// = intent (resolveOrder). El webhook topic order (mp_orders_webhook) la
// encuentra por mp_order_id; status y el cron de cobros en espera son el
// respaldo.
//
// Actions (body.action):
//   * create {amount, method: rapipago | pagofacil, title?, email?, name?,
//     doc_type?, doc_number?, customer_id?} → intent local (provider_key
//     'mp_cupon', mp_order_id) + POST /v1/orders type online con
//     payment_method ticket y vencimiento P3D (X-Idempotency-Key = intent.id).
//     El pagador sale del cuerpo o, si falta, del cliente (customer_id).
//     Devuelve el cupón (ticket_url como init_point, código de barras,
//     referencia y vencimiento). Si Mercado Pago todavía lo está procesando,
//     voucher llega null y lo completa status.
//   * status {intent_id} → GET /v1/orders/{id}: guarda el cupón si faltaba y
//     sincroniza el estado (action_required = pending).
//   * cancel {intent_id} → POST /v1/orders/{id}/cancel (sólo mientras está
//     action_required) y sincroniza.
//
// Gating real: tenant_has_feature_for(tenant,'cupones_efectivo') y
// tenant_has_feature_for(tenant,'mercado_pago') en create; Mercado Pago apagado
// en la sucursal o la caja → payment_method_disabled_in_store.
// =============================================================================
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.47.10";
import { MP_API, mpHeaders, tenantMpCredential } from "../_shared/mpAuth.ts";
import { bodyStoreId, insertIntentWithScope, intentSecretScope } from "../_shared/paymentSecrets.ts";
import { applyOrderToIntent, type OrderIntentRow } from "../_shared/mpIntents.ts";
import { locationOf, methodBlockedAt } from "../_shared/terminals.ts";
import {
  buildCuponOrderBody,
  cuponErrorCode,
  isCuponMethod,
  parsePayer,
  parseVoucher,
  type Voucher,
} from "../_shared/mpCupon.ts";
import type { MpOrder } from "../_shared/mpOrders.ts";

const cors = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};
const json = (b: unknown, s = 200) =>
  new Response(JSON.stringify(b), { status: s, headers: { ...cors, "Content-Type": "application/json" } });

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const COLS =
  "id, tenant_id, status, amount, mp_order_id, mp_payment_id, mp_env, provider_key, voucher, created_at";
type Row = OrderIntentRow & { voucher: Voucher | null; created_at: string };

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function readOrder(token: string, orderId: string): Promise<{ ok: true; order: MpOrder & Record<string, unknown> } | { ok: false; status: number }> {
  const r = await fetch(`${MP_API}/v1/orders/${encodeURIComponent(orderId)}`, { headers: mpHeaders(token) }).catch(() => null);
  if (!r || !r.ok) return { ok: false, status: r?.status ?? 0 };
  return { ok: true, order: (await r.json()) as MpOrder & Record<string, unknown> };
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
  const [{ data: { user }, error }, body] = await Promise.all([
    userClient.auth.getUser(),
    req.json().catch(() => null) as Promise<Record<string, unknown> | null>,
  ]);
  if (error || !user) return json({ error: "unauthorized" }, 401);
  const tenantId = (user.app_metadata as { current_tenant_id?: string } | null)?.current_tenant_id;
  if (!tenantId) return json({ error: "no_tenant" }, 400);
  if (!body) return json({ error: "invalid_json" }, 400);
  const b = body;
  const action = String(b.action ?? "");
  if (!["create", "status", "cancel"].includes(action)) return json({ error: "invalid_action" }, 400);

  const admin = createClient(url, serviceKey, { auth: { persistSession: false } });
  const { data: mem } = await admin
    .from("tenant_users")
    .select("role")
    .eq("tenant_id", tenantId)
    .eq("user_id", user.id)
    .eq("status", "active")
    .maybeSingle();
  if (!mem) return json({ error: "forbidden" }, 403);

  const audit = (act: string, entityId: string, after: Record<string, unknown>) =>
    admin.from("audit_logs").insert({
      tenant_id: tenantId,
      actor_user_id: user.id,
      entity_type: "mp_payment_intents",
      entity_id: entityId,
      action: act,
      after_data: after,
    });

  // ── create ─────────────────────────────────────────────────────────────────
  if (action === "create") {
    const feat = (key: string) =>
      admin.rpc("tenant_has_feature_for", { p_tenant: tenantId, p_key: key }).then((r: { data: unknown }) => r.data === true);
    const [cupones, mp] = await Promise.all([feat("cupones_efectivo"), feat("mercado_pago")]);
    if (!cupones || !mp) return json({ error: "payment_method_not_allowed" }, 403);

    const amount = Math.round(Number(b.amount) * 100) / 100;
    if (!Number.isFinite(amount) || amount <= 0) return json({ error: "invalid_amount" }, 400);
    if (!isCuponMethod(b.method)) return json({ error: "invalid_method" }, 400);
    const method = b.method;

    // Pagador: lo tipeado en el POS o, si falta, el cliente de la venta.
    let src: Record<string, unknown> = { email: b.email, name: b.name, doc_type: b.doc_type, doc_number: b.doc_number };
    if (UUID_RE.test(String(b.customer_id ?? "")) && (!b.email || !b.doc_number || !b.name)) {
      const { data: c } = await admin
        .from("customers")
        .select("name, email, document_type, document_number")
        .eq("id", String(b.customer_id))
        .eq("tenant_id", tenantId)
        .is("deleted_at", null)
        .maybeSingle();
      const cust = c as { name?: string; email?: string; document_type?: string; document_number?: string } | null;
      if (cust) {
        src = {
          email: b.email || cust.email,
          name: b.name || cust.name,
          doc_type: b.doc_type || cust.document_type,
          doc_number: b.doc_number || cust.document_number,
        };
      }
    }
    const payer = parsePayer(src);
    if (!payer.ok) return json({ error: payer.error }, 400);

    const loc = locationOf(b);
    const [cred, blocked] = await Promise.all([
      tenantMpCredential(admin, tenantId, null, { storeId: bodyStoreId(b) }),
      methodBlockedAt(admin, tenantId, "mercadopago", loc.storeId, loc.registerId),
    ]);
    if (!cred) return json({ error: "not_connected" }, 400);
    if (blocked) return json({ error: "payment_method_disabled_in_store" }, 403);

    const intentId = crypto.randomUUID();
    const ins = await insertIntentWithScope(
      admin,
      { id: intentId, tenant_id: tenantId, amount, provider_key: "mp_cupon", mp_env: cred.env },
      cred.scopeStoreId,
    );
    if (ins.error) return json({ error: "intent_failed" }, 500);

    const title = typeof b.title === "string" ? b.title : "Venta NinjaPos";
    const r = await fetch(`${MP_API}/v1/orders`, {
      method: "POST",
      headers: mpHeaders(cred.token, intentId),
      body: JSON.stringify(buildCuponOrderBody({ intentId, amount, method, payer: payer.payer, description: title })),
    }).catch(() => null);
    if (!r || !r.ok) {
      const detail = r ? (await r.text()).slice(0, 300) : "unreachable";
      await admin.from("mp_payment_intents").update({ status: "rejected" }).eq("id", intentId);
      return json({ error: r ? cuponErrorCode(r.status, detail) : "mp_error", detail: r ? `http_${r.status}` : "unreachable" }, 502);
    }
    const created = (await r.json()) as MpOrder & Record<string, unknown>;
    if (!created.id) {
      await admin.from("mp_payment_intents").update({ status: "rejected" }).eq("id", intentId);
      return json({ error: "mp_error", detail: "no_order_id" }, 502);
    }
    // Se guarda el id de la order antes de seguir: el webhook la encuentra por él.
    await admin.from("mp_payment_intents").update({ mp_order_id: created.id }).eq("id", intentId);

    // La creación es asíncrona: si todavía no trae el cupón, se re-lee unas
    // veces (≈ 4,5 s en total); si no, lo completa status.
    let voucher = parseVoucher(created);
    for (let i = 0; !voucher && i < 3; i++) {
      await sleep(1500);
      const got = await readOrder(cred.token, created.id);
      if (got.ok) voucher = parseVoucher(got.order);
    }
    if (voucher) {
      await admin
        .from("mp_payment_intents")
        .update({ voucher, init_point: voucher.ticket_url })
        .eq("id", intentId);
    }
    await audit("mp_cupon_created", intentId, {
      amount,
      method,
      env: cred.env,
      mp_order_id: created.id,
      ready: Boolean(voucher),
    });
    return json({ intent_id: intentId, order_id: created.id, init_point: voucher?.ticket_url ?? "", voucher });
  }

  // ── status / cancel ────────────────────────────────────────────────────────
  const intentId = String(b.intent_id ?? "");
  if (!UUID_RE.test(intentId)) return json({ error: "invalid_intent" }, 400);
  const { data: rowRaw } = await admin
    .from("mp_payment_intents")
    .select(COLS)
    .eq("id", intentId)
    .eq("tenant_id", tenantId)
    .eq("provider_key", "mp_cupon")
    .not("mp_order_id", "is", null)
    .maybeSingle();
  const row = rowRaw as Row | null;
  if (!row || !row.mp_order_id) return json({ error: "intent_not_found" }, 404);
  if (row.status !== "pending") {
    return json({ status: row.status, mp_payment_id: row.mp_payment_id, voucher: row.voucher });
  }

  const cred = await tenantMpCredential(admin, tenantId, row.mp_env ?? "prod", {
    scopeStoreId: await intentSecretScope(admin, row.id),
  });
  if (!cred) return json({ error: "not_connected" }, 400);

  if (action === "cancel") {
    const c = await fetch(`${MP_API}/v1/orders/${encodeURIComponent(row.mp_order_id)}/cancel`, {
      method: "POST",
      headers: mpHeaders(cred.token, `${row.id}-cancel`),
    }).catch(() => null);
    if (c?.ok) await audit("mp_cupon_cancelled", row.id, { mp_order_id: row.mp_order_id });
  }

  const got = await readOrder(cred.token, row.mp_order_id);
  if (!got.ok) return json({ error: "mp_error", detail: `http_${got.status}` }, 502);
  let voucher = row.voucher;
  if (!voucher) {
    voucher = parseVoucher(got.order, new Date(row.created_at));
    if (voucher) {
      await admin.from("mp_payment_intents").update({ voucher, init_point: voucher.ticket_url }).eq("id", row.id);
    }
  }
  const res = await applyOrderToIntent(admin, row, got.order, { userId: user.id, source: "poll" });
  return json({
    status: res.reason === "reference_mismatch" ? "pending" : res.status,
    mp_payment_id: res.paymentId,
    voucher,
  });
});
