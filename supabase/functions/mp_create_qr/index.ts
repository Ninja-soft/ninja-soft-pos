// =============================================================================
// Edge Function: mp_create_qr — crea una preferencia de Checkout Pro de Mercado
// Pago (link de pago). Lee el Access Token del tenant (payment_secrets,
// service_role), registra un mp_payment_intents y devuelve el init_point.
//
// Desde ADR-032 es el camino "Enviar link" (link compartible por WhatsApp /
// mail) y el respaldo cuando el tenant todavía no configuró su caja QR; el QR
// en el local va por la Orders API (Edge mp_qr). Respeta el switch Sandbox
// (token de prueba) y guarda el ambiente en el intent (mp_env) para que
// mp_webhook consulte el pago con la misma credencial.
// =============================================================================
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.47.10";
import { MP_API, tenantMpCredential } from "../_shared/mpAuth.ts";
import { edgeTimer } from "../_shared/timing.ts";

const cors = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers":
    "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });
  const timer = edgeTimer("mp_create_qr");
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
  const [{ data: { user }, error }, b] = await Promise.all([
    userClient.auth.getUser(),
    req.json().catch(() => null) as Promise<Record<string, unknown> | null>,
  ]);
  timer.mark("auth");
  if (error || !user) return json({ error: "unauthorized" }, 401);
  const tenantId = (user.app_metadata as { current_tenant_id?: string } | null)
    ?.current_tenant_id;
  if (!tenantId) return json({ error: "no_tenant" }, 400);
  if (!b) return json({ error: "invalid_json" }, 400);
  const amount = Number(b.amount);
  if (!Number.isFinite(amount) || amount <= 0) return json({ error: "invalid_amount" }, 400);
  const title = String(b.title ?? "Venta").slice(0, 120);

  const admin = createClient(url, serviceKey, { auth: { persistSession: false } });

  // Miembro activo, plan y credencial en UNA ronda (antes, tres seguidas).
  // Gating de plan (enforcement real): el botón del POS sólo se oculta en la
  // UI; acá se bloquea de verdad. Esta Edge corre con service_role (saltea
  // RLS) y crea el intent ANTES del cobro, así que es el primer punto donde hay
  // que validar el plan del tenant. Sin el feature 'mercado_pago' no se genera
  // el link. (El trigger en `payments` es la red de seguridad de la venta.)
  const [{ data: mem }, { data: mpAllowed }, cred] = await Promise.all([
    admin
      .from("tenant_users")
      .select("role")
      .eq("tenant_id", tenantId)
      .eq("user_id", user.id)
      .eq("status", "active")
      .maybeSingle(),
    admin.rpc("tenant_has_feature_for", { p_tenant: tenantId, p_key: "mercado_pago" }),
    // Access Token del tenant (producción o prueba según el switch Sandbox;
    // refresh OAuth incluido).
    tenantMpCredential(admin, tenantId),
  ]);
  timer.mark("prechecks");
  if (!mem) return json({ error: "forbidden" }, 403);
  if (mpAllowed !== true) return json({ error: "payment_method_not_allowed" }, 403);
  if (!cred) return json({ error: "not_connected" }, 400);

  // Intent (pending) → external_reference. El id se genera acá para crear la
  // preferencia en paralelo con el insert (el webhook llega recién cuando el
  // cliente paga, con el intent ya guardado).
  const intentId = crypto.randomUUID();
  const notificationUrl = `${url}/functions/v1/mp_webhook?intent=${intentId}`;

  const [ins, prefRes] = await Promise.all([
    admin
      .from("mp_payment_intents")
      .insert({ id: intentId, tenant_id: tenantId, amount, provider_key: "mercadopago", mp_env: cred.env }),
    fetch(`${MP_API}/checkout/preferences`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${cred.token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        items: [
          {
            title,
            quantity: 1,
            unit_price: Math.round(amount * 100) / 100,
            currency_id: "ARS",
          },
        ],
        external_reference: intentId,
        notification_url: notificationUrl,
        binary_mode: true,
      }),
    }).catch(() => null),
  ]);
  timer.mark("provider");
  if (ins.error) {
    timer.log({ error: "intent_failed" });
    return json({ error: "intent_failed" }, 500);
  }

  if (!prefRes || !prefRes.ok) {
    const detail = prefRes ? await prefRes.text() : "unreachable";
    await admin
      .from("mp_payment_intents")
      .update({ status: "rejected" })
      .eq("id", intentId);
    timer.log({ error: "mp_error" });
    return json({ error: "mp_error", detail: detail.slice(0, 300) }, 502);
  }
  const pref = (await prefRes.json()) as {
    id: string;
    init_point: string;
    sandbox_init_point?: string;
  };
  // Con credenciales de prueba el checkout válido es el sandbox_init_point.
  const initPoint =
    cred.env === "test"
      ? pref.sandbox_init_point || pref.init_point || ""
      : pref.init_point || pref.sandbox_init_point || "";

  await admin
    .from("mp_payment_intents")
    .update({ preference_id: pref.id, init_point: initPoint })
    .eq("id", intentId);
  timer.mark("save");
  timer.log();

  return json({ intent_id: intentId, init_point: initPoint });
});
