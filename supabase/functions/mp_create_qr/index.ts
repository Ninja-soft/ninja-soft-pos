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
import { MP_API, tenantMpCredential } from "../_shared/mpAuth.ts";
import { bodyStoreId, insertIntentWithScope } from "../_shared/paymentSecrets.ts";
import { edgeTimer } from "../_shared/timing.ts";
import { authenticateTenantUser, requireTenantMember } from "../_shared/tenantAuth.ts";

const cors = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers":
    "authorization, x-client-info, apikey, content-type, x-ninja-scope",
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

  // Auth y body en paralelo (ADR-048, "QR más rápido"). SEC-27: getUser +
  // claim current_tenant_id (401 / 400 no_tenant).
  const [session, b] = await Promise.all([
    authenticateTenantUser(req, { respond: json }),
    req.json().catch(() => null) as Promise<Record<string, unknown> | null>,
  ]);
  timer.mark("auth");
  if (session instanceof Response) return session;
  // Sólo para lanzar las lecturas en paralelo con la membresía: nada se usa
  // si requireTenantMember responde 403.
  const { tenantId, admin } = session;
  if (!b) return json({ error: "invalid_json" }, 400);
  const amount = Number(b.amount);
  if (!Number.isFinite(amount) || amount <= 0) return json({ error: "invalid_amount" }, 400);
  const title = String(b.title ?? "Venta").slice(0, 120);

  // Miembro activo (SEC-27: requireTenantMember), plan y credencial en UNA
  // ronda (antes, tres seguidas).
  // Gating de plan (enforcement real): el botón del POS sólo se oculta en la
  // UI; acá se bloquea de verdad. Esta Edge corre con service_role (saltea
  // RLS) y crea el intent ANTES del cobro, así que es el primer punto donde hay
  // que validar el plan del tenant. Sin el feature 'mercado_pago' no se genera
  // el link. (El trigger en `payments` es la red de seguridad de la venta.)
  const [member, { data: mpAllowed }, cred] = await Promise.all([
    requireTenantMember(session, { respond: json }),
    admin.rpc("tenant_has_feature_for", { p_tenant: tenantId, p_key: "mercado_pago" }),
    // Access Token del tenant (producción o prueba según el switch Sandbox;
    // refresh OAuth incluido). ADR-057: la de la sucursal si tiene una propia.
    tenantMpCredential(admin, tenantId, null, { storeId: bodyStoreId(b) }),
  ]);
  timer.mark("prechecks");
  if (member instanceof Response) return member;
  if (mpAllowed !== true) return json({ error: "payment_method_not_allowed" }, 403);
  if (!cred) return json({ error: "not_connected" }, 400);

  // Intent (pending) → external_reference. El id se genera acá para crear la
  // preferencia en paralelo con el insert (el webhook llega recién cuando el
  // cliente paga, con el intent ya guardado).
  const intentId = crypto.randomUUID();
  const notificationUrl = `${url}/functions/v1/mp_webhook?intent=${intentId}`;

  const [ins, prefRes] = await Promise.all([
    insertIntentWithScope(
      admin,
      { id: intentId, tenant_id: tenantId, amount, provider_key: "mercadopago", mp_env: cred.env },
      cred.scopeStoreId,
    ),
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
