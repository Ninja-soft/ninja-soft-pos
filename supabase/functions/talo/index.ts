// =============================================================================
// Edge Function: talo · cobro por transferencia con CVU / alias único (F8 ·
// ADR-175). API de Talo (docs.talo.com.ar): el comercio genera client_id y
// client_secret en su Dashboard (Usuario > Credenciales) y con su user_id
// pide un token TL- (POST /users/{user_id}/tokens).
//
// Actions (body.action):
//   * create {amount, title?} → intent local (mp_payment_intents,
//     provider_key='talo', mp_env por el switch Sandbox) + pago POST /payments/
//     con external_id = intent.id y webhook_url por intent (dominio de hooks).
//     Devuelve el CVU y el alias del pago y su payment_url (init_point, el
//     POS lo muestra como QR y link). El id del pago queda en preference_id.
//   * status {intent_id} → re-consulta el pago y sincroniza (respaldo del
//     webhook): SUCCESS u OVERPAID + referencia propia + precio del intent →
//     approved · UNDERPAID → sigue pending (devuelve cuánto falta) · EXPIRED →
//     cancelled.
//   * cancel {intent_id} → baja local del intent (la API no anula pagos; el
//     CVU vence solo a los ~5 días). Si el cliente igual transfiere, el webhook
//     lo registra como approved y queda en la conciliación.
//   * probe {user_id?, client_id?, client_secret?, environment?, store_id?} →
//     "Probar conexión": pide un token (dueño o encargado). Sin credenciales
//     tipeadas prueba las guardadas. No guarda nada.
//   * refund {intent_id, kind: 'full' | 'excess'} → devolución (dueño o
//     encargado). 'full': todo lo cobrado, sólo sin venta vigente (la venta se
//     anula primero). 'excess': la diferencia de un OVERPAID (con o sin venta).
//     Fila en talo_refunds (una devolución en curso por cobro) + POST
//     /payments/{id}/refunds con blame = quien la pide.
//
// Gating real: tenant_has_feature_for(tenant,'talo') en create y refund (y el
// trigger de payments vía payment_method_plan_key('talo')).
// Credencial: payment_secrets provider 'talo' (set_payment_secret). Nunca sale
// del servidor ni se loguea.
// =============================================================================
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.47.10";
import {
  buildRefundBody,
  checkAmount,
  classifyRefundResponse,
  isAuthFailure,
  parseCreds,
  planRefund,
  taloClient,
  UUID_RE,
  type TaloEnv,
} from "../_shared/talo.ts";
import {
  INTENT_COLS,
  clientFor,
  envOfIntent,
  hooksBase,
  intentEnvValue,
  loadCredsScoped,
  loadEnv,
  syncIntent,
  type IntentRow,
} from "../_shared/talo_server.ts";
import { bodyStoreId, insertIntentWithScope, intentSecretScope, isScopeUuid } from "../_shared/paymentSecrets.ts";

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

const envLabel = (e: TaloEnv) => (e === "sandbox" ? "Sandbox" : "Producción");

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
  const tenantId = (user.app_metadata as { current_tenant_id?: string } | null)?.current_tenant_id;
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
  const isManager = ["owner", "manager"].includes(String((mem as { role?: string }).role));

  // ── probe ("Probar conexión") ──────────────────────────────────────────────
  if (action === "probe") {
    if (!isManager) return json({ error: "forbidden" }, 403);
    const typed = parseCreds({ user_id: b.user_id, client_id: b.client_id, client_secret: b.client_secret });
    const storeId = isScopeUuid(b.store_id) ? b.store_id : null;
    const creds = typed ?? (await loadCredsScoped(admin, tenantId, { scopeStoreId: storeId }))?.creds ?? null;
    if (!creds) return json({ ok: false, error: "not_connected" });
    const env: TaloEnv =
      b.environment === "test" ? "sandbox" : b.environment === "prod" ? "prod" : await loadEnv(admin, tenantId);
    const r = await taloClient({ creds, env }).token(true);
    if (r.ok) {
      return json({
        ok: true,
        environment: env === "sandbox" ? "test" : "prod",
        label: `${envLabel(env)}: Talo aceptó las credenciales`,
      });
    }
    // ¿Son del otro ambiente? (la cuenta de sandbox es aparte). No guarda nada.
    const other: TaloEnv = env === "sandbox" ? "prod" : "sandbox";
    const alt = isAuthFailure(r.httpStatus) ? await taloClient({ creds, env: other }).token(true) : null;
    return json({
      ok: false,
      environment: env === "sandbox" ? "test" : "prod",
      mismatch: alt?.ok ? (other === "sandbox" ? "test" : "prod") : null,
      summary: alt?.ok
        ? `Estas credenciales son de ${envLabel(other).toLowerCase()}, no de ${envLabel(env).toLowerCase()}.`
        : isAuthFailure(r.httpStatus)
          ? "Talo rechazó el User ID, el Client ID o el Client Secret. Copialos de nuevo desde el Dashboard de Talo, Usuario, Credenciales."
          : "No pudimos comunicarnos con Talo. Probá de nuevo en unos segundos.",
    });
  }

  // ADR-057: al crear, la conexión de la sucursal del POS (si tiene); sobre
  // un intent, la misma con la que se creó.
  const conn = await loadCredsScoped(
    admin,
    tenantId,
    action === "create"
      ? { storeId: bodyStoreId(b) }
      : { scopeStoreId: await intentSecretScope(admin, String(b.intent_id ?? "")) },
  );
  if (!conn) return json({ error: "not_connected" }, 400);
  const creds = conn.creds;

  // ── create ─────────────────────────────────────────────────────────────────
  if (action === "create") {
    const { data: allowed } = await admin.rpc("tenant_has_feature_for", { p_tenant: tenantId, p_key: "talo" });
    if (allowed !== true) return json({ error: "payment_method_not_allowed" }, 403);

    const amount = Math.round(Number(b.amount) * 100) / 100;
    const check = checkAmount(amount);
    if (!check.ok) return json({ error: check.error }, 400);

    const env = await loadEnv(admin, tenantId);
    const motive = typeof b.title === "string" ? b.title.slice(0, 120) : "Venta";

    const { data: intent, error: intErr } = await insertIntentWithScope(
      admin,
      { tenant_id: tenantId, amount, provider_key: "talo", mp_env: intentEnvValue(env) },
      conn.scopeStoreId,
    );
    if (intErr || !intent) return json({ error: "intent_failed" }, 500);
    const intentId = (intent as { id: string }).id;

    const appUrl = (Deno.env.get("APP_URL") ?? "https://pos.soft.ninja").replace(/\/+$/, "");
    const created = await clientFor(creds, env).createPayment({
      amount,
      externalId: intentId,
      webhookUrl: `${hooksBase()}/talo?intent=${intentId}`,
      redirectUrl: `${appUrl}/pagar/listo?estado=ok&medio=talo`,
      motive,
    });
    if (!created.ok) {
      await admin.from("mp_payment_intents").update({ status: "rejected" }).eq("id", intentId);
      const auth = created.httpStatus === 401 || created.httpStatus === 403;
      return json({ error: auth ? "talo_auth_failed" : "talo_error", detail: created.detail }, 502);
    }

    const p = created.value;
    const { error: upErr } = await admin
      .from("mp_payment_intents")
      .update({ init_point: p.paymentUrl, preference_id: p.id })
      .eq("id", intentId);
    if (upErr) return json({ error: "intent_failed" }, 500);

    await admin.from("audit_logs").insert({
      tenant_id: tenantId,
      actor_user_id: user.id,
      entity_type: "mp_payment_intents",
      entity_id: intentId,
      action: "talo_payment_created",
      after_data: { amount, env, payment_id: p.id, expires_at: p.expiresAt },
    });

    return json({
      intent_id: intentId,
      init_point: p.paymentUrl ?? "",
      cvu: p.cvu,
      alias: p.alias,
      expires_at: p.expiresAt,
    });
  }

  // ── status / cancel / refund ───────────────────────────────────────────────
  const intentId = String(b.intent_id ?? "");
  if (!UUID_RE.test(intentId)) return json({ error: "invalid_intent" }, 400);
  const { data: rowData } = await admin
    .from("mp_payment_intents")
    .select(INTENT_COLS)
    .eq("id", intentId)
    .eq("tenant_id", tenantId)
    .eq("provider_key", "talo")
    .maybeSingle();
  const row = rowData as IntentRow | null;
  if (!row) return json({ error: "intent_not_found" }, 404);

  const resync = async () =>
    row.status === "pending" && row.preference_id ? await syncIntent(admin, row, creds, "status", user.id) : null;

  if (action === "status") {
    const res = await resync();
    if (!res) {
      // Ya resuelto (p. ej. por el webhook): lo recibido sale del intent.
      const paid = row.paid_amount === null ? null : Number(row.paid_amount);
      const over = paid === null ? 0 : Math.round((paid - Number(row.amount)) * 100) / 100;
      return json({
        status: row.status,
        mp_payment_id: row.mp_payment_id,
        paid,
        ...(row.status === "approved" && over > 0 ? { overpaid: over } : {}),
      });
    }
    if ("error" in res) return json(res, 502);
    return json(res);
  }

  if (action === "cancel") {
    if (row.status !== "pending") return json({ ok: true, status: row.status });
    // Última verificación: si el cliente justo transfirió, gana el pago.
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
        action: "talo_payment_cancelled",
        after_data: { amount: Number(row.amount), paid: row.paid_amount === null ? null : Number(row.paid_amount) },
      });
    }
    return json({ ok: true, status: "cancelled" });
  }

  if (action === "refund") {
    if (!isManager) return json({ error: "forbidden" }, 403);
    const { data: allowed } = await admin.rpc("tenant_has_feature_for", { p_tenant: tenantId, p_key: "talo" });
    if (allowed !== true) return json({ error: "payment_method_not_allowed" }, 403);
    const kind = b.kind === "excess" ? "excess" : "full";
    if (!row.preference_id) return json({ error: "not_refundable" }, 409);
    const paidLocal = row.paid_amount === null ? 0 : Number(row.paid_amount);
    // Total: cobro aprobado, o uno cerrado sin venta al que igual le llegó plata.
    // Diferencia: sólo un cobro aprobado (OVERPAID).
    const refundable =
      kind === "excess"
        ? row.status === "approved"
        : row.status === "approved" || (["cancelled", "rejected"].includes(row.status) && paidLocal > 0);
    if (!refundable) return json({ error: "not_refundable" }, 409);

    if (kind === "full") {
      // Con una venta vigente, primero se anula la venta (se devuelve todo).
      const { data: pays } = await admin
        .from("payments")
        .select("sale_id, sales(status)")
        .eq("tenant_id", tenantId)
        .eq("method", "qr")
        .in("reference", [row.id, row.preference_id]);
      const liveSale = ((pays ?? []) as { sales: { status?: string } | null }[]).some(
        (p) => p.sales && p.sales.status !== "voided",
      );
      if (liveSale) return json({ error: "sale_active" }, 409);
    }

    const blameMail = String(user.email ?? "").trim();
    if (!blameMail) return json({ error: "no_email" }, 409);

    // El monto sale del pago RE-CONSULTADO (lo cobrado menos lo ya devuelto).
    const client = clientFor(creds, envOfIntent(row));
    const pay = await client.getPayment(row.preference_id);
    if (!pay.ok) return json({ error: "talo_error", detail: `${pay.httpStatus} ${pay.detail}` }, 502);
    const plan = planRefund(pay.value, kind, Number(row.amount));
    if (!plan.ok) return json({ error: plan.error }, 409);

    // Una devolución en curso por cobro (índice único parcial): el reintento
    // de un pedido que ya salió no manda otro.
    const { data: refund, error: insErr } = await admin
      .from("talo_refunds")
      .insert({
        tenant_id: tenantId,
        intent_id: row.id,
        payment_id: row.preference_id,
        kind,
        refund_type: plan.type,
        amount: plan.amount,
        status: "requested",
        requested_by: user.id,
      })
      .select("id")
      .single();
    if (insErr || !refund) {
      const dup = (insErr as { code?: string } | null)?.code === "23505";
      return json({ error: dup ? "refund_in_progress" : "refund_failed" }, dup ? 409 : 500);
    }
    const refundId = (refund as { id: string }).id;

    const r = await client.refund(
      row.preference_id,
      buildRefundBody({ type: plan.type, amount: plan.amount, userId: creds.userId, blameMail }),
    );
    const c = classifyRefundResponse(r.httpStatus, r.body);
    await admin
      .from("talo_refunds")
      .update({ status: c.state, error_code: c.code, refund_ref: c.ref })
      .eq("id", refundId)
      .eq("status", "requested");
    await admin.from("audit_logs").insert({
      tenant_id: tenantId,
      actor_user_id: user.id,
      entity_type: "talo_refunds",
      entity_id: refundId,
      action: `talo_refund_${c.state}`,
      after_data: {
        intent_id: row.id,
        payment_id: row.preference_id,
        kind,
        refund_type: plan.type,
        amount: plan.amount,
        code: c.code,
        env: envOfIntent(row),
      },
    });
    return json({ refund_id: refundId, status: c.state, amount: plan.amount, error: c.state === "failed" ? c.code : undefined });
  }

  return json({ error: "invalid_action" }, 400);
});
