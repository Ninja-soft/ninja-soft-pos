// =============================================================================
// Edge Function: pagos360 — links de pago / cobranzas (F8 · H21).
// Crea una solicitud de pago (payment_request) en Pagos360 y devuelve su
// checkout hosted (checkout_url) que el POS muestra como QR + "Abrir link de
// pago". Sin webhook obligatorio: el POS sondea `status`, que sincroniza el
// estado contra la API de Pagos360 (patrón mp_point) y sólo acredita con
// state=paid y monto exacto (conservador: nunca se registra venta sin esa
// confirmación). Los cobros en espera (ADR-048) los sincroniza además el cron
// pending_charges_sync con la misma lógica (_shared/pagos360_server.ts).
//
// Actions (body.action):
//   * create {amount, title?} → intent local (mp_payment_intents,
//     provider_key='pagos360'; habilita el gating fino del trigger de payments
//     para method='qr') + payment_request en Pagos360. preference_id guarda el
//     id de Pagos360; init_point, el checkout_url.
//   * status {intent_id}      → GET payment-request/{id} y sincroniza:
//     paid (+ monto ok) → approved · expired/canceled/reverted → cancelled.
//
// Sandbox: si tenant_payment_methods.sandbox=true para pagos360, se usa
// https://api.sandbox.pagos360.com (permite probar el flujo completo con la
// API key de sandbox, sin plata real).
//
// Latencia (ADR-048): auth y body en paralelo, membresía + conexión + plan en
// una sola ronda, y el id del intent se genera acá para crear la solicitud en
// Pagos360 en paralelo con el insert del intent. Tiempos por etapa en el log y
// en Server-Timing.
//
// Gating real de plan: tenant_has_feature_for(tenant,'pagos360') en create.
// =============================================================================
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.47.10";
import { loadPagos360, syncPagos360Intent } from "../_shared/pagos360_server.ts";
import { edgeTimer } from "../_shared/timing.ts";

const cors = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers":
    "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

// Fecha DD-MM-YYYY en hora argentina (primer vencimiento del link). Mañana:
// evita el borde de medianoche AR vs UTC para un cobro de mostrador.
function firstDueDateAr(): string {
  const now = new Date(Date.now() + 24 * 60 * 60 * 1000);
  const ar = new Intl.DateTimeFormat("es-AR", {
    timeZone: "America/Argentina/Buenos_Aires",
    day: "2-digit",
    month: "2-digit",
    year: "numeric",
  }).formatToParts(now);
  const get = (t: string) => ar.find((p) => p.type === t)?.value ?? "";
  return `${get("day")}-${get("month")}-${get("year")}`;
}

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });
  const timer = edgeTimer("pagos360");
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
  const action = String(b.action ?? "");

  const admin = createClient(url, serviceKey, { auth: { persistSession: false } });

  // Una sola ronda: membresía, conexión (API key + ambiente) y plan.
  const [{ data: mem }, conn, allowed] = await Promise.all([
    admin
      .from("tenant_users")
      .select("role")
      .eq("tenant_id", tenantId)
      .eq("user_id", user.id)
      .eq("status", "active")
      .maybeSingle(),
    loadPagos360(admin, tenantId),
    action === "create"
      ? admin
          .rpc("tenant_has_feature_for", { p_tenant: tenantId, p_key: "pagos360" })
          .then((r: { data: unknown }) => r.data === true)
      : Promise.resolve(true),
  ]);
  timer.mark("prechecks");
  if (!mem) return json({ error: "forbidden" }, 403);
  if (!conn) return json({ error: "not_connected" }, 400);

  // ── create: intent local + payment_request en Pagos360 ──────────────────────
  if (action === "create") {
    if (!allowed) return json({ error: "payment_method_not_allowed" }, 403);

    const amount = Number(b.amount);
    if (!Number.isFinite(amount) || amount <= 0) {
      return json({ error: "invalid_amount" }, 400);
    }
    const title = String(b.title ?? "Venta NinjaPos").slice(0, 120);

    // El id se genera acá: el insert del intent y la solicitud en Pagos360
    // corren en paralelo (external_reference = intent).
    const intentId = crypto.randomUUID();
    const [ins, r] = await Promise.all([
      admin
        .from("mp_payment_intents")
        .insert({ id: intentId, tenant_id: tenantId, amount, provider_key: "pagos360" }),
      fetch(`${conn.base}/payment-request`, {
        method: "POST",
        headers: conn.headers,
        body: JSON.stringify({
          payment_request: {
            description: title,
            first_due_date: firstDueDateAr(),
            first_total: Math.round(amount * 100) / 100,
            payer_name: "Consumidor final",
            external_reference: intentId,
          },
        }),
      }).catch(() => null),
    ]);
    timer.mark("provider");
    if (ins.error) {
      timer.log({ action, error: "intent_failed" });
      return json({ error: "intent_failed" }, 500);
    }
    if (!r || !r.ok) {
      const detail = r ? await r.text() : "unreachable";
      await admin
        .from("mp_payment_intents")
        .update({ status: "rejected" })
        .eq("id", intentId);
      timer.log({ action, error: "pagos360_error" });
      return json({ error: "pagos360_error", detail: detail.slice(0, 300) }, 502);
    }
    const pr = (await r.json()) as {
      id: number | string;
      checkout_url?: string;
      form_url?: string;
    };
    const initPoint = pr.checkout_url || pr.form_url || "";
    if (!initPoint) {
      await admin
        .from("mp_payment_intents")
        .update({ status: "rejected" })
        .eq("id", intentId);
      return json({ error: "pagos360_error", detail: "sin checkout_url" }, 502);
    }
    await admin
      .from("mp_payment_intents")
      .update({ preference_id: String(pr.id), init_point: initPoint })
      .eq("id", intentId);
    timer.mark("save");
    timer.log({ action });
    return json({ intent_id: intentId, init_point: initPoint });
  }

  // ── status: sincroniza contra Pagos360 y devuelve el estado local ───────────
  if (action === "status") {
    const intentId = String(b.intent_id ?? "");
    if (!intentId) return json({ error: "invalid_intent" }, 400);
    const res = await syncPagos360Intent(admin, conn, tenantId, intentId);
    if (!res.ok) {
      return json({ error: res.error, detail: res.detail }, res.error === "intent_not_found" ? 404 : 502);
    }
    return json({ status: res.status, mp_payment_id: res.mp_payment_id, ...(res.state ? { state: res.state } : {}) });
  }

  return json({ error: "invalid_action" }, 400);
});
