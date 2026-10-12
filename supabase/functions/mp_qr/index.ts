// =============================================================================
// Edge Function: mp_qr — QR dinámico de Mercado Pago en el local sobre la
// Orders API (ADR-032). El cliente escanea con la app de MP (o cualquier
// billetera interoperable) el qr_data que el POS dibuja localmente.
//
// Actions (body.action):
//   * geocode {street_name?, street_number?, city_name?, state_name?}
//            (owner/manager) "QR en el mostrador": sin dirección, arma el
//            borrador con los datos del negocio (tenants.name,
//            tenant_branding.address o la del local por defecto) y lo ubica en
//            el mapa (Nominatim, _shared/geocode.ts). Con dirección, ubica esa.
//            Cachea el último resultado en config.mp_qr_geo. Siempre 200:
//            {draft?, place|null, geocode_error?}.
//   * setup  {name, street_name, street_number, city_name, state_name,
//             latitude?, longitude? | coordinates?, reference?}
//            (owner/manager, alta única). Sin coordenadas, geocodifica la
//            dirección (geocode_not_found / geocode_unavailable si no puede).
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
//
// Caja QR por caja (ADR-049, payment_terminals kind 'qr_caja'):
//   * setup {..., cash_register_id} crea (o reutiliza) una sucursal de MP por
//     sucursal y una caja de MP por caja, y la registra como terminal default
//     de esa caja. Sin cash_register_id: la caja única de siempre (se guarda
//     en config.mp_qr y además como terminal flotante de la sucursal
//     principal).
//   * reset {cash_register_id?} olvida la caja de esa caja (o la única).
//   * create {terminal_id?, store_id?, register_id?}: con terminal_id usa esa
//     caja QR (validada en el servidor: negocio, activa, sucursal del usuario
//     y mismo ambiente). Sin terminal_id, la caja única de config.mp_qr (POS
//     viejos). Medio apagado en la sucursal o la caja →
//     payment_method_disabled_in_store.
// =============================================================================
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.47.10";
import { MP_API, mpHeaders, tenantMpCredential } from "../_shared/mpAuth.ts";
import { bodyStoreId, insertIntentWithScope, intentSecretScope } from "../_shared/paymentSecrets.ts";
import {
  applyOrderToIntent,
  fetchOrder,
  ORDER_INTENT_COLUMNS,
  type OrderIntentRow,
} from "../_shared/mpIntents.ts";
import { geocodeAr } from "../_shared/geocode.ts";
import { edgeTimer } from "../_shared/timing.ts";
import {
  buildGeocodeQuery,
  buildPosBody,
  buildQrOrderBody,
  buildStoreBody,
  type GeoPick,
  type MpEnv,
  mpCityName,
  mpExternalIds,
  mpExternalIdsFor,
  mpStoreErrorField,
  parseBusinessAddress,
  parseStoreAddress,
  parseStoreSetup,
  type StoreAddress,
} from "../_shared/mpOrders.ts";
import { isUuid, locationOf, methodBlockedAt, resolveTerminal, touchTerminal } from "../_shared/terminals.ts";

const cors = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

type QrPos = {
  user_id: string;
  store_id: string;
  pos_id: string;
  external_pos_id: string;
  store_name: string;
  address: string;
  created_at: string;
};

// Último resultado de geocodificación (por texto de búsqueda).
type GeoCache = { q: string; place: GeoPick; at: string };

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });
  const timer = edgeTimer("mp_qr");
  const json = (b: unknown, s = 200) =>
    new Response(JSON.stringify(b), {
      status: s,
      headers: { ...cors, ...timer.headers(), "Content-Type": "application/json" },
    });
  if (req.method !== "POST") return json({ error: "method_not_allowed" }, 405);

  const url = Deno.env.get("SUPABASE_URL")!;
  const serviceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
  const anonKey = Deno.env.get("SUPABASE_ANON_KEY")!;

  const userClient = createClient(url, anonKey, {
    global: { headers: { Authorization: req.headers.get("Authorization") ?? "" } },
    auth: { persistSession: false },
  });
  // Auth y body en paralelo (ADR-048, "QR más rápido").
  const [{ data: { user }, error }, body] = await Promise.all([
    userClient.auth.getUser(),
    req.json().catch(() => null) as Promise<Record<string, unknown> | null>,
  ]);
  timer.mark("auth");
  if (error || !user) return json({ error: "unauthorized" }, 401);
  const tenantId = (user.app_metadata as { current_tenant_id?: string } | null)
    ?.current_tenant_id;
  if (!tenantId) return json({ error: "no_tenant" }, 400);

  if (!body) return json({ error: "invalid_json" }, 400);
  const b: Record<string, unknown> = body;
  const action = String(b.action ?? "");
  if (!["geocode", "setup", "reset", "create", "status", "cancel"].includes(action)) {
    return json({ error: "invalid_action" }, 400);
  }

  const admin = createClient(url, serviceKey, { auth: { persistSession: false } });

  // create: membresía, plan, credencial y config de la caja QR en UNA ronda
  // (antes eran cuatro consultas seguidas antes de llamar a Mercado Pago).
  const featureOk = () =>
    admin
      .rpc("tenant_has_feature_for", { p_tenant: tenantId, p_key: "mercado_pago" })
      .then((r: { data: unknown }) => r.data === true);
  const isCreate = action === "create";
  const [{ data: mem }, createFeature, createCred, createConfig] = await Promise.all([
    admin
      .from("tenant_users")
      .select("role")
      .eq("tenant_id", tenantId)
      .eq("user_id", user.id)
      .eq("status", "active")
      .maybeSingle(),
    isCreate ? featureOk() : Promise.resolve(false),
    // ADR-057: credencial de la sucursal del POS (si tiene una propia).
    isCreate ? tenantMpCredential(admin, tenantId, null, { storeId: bodyStoreId(b) }) : Promise.resolve(null),
    isCreate
      ? admin
          .from("tenant_payment_methods")
          .select("config")
          .eq("tenant_id", tenantId)
          .eq("provider_key", "mercadopago")
          .maybeSingle()
          .then((r: { data: { config?: unknown } | null }) => (r.data?.config ?? {}) as Record<string, unknown>)
      : Promise.resolve({} as Record<string, unknown>),
  ]);
  timer.mark("prechecks");
  if (!mem) return json({ error: "forbidden" }, 403);
  const canManage = mem.role === "owner" || mem.role === "manager";

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
  // Caja QR registrada como terminal (ADR-049). Reutiliza la fila si ya
  // existe con el mismo id externo y ambiente.
  const upsertQrTerminal = async (
    env: MpEnv,
    value: QrPos,
    where: { storeId: string; registerId: string | null; label: string },
  ) => {
    const { data: found } = await admin
      .from("payment_terminals")
      .select("id")
      .eq("tenant_id", tenantId)
      .eq("provider_key", "mercadopago")
      .eq("environment", env)
      .eq("external_id", value.external_pos_id)
      .is("deleted_at", null)
      .limit(1);
    const row = {
      tenant_id: tenantId,
      store_id: where.storeId,
      cash_register_id: where.registerId,
      provider_key: "mercadopago",
      kind: "qr_caja",
      external_id: value.external_pos_id,
      external_meta: value,
      environment: env,
      label: where.label.slice(0, 60),
      is_default: Boolean(where.registerId),
      active: true,
    };
    const id = (found as { id: string }[] | null)?.[0]?.id;
    if (id) await admin.from("payment_terminals").update(row).eq("id", id);
    else await admin.from("payment_terminals").insert({ ...row, created_by: user.id });
  };
  const defaultStoreId = async (): Promise<string | null> => {
    const { data } = await admin
      .from("stores")
      .select("id")
      .eq("tenant_id", tenantId)
      .is("deleted_at", null)
      .order("is_default", { ascending: false })
      .order("created_at")
      .limit(1);
    return (data as { id: string }[] | null)?.[0]?.id ?? null;
  };
  // Caja del negocio (para setup / reset por caja).
  const loadRegister = async (id: unknown) => {
    if (!isUuid(id)) return null;
    const { data } = await admin
      .from("cash_registers")
      .select("id, store_id, name")
      .eq("id", id)
      .eq("tenant_id", tenantId)
      .is("deleted_at", null)
      .maybeSingle();
    return (data as { id: string; store_id: string; name: string } | null) ?? null;
  };

  // Geocodifica con cache en config.mp_qr_geo (sólo si la fila ya existe).
  const locate = async (
    addr: StoreAddress,
  ): Promise<{ ok: true; place: GeoPick | null } | { ok: false; error: "geocode_unavailable" }> => {
    const q = buildGeocodeQuery(addr);
    if (!q) return { ok: true, place: null };
    const config = await readConfig();
    const cached = config.mp_qr_geo as GeoCache | undefined;
    if (cached?.q === q && cached.place) return { ok: true, place: cached.place };
    const res = await geocodeAr(q, addr.state_name || undefined);
    if (res.ok && res.place) {
      const geo: GeoCache = { q, place: res.place, at: new Date().toISOString() };
      await admin
        .from("tenant_payment_methods")
        .update({ config: { ...config, mp_qr_geo: geo } })
        .eq("tenant_id", tenantId)
        .eq("provider_key", "mercadopago");
    }
    return res;
  };
  const strField = (k: string) => (typeof b[k] === "string" ? (b[k] as string).trim() : "");

  const audit = (act: string, entityId: string | null, after: Record<string, unknown>) =>
    admin.from("audit_logs").insert({
      tenant_id: tenantId,
      actor_user_id: user.id,
      entity_type: entityId ? "mp_payment_intents" : "tenant_payment_methods",
      entity_id: entityId,
      action: act,
      after_data: after,
    });

  // ── geocode: borrador con los datos del negocio + ubicación en el mapa ────
  if (action === "geocode") {
    if (!canManage) return json({ error: "forbidden" }, 403);
    if (!(await featureOk())) return json({ error: "payment_method_not_allowed" }, 403);
    let draft: (StoreAddress & { name: string }) | undefined;
    let addr: StoreAddress;
    if (strField("street_name")) {
      addr = {
        street_name: strField("street_name").slice(0, 100),
        street_number: strField("street_number").slice(0, 20),
        city_name: strField("city_name").slice(0, 80),
        state_name: strField("state_name").slice(0, 60),
      };
    } else {
      const [{ data: t }, { data: br }, { data: st }] = await Promise.all([
        admin.from("tenants").select("name").eq("id", tenantId).maybeSingle(),
        admin
          .from("tenant_branding")
          .select("address, legal_name")
          .eq("tenant_id", tenantId)
          .maybeSingle(),
        admin
          .from("stores")
          .select("address")
          .eq("tenant_id", tenantId)
          .is("deleted_at", null)
          .order("is_default", { ascending: false })
          .limit(1)
          .maybeSingle(),
      ]);
      addr = parseBusinessAddress(
        (br?.address as string | null) || (st?.address as string | null) || "",
      );
      draft = {
        name: String(t?.name || br?.legal_name || "").slice(0, 60),
        ...addr,
      };
    }
    const res = await locate(addr);
    const place = res.ok ? res.place : null;
    if (draft && place) {
      // Completa lo que el texto libre no traía (provincia, localidad o barrio).
      draft.state_name = draft.state_name || place.state_name;
      draft.city_name = mpCityName(draft.city_name, draft.state_name, place.city_name);
    }
    return json({
      ...(draft ? { draft } : {}),
      place,
      ...(res.ok ? {} : { geocode_error: res.error }),
    });
  }

  // ── setup: sucursal + caja en MP (una vez por ambiente) ────────────────────
  if (action === "setup" || action === "reset") {
    if (!canManage) return json({ error: "forbidden" }, 403);
    if (!(await featureOk())) return json({ error: "payment_method_not_allowed" }, 403);

    const perRegister = b.cash_register_id !== undefined && b.cash_register_id !== null;
    const register = perRegister ? await loadRegister(b.cash_register_id) : null;
    if (perRegister && !register) return json({ error: "invalid_register" }, 400);
    // ADR-057: la caja QR se crea en la cuenta de MP de la sucursal de la caja
    // (o la pedida), si tiene una propia; si no, en la del negocio.
    const cred = await tenantMpCredential(admin, tenantId, null, {
      storeId: register?.store_id ?? bodyStoreId(b),
    });
    if (!cred) return json({ error: "not_connected" }, 400);

    if (action === "reset") {
      if (register) {
        await admin
          .from("payment_terminals")
          .update({ deleted_at: new Date().toISOString(), is_default: false })
          .eq("tenant_id", tenantId)
          .eq("provider_key", "mercadopago")
          .eq("kind", "qr_caja")
          .eq("environment", cred.env)
          .eq("cash_register_id", register.id)
          .is("deleted_at", null);
      } else {
        await writeQrPos(cred.env, null);
      }
      await audit("mp_qr_pos_reset", null, {
        provider_key: "mercadopago",
        env: cred.env,
        cash_register_id: register?.id ?? null,
      });
      return json({ ok: true });
    }

    const addr = parseStoreAddress(b);
    if (!addr.ok) return json({ error: "invalid_store", field: addr.field }, 400);
    const input: Record<string, unknown> = { ...addr.value };
    const hasLatLon = typeof b.latitude === "number" && typeof b.longitude === "number";
    if (hasLatLon) {
      input.latitude = b.latitude;
      input.longitude = b.longitude;
    } else if (strField("coordinates")) {
      input.coordinates = strField("coordinates");
    }
    // Sin coordenadas (o en Capital sin barrio): las completa el mapa.
    if ((!hasLatLon && !input.coordinates) || !addr.value.city_name) {
      const geo = await locate(addr.value);
      if (!geo.ok) return json({ error: geo.error }, 502);
      if (!geo.place) return json({ error: "geocode_not_found" }, 400);
      if (!hasLatLon && !input.coordinates) {
        input.latitude = geo.place.lat;
        input.longitude = geo.place.lon;
      }
      input.city_name = mpCityName(addr.value.city_name, addr.value.state_name, geo.place.city_name);
    }
    const parsed = parseStoreSetup(input);
    if (!parsed.ok) return json({ error: "invalid_store", field: parsed.field }, 400);
    const ids = register
      ? mpExternalIdsFor(tenantId, register.store_id, register.id)
      : mpExternalIds(tenantId);
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
        const detail = (await st.text()).slice(0, 300);
        return json(
          { error: "mp_store_error", field: mpStoreErrorField(detail), detail },
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
        body: JSON.stringify(buildPosBody(storeId, ids, register ? `Caja ${register.name}` : undefined)),
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
    if (register) {
      await upsertQrTerminal(cred.env, value, {
        storeId: register.store_id,
        registerId: register.id,
        label: `Caja QR MP · ${register.name}`,
      });
    } else {
      await writeQrPos(cred.env, value);
      const st = await defaultStoreId();
      if (st) await upsertQrTerminal(cred.env, value, { storeId: st, registerId: null, label: "Caja QR Mercado Pago" });
    }
    await audit("mp_qr_pos_setup", null, {
      cash_register_id: register?.id ?? null,
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
    if (!createFeature) return json({ error: "payment_method_not_allowed" }, 403);
    const amount = Number(b.amount);
    if (!Number.isFinite(amount) || amount <= 0) return json({ error: "invalid_amount" }, 400);
    const title = String(b.title ?? "Venta NinjaPos");

    let cred = createCred;
    if (!cred) return json({ error: "not_connected" }, 400);
    // F17 · ADR-049: caja QR registrada de esta caja (terminal_id, validada en
    // el servidor) o la caja única de config.mp_qr (POS viejos).
    const loc = locationOf(b);
    let externalPosId = "";
    let terminalId: string | null = null;
    let storeId = loc.storeId;
    let registerId = loc.registerId;
    if (b.terminal_id !== undefined && b.terminal_id !== null) {
      const t = await resolveTerminal(admin, {
        tenantId,
        userId: user.id,
        terminalId: b.terminal_id,
        providers: ["mercadopago"],
        storeId: loc.storeId,
      });
      if (!t.ok) return json({ error: t.error }, 400);
      if (t.terminal.kind !== "qr_caja") return json({ error: "terminal_provider_mismatch" }, 400);
      // La terminal manda: si es de otra sucursal que la del body, se vuelve a
      // resolver la credencial con la suya (ADR-057).
      if (t.terminal.store_id !== loc.storeId) {
        cred = await tenantMpCredential(admin, tenantId, null, { storeId: t.terminal.store_id });
        if (!cred) return json({ error: "not_connected" }, 400);
      }
      if ((t.terminal.environment ?? cred.env) !== cred.env) return json({ error: "terminal_env_mismatch" }, 400);
      externalPosId = t.terminal.external_id!;
      terminalId = t.terminal.id;
      storeId = t.terminal.store_id;
      registerId = registerId ?? t.terminal.cash_register_id;
    } else {
      const pos = ((createConfig.mp_qr as Record<string, QrPos | undefined>) ?? {})[cred.env];
      if (!pos?.external_pos_id) return json({ error: "qr_pos_not_configured" }, 400);
      externalPosId = pos.external_pos_id;
    }
    if (await methodBlockedAt(admin, tenantId, "mercadopago", storeId, registerId)) {
      return json({ error: "payment_method_disabled_in_store" }, 403);
    }

    // El id del intent se genera acá: el insert y la order en Mercado Pago
    // corren en paralelo (la order lleva el id como external_reference e
    // idempotency key; el webhook la encuentra por mp_order_id, que se guarda
    // antes de responder).
    const intentId = crypto.randomUUID();
    const [ins, r] = await Promise.all([
      insertIntentWithScope(
        admin,
        {
          id: intentId,
          tenant_id: tenantId,
          amount,
          provider_key: "mercadopago",
          mp_env: cred.env,
          ...(terminalId ? { payment_terminal_id: terminalId } : {}),
        },
        cred.scopeStoreId,
      ),
      fetch(`${MP_API}/v1/orders`, {
        method: "POST",
        headers: mpHeaders(cred.token, intentId),
        body: JSON.stringify(
          buildQrOrderBody({
            intentId,
            amount,
            externalPosId,
            title,
          }),
        ),
      }).catch(() => null),
    ]);
    timer.mark("provider");
    if (ins.error) {
      // Sin intent no hay conciliación posible: se da de baja la order.
      const created = r && r.ok ? ((await r.json().catch(() => null)) as { id?: string } | null) : null;
      if (created?.id) {
        await fetch(`${MP_API}/v1/orders/${encodeURIComponent(created.id)}/cancel`, {
          method: "POST",
          headers: mpHeaders(cred.token, `${intentId}-cancel`),
        }).catch(() => null);
      }
      timer.log({ action, error: "intent_failed" });
      return json({ error: "intent_failed" }, 500);
    }
    if (!r || !r.ok) {
      const detail = r ? (await r.text()).slice(0, 300) : "unreachable";
      await admin.from("mp_payment_intents").update({ status: "rejected" }).eq("id", intentId);
      const code = r && r.status === 404 && detail.includes("pos_not_found") ? "qr_pos_not_found" : "mp_error";
      timer.log({ action, error: code });
      return json({ error: code, detail }, 502);
    }
    const order = (await r.json()) as { id?: string; type_response?: { qr_data?: string } };
    const qrData = order.type_response?.qr_data ?? "";
    if (!order.id || !qrData) {
      await admin.from("mp_payment_intents").update({ status: "rejected" }).eq("id", intentId);
      return json({ error: "mp_error", detail: "no_qr_data" }, 502);
    }
    await admin
      .from("mp_payment_intents")
      .update({ mp_order_id: order.id, init_point: qrData })
      .eq("id", intentId);
    timer.mark("save");
    await touchTerminal(admin, terminalId);
    timer.log({ action });
    return json({ intent_id: intentId, order_id: order.id, qr_data: qrData });
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
  const cred = await tenantMpCredential(admin, tenantId, row.mp_env ?? "prod", {
    scopeStoreId: await intentSecretScope(admin, row.id),
  });
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
