// =============================================================================
// Edge Function: pending_charges_sync — sincroniza con el proveedor los cobros
// en espera (ADR-048) que no reciben webhook, aunque ningún POS esté abierto.
//
// Cron (pg_cron + pg_net, cada 2 min): header X-Cron-Secret ==
// platform_secrets('internal_cron').token. Toma los cobros 'waiting' sin
// vencer de los proveedores sin webhook (hoy Pagos360) y re-consulta cada
// intent. Si el proveedor acreditó, el intent pasa a 'approved' y el trigger
// de la base (pending_charges_on_intent_status) registra la venta en el acto.
// Nunca confía en nada que no venga de la API del proveedor con la credencial
// del negocio (misma regla que la Edge del proveedor).
//
// Los proveedores con webhook (Mercado Pago, MODO, Mobbex, Payway, Getnet,
// Nave, GO Cuotas, Directo) no pasan por acá: su webhook ya actualiza el intent
// y el trigger completa. El POS además sondea mientras está abierto.
//
// Deploy: verify_jwt = true (el cron manda el anon key como Bearer para pasar
// el gateway; la autenticación real es el X-Cron-Secret).
// =============================================================================
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.47.10";
import { loadPagos360, syncPagos360Intent } from "../_shared/pagos360_server.ts";

const json = (b: unknown, s = 200) =>
  new Response(JSON.stringify(b), { status: s, headers: { "Content-Type": "application/json" } });

const MAX_PER_RUN = 150;

function safeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let r = 0;
  for (let i = 0; i < a.length; i++) r |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return r === 0;
}

Deno.serve(async (req: Request) => {
  if (req.method !== "POST") return json({ error: "method_not_allowed" }, 405);
  const url = Deno.env.get("SUPABASE_URL")!;
  const serviceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
  const admin = createClient(url, serviceKey, { auth: { persistSession: false } });

  const secret = req.headers.get("X-Cron-Secret") ?? "";
  if (!secret) return json({ error: "forbidden" }, 403);
  const { data: row } = await admin
    .from("platform_secrets")
    .select("secrets")
    .eq("key", "internal_cron")
    .maybeSingle();
  const token = String((row?.secrets as { token?: string } | null)?.token ?? "");
  if (!token || !safeEqual(secret, token)) return json({ error: "forbidden" }, 403);

  const t0 = performance.now();
  const { data: charges, error } = await admin
    .from("pending_charges")
    .select("id, tenant_id, intent_id, provider_key")
    .eq("status", "waiting")
    .is("deleted_at", null)
    .gt("expires_at", new Date().toISOString())
    .in("provider_key", ["pagos360"])
    .order("created_at", { ascending: true })
    .limit(MAX_PER_RUN);
  if (error) return json({ error: "query_failed", detail: error.message }, 500);

  const byTenant = new Map<string, { id: string; intent_id: string }[]>();
  for (const c of (charges ?? []) as { id: string; tenant_id: string; intent_id: string }[]) {
    const list = byTenant.get(c.tenant_id) ?? [];
    list.push(c);
    byTenant.set(c.tenant_id, list);
  }

  let checked = 0;
  let approved = 0;
  let failed = 0;
  // Un negocio a la vez (su API key), sus intents en paralelo de a 5.
  for (const [tenantId, list] of byTenant) {
    const conn = await loadPagos360(admin, tenantId);
    if (!conn) continue;
    for (let i = 0; i < list.length; i += 5) {
      const chunk = list.slice(i, i + 5);
      const results = await Promise.all(
        chunk.map((c) => syncPagos360Intent(admin, conn, tenantId, c.intent_id).catch(() => null)),
      );
      for (const r of results) {
        checked++;
        if (!r || !r.ok) failed++;
        else if (r.status === "approved") approved++;
      }
    }
  }

  const out = { checked, approved, failed, ms: Math.round(performance.now() - t0) };
  console.log(JSON.stringify({ fn: "pending_charges_sync", ...out }));
  return json(out);
});
