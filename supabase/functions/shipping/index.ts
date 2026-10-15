// =============================================================================
// Edge Function: shipping  (Envíos y logística · ADR-103) · verify_jwt = true
//
// Acciones del usuario (JWT; el negocio sale del app_metadata y cada acción
// pasa por shipping_access_check: rol, sucursal, plan con `envios` y la key
// del carrier):
//   test_connection   prueba credenciales (cargadas o recién tipeadas).
//   save_connection   guarda config no secreta y secretos por negocio o
//                     sucursal (ADR-057). Auditado. Secretos sólo service_role.
//   delete_connection baja lógica de la conexión y borra sus secretos.
//   quote             cotiza en paralelo entre las logísticas efectivas de la
//                     sucursal (timeout por carrier, errores por carrier).
//   points            sucursales o puntos de retiro de una logística por CP.
//   process           corre ya los trabajos pendientes de un envío (alta y
//                     etiqueta) en vez de esperar al cron.
//   track             pide un seguimiento ahora y lo procesa.
//   label             URL firmada corta del PDF o el texto ZPL de un envío.
//   labels_batch      un PDF combinado (o un ZPL concatenado) de varios envíos.
//
// Cron (X-Cron-Secret = platform_secrets('internal_cron').token): toma
// trabajos vencidos con shipping_jobs_claim (SKIP LOCKED) y los procesa con
// _shared/shipping/worker.ts hasta agotar el presupuesto de tiempo.
//
// Ninguna logística de esta fase usa webhooks: no hay Edge pública.
// =============================================================================
import { createClient, type SupabaseClient } from "https://esm.sh/@supabase/supabase-js@2.47.10";
import { PDFDocument } from "https://esm.sh/pdf-lib@1.17.1";
import { adapterFor, ADAPTERS } from "../_shared/shipping/registry.ts";
import {
  originAddress,
  processJob,
  shipmentRef,
  toCarrierError,
  type Credentials,
  type JobRow,
  type ShipmentPatch,
  type ShipmentRow,
  type WorkerDeps,
} from "../_shared/shipping/worker.ts";
import type { CarrierContext, FetchLike, LabelFile, Package, Quote, TrackingEvent } from "../_shared/shipping/types.ts";

const cors = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type, x-cron-secret, x-ninja-scope",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};
const json = (b: unknown, s = 200) =>
  new Response(JSON.stringify(b), { status: s, headers: { ...cors, "Content-Type": "application/json" } });

const BUCKET = "shipping-labels";
const CRON_BUDGET_MS = 45_000;
const CARRIER_TIMEOUT_MS = 12_000;
const fetcher: FetchLike = (url, init) => fetch(url, init);

function safeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let r = 0;
  for (let i = 0; i < a.length; i++) r |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return r === 0;
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const isUuid = (v: unknown): v is string => typeof v === "string" && UUID_RE.test(v);

function errStatus(code: string): number {
  if (code.startsWith("forbidden") || code.startsWith("feature_not_in_plan")) return 403;
  if (code === "store_not_found" || code === "not_found") return 404;
  return 400;
}

function withTimeout<T>(p: Promise<T>, ms: number, label: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const t = setTimeout(() => reject(new Error(`${label}: tiempo agotado`)), ms);
    p.then(
      (v) => {
        clearTimeout(t);
        resolve(v);
      },
      (e) => {
        clearTimeout(t);
        reject(e);
      },
    );
  });
}

// Config visible: sólo escalares, sin nada que parezca un secreto.
const SECRET_KEY_RE = /(password|passwd|clave|secret|token|api_?key|apikey)/i;
function cleanConfig(raw: unknown): Record<string, string | number | boolean> {
  const out: Record<string, string | number | boolean> = {};
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return out;
  for (const [k, v] of Object.entries(raw as Record<string, unknown>).slice(0, 40)) {
    if (!/^[a-z][a-z0-9_]{0,39}$/.test(k) || SECRET_KEY_RE.test(k)) continue;
    if (typeof v === "string") {
      const t = v.trim();
      if (t) out[k] = t.slice(0, 200);
    } else if (typeof v === "number" && Number.isFinite(v)) out[k] = v;
    else if (typeof v === "boolean") out[k] = v;
  }
  return out;
}

function cleanSecrets(raw: unknown): Record<string, string> {
  const out: Record<string, string> = {};
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return out;
  for (const [k, v] of Object.entries(raw as Record<string, unknown>).slice(0, 20)) {
    if (!/^[a-z][a-z0-9_]{0,39}$/.test(k)) continue;
    if (typeof v === "string" && v.trim()) out[k] = v.trim().slice(0, 500);
  }
  return out;
}

// ---------------------------------------------------------------------------
// Dependencias reales del worker
// ---------------------------------------------------------------------------
async function connectionFor(admin: SupabaseClient, s: Pick<ShipmentRow, "tenant_id" | "store_id" | "provider_key" | "connection_id">) {
  let connId: string | null = null;
  if (s.connection_id) {
    const { data } = await admin
      .from("shipping_connections")
      .select("id, deleted_at")
      .eq("id", s.connection_id)
      .maybeSingle();
    if (data && !data.deleted_at) connId = data.id as string;
  }
  if (!connId && s.provider_key) {
    const { data } = await admin.rpc("shipping_effective_connection", {
      p_tenant: s.tenant_id,
      p_store: s.store_id,
      p_provider: s.provider_key,
    });
    connId = (data as string | null) ?? null;
  }
  return connId;
}

async function loadCredentialsById(admin: SupabaseClient, connId: string): Promise<Credentials | null> {
  const { data: conn } = await admin
    .from("shipping_connections")
    .select("id, sandbox, config, enabled")
    .eq("id", connId)
    .maybeSingle();
  if (!conn) return null;
  const { data: sec } = await admin.from("shipping_secrets").select("secrets").eq("connection_id", connId).maybeSingle();
  return {
    sandbox: Boolean(conn.sandbox),
    config: (conn.config as Record<string, unknown>) ?? {},
    secrets: (sec?.secrets as Record<string, string>) ?? {},
  };
}

function workerDeps(admin: SupabaseClient): WorkerDeps {
  return {
    now: () => new Date(),
    fetch: fetcher,
    adapters: ADAPTERS,
    async loadShipment(id) {
      const { data } = await admin.from("shipments").select("*").eq("id", id).is("deleted_at", null).maybeSingle();
      return (data as ShipmentRow | null) ?? null;
    },
    async loadCredentials(s) {
      const connId = await connectionFor(admin, s);
      return connId ? loadCredentialsById(admin, connId) : null;
    },
    async loadSender(s) {
      const [{ data: t }, { data: st }, cred] = await Promise.all([
        admin.from("tenants").select("name, cuit").eq("id", s.tenant_id).maybeSingle(),
        admin.from("stores").select("name, phone, email").eq("id", s.store_id).maybeSingle(),
        (async () => {
          const id = await connectionFor(admin, s);
          return id ? loadCredentialsById(admin, id) : null;
        })(),
      ]);
      const c = cred?.config ?? {};
      const str = (k: string) => (typeof c[k] === "string" && (c[k] as string).trim() ? (c[k] as string).trim() : undefined);
      return {
        name: str("sender_name") ?? (t?.name as string) ?? (st?.name as string) ?? "Remitente",
        document: str("sender_cuit") ?? ((t?.cuit as string | null) ?? undefined),
        email: str("sender_email") ?? ((st?.email as string | null) ?? undefined),
        phone: str("sender_phone") ?? ((st?.phone as string | null) ?? undefined),
      };
    },
    async updateShipment(id, patch: ShipmentPatch) {
      const { error } = await admin.from("shipments").update(patch).eq("id", id);
      if (error) throw new Error(`update_shipment: ${error.message}`);
    },
    async recordEvents(id, events: TrackingEvent[], source) {
      if (events.length === 0 && source !== "poll") return;
      const { error } = await admin.rpc("shipment_record_events", { p_shipment: id, p_events: events, p_source: source });
      if (error) throw new Error(`record_events: ${error.message}`);
    },
    async enqueue(s, kind, delaySeconds) {
      const { error } = await admin.rpc("_shipping_enqueue", {
        p_tenant: s.tenant_id,
        p_shipment: s.id,
        p_kind: kind,
        p_delay_seconds: delaySeconds,
      });
      if (error) throw new Error(`enqueue: ${error.message}`);
    },
    async uploadLabel(s, file: LabelFile) {
      const path = `${s.tenant_id}/${s.id}.${file.format}`;
      const { error } = await admin.storage.from(BUCKET).upload(path, file.bytes, { contentType: file.mime, upsert: true });
      if (error) throw new Error(`upload_label: ${error.message}`);
      return path;
    },
  };
}

/** Toma y procesa trabajos (todos o los de un envío). */
async function runJobs(admin: SupabaseClient, opts: { shipmentId?: string; limit: number; deadline: number; worker: string }) {
  const deps = workerDeps(admin);
  const done: { id: string; kind: string; outcome: string }[] = [];
  while (Date.now() < opts.deadline && done.length < opts.limit) {
    const { data, error } = await admin.rpc("shipping_jobs_claim", {
      p_limit: Math.min(10, opts.limit - done.length),
      p_worker: opts.worker,
      p_shipment: opts.shipmentId ?? null,
    });
    if (error) throw new Error(`claim: ${error.message}`);
    const jobs = (data ?? []) as JobRow[];
    if (jobs.length === 0) break;
    for (const job of jobs) {
      let out;
      try {
        out = await processJob(job, deps);
      } catch (e) {
        // Error de infraestructura (base, Storage): se reintenta.
        out = { outcome: "retry" as const, error: String(e instanceof Error ? e.message : e).slice(0, 300), retrySeconds: 60 };
      }
      const { error: finErr } = await admin.rpc("shipping_job_finish", {
        p_id: job.id,
        p_outcome: out.outcome,
        p_error: out.error ?? null,
        p_retry_seconds: out.retrySeconds ?? 60,
        p_result: out.result ?? null,
      });
      if (finErr) console.error(JSON.stringify({ fn: "shipping", job: job.id, error: finErr.message }));
      done.push({ id: job.id, kind: job.kind, outcome: out.outcome });
    }
  }
  return done;
}

async function mergePdfs(files: Uint8Array[]): Promise<Uint8Array> {
  const out = await PDFDocument.create();
  for (const f of files) {
    const src = await PDFDocument.load(f);
    const pages = await out.copyPages(src, src.getPageIndices());
    for (const p of pages) out.addPage(p);
  }
  return await out.save();
}

// ---------------------------------------------------------------------------
// Handler
// ---------------------------------------------------------------------------
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

  // --- Cron --------------------------------------------------------------------
  const cronSecret = req.headers.get("X-Cron-Secret") ?? "";
  if (cronSecret) {
    const { data: row } = await admin.from("platform_secrets").select("secrets").eq("key", "internal_cron").maybeSingle();
    const token = String((row?.secrets as { token?: string } | null)?.token ?? "");
    if (!token || !safeEqual(cronSecret, token)) return json({ error: "forbidden" }, 403);
    const t0 = Date.now();
    try {
      const done = await runJobs(admin, { limit: 200, deadline: t0 + CRON_BUDGET_MS, worker: "cron" });
      return json({ ok: true, processed: done.length, ms: Date.now() - t0 });
    } catch (e) {
      console.error(JSON.stringify({ fn: "shipping", mode: "cron", error: String(e) }));
      return json({ error: "worker_failed" }, 500);
    }
  }

  // --- Usuario -----------------------------------------------------------------
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

  const action = String(body.action ?? "");
  const check = async (storeId: string | null, provider: string | null, mode: "manage" | "operate" | "read") => {
    const { data, error } = await admin.rpc("shipping_access_check", {
      p_tenant: tenantId,
      p_user: user.id,
      p_store: storeId,
      p_provider: provider,
      p_mode: mode,
    });
    if (error) return "access_check_failed";
    return (data as string | null) ?? null;
  };
  const audit = (action_: string, entityId: string | null, after: Record<string, unknown>, storeId: string | null) =>
    admin.from("audit_logs").insert({
      tenant_id: tenantId,
      actor_user_id: user.id,
      entity_type: "shipping_connection",
      entity_id: entityId,
      action: action_,
      after_data: after,
      store_id: storeId,
    });
  // Envío visible para el usuario (RLS de shipments: negocio y sucursal).
  const visibleShipment = async (id: unknown) => {
    if (!isUuid(id)) return null;
    const { data } = await userClient.from("shipments").select("*").eq("id", id).maybeSingle();
    return (data as ShipmentRow | null) ?? null;
  };

  try {
    switch (action) {
      // ---------------------------------------------------------------- conexión
      case "test_connection":
      case "save_connection": {
        const provider = String(body.provider_key ?? "");
        const adapter = adapterFor(provider);
        if (!adapter) return json({ error: "invalid_provider" }, 400);
        if (body.store_id != null && !isUuid(body.store_id)) return json({ error: "invalid_store" }, 400);
        const storeId = isUuid(body.store_id) ? body.store_id : null;
        const err = await check(storeId, provider, "manage");
        if (err) return json({ error: err }, errStatus(err));

        let q = admin
          .from("shipping_connections")
          .select("*")
          .eq("tenant_id", tenantId)
          .eq("provider_key", provider)
          .is("deleted_at", null);
        q = storeId ? q.eq("store_id", storeId) : q.is("store_id", null);
        const { data: existing } = await q.maybeSingle();
        const { data: prevSec } = existing
          ? await admin.from("shipping_secrets").select("secrets").eq("connection_id", existing.id).maybeSingle()
          : { data: null };
        const config = body.config !== undefined ? cleanConfig(body.config) : ((existing?.config as Record<string, string>) ?? {});
        const typed = cleanSecrets(body.secrets);
        const secrets = { ...((prevSec?.secrets as Record<string, string>) ?? {}), ...typed };
        for (const k of Array.isArray(body.remove_secrets) ? (body.remove_secrets as unknown[]) : []) {
          if (typeof k === "string") delete secrets[k];
        }
        const sandbox = typeof body.sandbox === "boolean" ? body.sandbox : (existing?.sandbox ?? true);

        if (action === "test_connection") {
          const ctx: CarrierContext = { sandbox, config, secrets, fetch: fetcher, now: () => new Date() };
          let result: { ok: boolean; detail?: string; error?: string };
          try {
            const r = await withTimeout(adapter.testConnection(ctx), CARRIER_TIMEOUT_MS, adapter.name);
            result = { ok: true, detail: r.detail };
          } catch (e) {
            const ce = toCarrierError(e);
            result = { ok: false, error: ce.message, detail: ce.code };
          }
          if (existing) {
            await admin
              .from("shipping_connections")
              .update({
                last_test_at: new Date().toISOString(),
                last_test_ok: result.ok,
                last_test_error: result.ok ? null : (result.error ?? "").slice(0, 300),
              })
              .eq("id", existing.id);
          }
          return json(result);
        }

        const row = {
          tenant_id: tenantId,
          store_id: storeId,
          provider_key: provider,
          enabled: typeof body.enabled === "boolean" ? body.enabled : (existing?.enabled ?? true),
          sandbox,
          config,
          secret_keys: Object.keys(secrets).sort(),
        };
        let connId: string;
        if (existing) {
          const { error } = await admin.from("shipping_connections").update(row).eq("id", existing.id);
          if (error) return json({ error: "save_failed", detail: error.message }, 400);
          connId = existing.id as string;
        } else {
          const { data, error } = await admin
            .from("shipping_connections")
            .insert({ ...row, created_by: user.id })
            .select("id")
            .single();
          if (error || !data) return json({ error: "save_failed", detail: error?.message }, 400);
          connId = data.id as string;
        }
        if (Object.keys(typed).length > 0 || (Array.isArray(body.remove_secrets) && body.remove_secrets.length > 0)) {
          const { error } = await admin
            .from("shipping_secrets")
            .upsert({ tenant_id: tenantId, connection_id: connId, secrets }, { onConflict: "connection_id" });
          if (error) return json({ error: "save_failed", detail: error.message }, 500);
        }
        await audit(
          existing ? "shipping_connection_updated" : "shipping_connection_created",
          connId,
          {
            provider_key: provider,
            store_id: storeId,
            enabled: row.enabled,
            sandbox,
            config_keys: Object.keys(config).sort(),
            secret_keys_set: Object.keys(typed).sort(),
          },
          storeId,
        );
        const { data: saved } = await admin.from("shipping_connections").select("*").eq("id", connId).single();
        return json({ ok: true, connection: saved });
      }

      case "delete_connection": {
        if (!isUuid(body.connection_id)) return json({ error: "invalid_connection" }, 400);
        const { data: conn } = await admin
          .from("shipping_connections")
          .select("*")
          .eq("id", body.connection_id)
          .eq("tenant_id", tenantId)
          .is("deleted_at", null)
          .maybeSingle();
        if (!conn) return json({ error: "not_found" }, 404);
        const err = await check((conn.store_id as string | null) ?? null, conn.provider_key as string, "manage");
        // Desconectar se permite aunque el plan ya no incluya la logística.
        if (err && !err.startsWith("feature_not_in_plan") && err !== "provider_not_available") {
          return json({ error: err }, errStatus(err));
        }
        await admin.from("shipping_secrets").delete().eq("connection_id", conn.id);
        await admin
          .from("shipping_connections")
          .update({ deleted_at: new Date().toISOString(), enabled: false, secret_keys: [] })
          .eq("id", conn.id);
        await audit("shipping_connection_deleted", conn.id as string, { provider_key: conn.provider_key, store_id: conn.store_id }, conn.store_id as string | null);
        return json({ ok: true });
      }

      // ---------------------------------------------------------------- cotizar
      case "quote": {
        if (!isUuid(body.store_id)) return json({ error: "invalid_store" }, 400);
        const storeId = body.store_id;
        const err = await check(storeId, null, "operate");
        if (err) return json({ error: err }, errStatus(err));
        const dest = (body.destination ?? {}) as { postal_code?: string };
        const cp = String(dest.postal_code ?? "").trim().toUpperCase();
        if (!/^([0-9]{4}|[A-Z][0-9]{4}[A-Z]{3})$/.test(cp)) return json({ error: "invalid_postal_code" }, 400);
        const pkgs = (Array.isArray(body.packages) ? body.packages : []) as Package[];
        if (pkgs.length === 0 || pkgs.length > 20) return json({ error: "packages_required" }, 400);
        for (const p of pkgs) {
          for (const k of ["weight_kg", "length_cm", "width_cm", "height_cm"] as const) {
            const v = Number(p[k]);
            if (!Number.isFinite(v) || v <= 0 || v > 1000) return json({ error: "invalid_package" }, 400);
          }
        }
        const { data: eff, error: effErr } = await userClient.rpc("shipping_effective_connections", { p_store: storeId });
        if (effErr) return json({ error: "connections_failed", detail: effErr.message }, 400);
        const wanted = Array.isArray(body.provider_keys) ? new Set(body.provider_keys as string[]) : null;
        const { data: store } = await admin
          .from("stores")
          .select("name, address, city, province, postal_code")
          .eq("id", storeId)
          .maybeSingle();
        const list = ((eff ?? []) as {
          provider_key: string;
          connection_id: string | null;
          capabilities: { quote?: boolean };
          in_plan: boolean;
          connected: boolean;
        }[]).filter((c) => c.in_plan && c.connected && c.capabilities?.quote && (!wanted || wanted.has(c.provider_key)));
        const serviceType = body.service_type === "branch" || body.service_type === "door" ? body.service_type : undefined;
        const results = await Promise.all(
          list.map(async (c) => {
            const adapter = adapterFor(c.provider_key);
            if (!adapter) return { provider_key: c.provider_key, error: "Sin adaptador" };
            try {
              const cred = c.connection_id
                ? await loadCredentialsById(admin, c.connection_id)
                : { sandbox: true, config: {}, secrets: {} };
              if (!cred) return { provider_key: c.provider_key, error: "Sin credenciales" };
              const ctx: CarrierContext = { ...cred, fetch: fetcher, now: () => new Date() };
              const origin = originAddress(
                { origin: { street: store?.address ?? "", city: store?.city ?? "", province: store?.province ?? "", postal_code: store?.postal_code ?? "" } } as ShipmentRow,
                cred.config,
              );
              const quotes = await withTimeout(
                adapter.quote(ctx, {
                  origin,
                  destination: { ...(body.destination as Record<string, string>), postal_code: cp },
                  packages: pkgs.map((p) => ({
                    weight_kg: Number(p.weight_kg),
                    length_cm: Number(p.length_cm),
                    width_cm: Number(p.width_cm),
                    height_cm: Number(p.height_cm),
                  })),
                  declared_value: Math.max(0, Number(body.declared_value ?? 0) || 0),
                  service_type: serviceType,
                }),
                CARRIER_TIMEOUT_MS,
                adapter.name,
              );
              return { provider_key: c.provider_key, quotes, sandbox: cred.sandbox };
            } catch (e) {
              return { provider_key: c.provider_key, error: toCarrierError(e).message };
            }
          }),
        );
        const quotes: (Quote & { sandbox?: boolean })[] = [];
        const errors: { provider_key: string; error: string }[] = [];
        for (const r of results) {
          if ("error" in r && r.error) errors.push({ provider_key: r.provider_key, error: r.error });
          else if ("quotes" in r) for (const q of r.quotes ?? []) quotes.push({ ...q, sandbox: r.sandbox });
        }
        quotes.sort((a, b) => a.cost - b.cost);
        return json({ quotes, errors });
      }

      case "points": {
        if (!isUuid(body.store_id)) return json({ error: "invalid_store" }, 400);
        const provider = String(body.provider_key ?? "");
        const adapter = adapterFor(provider);
        if (!adapter || !adapter.capabilities.points) return json({ error: "invalid_provider" }, 400);
        const err = await check(body.store_id, provider, "operate");
        if (err) return json({ error: err }, errStatus(err));
        const cp = String(body.postal_code ?? "").replace(/\D/g, "").slice(0, 4);
        if (cp.length !== 4) return json({ error: "invalid_postal_code" }, 400);
        const connId = await connectionFor(admin, {
          tenant_id: tenantId,
          store_id: body.store_id,
          provider_key: provider,
          connection_id: null,
        });
        const cred = connId ? await loadCredentialsById(admin, connId) : provider === "simulador" ? { sandbox: true, config: {}, secrets: {} } : null;
        if (!cred) return json({ error: "carrier_not_connected" }, 400);
        try {
          const points = await withTimeout(
            adapter.listPoints({ ...cred, fetch: fetcher, now: () => new Date() }, { postal_code: cp }),
            CARRIER_TIMEOUT_MS,
            adapter.name,
          );
          return json({ points: points.slice(0, 50) });
        } catch (e) {
          return json({ error: "carrier_error", detail: toCarrierError(e).message }, 502);
        }
      }

      // ---------------------------------------------------------------- envíos
      case "process":
      case "track": {
        const s = await visibleShipment(body.shipment_id);
        if (!s) return json({ error: "not_found" }, 404);
        const err = await check(s.store_id, s.provider_key, action === "track" ? "read" : "operate");
        if (err) return json({ error: err }, errStatus(err));
        if (action === "track") {
          const { error } = await userClient.rpc("shipment_request_track", { p_id: s.id });
          if (error) return json({ error: error.message }, 400);
        }
        const done = await runJobs(admin, { shipmentId: s.id, limit: 4, deadline: Date.now() + 40_000, worker: `user:${user.id}` });
        const fresh = await visibleShipment(s.id);
        return json({ ok: true, jobs: done, shipment: fresh });
      }

      case "label": {
        const s = await visibleShipment(body.shipment_id);
        if (!s) return json({ error: "not_found" }, 404);
        const err = await check(s.store_id, s.provider_key, "read");
        if (err) return json({ error: err }, errStatus(err));
        const adapter = adapterFor(s.provider_key);
        const want = body.format === "zpl" ? "zpl" : body.format === "pdf" ? "pdf" : (s.label_format ?? "pdf");
        let path = s.label_path;
        if (!path || s.label_format !== want) {
          // Otro formato que la logística también genera (p. ej. ZPL del simulador).
          if (!adapter || !adapter.labelFormats.includes(want) || !s.external_id) {
            return json({ error: path ? "format_not_available" : "label_not_ready" }, 409);
          }
          const connId = await connectionFor(admin, s);
          const cred = connId ? await loadCredentialsById(admin, connId) : { sandbox: true, config: {}, secrets: {} };
          if (!cred) return json({ error: "carrier_not_connected" }, 400);
          const file = await withTimeout(
            adapter.label({ ...cred, fetch: fetcher, now: () => new Date() }, shipmentRef(s), want),
            CARRIER_TIMEOUT_MS,
            adapter.name,
          );
          path = `${s.tenant_id}/${s.id}.${file.format}`;
          const up = await admin.storage.from(BUCKET).upload(path, file.bytes, { contentType: file.mime, upsert: true });
          if (up.error) return json({ error: "upload_failed" }, 500);
        }
        if (want === "zpl") {
          const { data, error } = await admin.storage.from(BUCKET).download(path);
          if (error || !data) return json({ error: "label_not_found" }, 404);
          return json({ format: "zpl", zpl: await data.text(), tracking_number: s.tracking_number });
        }
        const { data, error } = await admin.storage.from(BUCKET).createSignedUrl(path, 120);
        if (error || !data) return json({ error: "sign_failed" }, 500);
        return json({ format: "pdf", url: data.signedUrl, tracking_number: s.tracking_number });
      }

      case "labels_batch": {
        const ids = (Array.isArray(body.shipment_ids) ? body.shipment_ids : []).filter(isUuid).slice(0, 100);
        if (ids.length === 0) return json({ error: "shipments_required" }, 400);
        const format = body.format === "zpl" ? "zpl" : "pdf";
        const { data: rows } = await userClient
          .from("shipments")
          .select("id, tenant_id, store_id, provider_key, label_path, label_format, tracking_number")
          .in("id", ids);
        const ok: string[] = [];
        const skipped: string[] = [];
        const files: Uint8Array[] = [];
        const zpls: string[] = [];
        for (const r of (rows ?? []) as Pick<ShipmentRow, "id" | "store_id" | "provider_key" | "label_path" | "label_format">[]) {
          const err = await check(r.store_id, r.provider_key, "read");
          if (err || !r.label_path || r.label_format !== format) {
            skipped.push(r.id);
            continue;
          }
          const { data, error } = await admin.storage.from(BUCKET).download(r.label_path);
          if (error || !data) {
            skipped.push(r.id);
            continue;
          }
          if (format === "zpl") zpls.push(await data.text());
          else files.push(new Uint8Array(await data.arrayBuffer()));
          ok.push(r.id);
        }
        for (const id of ids) if (!ok.includes(id) && !skipped.includes(id)) skipped.push(id);
        if (ok.length === 0) return json({ error: "no_labels", skipped }, 409);
        if (format === "zpl") return json({ format, zpl: zpls.join("\n"), included: ok, skipped });
        const merged = await mergePdfs(files);
        const path = `${tenantId}/lotes/${crypto.randomUUID()}.pdf`;
        const up = await admin.storage.from(BUCKET).upload(path, merged, { contentType: "application/pdf", upsert: false });
        if (up.error) return json({ error: "upload_failed" }, 500);
        const { data: signed } = await admin.storage.from(BUCKET).createSignedUrl(path, 300);
        return json({ format, url: signed?.signedUrl ?? null, included: ok, skipped });
      }

      default:
        return json({ error: "invalid_action" }, 400);
    }
  } catch (e) {
    console.error(JSON.stringify({ fn: "shipping", action, error: String(e instanceof Error ? e.message : e) }));
    return json({ error: "internal_error" }, 500);
  }
});
