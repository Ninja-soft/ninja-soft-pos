// =============================================================================
// Edge Function: nubceo_sync, envío de ventas a NubCeo y lectura de asientos
// contables (ADR-062). Lógica pura en ../_shared/nubceo.ts (con tests).
//
// DOS MODOS:
//   1. Cron (pg_cron + pg_net, cada minuto sólo si nubceo_any_due()): header
//      X-Cron-Secret == platform_secrets('internal_cron').token. Toma los
//      negocios vencidos (nubceo_due_tenants: activos, en su ventana horaria,
//      con la feature) y corre una vuelta por cada uno; además importa los
//      asientos de los que tienen la importación automática (cada 6 h).
//   2. Usuario (JWT de dueño o encargado con la feature, nubceo_edge_guard):
//        { action: "test", environment }       login + compañías (guarda el
//                                               companyId del CUIT)
//        { action: "run" }                     una vuelta ya (ignora la ventana)
//        { action: "preview", sync_id }        arma el JSON sin mandarlo
//        { action: "ledger_import", since? }   trae asientos de NubCeo
//        { action: "ledger_status", ids, status } confirma o desconfirma
//        { action: "reconciliation_pull", days? } estado de conciliación de
//                                               las ventas enviadas (ADR-162);
//                                               el cron lo trae una vez por día
//
// Una vuelta: siembra (red del trigger) → toma con lease (nubceo_claim) →
// snapshot → clasifica y arma → "solo simular" guarda el JSON sin mandar; si
// no, POST de a una tanda (secuencial, como pide NubCeo) con la lectura de la
// respuesta de ANDESMAR (400 con índice: se rechazan esas y se reenvía el
// resto; 400 sin índice: se parte la tanda; 401: pausa; 5xx/red: reintento
// con espera creciente) → borra en NubCeo las anuladas → resultados fila por
// fila (nubceo_apply_results) → cierre (nubceo_finish_run).
//
// Credenciales: nubceo_credentials (sin policies; sólo service_role acá).
// Nunca se loguea el secreto ni el token.
//
// Deploy: verify_jwt = true (el cron manda el anon key como Bearer para pasar
// el gateway; la autenticación real es el X-Cron-Secret o el JWT del usuario).
// =============================================================================
import { createClient, type SupabaseClient } from "https://esm.sh/@supabase/supabase-js@2.47.10";
import {
  allowedApiUrl,
  buildNubceoSale,
  classifySnapshot,
  createNubceoApi,
  exhausted,
  ledgerNextCursor,
  ledgerQuery,
  listCompanies,
  nextAttemptAt,
  normalizeMapping,
  parseLedgerPage,
  parseReconciledSales,
  payloadHash,
  pickCompany,
  reconciledQuery,
  readDeleteResponse,
  readInsertResponse,
  type NubceoApi,
  type NubceoMapping,
  type NubceoSale,
  type SaleSnapshot,
} from "../_shared/nubceo.ts";

const cors = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type, x-cron-secret, x-ninja-scope",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};
const json = (b: unknown, s = 200) =>
  new Response(JSON.stringify(b), { status: s, headers: { ...cors, "Content-Type": "application/json" } });

/** Presupuesto de una invocación del cron: no se arranca otro negocio pasado esto. */
const CRON_BUDGET_MS = 40_000;
const LEDGER_MAX_PAGES = 20;
const LEDGER_PAGE_SIZE = 200;

function safeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let r = 0;
  for (let i = 0; i < a.length; i++) r |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return r === 0;
}

interface Settings {
  tenant_id: string;
  enabled: boolean;
  environment: "test" | "prod";
  simulate: boolean;
  store_ids: string[] | null;
  batch_size: number;
  max_attempts: number;
  mapping: unknown;
  ledger_since: string | null;
  ledger_last_import_at: string | null;
}

interface Creds {
  environment: string;
  api_url: string | null;
  api_key: string;
  api_secret: string;
  nubceo_tenant: string;
  tax_code: string | null;
  company_id: string | null;
}

interface SyncRow {
  id: string;
  kind: "sale" | "return";
  venta_id: string;
  status: string;
  attempts: number;
}

type Result = Record<string, unknown> & { id: string; status: string };

async function loadSettings(admin: SupabaseClient, tenantId: string): Promise<Settings | null> {
  const { data } = await admin.from("nubceo_settings").select("*").eq("tenant_id", tenantId).maybeSingle();
  return (data as Settings | null) ?? null;
}

async function loadCreds(admin: SupabaseClient, tenantId: string, env: string): Promise<Creds | null> {
  const { data } = await admin
    .from("nubceo_credentials")
    .select("environment, api_url, api_key, api_secret, nubceo_tenant, tax_code, company_id")
    .eq("tenant_id", tenantId)
    .eq("environment", env)
    .maybeSingle();
  return (data as Creds | null) ?? null;
}

function apiFor(c: Creds): NubceoApi | { error: string } {
  const u = allowedApiUrl(c.api_url);
  if (!u.ok) return { error: u.reason };
  return createNubceoApi({ baseUrl: u.url, apiKey: c.api_key, apiSecret: c.api_secret, tenant: c.nubceo_tenant });
}

const short = (v: unknown, n = 4000) => {
  try {
    const s = JSON.stringify(v ?? null);
    return s.length > n ? { truncated: true, text: s.slice(0, n) } : (v ?? null);
  } catch {
    return null;
  }
};

/** companyId para borrar: el guardado, o se busca por CUIT y se guarda. */
async function companyFor(admin: SupabaseClient, tenantId: string, creds: Creds, api: NubceoApi): Promise<string | null> {
  if (creds.company_id) return creds.company_id;
  const r = await api.companies();
  if (r.status !== 200) return null;
  const c = pickCompany(r.body, creds.tax_code ?? "");
  if (!c) return null;
  await admin
    .from("nubceo_credentials")
    .update({ company_id: c.id, company_name: c.name })
    .eq("tenant_id", tenantId)
    .eq("environment", creds.environment);
  creds.company_id = c.id;
  return c.id;
}

interface Counts {
  seeded: number;
  claimed: number;
  synced: number;
  already: number;
  simulated: number;
  excluded: number;
  errors: number;
  retried: number;
  deleted: number;
}

// -----------------------------------------------------------------------------
// Una vuelta de envío para un negocio
// -----------------------------------------------------------------------------
async function runTenant(
  admin: SupabaseClient,
  tenantId: string,
  trigger: "cron" | "manual",
): Promise<{ status: string; counts: Counts; message: string }> {
  const started = new Date().toISOString();
  const counts: Counts = { seeded: 0, claimed: 0, synced: 0, already: 0, simulated: 0, excluded: 0, errors: 0, retried: 0, deleted: 0 };
  const finish = async (status: string, message: string, failed = false, s?: Settings) => {
    await admin.rpc("nubceo_finish_run", {
      p_tenant: tenantId,
      p_run: {
        status,
        message,
        failed,
        counts,
        trigger,
        started_at: started,
        environment: s?.environment ?? null,
        simulate: s?.simulate ?? false,
      },
    });
    console.log(JSON.stringify({ fn: "nubceo_sync", tenant: tenantId, trigger, status, ...counts }));
    return { status, counts, message };
  };

  const s = await loadSettings(admin, tenantId);
  if (!s || !s.enabled) return await finish("skipped", "La integración está apagada", false, s ?? undefined);
  const mapping: NubceoMapping = normalizeMapping(s.mapping);
  const creds = s.simulate ? null : await loadCreds(admin, tenantId, s.environment);
  if (!s.simulate && !creds) {
    return await finish("error", `Faltan las credenciales de ${s.environment === "prod" ? "producción" : "prueba"}`, true, s);
  }
  let api: NubceoApi | null = null;
  if (creds) {
    const a = apiFor(creds);
    if ("error" in a) return await finish("error", a.error, true, s);
    api = a;
  }

  const { data: seeded } = await admin.rpc("nubceo_seed", { p_tenant: tenantId, p_limit: 500 });
  counts.seeded = Number(seeded) || 0;

  const { data: claimedRaw, error: claimErr } = await admin.rpc("nubceo_claim", {
    p_tenant: tenantId,
    p_limit: s.batch_size || 100,
  });
  if (claimErr) return await finish("error", `No se pudo tomar la cola: ${claimErr.message}`, false, s);
  const claimed = (claimedRaw ?? []) as SyncRow[];
  counts.claimed = claimed.length;
  if (claimed.length === 0) return await finish(s.simulate ? "simulated" : "ok", "Nada para mandar", false, s);

  const now = Date.now();
  const results: Result[] = [];
  const byId = new Map(claimed.map((r) => [r.id, r]));
  const inserts = claimed.filter((r) => r.status === "sending");
  const deletes = claimed.filter((r) => r.status === "delete_pending");

  // Reintento con espera creciente; agotado → error.
  const retryOrFail = (row: SyncRow, message: string, kind: "network" | "credentials", attempt = true): Result => {
    const attempts = row.attempts + (attempt ? 1 : 0);
    if (attempt && exhausted(attempts, s.max_attempts || 8)) {
      counts.errors++;
      return { id: row.id, status: "error", error: message, error_kind: "exhausted", attempt: true };
    }
    counts.retried++;
    return {
      id: row.id,
      status: row.status === "delete_pending" ? "delete_pending" : "pending",
      error: message,
      error_kind: kind,
      attempt,
      next_attempt_at: attempt ? nextAttemptAt(attempts, now) : new Date(now + 5 * 60_000).toISOString(),
    };
  };

  // --- Altas --------------------------------------------------------------
  const ready: { row: SyncRow; sale: NubceoSale; hash: string }[] = [];
  if (inserts.length > 0) {
    const { data: snaps, error: snapErr } = await admin.rpc("nubceo_snapshots", {
      p_tenant: tenantId,
      p_ids: inserts.map((r) => r.id),
    });
    if (snapErr) {
      for (const r of inserts) results.push(retryOrFail(r, `No se pudo leer la venta: ${snapErr.message}`, "network"));
    } else {
      for (const snap of (snaps ?? []) as SaleSnapshot[]) {
        const row = byId.get(snap.sync_id);
        if (!row) continue;
        const c = classifySnapshot(snap, { mapping, storeIds: s.store_ids });
        if (c.action === "exclude") {
          counts.excluded++;
          results.push({ id: row.id, status: "excluded", excluded_reason: c.reason });
        } else if (c.action === "config_error") {
          counts.errors++;
          results.push({ id: row.id, status: "error", error: c.reason, error_kind: "config" });
        } else {
          const sale = buildNubceoSale(c.envelope, {
            index: 0,
            taxCode: creds?.tax_code ?? "",
            paymentDate: mapping.paymentDate,
            fields: mapping.paymentFields,
          });
          ready.push({ row, sale, hash: payloadHash({ ...sale, saleIndexNumber: 0 }) });
        }
      }
      // Filas sin snapshot (venta borrada): fuera.
      const seen = new Set(((snaps ?? []) as SaleSnapshot[]).map((x) => x.sync_id));
      for (const r of inserts) {
        if (!seen.has(r.id)) {
          counts.excluded++;
          results.push({ id: r.id, status: "excluded", excluded_reason: "La venta ya no existe" });
        }
      }
    }
  }

  let credentialsFailed = false;
  let networkFailed = false;

  if (s.simulate) {
    for (const x of ready) {
      counts.simulated++;
      results.push({
        id: x.row.id,
        status: "simulated",
        payload: x.sale,
        payload_hash: x.hash,
        environment: s.environment,
        error: null,
      });
    }
  } else if (api && ready.length > 0) {
    // Tanda secuencial; 400 con índice → se rechazan esas y se reenvía el
    // resto; 400 sin índice → mitades hasta aislar la que falla.
    const sendBatch = async (batch: typeof ready, depth: number): Promise<void> => {
      if (batch.length === 0 || credentialsFailed) return;
      const sales = batch.map((x, i) => ({ ...x.sale, saleIndexNumber: i }));
      const ids = batch.map((x) => x.sale.id);
      const res = await api!.insertSales(sales);
      const reading = readInsertResponse(res, ids);
      const base = (x: (typeof ready)[number], i: number) => ({
        payload: sales[i],
        payload_hash: x.hash,
        http_status: res.status || null,
        environment: s.environment,
        sent: true,
      });
      if (reading.kind === "ok") {
        batch.forEach((x, i) => {
          const o = reading.results[x.sale.id];
          if (o?.result === "ok" || o?.result === "already") {
            counts.synced++;
            if (o.result === "already") counts.already++;
            results.push({ id: x.row.id, status: "synced", already: o.result === "already", ...base(x, i), error: null });
          } else {
            results.push({ ...retryOrFail(x.row, o && "message" in o ? o.message : "Sin confirmar", "network"), ...base(x, i) });
          }
        });
        return;
      }
      if (reading.kind === "rejected") {
        const rest: typeof ready = [];
        batch.forEach((x, i) => {
          const o = reading.results[x.sale.id];
          if (o?.result === "rejected") {
            counts.errors++;
            results.push({
              id: x.row.id,
              status: "error",
              error: o.message,
              error_kind: "validation",
              attempt: true,
              response: short(res.body),
              ...base(x, i),
            });
          } else {
            rest.push(x);
          }
        });
        if (depth < 12) await sendBatch(rest, depth + 1);
        return;
      }
      if (reading.kind === "split" && batch.length > 1 && depth < 12) {
        const half = Math.ceil(batch.length / 2);
        await sendBatch(batch.slice(0, half), depth + 1);
        await sendBatch(batch.slice(half), depth + 1);
        return;
      }
      if (reading.kind === "credentials") {
        credentialsFailed = true;
        for (const x of batch) {
          results.push({ ...retryOrFail(x.row, reading.message, "credentials", false), http_status: res.status });
        }
        return;
      }
      networkFailed = true;
      batch.forEach((x, i) => {
        results.push({ ...retryOrFail(x.row, reading.message, "network"), ...base(x, i), sent: false, response: short(res.body) });
      });
    };
    await sendBatch(ready, 0);
  }

  // --- Borrados (ventas anuladas o pedidas por el dueño) --------------------
  if (deletes.length > 0) {
    if (s.simulate || !api || !creds) {
      for (const r of deletes) {
        results.push({
          id: r.id,
          status: "delete_pending",
          error: "Modo simulación: el borrado en NubCeo se hace al mandar de verdad",
          next_attempt_at: new Date(now + 60 * 60_000).toISOString(),
        });
      }
    } else if (credentialsFailed) {
      for (const r of deletes) results.push(retryOrFail(r, "NubCeo rechazó las credenciales", "credentials", false));
    } else {
      const company = await companyFor(admin, tenantId, creds, api);
      if (!company) {
        for (const r of deletes) results.push(retryOrFail(r, "No se encontró la compañía del CUIT en NubCeo", "network"));
      } else {
        for (let i = 0; i < deletes.length; i += 500) {
          const chunk = deletes.slice(i, i + 500);
          const res = await api.deleteSales(company, chunk.map((r) => r.venta_id));
          const out = readDeleteResponse(res, chunk.map((r) => r.venta_id));
          for (const r of chunk) {
            const o = out[r.venta_id];
            if (o?.result === "deleted") {
              counts.deleted++;
              results.push({ id: r.id, status: "deleted", error: o.message ?? null, http_status: res.status });
            } else if (o?.result === "reconciled") {
              results.push({ id: r.id, status: "synced", error: o.message, http_status: res.status });
            } else {
              const rr = retryOrFail(r, o?.message ?? "Sin respuesta", "network");
              // Agotado: queda como mandada, con el aviso.
              results.push(
                rr.status === "error"
                  ? { id: r.id, status: "synced", error: `No se pudo borrar de NubCeo: ${o?.message ?? ""}`.trim() }
                  : { ...rr, http_status: res.status },
              );
            }
          }
        }
      }
    }
  }

  for (let i = 0; i < results.length; i += 200) {
    const { error } = await admin.rpc("nubceo_apply_results", { p_tenant: tenantId, p_results: results.slice(i, i + 200) });
    if (error) console.error(JSON.stringify({ fn: "nubceo_sync", tenant: tenantId, apply_error: error.message }));
  }

  const failed = credentialsFailed || (networkFailed && counts.synced === 0);
  const status = s.simulate
    ? "simulated"
    : credentialsFailed
      ? "error"
      : counts.errors + counts.retried > 0
        ? counts.synced + counts.deleted > 0
          ? "partial"
          : "error"
        : "ok";
  const message = credentialsFailed
    ? "NubCeo rechazó las credenciales: revisalas en Conexión"
    : s.simulate
      ? `Simulación: ${counts.simulated} armadas sin mandar`
      : `${counts.synced} enviadas${counts.already ? ` (${counts.already} ya estaban)` : ""}, ${counts.errors} con error, ${counts.retried} para reintentar${counts.deleted ? `, ${counts.deleted} borradas` : ""}`;
  return await finish(status, message, failed, s);
}

// -----------------------------------------------------------------------------
// Asientos contables
// -----------------------------------------------------------------------------
async function importLedger(
  admin: SupabaseClient,
  tenantId: string,
  since: string | null,
): Promise<{ ok: boolean; headers: number; entries: number; message: string }> {
  const s = await loadSettings(admin, tenantId);
  const env = s?.environment ?? "prod";
  const creds = await loadCreds(admin, tenantId, env);
  if (!creds) return { ok: false, headers: 0, entries: 0, message: "Faltan las credenciales" };
  const api = apiFor(creds);
  if ("error" in api) return { ok: false, headers: 0, entries: 0, message: api.error };
  const from = since ?? s?.ledger_last_import_at ?? s?.ledger_since ?? null;
  const startedAt = new Date().toISOString();
  let headers = 0;
  let entries = 0;
  let message = "";
  let ok = true;
  let complete = false;
  let lastUpdatedAt: string | null = null;
  for (let page = 1; page <= LEDGER_MAX_PAGES; page++) {
    const r = await api.ledgerHeaders(ledgerQuery({ page, pageSize: LEDGER_PAGE_SIZE, updatedSince: from }));
    if (r.status !== 200) {
      ok = false;
      message = r.status === 401 ? "NubCeo rechazó las credenciales" : `NubCeo respondió ${r.status || "sin respuesta"}`;
      break;
    }
    const pageData = parseLedgerPage(r.body);
    if (pageData.headers.length > 0) {
      const { data, error } = await admin.rpc("nubceo_ledger_upsert", {
        p_tenant: tenantId,
        p_headers: pageData.headers.map((h) => ({ ...h, deleted: h.deleted })),
        p_source: "api",
      });
      if (error) {
        ok = false;
        message = `No se pudieron guardar: ${error.message}`;
        break;
      }
      headers += Number((data as { headers?: number })?.headers) || 0;
      entries += Number((data as { entries?: number })?.entries) || 0;
    }
    lastUpdatedAt = pageData.lastUpdatedAt ?? lastUpdatedAt;
    const total = pageData.total;
    if (pageData.rows < LEDGER_PAGE_SIZE || (total > 0 && page * LEDGER_PAGE_SIZE >= total)) {
      complete = true;
      break;
    }
  }
  if (ok) {
    message = complete
      ? `${headers} asientos importados`
      : `${headers} asientos importados; quedan más, siguen en la próxima importación`;
  }
  const cursor = ledgerNextCursor({
    ok,
    complete,
    startedAt,
    previous: s?.ledger_last_import_at ?? null,
    lastUpdatedAt,
  });
  await admin
    .from("nubceo_settings")
    .update({ ledger_last_import_at: cursor, ledger_last_message: message })
    .eq("tenant_id", tenantId);
  return { ok, headers, entries, message };
}

// -----------------------------------------------------------------------------
// Estado de conciliación por venta (ADR-162, H153)
// -----------------------------------------------------------------------------
const RECON_PAGE_SIZE = 200;
const RECON_MAX_PAGES = 25;
const RECON_DAYS = 45;

async function pullReconciliation(
  admin: SupabaseClient,
  tenantId: string,
  days = RECON_DAYS,
): Promise<{ ok: boolean; rows: number; updated: number; message: string }> {
  const s = await loadSettings(admin, tenantId);
  const env = s?.environment ?? "prod";
  const creds = await loadCreds(admin, tenantId, env);
  if (!creds) return { ok: false, rows: 0, updated: 0, message: "Faltan las credenciales" };
  const api = apiFor(creds);
  if ("error" in api) return { ok: false, rows: 0, updated: 0, message: api.error };
  const to = new Date();
  const from = new Date(to.getTime() - Math.max(1, Math.min(days, 93)) * 86_400_000);
  let rows = 0;
  let updated = 0;
  let ok = true;
  let message = "";
  for (let page = 1; page <= RECON_MAX_PAGES; page++) {
    const r = await api.reconciledSales(
      reconciledQuery({ page, pageSize: RECON_PAGE_SIZE, from: from.toISOString().slice(0, 10), to: to.toISOString().slice(0, 10) }),
    );
    if (r.status !== 200) {
      ok = false;
      message = r.status === 401 ? "NubCeo rechazó las credenciales" : `NubCeo respondió ${r.status || "sin respuesta"}`;
      break;
    }
    const parsed = parseReconciledSales(r.body);
    rows += parsed.rows.length;
    if (parsed.rows.length > 0) {
      const { data, error } = await admin.rpc("nubceo_reconciliation_apply", { p_tenant: tenantId, p_rows: parsed.rows });
      if (error) {
        ok = false;
        message = `No se pudo guardar: ${error.message}`;
        break;
      }
      updated += Number(data) || 0;
    }
    if (parsed.count < RECON_PAGE_SIZE || (parsed.total > 0 && page * RECON_PAGE_SIZE >= parsed.total)) break;
  }
  if (ok) message = `${rows} ventas leídas, ${updated} con estado nuevo`;
  await admin
    .from("nubceo_settings")
    .update({ reconciliation_last_pull_at: new Date().toISOString(), reconciliation_last_message: message })
    .eq("tenant_id", tenantId);
  return { ok, rows, updated, message };
}

// -----------------------------------------------------------------------------
// Entrada
// -----------------------------------------------------------------------------
Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });
  if (req.method !== "POST") return json({ error: "method_not_allowed" }, 405);

  const url = Deno.env.get("SUPABASE_URL")!;
  const serviceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
  const anonKey = Deno.env.get("SUPABASE_ANON_KEY")!;
  const admin = createClient(url, serviceKey, { auth: { persistSession: false } });

  let body: Record<string, unknown> = {};
  try {
    body = (await req.json()) as Record<string, unknown>;
  } catch {
    body = {};
  }

  // --- Cron -------------------------------------------------------------------
  const cronSecret = req.headers.get("X-Cron-Secret") ?? "";
  if (cronSecret) {
    const { data: row } = await admin.from("platform_secrets").select("secrets").eq("key", "internal_cron").maybeSingle();
    const token = String((row?.secrets as { token?: string } | null)?.token ?? "");
    if (!token || !safeEqual(cronSecret, token)) return json({ error: "forbidden" }, 403);
    const t0 = Date.now();
    const { data: due, error } = await admin.rpc("nubceo_due_tenants", { p_limit: 20 });
    if (error) return json({ error: "query_failed", detail: error.message }, 500);
    const out: unknown[] = [];
    for (const d of (due ?? []) as { tenant_id: string; send_due: boolean; ledger_due: boolean }[]) {
      if (Date.now() - t0 > CRON_BUDGET_MS) break;
      try {
        const run = d.send_due ? await runTenant(admin, d.tenant_id, "cron") : null;
        const ledger = d.ledger_due ? await importLedger(admin, d.tenant_id, null) : null;
        out.push({ tenant: d.tenant_id, run: run?.status ?? null, ledger: ledger?.ok ?? null });
      } catch (e) {
        console.error(JSON.stringify({ fn: "nubceo_sync", tenant: d.tenant_id, error: String(e) }));
        out.push({ tenant: d.tenant_id, error: "failed" });
      }
    }
    // Una vez por día, el estado de conciliación de lo enviado (ADR-162).
    const { data: recDue } = await admin.rpc("nubceo_reconciliation_due", { p_limit: 5 });
    for (const d of (recDue ?? []) as { tenant_id: string }[]) {
      if (Date.now() - t0 > CRON_BUDGET_MS) break;
      try {
        const rec = await pullReconciliation(admin, d.tenant_id);
        out.push({ tenant: d.tenant_id, reconciliation: rec.ok });
      } catch (e) {
        console.error(JSON.stringify({ fn: "nubceo_sync", tenant: d.tenant_id, step: "reconciliation", error: String(e) }));
      }
    }
    return json({ ok: true, tenants: out, ms: Date.now() - t0 });
  }

  // --- Usuario ----------------------------------------------------------------
  const userClient = createClient(url, anonKey, {
    global: { headers: { Authorization: req.headers.get("Authorization") ?? "" } },
    auth: { persistSession: false },
  });
  const {
    data: { user },
    error: authErr,
  } = await userClient.auth.getUser();
  if (authErr || !user) return json({ error: "unauthorized" }, 401);
  const tenantId = (user.app_metadata as { current_tenant_id?: string } | null)?.current_tenant_id;
  if (!tenantId) return json({ error: "no_tenant" }, 400);
  const { data: guard, error: guardErr } = await admin.rpc("nubceo_edge_guard", { p_tenant: tenantId, p_user: user.id });
  if (guardErr) return json({ error: "guard_failed" }, 500);
  if (guard) return json({ error: guard }, 403);

  const action = String(body.action ?? "");
  const audit = (act: string, after: Record<string, unknown>) =>
    admin.from("audit_logs").insert({
      tenant_id: tenantId,
      actor_user_id: user.id,
      entity_type: "nubceo",
      entity_id: null,
      action: act,
      after_data: after,
    });

  if (action === "test") {
    const env = body.environment === "test" ? "test" : "prod";
    const creds = await loadCreds(admin, tenantId, env);
    if (!creds) return json({ ok: false, error: "credentials_missing" });
    const api = apiFor(creds);
    if ("error" in api) return json({ ok: false, error: "invalid_api_url", message: api.error });
    const r = await api.companies();
    if (r.status !== 200) {
      await audit("nubceo_connection_test", { environment: env, ok: false, status: r.status });
      return json({
        ok: false,
        error: r.status === 401 ? "invalid_credentials" : "unreachable",
        status: r.status,
        message: r.status === 401 ? "NubCeo rechazó la API key o el secreto" : `NubCeo respondió ${r.status || "sin respuesta"}`,
      });
    }
    const companies = listCompanies(r.body);
    const company = pickCompany(r.body, creds.tax_code ?? "");
    await admin
      .from("nubceo_credentials")
      .update({ company_id: company?.id ?? null, company_name: company?.name ?? null, verified_at: new Date().toISOString() })
      .eq("tenant_id", tenantId)
      .eq("environment", env);
    await audit("nubceo_connection_test", { environment: env, ok: true, companies: companies.length, company: company?.id ?? null });
    return json({ ok: true, companies, company });
  }

  if (action === "run") {
    const r = await runTenant(admin, tenantId, "manual");
    await audit("nubceo_run_manual", { status: r.status, counts: r.counts });
    return json({ ok: true, ...r });
  }

  if (action === "preview") {
    const syncId = String(body.sync_id ?? "");
    if (!/^[0-9a-f-]{36}$/i.test(syncId)) return json({ error: "invalid_sync_id" }, 400);
    const s = await loadSettings(admin, tenantId);
    if (!s) return json({ error: "not_configured" }, 400);
    const creds = await loadCreds(admin, tenantId, s.environment);
    const mapping = normalizeMapping(s.mapping);
    const { data: snaps } = await admin.rpc("nubceo_snapshots", { p_tenant: tenantId, p_ids: [syncId] });
    const snap = ((snaps ?? []) as SaleSnapshot[])[0];
    if (!snap) return json({ error: "not_found" }, 404);
    const c = classifySnapshot(snap, { mapping, storeIds: s.store_ids });
    if (c.action !== "send") return json({ ok: true, action: c.action, reason: c.reason });
    const sale = buildNubceoSale(c.envelope, {
      index: 0,
      taxCode: creds?.tax_code ?? "",
      paymentDate: mapping.paymentDate,
      fields: mapping.paymentFields,
    });
    return json({ ok: true, action: "send", payload: sale });
  }

  if (action === "ledger_import") {
    const since = typeof body.since === "string" && /^\d{4}-\d{2}-\d{2}/.test(body.since) ? body.since : null;
    const r = await importLedger(admin, tenantId, since);
    await audit("nubceo_ledger_import_api", { ok: r.ok, headers: r.headers, since });
    return json(r);
  }

  if (action === "reconciliation_pull") {
    const days = typeof body.days === "number" && body.days > 0 ? Math.min(93, Math.trunc(body.days)) : RECON_DAYS;
    const r = await pullReconciliation(admin, tenantId, days);
    await audit("nubceo_reconciliation_pull", { ok: r.ok, rows: r.rows, updated: r.updated, days });
    return json(r);
  }

  if (action === "ledger_status") {
    const status = body.status === "confirmed" ? "confirmed" : body.status === "not_confirmed" ? "not_confirmed" : null;
    const ids = Array.isArray(body.ids) ? (body.ids as unknown[]).map(String).filter((x) => x.length > 0 && x.length <= 200) : [];
    if (!status || ids.length === 0 || ids.length > 500) return json({ error: "invalid_request" }, 400);
    // Sólo asientos de este negocio que vinieron de la API.
    const { data: own } = await admin
      .from("nubceo_ledger_headers")
      .select("nubceo_id")
      .eq("tenant_id", tenantId)
      .eq("source", "api")
      .in("nubceo_id", ids);
    const ownIds = ((own ?? []) as { nubceo_id: string }[]).map((x) => x.nubceo_id);
    if (ownIds.length === 0) return json({ error: "not_found" }, 404);
    const s = await loadSettings(admin, tenantId);
    const creds = await loadCreds(admin, tenantId, s?.environment ?? "prod");
    if (!creds) return json({ ok: false, error: "credentials_missing" });
    const api = apiFor(creds);
    if ("error" in api) return json({ ok: false, error: "invalid_api_url" });
    const r = await api.ledgerStatus(status, ownIds);
    if (r.status !== 200) return json({ ok: false, error: "nubceo_error", status: r.status });
    const data = (r.body as { data?: { updatedIds?: unknown[] } } | null)?.data;
    const updated = Array.isArray(data?.updatedIds) ? data!.updatedIds!.map(String) : ownIds;
    if (updated.length > 0) {
      await admin
        .from("nubceo_ledger_headers")
        .update({ status, updated_at: new Date().toISOString() })
        .eq("tenant_id", tenantId)
        .in("nubceo_id", updated);
    }
    await audit("nubceo_ledger_status", { status, ids: updated });
    return json({ ok: true, updated });
  }

  return json({ error: "invalid_action" }, 400);
});
