// =============================================================================
// Edge Function: nave_point: cobro presencial con la terminal Nave Point
// (smart_pos) (F8 · H21c, ADR-030). Reutiliza la conexión Nave del tenant
// (payment_secrets provider 'nave'): NO pide credenciales nuevas; los ids de
// punto de venta de las terminales se cargan en esa misma conexión
// (point_pos_ids).
//
// Actions (body.action):
//   * devices                     → terminales configuradas [{id, label}].
//   * create {device_id, amount}  → intent local (provider_key 'nave_point',
//     point_device_id = pos_id de la terminal) + POST
//     payment_requests/smart_pos: Nave empuja el cobro a la terminal asociada
//     a ese pos_id. preference_id guarda el payment_request_id.
//   * status {intent_id}          → fallback del webhook: GET
//     payment_requests/{id} → pago aprobado verificado contra GET payments/{id}
//     (APPROVED + monto exacto) → approved + card_type (débito/crédito según la
//     tarjeta). DISABLED (baja en la terminal, batería, timeout) → cancelled;
//     FAILURE_PROCESSED → rejected.
//   * cancel {intent_id}          → DELETE payment_requests/{id} y cancela local.
//
// Gating real: tenant_has_feature_for(tenant,'nave_point') en create. El
// pos_id recibido DEBE ser una terminal configurada del tenant.
//
// Terminales (ADR-049): create acepta terminal_id (payment_terminals,
// validado en el servidor con terminal_for_user: negocio, activa, proveedor
// y sucursal del usuario; si viene store_id, esa sucursal). device_id sigue
// funcionando (POS viejos). Si la sucursal o la caja apagaron el medio
// (config_overrides) → payment_method_disabled_in_store.
// =============================================================================
import { buildPaymentRequest, naveApiBase } from "../_shared/nave.ts";
import {
  INTENT_COLS,
  audit,
  authMember,
  cancelIntent,
  cors,
  json,
  loadNaveConnection,
  syncIntent,
  type IntentRow,
} from "../_shared/nave_server.ts";
import { locationOf, methodBlockedAt, resolveTerminal, touchTerminal } from "../_shared/terminals.ts";

// Tiempo para que el cliente pague en la terminal.
const POINT_DURATION_SECONDS = 10 * 60;

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });
  if (req.method !== "POST") return json({ error: "method_not_allowed" }, 405);

  const ctx = await authMember(req);
  if (ctx instanceof Response) return ctx;
  const { admin, tenantId, userId } = ctx;

  let b: Record<string, unknown>;
  try {
    b = await req.json();
  } catch {
    return json({ error: "invalid_json" }, 400);
  }
  const action = String(b.action ?? "");

  const conn = await loadNaveConnection(admin, tenantId);
  if (!conn) return json({ error: "not_connected" }, 400);

  // ── devices: terminales configuradas (sin secretos) ─────────────────────────
  if (action === "devices") {
    return json({ devices: conn.terminals });
  }

  // ── create: intent local + payment_request smart_pos a la terminal ──────────
  if (action === "create") {
    const { data: allowed } = await admin.rpc("tenant_has_feature_for", {
      p_tenant: tenantId,
      p_key: "nave_point",
    });
    if (allowed !== true) return json({ error: "payment_method_not_allowed" }, 403);

    const loc = locationOf(b);
    let deviceId = String(b.device_id ?? "");
    let terminalId: string | null = null;
    let storeId = loc.storeId;
    let registerId = loc.registerId;
    if (b.terminal_id !== undefined && b.terminal_id !== null) {
      const t = await resolveTerminal(admin, {
        tenantId,
        userId: userId,
        terminalId: b.terminal_id,
        providers: ["nave_point"],
        storeId: loc.storeId,
      });
      if (!t.ok) return json({ error: t.error }, 400);
      deviceId = t.terminal.external_id!;
      terminalId = t.terminal.id;
      storeId = t.terminal.store_id;
      registerId = registerId ?? t.terminal.cash_register_id;
    }
    if (!terminalId && !conn.terminals.some((t) => t.id === deviceId)) {
      // Compatibilidad: id suelto, válido si está registrado como terminal del negocio.
      const { data: reg } = await admin
        .from("payment_terminals")
        .select("id")
        .eq("tenant_id", tenantId)
        .eq("provider_key", "nave_point")
        .eq("external_id", deviceId)
        .eq("active", true)
        .is("deleted_at", null)
        .limit(1);
      if (!deviceId || !(reg as unknown[] | null)?.length) {
        return json({ error: "invalid_device" }, 400);
      }
    }
    if (await methodBlockedAt(admin, tenantId, "nave_point", storeId, registerId)) {
      return json({ error: "payment_method_disabled_in_store" }, 403);
    }
    const amount = Math.round(Number(b.amount) * 100) / 100;
    if (!Number.isFinite(amount) || amount <= 0) {
      return json({ error: "invalid_amount" }, 400);
    }

    const { data: intent, error: intErr } = await admin
      .from("mp_payment_intents")
      .insert({
        tenant_id: tenantId,
        amount,
        provider_key: "nave_point",
        point_device_id: deviceId,
        ...(terminalId ? { payment_terminal_id: terminalId } : {}),
      })
      .select("id")
      .single();
    if (intErr || !intent) return json({ error: "intent_failed" }, 500);
    const intentId = (intent as { id: string }).id;

    const fail = async (error: string, detail: string) => {
      await admin.from("mp_payment_intents").update({ status: "rejected" }).eq("id", intentId);
      return json({ error, detail: detail.slice(0, 300) }, 502);
    };

    let r: Response;
    try {
      r = await conn.client.request(
        "POST",
        `${naveApiBase(conn.env, "point")}/integrations/payment_requests/smart_pos`,
        buildPaymentRequest({
          externalPaymentId: intentId,
          posId: deviceId,
          amount,
          title: String(b.title ?? "Venta NinjaPos"),
          durationSeconds: POINT_DURATION_SECONDS,
        }),
      );
    } catch (e) {
      const msg = e instanceof Error ? e.message : "";
      return fail(msg === "nave_auth_failed" ? "nave_auth_failed" : "nave_unreachable", msg);
    }
    // Errores típicos: invalid_pos (pos_id de otro tipo de cobro),
    // api_status_error (medio no operativo).
    if (!r.ok) return fail("nave_error", await r.text());
    const pr = (await r.json().catch(() => null)) as { id?: string } | null;
    if (!pr?.id) return fail("nave_error", "respuesta sin id");

    const { error: upErr } = await admin
      .from("mp_payment_intents")
      .update({ preference_id: pr.id })
      .eq("id", intentId);
    if (upErr) return json({ error: "intent_failed" }, 500);

    await audit(
      admin,
      { id: intentId, tenant_id: tenantId },
      "nave_payment_request_created",
      {
        provider_key: "nave_point",
        payment_request_id: pr.id,
        pos_id: deviceId,
        amount,
        env: conn.env,
      },
      userId,
    );
    await touchTerminal(admin, terminalId);
    return json({ intent_id: intentId, point_intent_id: pr.id });
  }

  // ── status / cancel ─────────────────────────────────────────────────────────
  const intentId = String(b.intent_id ?? "");
  if (!intentId) return json({ error: "invalid_intent" }, 400);
  const { data: row } = await admin
    .from("mp_payment_intents")
    .select(INTENT_COLS)
    .eq("id", intentId)
    .eq("tenant_id", tenantId)
    .eq("provider_key", "nave_point")
    .maybeSingle();
  if (!row) return json({ error: "intent_not_found" }, 404);

  if (action === "status") {
    try {
      const res = await syncIntent(admin, conn, row as IntentRow, "status");
      if ("error" in res) return json(res, 502);
      return json({
        status: res.status,
        mp_payment_id: res.mp_payment_id,
        card_type: res.card_type,
        reason: res.reason ?? null,
      });
    } catch (e) {
      return json({ error: "nave_unreachable", detail: e instanceof Error ? e.message : "" }, 502);
    }
  }

  if (action === "cancel") {
    const status = await cancelIntent(admin, conn, row as IntentRow, userId).catch(() => "pending");
    return json({ ok: true, status });
  }

  return json({ error: "invalid_action" }, 400);
});
