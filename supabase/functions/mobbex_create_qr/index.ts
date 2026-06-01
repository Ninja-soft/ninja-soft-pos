// =============================================================================
// Edge Function: mobbex_create_qr — crea un checkout de Mobbex para cobrar por
// QR. Lee las credenciales del tenant (payment_secrets: api_key + access_token,
// service_role), registra un mp_payment_intents (provider 'mobbex') y devuelve
// la URL del checkout para mostrar como QR.
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

  // Mapeo grid → Mobbex: planes de crédito activos del tenant. Mobbex aplica
  // las cuotas con su interés en el checkout (a diferencia de MP, que solo
  // ajusta el precio). NOTA: validar el formato exacto de `installments` contra
  // la API de Mobbex al probar con credenciales reales.
  const { data: planRows } = await admin
    .from("payment_plans")
    .select("installments, surcharge_pct")
    .eq("tenant_id", tenantId)
    .eq("provider_key", "mobbex")
    .eq("is_active", true)
    .eq("base", "credito");
  const seen = new Set<number>();
  const installments = (planRows ?? [])
    .filter((p) => {
      const n = Number(p.installments) || 1;
      if (n <= 1 || seen.has(n)) return false;
      seen.add(n);
      return true;
    })
    .map((p) => ({
      months: Number(p.installments),
      recharge: Number(p.surcharge_pct) || 0,
    }))
    .sort((a, b) => a.months - b.months);

  const body: Record<string, unknown> = {
    total: Math.round(amount * 100) / 100,
    currency: "ARS",
    reference: intent.id,
    description: title,
    webhook,
    return_url: webhook,
  };
  if (installments.length > 0) {
    body.installments = { enabled: true, list: installments };
  }

  // Crea el checkout en Mobbex.
  const res = await fetch("https://api.mobbex.com/p/checkout", {
    method: "POST",
    headers: {
      "x-api-key": sec.api_key,
      "x-access-token": sec.access_token,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(body),
  });

  if (!res.ok) {
    const detail = await res.text();
    await admin.from("mp_payment_intents").update({ status: "rejected" }).eq("id", intent.id);
    return json({ error: "mobbex_error", detail: detail.slice(0, 300) }, 502);
  }
  const out = (await res.json()) as { data?: { id?: string; url?: string } };
  const initPoint = out.data?.url ?? "";
  if (!initPoint) {
    await admin.from("mp_payment_intents").update({ status: "rejected" }).eq("id", intent.id);
    return json({ error: "mobbex_no_url" }, 502);
  }

  await admin
    .from("mp_payment_intents")
    .update({ preference_id: out.data?.id ?? null, init_point: initPoint })
    .eq("id", intent.id);

  return json({ intent_id: intent.id, init_point: initPoint });
});
