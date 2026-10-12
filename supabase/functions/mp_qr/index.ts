// =============================================================================
// Edge Function: mp_qr — QR dinámico de Mercado Pago en el local sobre la
// Orders API (ADR-032). El cliente escanea con la app de MP (o cualquier
// billetera interoperable) el qr_data que el POS dibuja localmente.
//
// Actions (body.action):
//   * setup  {name, street_name, street_number, city_name, state_name,
//             coordinates, reference?}  (owner/manager, alta única)
//            → GET /users/me → POST /users/{id}/stores → POST /v2/pos.
//            Guarda ids en tenant_payment_methods(mercadopago).config.mp_qr[env]
//            (env = prod | test según el switch Sandbox). Si la sucursal o la
//            caja ya existían (mismo external_id), las reutiliza.
//   * reset  (owner/manager) → olvida la caja del ambiente actual (p. ej. al
//            reconectar otra cuenta de MP).
//   * create {amount, title?} → intent local + POST /v1/orders type "qr" modo
//            dynamic con X-Idempotency-Key = intent.id. Devuelve qr_data.
//            Sin caja configurada → 400 qr_pos_not_configured (el POS cae al
//            QR del link de Checkout Pro, mp_create_qr).
//   * status {intent_id} → GET /v1/orders/{id} y sincroniza (aunque no haya
//            webhook configurado). Sólo approved con monto exacto.
//   * cancel {intent_id} → POST /v1/orders/{id}/cancel y sincroniza.
//
// Gating real: tenant_has_feature_for(tenant,'mercado_pago') en setup y
// create (la UI nunca es la única barrera); el trigger de `payments` vuelve a
// cortar al registrar la venta.
// =============================================================================
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.47.10";
import { MP_API, mpHeaders, tenantMpCredential } from "../_shared/mpAuth.ts";
import {
  applyOrderToIntent,
  fetchOrder,
  ORDER_INTENT_COLUMNS,
  type OrderIntentRow,
} from "../_shared/mpIntents.ts";
import {
  buildPosBody,
  buildQrOrderBody,
  buildStoreBody,
  type MpEnv,
  mpExternalIds,
  parseStoreSetup,
} from "../_shared/mpOrders.ts";

const cors = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};
const json = (b: unknown, s = 200) =>
  new Response(JSON.stringify(b), {
    status: s,
    headers: { ...cors, "Content-Type": "application/json" },
  });

type QrPos = {
  user_id: string;
  store_id: string;
  pos_id: string;
  external_pos_id: string;
  store_name: string;
  address: string;
  created_at: string;
};

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
  if (!["setup", "reset", "create", "status", "cancel"].includes(action)) {
    return json({ error: "invalid_action" }, 400);
  }

  const admin = createClient(url, serviceKey, { auth: { persistSession: false } });

  const { data: mem } = await admin
    .from("tenant_users")
    .select("role")
    .eq("tenant_id", tenantId)
    .eq("user_id", user.id)
    .eq("status", "active")
    .maybeSingle();
  if (!mem) return json({ error: "forbidden" }, 403);
  const canManage = mem.role === "owner" || mem.role === "manager";

  const featureOk = async () => {
    const { data } = await admin.rpc("tenant_has_feature_for", {
      p_tenant: tenantId,
      p_key: "mercado_pago",
    });
    return data === true;
  };

  const readConfig = async (): Promise<Record<string, unknown>> => {
    const { data } = await admin
      .from("tenant_payment_methods")
      .select("config")
      .eq("tenant_id", tenantId)
      .eq("provider_key", "mercadopago")
      .maybeSingle();
    return ((data?.config as Record<string, unknown>) ?? {}) as Record<string, unknown>;
  };
  const writeQrPos = async (env: MpEnv, value: QrPos | null) => {
    const config = await readConfig();
    const mpQr = { ...((config.mp_qr as Record<string, unknown>) ?? {}) };
    if (value) mpQr[env] = value;
    else delete mpQr[env];
    await admin.from("tenant_payment_methods").upsert(
      { tenant_id: tenantId, provider_key: "mercadopago", config: { ...config, mp_qr: mpQr } },
      { onConflict: "tenant_id,provider_key" },
    );
  };
  const audit = (act: string, entityId: string | null, after: Record<string, unknown>) =>
    admin.from("audit_logs").insert({
      tenant_id: tenantId,
      actor_user_id: user.id,
      entity_type: entityId ? "mp_payment_intents" : "tenant_payment_methods",
      entity_id: entityId,
      action: act,
      after_data: after,
    });

  // ── setup: sucursal + caja en MP (una vez por ambiente) ────────────────────
  if (action === "setup" || action === "reset") {
    if (!canManage) return json({ error: "forbidden" }, 403);
    if (!(await featureOk())) return json({ error: "payment_method_not_allowed" }, 403);
    const cred = await tenantMpCredential(admin, tenantId);
    if (!cred) return json({ error: "not_connected" }, 400);

    if (action === "reset") {
      await writeQrPos(cred.env, null);
      await audit("mp_qr_pos_reset", null, { provider_key: "mercadopago", env: cred.env });
      return json({ ok: true });
    }

    const parsed = parseStoreSetup(b);
    if (!parsed.ok) return json({ error: "invalid_store", field: parsed.field }, 400);
    const ids = mpExternalIds(tenantId);
    const h = mpHeaders(cred.token);

    const me = await fetch(`${MP_API}/users/me`, { headers: h });
    if (!me.ok) return json({ error: "mp_error", detail: (await me.text()).slice(0, 300) }, 502);
    const mpUserId = String(((await me.json()) as { id?: number | string }).id ?? "");
    if (!mpUserId) return json({ error: "mp_error", detail: "no_user_id" }, 502);

    // Sucursal: se reutiliza si ya existe una con el external_id del tenant.
    let storeId = "";
    const found = await fetch(
      `${MP_API}/users/${mpUserId}/stores/search?external_id=${ids.storeExternalId}`,
      { headers: h },
    );
    if (found.ok) {
      const res = (await found.json()) as { results?: { id?: string | number }[] };
      storeId = String(res.results?.[0]?.id ?? "");
    }
    if (!storeId) {
      const st = await fetch(`${MP_API}/users/${mpUserId}/stores`, {
        method: "POST",
        headers: h,
        body: JSON.stringify(buildStoreBody(parsed.value, ids.storeExternalId)),
      });
      if (!st.ok) {
        return json(
          { error: "mp_store_error", detail: (await st.text()).slice(0, 300) },
          502,
        );
      }
      storeId = String(((await st.json()) as { id?: string | number }).id ?? "");
    }
    if (!storeId) return json({ error: "mp_store_error", detail: "no_store_id" }, 502);

    // Caja: idem por external_id.
    let posId = "";
    const pf = await fetch(`${MP_API}/pos?external_id=${ids.posExternalId}`, { headers: h });
    if (pf.ok) {
      const res = (await pf.json()) as { results?: { id?: string | number }[] };
      posId = String(res.results?.[0]?.id ?? "");
    }
    if (!posId) {
      const pr = await fetch(`${MP_API}/v2/pos`, {
        method: "POST",
        headers: mpHeaders(cred.token, `${ids.posExternalId}-${cred.env}`),
        body: JSON.stringify(buildPosBody(storeId, ids)),
      });
      if (!pr.ok) {
        return json({ error: "mp_pos_error", detail: (await pr.text()).slice(0, 300) }, 502);
      }
      posId = String(((await pr.json()) as { id?: string | number }).id ?? "");
    }
    if (!posId) return json({ error: "mp_pos_error", detail: "no_pos_id" }, 502);

    const loc = parsed.value.location;
    const value: QrPos = {
      user_id: mpUserId,
      store_id: storeId,
      pos_id: posId,
      external_pos_id: ids.posExternalId,
      store_name: parsed.value.name,
      address: `${loc.street_name} ${loc.street_number}, ${loc.city_name}, ${loc.state_name}`,
      created_at: new Date().toISOString(),
    };
    await writeQrPos(cred.env, value);
    await audit("mp_qr_pos_setup", null, {
      provider_key: "mercadopago",
      env: cred.env,
      store_id: storeId,
      pos_id: posId,
      external_pos_id: ids.posExternalId,
    });
    return json({ ok: true, env: cred.env, pos: value });
  }

  // ── create: order QR dinámica ───────────────────────────────────────────────
  if (action === "create") {
    if (!(await featureOk())) return json({ error: "payment_method_not_allowed" }, 403);
    const amount = Number(b.amount);
    if (!Number.isFinite(amount) || amount <= 0) return json({ error: "invalid_amount" }, 400);
    const title = String(b.title ?? "Venta NinjaPos");

    const cred = await tenantMpCredential(admin, tenantId);
    if (!cred) return json({ error: "not_connected" }, 400);
    const config = await readConfig();
    const pos = ((config.mp_qr as Record<string, QrPos | undefined>) ?? {})[cred.env];
    if (!pos?.external_pos_id) return json({ error: "qr_pos_not_configured" }, 400);

    const { data: intent, error: intErr } = await admin
      .from("mp_payment_intents")
      .insert({ tenant_id: tenantId, amount, provider_key: "mercadopago", mp_env: cred.env })
      .select("id")
      .single();
    if (intErr || !intent) return json({ error: "intent_failed" }, 500);

    const r = await fetch(`${MP_API}/v1/orders`, {
      method: "POST",
      headers: mpHeaders(cred.token, intent.id),
      body: JSON.stringify(
        buildQrOrderBody({
          intentId: intent.id,
          amount,
          externalPosId: pos.external_pos_id,
          title,
        }),
      ),
    });
    if (!r.ok) {
      const detail = (await r.text()).slice(0, 300);
      await admin.from("mp_payment_intents").update({ status: "rejected" }).eq("id", intent.id);
      const code = r.status === 404 && detail.includes("pos_not_found") ? "qr_pos_not_found" : "mp_error";
      return json({ error: code, detail }, 502);
    }
    const order = (await r.json()) as { id?: string; type_response?: { qr_data?: string } };
    const qrData = order.type_response?.qr_data ?? "";
    if (!order.id || !qrData) {
      await admin.from("mp_payment_intents").update({ status: "rejected" }).eq("id", intent.id);
      return json({ error: "mp_error", detail: "no_qr_data" }, 502);
    }
    await admin
      .from("mp_payment_intents")
      .update({ mp_order_id: order.id, init_point: qrData })
      .eq("id", intent.id);
    return json({ intent_id: intent.id, order_id: order.id, qr_data: qrData });
  }

  // ── status / cancel sobre un intent QR (Orders API) del tenant ─────────────
  const intentId = String(b.intent_id ?? "");
  if (!intentId) return json({ error: "invalid_intent" }, 400);
  const { data: rowRaw } = await admin
    .from("mp_payment_intents")
    .select(ORDER_INTENT_COLUMNS)
    .eq("id", intentId)
    .eq("tenant_id", tenantId)
    .eq("provider_key", "mercadopago")
    .not("mp_order_id", "is", null)
    .maybeSingle();
  const row = rowRaw as OrderIntentRow | null;
  if (!row || !row.mp_order_id) return json({ error: "intent_not_found" }, 404);

  if (row.status !== "pending") {
    return json({ status: row.status, mp_payment_id: row.mp_payment_id });
  }
  const cred = await tenantMpCredential(admin, tenantId, row.mp_env ?? "prod");
  if (!cred) return json({ error: "not_connected" }, 400);

  if (action === "cancel") {
    const c = await fetch(`${MP_API}/v1/orders/${encodeURIComponent(row.mp_order_id)}/cancel`, {
      method: "POST",
      headers: mpHeaders(cred.token, `${row.id}-cancel`),
    });
    if (c.ok) {
      await audit("mp_order_cancelled", row.id, {
        provider_key: "mercadopago",
        mp_order_id: row.mp_order_id,
      });
    }
  }

  const got = await fetchOrder(cred.token, row.mp_order_id);
  if (!got.ok) return json({ error: "mp_error", detail: got.detail }, 502);
  const res = await applyOrderToIntent(admin, row, got.order, {
    userId: user.id,
    source: "poll",
  });
  return json({
    status: res.reason === "reference_mismatch" ? "pending" : res.status,
    mp_payment_id: res.paymentId,
  });
});
