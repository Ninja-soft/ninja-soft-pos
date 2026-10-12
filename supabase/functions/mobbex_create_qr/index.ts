// =============================================================================
// Edge Function: mobbex_create_qr — crea un checkout de Mobbex para cobrar por
// QR. Lee las credenciales del tenant (payment_secrets: api_key + access_token,
// service_role), registra un mp_payment_intents (provider 'mobbex') y devuelve
// la URL del checkout para mostrar como QR.
//
// Body: { amount, title?, customer_id? }. El checkout lleva:
//   * customer {email,name,identification}: del cliente de la venta
//     (customer_id del tenant) o, si falta, el email del cajero + "Consumidor
//     Final" + identificación "0" (Mobbex avisa que sin customer el checkout
//     dejará de crearse).
//   * webhooksType "final": Mobbex no notifica los intentos fallidos mientras
//     el checkout está abierto (el cliente puede reintentar).
//   * SIN installments: el formato de la API son referencias de planes de la
//     cuenta Mobbex del comercio. Las cuotas e intereses que ve el cliente son
//     los configurados en Mobbex; el recargo del plan elegido en el POS ya
//     viene sumado en `amount` (ver ADR-024, addendum 2026-10-11).
// Mobbex responde HTTP 200 también en error ({ result:false, code, error }).
// Lógica pura en _shared/mobbex.ts.
// =============================================================================
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.47.10";
import {
  MOBBEX_API,
  buildCheckoutBody,
  mobbexCustomer,
  parseCheckoutResponse,
} from "../_shared/mobbex.ts";

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

  const { data: mem } = await admin
    .from("tenant_users")
    .select("role")
    .eq("tenant_id", tenantId)
    .eq("user_id", user.id)
    .eq("status", "active")
    .maybeSingle();
  if (!mem) return json({ error: "forbidden" }, 403);

  // Gating de plan (enforcement real): el botón "Cobrar con QR · Mobbex" del POS
  // sólo se oculta en la UI; acá se bloquea de verdad. Esta Edge corre con
  // service_role (saltea RLS) y crea el intent ANTES del cobro. Sin el feature
  // 'mobbex' no se genera el checkout. (El trigger en `payments` es la red de
  // seguridad para el registro de la venta.)
  const { data: mbxAllowed } = await admin.rpc("tenant_has_feature_for", {
    p_tenant: tenantId,
    p_key: "mobbex",
  });
  if (mbxAllowed !== true) return json({ error: "payment_method_not_allowed" }, 403);

  // Credenciales Mobbex del tenant.
  const { data: secretRow } = await admin
    .from("payment_secrets")
    .select("secrets")
    .eq("tenant_id", tenantId)
    .eq("provider_key", "mobbex")
    .maybeSingle();
  const sec = (secretRow?.secrets ?? {}) as { api_key?: string; access_token?: string };
  if (!sec.api_key || !sec.access_token) return json({ error: "not_connected" }, 400);

  // Intent pendiente.
  const { data: intent, error: intErr } = await admin
    .from("mp_payment_intents")
    .insert({ tenant_id: tenantId, amount, provider_key: "mobbex" })
    .select("id")
    .single();
  if (intErr || !intent) return json({ error: "intent_failed" }, 500);

  const webhook = `${url}/functions/v1/mobbex_webhook?intent=${intent.id}`;

  // Cliente de la venta (opcional, siempre del mismo tenant).
  let customerRow: { name: string | null; email: string | null; document_number: string | null } | null =
    null;
  const customerId = String(b.customer_id ?? "");
  if (/^[0-9a-f-]{36}$/i.test(customerId)) {
    const { data: c } = await admin
      .from("customers")
      .select("name, email, document_number")
      .eq("id", customerId)
      .eq("tenant_id", tenantId)
      .is("deleted_at", null)
      .maybeSingle();
    customerRow = c ?? null;
  }

  const body = buildCheckoutBody({
    amount,
    reference: intent.id,
    description: title,
    webhookUrl: webhook,
    customer: mobbexCustomer(customerRow, { email: user.email ?? null }),
  });

  // Crea el checkout en Mobbex.
  let res: Response;
  try {
    res = await fetch(`${MOBBEX_API}/p/checkout`, {
      method: "POST",
      headers: {
        "x-api-key": sec.api_key,
        "x-access-token": sec.access_token,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(body),
    });
  } catch {
    await admin.from("mp_payment_intents").update({ status: "rejected" }).eq("id", intent.id);
    return json({ error: "mobbex_error", detail: "unreachable" }, 502);
  }
  const out = parseCheckoutResponse(res.status, await res.json().catch(() => null));
  if (!out.ok) {
    await admin.from("mp_payment_intents").update({ status: "rejected" }).eq("id", intent.id);
    return json(
      { error: "mobbex_error", code: out.code, detail: `${out.code}: ${out.error}`.slice(0, 300) },
      502,
    );
  }
  if (out.warnings.length) console.warn("[mobbex_create_qr] warnings", out.warnings);
  const initPoint = out.url;

  await admin
    .from("mp_payment_intents")
    .update({ preference_id: out.id, init_point: initPoint })
    .eq("id", intent.id);

  return json({ intent_id: intent.id, init_point: initPoint });
});
