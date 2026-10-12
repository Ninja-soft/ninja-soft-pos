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
  const amount = Number(b.amount);
  if (!Number.isFinite(amount) || amount <= 0) return json({ error: "invalid_amount" }, 400);
  const title = String(b.title ?? "Venta").slice(0, 120);

  const admin = createClient(url, serviceKey, { auth: { persistSession: false } });

  // Miembro activo del tenant.
  const { data: mem } = await admin
    .from("tenant_users")
    .select("role")
    .eq("tenant_id", tenantId)
    .eq("user_id", user.id)
    .eq("status", "active")
    .maybeSingle();
  if (!mem) return json({ error: "forbidden" }, 403);

  // Gating de plan (enforcement real): el botón del POS sólo se oculta en la
  // UI; acá se bloquea de verdad. Esta Edge corre con service_role (saltea
  // RLS) y crea el intent ANTES del cobro, así que es el primer punto donde hay
  // que validar el plan del tenant. Sin el feature 'mercado_pago' no se genera
  // el link. (El trigger en `payments` es la red de seguridad de la venta.)
  const { data: mpAllowed } = await admin.rpc("tenant_has_feature_for", {
    p_tenant: tenantId,
    p_key: "mercado_pago",
  });
  if (mpAllowed !== true) return json({ error: "payment_method_not_allowed" }, 403);

  // Access Token del tenant (producción o prueba según el switch Sandbox;
  // refresh OAuth incluido).
  const cred = await tenantMpCredential(admin, tenantId);
  if (!cred) return json({ error: "not_connected" }, 400);

  // Intent (pending) → external_reference.
  const { data: intent, error: intErr } = await admin
    .from("mp_payment_intents")
    .insert({ tenant_id: tenantId, amount, provider_key: "mercadopago", mp_env: cred.env })
    .select("id")
    .single();
  if (intErr || !intent) return json({ error: "intent_failed" }, 500);

  const notificationUrl = `${url}/functions/v1/mp_webhook?intent=${intent.id}`;

  const prefRes = await fetch(`${MP_API}/checkout/preferences`, {
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
      external_reference: intent.id,
      notification_url: notificationUrl,
      binary_mode: true,
    }),
  });

  if (!prefRes.ok) {
    const detail = await prefRes.text();
    await admin
      .from("mp_payment_intents")
      .update({ status: "rejected" })
      .eq("id", intent.id);
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
    .eq("id", intent.id);

  return json({ intent_id: intent.id, init_point: initPoint });
});
