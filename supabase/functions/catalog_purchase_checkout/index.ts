// =============================================================================
// Edge Function: catalog_purchase_checkout — crea una preferencia de Checkout
// Pro (pago ÚNICO) de Mercado Pago con la cuenta de NinjaSoft para que un tenant
// COMPRE un catálogo de Tiendita. A diferencia de la suscripción (preapproval
// recurrente), esto es un cobro único por el price_ars del catálogo.
//
// Quién puede invocarla:
//   • El DUEÑO del tenant (self-service): usa SIEMPRE su current_tenant_id y se
//     verifica que sea owner activo. Paga la compra desde la sección Tiendita.
//   • Staff interno: puede pasar tenant_id en el body (comprar a nombre de un
//     tenant desde herramientas internas).
//
// El cobro lo recibe NinjaSoft (platform_secrets.mercadopago.access_token). Se
// registra un catalog_payment_intents (pending) cuyo id viaja como
// external_reference y en el notification_url, para que el webhook acredite el
// pago de forma idempotente.
//
// verify_jwt = true (se setea al desplegar).
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

type PgError = {
  message?: string;
  details?: string;
  hint?: string;
  code?: string;
} | null;

// Loguea el detalle real (incl. error de PostgREST) y devuelve un `error` estable.
const fail = (error: string, status: number, detail?: unknown) => {
  console.error(`[catalog_purchase_checkout] ${error}`, detail ?? "");
  return json({ error }, status);
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
    error: authError,
  } = await userClient.auth.getUser();
  if (authError || !user) return fail("unauthorized", 401, authError?.message);

  const meta = (user.app_metadata ?? {}) as {
    is_internal?: boolean;
    current_tenant_id?: string;
  };
  const isInternal = meta.is_internal === true;

  let b: Record<string, unknown>;
  try {
    b = await req.json();
  } catch {
    return fail("invalid_json", 400);
  }
  const catalogId = String(b.catalog_id ?? "").trim();
  if (!catalogId) return fail("missing_catalog", 400);
  const backUrl = String(b.back_url ?? "").trim();

  // Tenant: staff puede pasar tenant_id; el dueño usa SIEMPRE su current_tenant_id.
  const tenantId = isInternal
    ? String(b.tenant_id ?? meta.current_tenant_id ?? "").trim()
    : String(meta.current_tenant_id ?? "").trim();
  if (!tenantId) return fail("missing_tenant", 400, { isInternal });

  const admin = createClient(url, serviceKey, { auth: { persistSession: false } });

  // Autorización del path dueño: owner activo del tenant.
  if (!isInternal) {
    const { data: mem, error: memErr } = await admin
      .from("tenant_users")
      .select("role")
      .eq("tenant_id", tenantId)
      .eq("user_id", user.id)
      .eq("status", "active")
      .maybeSingle();
    if (memErr) return fail("membership_lookup_failed", 400, memErr as PgError);
    if (!mem || mem.role !== "owner") {
      return fail("forbidden", 403, { role: mem?.role ?? null });
    }
  }

  // Catálogo: tiene que existir, estar activo y tener precio > 0 (los gratis se
  // bonifican desde internal, no se compran).
  const { data: cat, error: catErr } = await admin
    .from("catalogs")
    .select("id, name, price_ars, is_active")
    .eq("id", catalogId)
    .maybeSingle();
  if (catErr) return fail("catalog_lookup_failed", 400, catErr as PgError);
  if (!cat || cat.is_active !== true) return fail("catalog_unavailable", 400);
  const amount = Number(cat.price_ars);
  if (!Number.isFinite(amount) || amount <= 0) {
    return fail("invalid_catalog_price", 400, { amount });
  }

  // ¿Ya lo tiene? (compra previa o grant) → no recrear cobro.
  const { data: owned } = await admin
    .from("tenant_catalog_purchases")
    .select("id")
    .eq("tenant_id", tenantId)
    .eq("catalog_id", catalogId)
    .maybeSingle();
  if (owned) return json({ error: "already_owned" }, 409);

  // Access Token de la cuenta de NinjaSoft (cobra la plataforma).
  const { data: plat, error: platErr } = await admin
    .from("platform_secrets")
    .select("secrets")
    .eq("key", "mercadopago")
    .maybeSingle();
  if (platErr) return fail("platform_lookup_failed", 400, platErr as PgError);
  const accessToken = (plat?.secrets as { access_token?: string } | null)
    ?.access_token;
  // Honestidad: sin el access_token de MP de NinjaSoft no se puede cobrar.
  if (!accessToken) return fail("platform_not_configured", 400);

  // Intent (pending) → external_reference + notification_url.
  const { data: intent, error: intErr } = await admin
    .from("catalog_payment_intents")
    .insert({ tenant_id: tenantId, catalog_id: catalogId, amount })
    .select("id")
    .single();
  if (intErr || !intent) return fail("intent_failed", 500, intErr as PgError);

  const notificationUrl = `${url}/functions/v1/catalog_purchase_webhook?intent=${intent.id}`;

  const prefRes = await fetch("https://api.mercadopago.com/checkout/preferences", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${accessToken}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      items: [
        {
          title: `Catálogo ${cat.name}`.slice(0, 120),
          quantity: 1,
          unit_price: Math.round(amount * 100) / 100,
          currency_id: "ARS",
        },
      ],
      external_reference: intent.id,
      notification_url: notificationUrl,
      back_urls: backUrl ? { success: backUrl, pending: backUrl, failure: backUrl } : undefined,
      auto_return: backUrl ? "approved" : undefined,
      binary_mode: true,
      metadata: { kind: "catalog_purchase", catalog_id: catalogId, tenant_id: tenantId },
    }),
  });

  if (!prefRes.ok) {
    const detail = await prefRes.text();
    console.error("[catalog_purchase_checkout] mp_error", detail.slice(0, 400));
    await admin
      .from("catalog_payment_intents")
      .update({ status: "rejected" })
      .eq("id", intent.id);
    return json({ error: "mp_error", detail: detail.slice(0, 300) }, 502);
  }
  const pref = (await prefRes.json()) as {
    id: string;
    init_point?: string;
    sandbox_init_point?: string;
  };
  const initPoint = pref.init_point || pref.sandbox_init_point || "";

  await admin
    .from("catalog_payment_intents")
    .update({ mp_preference_id: pref.id, init_point: initPoint })
    .eq("id", intent.id);

  await admin.from("audit_logs").insert({
    tenant_id: tenantId,
    actor_user_id: user.id,
    entity_type: "catalog_payment_intents",
    entity_id: intent.id,
    action: "catalog_checkout_created",
    after_data: {
      catalog_id: catalogId,
      preference_id: pref.id,
      amount,
      via: isInternal ? "staff" : "owner",
    },
  });

  return json({ intent_id: intent.id, init_point: initPoint });
});
