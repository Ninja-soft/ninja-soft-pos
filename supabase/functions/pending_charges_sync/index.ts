// =============================================================================
// Edge Function: pending_charges_sync: sincroniza con el proveedor los cobros
// en espera (ADR-048) que no reciben webhook, aunque ningún POS esté abierto.
//
// Cron (pg_cron + pg_net, cada 2 min): header X-Cron-Secret ==
// platform_secrets('internal_cron').token. Toma los cobros 'waiting' sin
// vencer de los proveedores sin webhook (Pagos360) o con un webhook de pocos
// reintentos (Ualá Bis, ADR-143: 4 intentos sin firma; Viumi, ADR-173: sin
// firma ni reintentos documentados; Talo, ADR-175: sin firma ni política de
// reintentos documentada, y una transferencia puede llegar horas después;
// dLocal Go, ADR-180: webhook firmado que sólo se acepta con firma válida, y
// los cupones de pago en efectivo de Mercado Pago, ADR-180: se pagan días
// después, el webhook topic order es por aplicación) y re-consulta cada
// intent. Si el proveedor acreditó, el intent pasa a 'approved' y el trigger
// de la base (pending_charges_on_intent_status) registra la venta en el acto.
// Nunca confía en nada que no venga de la API del proveedor con la credencial
// del negocio (misma regla que la Edge del proveedor).
//
// Los demás proveedores con webhook (Mercado Pago, MODO, Mobbex, Payway, Getnet,
// Nave, GO Cuotas, Directo) no pasan por acá: su webhook ya actualiza el intent
// y el trigger completa. El POS además sondea mientras está abierto.
//
// Deploy: verify_jwt = true (el cron manda el anon key como Bearer para pasar
// el gateway; la autenticación real es el X-Cron-Secret).
// =============================================================================
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.47.10";
import { loadPagos360, syncPagos360Intent } from "../_shared/pagos360_server.ts";
import { intentSecretScope } from "../_shared/paymentSecrets.ts";
import {
  INTENT_COLS as UALA_INTENT_COLS,
  loadCredsScoped as loadUala,
  syncIntent as syncUala,
  type IntentRow as UalaIntentRow,
} from "../_shared/ualabis_server.ts";
import {
  INTENT_COLS as VIUMI_INTENT_COLS,
  loadCredsScoped as loadViumi,
  syncIntent as syncViumi,
  type IntentRow as ViumiIntentRow,
} from "../_shared/viumi_server.ts";
import {
  INTENT_COLS as TALO_INTENT_COLS,
  loadCredsScoped as loadTalo,
  syncIntent as syncTalo,
  type IntentRow as TaloIntentRow,
} from "../_shared/talo_server.ts";
import {
  INTENT_COLS as DLOCAL_INTENT_COLS,
  loadCredsScoped as loadDlocal,
  syncIntent as syncDlocal,
  type IntentRow as DlocalIntentRow,
} from "../_shared/dlocalgo_server.ts";
import { tenantMpCredential } from "../_shared/mpAuth.ts";
import { applyOrderToIntent, fetchOrder, ORDER_INTENT_COLUMNS, type OrderIntentRow } from "../_shared/mpIntents.ts";

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
    .in("provider_key", ["pagos360", "ualabis", "viumi", "talo", "dlocalgo", "mp_cupon"])
    .order("created_at", { ascending: true })
    .limit(MAX_PER_RUN);
  if (error) return json({ error: "query_failed", detail: error.message }, 500);

  type Charge = { id: string; tenant_id: string; intent_id: string; provider_key: string };
  const byTenant = new Map<string, Charge[]>();
  for (const c of (charges ?? []) as Charge[]) {
    const list = byTenant.get(c.tenant_id) ?? [];
    list.push(c);
    byTenant.set(c.tenant_id, list);
  }

  let checked = 0;
  let approved = 0;
  let failed = 0;
  // Ualá Bis: re-consulta la orden con la credencial exacta del cobro.
  const syncUalaCharge = async (tenantId: string, intentId: string) => {
    const { data: row } = await admin
      .from("mp_payment_intents")
      .select(UALA_INTENT_COLS)
      .eq("id", intentId)
      .eq("tenant_id", tenantId)
      .eq("provider_key", "ualabis")
      .maybeSingle();
    if (!row) return null;
    const conn = await loadUala(admin, tenantId, { scopeStoreId: await intentSecretScope(admin, intentId) });
    if (!conn) return null;
    const r = await syncUala(admin, row as UalaIntentRow, conn.creds, "cron", null);
    return "error" in r ? { ok: false as const } : { ok: true as const, status: r.status };
  };
  // Viumi: re-consulta la orden con la credencial exacta del cobro.
  const syncViumiCharge = async (tenantId: string, intentId: string) => {
    const { data: row } = await admin
      .from("mp_payment_intents")
      .select(VIUMI_INTENT_COLS)
      .eq("id", intentId)
      .eq("tenant_id", tenantId)
      .eq("provider_key", "viumi")
      .maybeSingle();
    if (!row) return null;
    const conn = await loadViumi(admin, tenantId, { scopeStoreId: await intentSecretScope(admin, intentId) });
    if (!conn) return null;
    const r = await syncViumi(admin, row as ViumiIntentRow, conn.creds, "cron", null);
    return "error" in r ? { ok: false as const } : { ok: true as const, status: r.status };
  };

  // Talo: re-consulta el pago con la credencial exacta del cobro.
  const syncTaloCharge = async (tenantId: string, intentId: string) => {
    const { data: row } = await admin
      .from("mp_payment_intents")
      .select(TALO_INTENT_COLS)
      .eq("id", intentId)
      .eq("tenant_id", tenantId)
      .eq("provider_key", "talo")
      .maybeSingle();
    if (!row) return null;
    const conn = await loadTalo(admin, tenantId, { scopeStoreId: await intentSecretScope(admin, intentId) });
    if (!conn) return null;
    const r = await syncTalo(admin, row as TaloIntentRow, conn.creds, "cron", null);
    return "error" in r ? { ok: false as const } : { ok: true as const, status: r.status };
  };

  // dLocal Go: re-consulta el pago con la credencial exacta del cobro.
  const syncDlocalCharge = async (tenantId: string, intentId: string) => {
    const { data: row } = await admin
      .from("mp_payment_intents")
      .select(DLOCAL_INTENT_COLS)
      .eq("id", intentId)
      .eq("tenant_id", tenantId)
      .eq("provider_key", "dlocalgo")
      .maybeSingle();
    if (!row) return null;
    const conn = await loadDlocal(admin, tenantId, { scopeStoreId: await intentSecretScope(admin, intentId) });
    if (!conn) return null;
    const r = await syncDlocal(admin, row as DlocalIntentRow, conn.creds, "cron", null);
    return "error" in r ? { ok: false as const } : { ok: true as const, status: r.status };
  };

  // Cupón de Mercado Pago: re-lee la order con el token (ambiente y alcance)
  // con que se creó, misma regla que el webhook topic order.
  const syncCuponCharge = async (tenantId: string, intentId: string) => {
    const { data: row } = await admin
      .from("mp_payment_intents")
      .select(ORDER_INTENT_COLUMNS)
      .eq("id", intentId)
      .eq("tenant_id", tenantId)
      .eq("provider_key", "mp_cupon")
      .eq("status", "pending")
      .not("mp_order_id", "is", null)
      .maybeSingle();
    const r = row as OrderIntentRow | null;
    if (!r || !r.mp_order_id) return null;
    const cred = await tenantMpCredential(admin, tenantId, r.mp_env ?? "prod", {
      scopeStoreId: await intentSecretScope(admin, intentId),
    });
    if (!cred) return null;
    const got = await fetchOrder(cred.token, r.mp_order_id);
    if (!got.ok) return { ok: false as const };
    const res = await applyOrderToIntent(admin, r, got.order, { userId: null, source: "poll" });
    return { ok: true as const, status: res.status };
  };

  // Un negocio a la vez, sus intents en paralelo de a 5. ADR-057: cada intent
  // se verifica con la API key (negocio o sucursal) con la que se creó; las
  // conexiones se cachean por alcance.
  for (const [tenantId, list] of byTenant) {
    const conns = new Map<string, Awaited<ReturnType<typeof loadPagos360>>>();
    const connFor = async (intentId: string) => {
      const scope = await intentSecretScope(admin, intentId);
      const key = scope ?? "";
      if (!conns.has(key)) conns.set(key, await loadPagos360(admin, tenantId, { scopeStoreId: scope }));
      return conns.get(key) ?? null;
    };
    for (let i = 0; i < list.length; i += 5) {
      const chunk = list.slice(i, i + 5);
      const results = await Promise.all(
        chunk.map(async (c) => {
          if (c.provider_key === "ualabis") return await syncUalaCharge(tenantId, c.intent_id).catch(() => null);
          if (c.provider_key === "viumi") return await syncViumiCharge(tenantId, c.intent_id).catch(() => null);
          if (c.provider_key === "talo") return await syncTaloCharge(tenantId, c.intent_id).catch(() => null);
          if (c.provider_key === "dlocalgo") return await syncDlocalCharge(tenantId, c.intent_id).catch(() => null);
          if (c.provider_key === "mp_cupon") return await syncCuponCharge(tenantId, c.intent_id).catch(() => null);
          const conn = await connFor(c.intent_id);
          if (!conn) return null;
          return await syncPagos360Intent(admin, conn, tenantId, c.intent_id).catch(() => null);
        }),
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
