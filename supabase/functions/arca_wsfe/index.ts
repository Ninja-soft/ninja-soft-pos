// =============================================================================
// Edge Function: arca_wsfe, facturación electrónica con ARCA (ADR-072).
// Lógica pura y testeada en ../_shared/arca/*.
//
// MODOS:
//   1. Cron (pg_cron + pg_net cada minuto si arca_any_due()): header
//      X-Cron-Secret == platform_secrets('internal_cron').token. Procesa la
//      cola de los negocios con trabajo (arca_due_tenants) y sus tareas de
//      CAEA, dentro de un presupuesto de tiempo.
//   2. Usuario (JWT; arca_edge_guard):
//      cualquier miembro activo con la feature:
//        { action: "emitir_venta", sale_id }      la factura de la venta recién hecha
//      dueño o encargado con la feature:
//        { action: "emitir", document_id? }       procesa la cola ya
//        { action: "reintentar", document_id }    reproceso manual
//        { action: "test_conexion", environment } WSAA + FEDummy + último + PV
//        { action: "param", environment, table }  tablas FEParamGet*
//        { action: "ultimo_autorizado", environment, pto_vta, cbte_tipo }
//        { action: "generar_csr", environment, alias?, organization? }
//        { action: "subir_certificado", environment, cert_pem }
//        { action: "caea_tareas" }                pedir/informar CAEA ya
//      staff interno (app_metadata.is_internal):
//        { action: "platform_set_cuit" | "platform_generar_csr" | "platform_subir_certificado" | "platform_subir_par" (ADR-133; con `cuit` opcional de la empresa titular), ... }
//
// Secretos: ARCA_KEY_ENC (32 bytes base64) cifra las claves privadas; nunca
// sale de acá. Token y Sign de WSAA no se loguean ni se guardan en el XML.
// Endpoints: oficiales, o ARCA_WSAA_URL_HOMO / ARCA_WSFE_URL_HOMO /
// ARCA_WSAA_URL_PROD / ARCA_WSFE_URL_PROD (sólo dominios de ARCA o localhost).
//
// Deploy: verify_jwt = true (el cron manda el anon key como Bearer).
// =============================================================================
import { createClient, type SupabaseClient } from "https://esm.sh/@supabase/supabase-js@2.47.10";
import { endpointsFor, EXPECTED_ISSUER_CN, type ArcaEnv } from "../_shared/arca/config.ts";
import { createWsfeClient, loginCms, type FetchLike } from "../_shared/arca/client.ts";
import { buildTra, classifyWsaaFault, ticketUsable } from "../_shared/arca/wsaa.ts";
import { buildCsr, checkCertificate, generateKeyPem, sanitizeAlias } from "../_shared/arca/pki.ts";
import { signCms } from "../_shared/arca/pki.ts";
import { decryptSecret, encryptSecret, keyAad } from "../_shared/arca/crypto.ts";
import { activePointsOfSale, PARAM_OPS, type ParamTable, type WsfeAuth } from "../_shared/arca/wsfe.ts";
import { classifyWsfeErrors, humanError, joinMsgs } from "../_shared/arca/errors.ts";
import { cuitIsValid } from "../_shared/arca/padron.ts";
import { processDocument, type AuthOutcome, type Snapshot, type WorkerDeps } from "../_shared/arca/worker.ts";
import { runCaeaTasks, type CaeaTasks } from "../_shared/arca/caeaTasks.ts";

const cors = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type, x-cron-secret, x-ninja-scope",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};
const json = (b: unknown, s = 200) =>
  new Response(JSON.stringify(b), { status: s, headers: { ...cors, "Content-Type": "application/json" } });

const CRON_BUDGET_MS = 40_000;
const ENVS: ArcaEnv[] = ["homologacion", "produccion"];
const isEnv = (v: unknown): v is ArcaEnv => v === "homologacion" || v === "produccion";

function safeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let r = 0;
  for (let i = 0; i < a.length; i++) r |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return r === 0;
}

const fetcher: FetchLike = (url, init) => fetch(url, init);
const envVars = () => Deno.env.toObject();
const masterKey = () => Deno.env.get("ARCA_KEY_ENC") ?? "";

interface Settings {
  tenant_id: string;
  enabled: boolean;
  auth_mode: "propio" | "delegado";
  environment: ArcaEnv;
  caea_enabled: boolean;
  caea_pto_vta: number | null;
  caea_timeout_seconds: number;
  caea_next_check_at: string | null;
}

async function loadSettings(admin: SupabaseClient, tenantId: string): Promise<Settings | null> {
  const { data } = await admin.from("arca_settings").select("*").eq("tenant_id", tenantId).maybeSingle();
  return (data as Settings | null) ?? null;
}

async function emitterOf(admin: SupabaseClient, tenantId: string): Promise<{ cuit: string | null; iva_condition: string | null }> {
  const { data } = await admin.from("tax_settings").select("cuit, iva_condition").eq("tenant_id", tenantId).maybeSingle();
  const row = data as { cuit: string | null; iva_condition: string | null } | null;
  if (row?.cuit) return row;
  const { data: b } = await admin.from("tenant_branding").select("cuit, iva_condition").eq("tenant_id", tenantId).maybeSingle();
  const br = b as { cuit: string | null; iva_condition: string | null } | null;
  return { cuit: row?.cuit ?? (br?.cuit ? br.cuit.replace(/\D/g, "") : null), iva_condition: row?.iva_condition ?? br?.iva_condition ?? null };
}

// -----------------------------------------------------------------------------
// Credenciales y ticket de acceso
// -----------------------------------------------------------------------------
interface Creds {
  owner: "tenant" | "platform";
  certPem: string;
  keyPem: string;
  certificateId: string | null;
  /** CUIT representada (Auth.Cuit). */
  cuit: string;
}

type CredsResult = { ok: true; creds: Creds } | { ok: false; code: string; message: string };

async function loadCreds(admin: SupabaseClient, tenantId: string, env: ArcaEnv, mode: string, emitterCuit: string | null): Promise<CredsResult> {
  const mk = masterKey();
  if (mode === "delegado") {
    const { data } = await admin.from("arca_platform").select("cuit, cert_pem, key_enc, not_after").eq("environment", env).maybeSingle();
    const p = data as { cuit: string | null; cert_pem: string | null; key_enc: string | null; not_after: string | null } | null;
    if (!p?.cuit || !p.cert_pem || !p.key_enc) return { ok: false, code: "plataforma_no_configurada", message: "La delegación en NinjaSoft todavía no está disponible" };
    try {
      const keyPem = await decryptSecret(p.key_enc, mk, keyAad("platform", env));
      // En homologación la delegación de un cliente no existe: se prueba con
      // la CUIT de la plataforma. En producción, la CUIT del negocio.
      const cuit = env === "homologacion" ? p.cuit : emitterCuit;
      if (!cuit) return { ok: false, code: "fiscal_data_missing", message: "Falta la CUIT del negocio" };
      return { ok: true, creds: { owner: "platform", certPem: p.cert_pem, keyPem, certificateId: null, cuit } };
    } catch {
      return { ok: false, code: "certificado_ilegible", message: "No se pudo leer el certificado de la plataforma" };
    }
  }
  const { data } = await admin
    .from("arca_certificates")
    .select("id, cert_pem, key_enc, cuit, not_after")
    .eq("tenant_id", tenantId)
    .eq("environment", env)
    .eq("status", "active")
    .is("deleted_at", null)
    .maybeSingle();
  const c = data as { id: string; cert_pem: string; key_enc: string; cuit: string | null; not_after: string | null } | null;
  if (!c) return { ok: false, code: "certificado_faltante", message: "Falta el certificado de este ambiente" };
  if (c.not_after && new Date(c.not_after).getTime() < Date.now()) {
    return { ok: false, code: "cms.cert.expired", message: "El certificado está vencido" };
  }
  try {
    const keyPem = await decryptSecret(c.key_enc, mk, keyAad(tenantId, env));
    const cuit = emitterCuit ?? c.cuit;
    if (!cuit) return { ok: false, code: "fiscal_data_missing", message: "Falta la CUIT del negocio" };
    return { ok: true, creds: { owner: "tenant", certPem: c.cert_pem, keyPem, certificateId: c.id, cuit } };
  } catch {
    return { ok: false, code: "certificado_ilegible", message: "No se pudo leer la clave guardada (ARCA_KEY_ENC)" };
  }
}

async function readTicket(admin: SupabaseClient, tenantId: string, env: ArcaEnv, owner: "tenant" | "platform") {
  const q = owner === "platform"
    ? admin.from("arca_platform_tickets").select("token, sign, expires_at").eq("environment", env).eq("service", "wsfe")
    : admin.from("arca_tickets").select("token, sign, expires_at").eq("tenant_id", tenantId).eq("environment", env).eq("service", "wsfe");
  const { data } = await q.maybeSingle();
  return (data as { token: string; sign: string; expires_at: string } | null) ?? null;
}

async function saveTicket(admin: SupabaseClient, tenantId: string, env: ArcaEnv, creds: Creds, t: { token: string; sign: string; generationTime: string; expirationTime: string }) {
  const row = {
    environment: env,
    service: "wsfe",
    token: t.token,
    sign: t.sign,
    generated_at: t.generationTime || new Date().toISOString(),
    expires_at: t.expirationTime,
  };
  if (creds.owner === "platform") {
    await admin.from("arca_platform_tickets").upsert(row, { onConflict: "environment,service" });
  } else {
    await admin
      .from("arca_tickets")
      .upsert({ ...row, tenant_id: tenantId, certificate_id: creds.certificateId }, { onConflict: "tenant_id,environment,service" });
  }
}

async function authFor(admin: SupabaseClient, tenantId: string, env: ArcaEnv, mode: string, emitterCuit: string | null): Promise<AuthOutcome> {
  const cr = await loadCreds(admin, tenantId, env, mode, emitterCuit);
  if (!cr.ok) return { ok: false, kind: "action", code: cr.code, message: cr.message };
  const creds = cr.creds;
  const cached = await readTicket(admin, tenantId, env, creds.owner);
  if (cached && ticketUsable(cached.expires_at)) {
    return { ok: true, auth: { token: cached.token, sign: cached.sign, cuit: creds.cuit } };
  }
  let cms: string;
  try {
    cms = signCms(buildTra("wsfe"), creds.certPem, creds.keyPem);
  } catch {
    return { ok: false, kind: "action", code: "certificado_ilegible", message: "No se pudo firmar con el certificado" };
  }
  const eps = endpointsFor(env, envVars());
  const r = await loginCms(fetcher, eps.wsaa, cms);
  if (r.transport || !r.result) {
    return { ok: false, kind: "transient", code: "sin_respuesta", message: `El servicio de acceso de ARCA no respondió (${r.error ?? "sin datos"})` };
  }
  if (r.result.ok) {
    await saveTicket(admin, tenantId, env, creds, r.result.ticket);
    return { ok: true, auth: { token: r.result.ticket.token, sign: r.result.ticket.sign, cuit: creds.cuit } };
  }
  const kind = classifyWsaaFault(r.result.code);
  if (kind === "already") {
    // Otra invocación pudo haberlo guardado recién.
    const again = await readTicket(admin, tenantId, env, creds.owner);
    if (again && ticketUsable(again.expires_at, new Date(), 60_000)) {
      return { ok: true, auth: { token: again.token, sign: again.sign, cuit: creds.cuit } };
    }
    return {
      ok: false,
      kind: "action",
      code: "ta_ya_emitido",
      message: "ARCA ya entregó un permiso de acceso vigente que NinjaSoft no tiene guardado: hay que esperar a que venza (hasta 12 horas) y reprocesar.",
    };
  }
  return { ok: false, kind, code: r.result.code, message: r.result.message || humanError(r.result.code).title };
}

// -----------------------------------------------------------------------------
// Dependencias del worker
// -----------------------------------------------------------------------------
function makeDeps(admin: SupabaseClient, tenantId: string, s: Settings, emitter: { cuit: string | null }): WorkerDeps {
  const authCache = new Map<ArcaEnv, Promise<AuthOutcome>>();
  const rpc = async (fn: string, args: Record<string, unknown>) => {
    const { data, error } = await admin.rpc(fn, args);
    if (error) throw new Error(`${fn}: ${error.message}`);
    return data;
  };
  return {
    now: () => new Date(),
    auth: (env) => {
      let p = authCache.get(env);
      if (!p) {
        p = authFor(admin, tenantId, env, s.auth_mode, emitter.cuit);
        authCache.set(env, p);
      }
      return p;
    },
    wsfe: (env, opts) => createWsfeClient({ fetch: fetcher, endpoints: endpointsFor(env, envVars()), queryTimeoutMs: opts?.queryTimeoutMs }),
    // QR de un comprobante CAEA emitido sin acceso a ARCA: la CUIT del negocio.
    cuitFor: (_env, snap: Snapshot) => snap.emitter.cuit ?? emitter.cuit,
    db: {
      snapshot: async (id) => (await rpc("arca_snapshot", { p_doc: id })) as Snapshot | null,
      markSending: async (id, p) => void (await rpc("arca_mark_sending", { p_doc: id, p })),
      applyResult: async (id, p) => void (await rpc("arca_apply_result", { p_doc: id, p })),
      caeaIssue: async (id, p) => (await rpc("arca_caea_issue", { p_doc: id, p })) as never,
      setQr: async (id, url) => void (await rpc("arca_set_qr", { p_doc: id, p_url: url })),
      informResult: async (id, p) => void (await rpc("arca_caea_inform_result", { p_doc: id, p })),
    },
  };
}

interface RunResult {
  processed: { id: string; outcome: string; detail?: string }[];
  caea: unknown;
}

async function runTenant(admin: SupabaseClient, tenantId: string, opts: { ids?: string[]; limit?: number; caea?: boolean; deadline?: number }): Promise<RunResult> {
  const out: RunResult = { processed: [], caea: null };
  const s = await loadSettings(admin, tenantId);
  if (!s || !s.enabled) return out;
  const emitter = await emitterOf(admin, tenantId);
  const deps = makeDeps(admin, tenantId, s, emitter);
  const { data: claims, error } = await admin.rpc("arca_claim", {
    p_tenant: tenantId,
    p_limit: opts.limit ?? 10,
    p_ids: opts.ids ?? null,
  });
  if (error) throw new Error(`arca_claim: ${error.message}`);
  for (const c of (claims ?? []) as { id: string; recovering: boolean }[]) {
    if (opts.deadline && Date.now() > opts.deadline) {
      // Se libera: vuelve a la cola sin contar el intento como falla.
      await admin.rpc("arca_apply_result", {
        p_doc: c.id,
        p: { outcome: "reintentar", error_code: "presupuesto", error_msg: "Quedó para la próxima vuelta", keep_number: true, next_attempt_at: new Date().toISOString() },
      });
      continue;
    }
    try {
      const r = await processDocument(deps, c.id, c.recovering);
      out.processed.push({ id: c.id, ...r });
    } catch (e) {
      console.error(JSON.stringify({ fn: "arca_wsfe", tenant: tenantId, doc: c.id, error: String(e) }));
      out.processed.push({ id: c.id, outcome: "error" });
    }
  }
  if (opts.caea !== false && s.caea_enabled && s.caea_pto_vta) {
    const due = !s.caea_next_check_at || new Date(s.caea_next_check_at).getTime() <= Date.now();
    const { count } = await admin
      .from("fiscal_documents")
      .select("id", { count: "exact", head: true })
      .eq("tenant_id", tenantId)
      .eq("inform_status", "pendiente");
    if (due || (count ?? 0) > 0 || opts.caea) {
      out.caea = await runCaeaTasks(deps, caeaDb(admin, tenantId), emitter.iva_condition);
    }
  }
  console.log(JSON.stringify({ fn: "arca_wsfe", tenant: tenantId, processed: out.processed.length }));
  return out;
}

function caeaDb(admin: SupabaseClient, tenantId: string) {
  return {
    tasks: async () => {
      const { data } = await admin.rpc("arca_caea_tasks", { p_tenant: tenantId });
      return (data as CaeaTasks | null) ?? null;
    },
    store: async (env: ArcaEnv, p: Record<string, unknown>) => {
      await admin.rpc("arca_caea_store", { p_tenant: tenantId, p_env: env, p });
    },
    seriesSync: async (env: ArcaEnv, pv: number, tipo: number, last: number) => {
      await admin.rpc("arca_caea_series_sync", { p_tenant: tenantId, p_env: env, p_pto_vta: pv, p_cbte_tipo: tipo, p_last: last });
    },
    sinMovimiento: async (id: string, ok: boolean, message: string | null) => {
      await admin.rpc("arca_caea_sin_movimiento_result", { p_caea: id, p_ok: ok, p_message: message });
    },
    checked: async (next: Date, message: string) => {
      await admin.rpc("arca_caea_checked", { p_tenant: tenantId, p_next: next.toISOString(), p_message: message });
    },
  };
}

// -----------------------------------------------------------------------------
// Prueba de conexión
// -----------------------------------------------------------------------------
interface Step {
  key: string;
  ok: boolean;
  code?: string;
  message: string;
  title?: string;
  action?: string;
}

async function testConnection(admin: SupabaseClient, tenantId: string, env: ArcaEnv, userId: string) {
  const s = (await loadSettings(admin, tenantId)) ?? ({ auth_mode: "propio" } as Settings);
  const emitter = await emitterOf(admin, tenantId);
  const steps: Step[] = [];
  const t0 = Date.now();
  const fail = (key: string, code: string, message: string) => {
    const h = humanError(code, message);
    steps.push({ key, ok: false, code, message, title: h.title, action: h.action });
  };
  let pos: { nro: number; emisionTipo: string }[] = [];
  let cuit: string | null = null;

  const cr = await loadCreds(admin, tenantId, env, s.auth_mode, emitter.cuit);
  if (!cr.ok) {
    fail("certificado", cr.code, cr.message);
  } else {
    steps.push({ key: "certificado", ok: true, message: "Certificado listo" });
    cuit = cr.creds.cuit;
    const a = await authFor(admin, tenantId, env, s.auth_mode, emitter.cuit);
    if (!a.ok) {
      fail("wsaa", a.code, a.message);
    } else {
      steps.push({ key: "wsaa", ok: true, message: "ARCA aceptó el certificado" });
      const ws = createWsfeClient({ fetch: fetcher, endpoints: endpointsFor(env, envVars()) });
      const d = await ws.dummy();
      if (d.transport || !d.parsed?.ok) fail("dummy", "sin_respuesta", d.parsed ? `AppServer ${d.parsed.app} · DbServer ${d.parsed.db} · AuthServer ${d.parsed.auth}` : "ARCA no respondió");
      else steps.push({ key: "dummy", ok: true, message: "Servicio de facturación en línea" });

      const p = await ws.param(a.auth, "ptos_venta");
      if (p.transport || !p.parsed) {
        fail("ptos_venta", "sin_respuesta", "ARCA no respondió la consulta de puntos de venta");
      } else {
        const errs = p.parsed.errors.filter((e) => e.code !== "602");
        if (errs.length) {
          fail("ptos_venta", errs[0]?.code ?? "", joinMsgs(errs));
        } else {
          pos = activePointsOfSale(p.parsed.items);
          steps.push({ key: "ptos_venta", ok: true, message: pos.length ? `Puntos de venta: ${pos.map((x) => x.nro).join(", ")}` : "ARCA no informó puntos de venta para esta CUIT" });
        }
      }

      const { data: st } = await admin
        .from("stores")
        .select("afip_pos_number")
        .eq("tenant_id", tenantId)
        .is("deleted_at", null)
        .not("afip_pos_number", "is", null)
        .limit(1);
      const pv = ((st ?? []) as { afip_pos_number: number }[])[0]?.afip_pos_number ?? pos[0]?.nro ?? 1;
      const tipo = !emitter.iva_condition || emitter.iva_condition === "responsable_inscripto" ? 6 : 11;
      const u = await ws.ultimo(a.auth, pv, tipo);
      if (u.transport || !u.parsed) fail("ultimo", "sin_respuesta", "ARCA no respondió el último comprobante");
      else if (u.parsed.errors.length) fail("ultimo", u.parsed.errors[0]?.code ?? "", joinMsgs(u.parsed.errors));
      else steps.push({ key: "ultimo", ok: true, message: `Último comprobante autorizado en el punto de venta ${pv}: ${u.parsed.nro ?? 0}` });
    }
  }
  const ok = steps.every((x) => x.ok);
  await admin.rpc("arca_record_connection", {
    p_tenant: tenantId,
    p_env: env,
    p: {
      ok,
      full_test: ok,
      action: "test_conexion",
      message: ok ? "Conexión correcta" : steps.find((x) => !x.ok)?.message ?? "Error",
      error_code: steps.find((x) => !x.ok)?.code ?? null,
      duration_ms: Date.now() - t0,
      user_id: userId,
      ...(ok ? { pos: pos.filter((x) => !/caea/i.test(x.emisionTipo)).map((x) => x.nro) } : {}),
    },
  });
  return { ok, cuit, steps, pos };
}

// -----------------------------------------------------------------------------
// Certificados (negocio y plataforma)
// -----------------------------------------------------------------------------
async function orgName(admin: SupabaseClient, tenantId: string): Promise<string> {
  const { data: b } = await admin.from("tenant_branding").select("legal_name").eq("tenant_id", tenantId).maybeSingle();
  const legal = (b as { legal_name?: string | null } | null)?.legal_name;
  if (legal) return legal;
  const { data: t } = await admin.from("tenants").select("name").eq("id", tenantId).maybeSingle();
  return (t as { name?: string } | null)?.name ?? "NinjaSoft";
}

async function generateCsr(admin: SupabaseClient, tenantId: string, userId: string, env: ArcaEnv, body: Record<string, unknown>) {
  const emitter = await emitterOf(admin, tenantId);
  if (!emitter.cuit) return { ok: false, error: "fiscal_data_missing" };
  if (!masterKey()) return { ok: false, error: "server_not_configured" };
  const organization = String(body.organization ?? "").trim() || (await orgName(admin, tenantId));
  const alias = sanitizeAlias(String(body.alias ?? "")) || `ninjapos${emitter.cuit}`;
  const keyPem = await generateKeyPem();
  const csr = buildCsr(keyPem, { cuit: emitter.cuit, organization, alias });
  const keyEnc = await encryptSecret(keyPem, masterKey(), keyAad(tenantId, env));
  const { data, error } = await admin.rpc("arca_certificate_store", {
    p_tenant: tenantId,
    p_user: userId,
    p: { environment: env, status: "pending_csr", csr_pem: csr, key_enc: keyEnc, cuit: emitter.cuit, subject: `CN=${alias}` },
  });
  if (error) return { ok: false, error: "store_failed" };
  return { ok: true, csr_pem: csr, alias, cuit: emitter.cuit, organization, certificate_id: data };
}

async function uploadCertificate(admin: SupabaseClient, tenantId: string, userId: string, env: ArcaEnv, certPem: string) {
  const emitter = await emitterOf(admin, tenantId);
  const { data } = await admin
    .from("arca_certificates")
    .select("id, key_enc")
    .eq("tenant_id", tenantId)
    .eq("environment", env)
    .eq("status", "pending_csr")
    .is("deleted_at", null)
    .maybeSingle();
  const pend = data as { id: string; key_enc: string } | null;
  if (!pend) return { ok: false, error: "csr_faltante", messages: [humanError("csr_faltante", "Primero generá el pedido (CSR) en NinjaSoft")] };
  let keyPem: string;
  try {
    keyPem = await decryptSecret(pend.key_enc, masterKey(), keyAad(tenantId, env));
  } catch {
    return { ok: false, error: "certificado_ilegible", messages: [humanError("certificado_ilegible")] };
  }
  const chk = checkCertificate(certPem, keyPem, { cuit: emitter.cuit, issuerCn: EXPECTED_ISSUER_CN[env] });
  if (!chk.ok || !chk.info) {
    return { ok: false, error: "cert_check_failed", problems: chk.problems, messages: chk.problems.map((p) => ({ code: p, ...humanError(p) })) };
  }
  const i = chk.info;
  const { data: id, error } = await admin.rpc("arca_certificate_store", {
    p_tenant: tenantId,
    p_user: userId,
    p: {
      environment: env,
      status: "active",
      pending_id: pend.id,
      cert_pem: certPem.trim() + "\n",
      cuit: i.cuit,
      subject: i.subject,
      issuer: i.issuer,
      serial: i.serial,
      not_before: i.notBefore,
      not_after: i.notAfter,
      fingerprint_sha256: i.fingerprintSha256,
    },
  });
  if (error) return { ok: false, error: "store_failed" };
  return { ok: true, certificate: { id, environment: env, cuit: i.cuit, subject: i.subject, issuer: i.issuer, not_after: i.notAfter } };
}

async function platformAction(admin: SupabaseClient, userId: string, action: string, body: Record<string, unknown>) {
  const env = body.environment;
  if (!isEnv(env)) return json({ error: "invalid_environment" }, 400);
  if (action === "platform_set_cuit") {
    const cuit = String(body.cuit ?? "").replace(/\D/g, "");
    if (cuit && cuit.length !== 11) return json({ error: "invalid_cuit" }, 400);
    await admin.rpc("arca_platform_store", { p_user: userId, p_env: env, p: { cuit, audit_action: "arca_platform_cuit" } });
    return json({ ok: true });
  }
  const { data } = await admin.from("arca_platform").select("cuit, key_enc").eq("environment", env).maybeSingle();
  const p = data as { cuit: string | null; key_enc: string | null } | null;
  // ADR-133: certificado y clave privada que ya tiene NinjaSoft (generados
  // fuera, p. ej. con openssl). Se valida el par contra la CUIT y ARCA, la
  // clave se cifra con ARCA_KEY_ENC y nunca vuelve al navegador ni se loguea.
  // Rediseño (2026-10): llega también la CUIT de la empresa titular; tiene que
  // coincidir con la del certificado y se guarda como CUIT de la plataforma
  // (la representada en el padrón) en la misma escritura auditada.
  if (action === "platform_subir_par") {
    const bodyCuit = String(body.cuit ?? "").replace(/\D/g, "");
    if (bodyCuit && !cuitIsValid(bodyCuit)) {
      return json({ ok: false, error: "cert_check_failed", problems: ["cuit_invalida"], messages: [{ code: "cuit_invalida", title: "La CUIT no es válida", action: "Revisá los 11 números: el último es el dígito verificador." }] });
    }
    const expectedCuit = bodyCuit || p?.cuit || null;
    if (!expectedCuit) return json({ ok: false, error: "platform_cuit_missing" });
    const certPem = String(body.cert_pem ?? "");
    const keyPem = String(body.key_pem ?? "").trim();
    if (/^-----BEGIN ENCRYPTED PRIVATE KEY-----/.test(keyPem)) {
      return json({ ok: false, error: "cert_check_failed", problems: ["clave_con_contrasena"], messages: [{ code: "clave_con_contrasena", title: "La clave privada tiene contraseña", action: "Exportala sin contraseña (por ejemplo, openssl rsa -in clave.key -out clave-sin-pass.key) y volvé a cargarla." }] });
    }
    if (!/^-----BEGIN (RSA |EC )?PRIVATE KEY-----/.test(keyPem) || keyPem.length > 20_000) {
      return json({ ok: false, error: "cert_check_failed", problems: ["clave_invalida"], messages: [{ code: "clave_invalida", title: "La clave privada no es válida", action: "Cargá la clave en formato PEM (empieza con -----BEGIN PRIVATE KEY----- o -----BEGIN RSA PRIVATE KEY-----)." }] });
    }
    let chk: ReturnType<typeof checkCertificate>;
    try {
      chk = checkCertificate(certPem, keyPem, { cuit: expectedCuit, issuerCn: EXPECTED_ISSUER_CN[env] });
    } catch {
      return json({ ok: false, error: "cert_check_failed", problems: ["clave_invalida"], messages: [{ code: "clave_invalida", title: "No se pudo leer la clave privada", action: "Revisá que sea la clave del certificado y que no tenga contraseña." }] });
    }
    if (!chk.ok || !chk.info) {
      // Sólo metadatos públicos del certificado (nunca la clave) para explicar el error.
      const ci = chk.info;
      return json({
        ok: false,
        error: "cert_check_failed",
        problems: chk.problems,
        messages: chk.problems.map((x) => ({ code: x, ...humanError(x) })),
        certificate: ci ? { environment: env, cuit: ci.cuit, subject: ci.subject, issuer: ci.issuer, not_after: ci.notAfter } : undefined,
      });
    }
    const i = chk.info;
    const keyEnc = await encryptSecret(keyPem + "\n", masterKey(), keyAad("platform", env));
    const { error: storeErr } = await admin.rpc("arca_platform_store", {
      p_user: userId,
      p_env: env,
      p: {
        ...(bodyCuit ? { cuit: bodyCuit } : {}),
        key_enc: keyEnc,
        csr_pem: null,
        cert_pem: certPem.trim() + "\n",
        subject: i.subject,
        issuer: i.issuer,
        serial: i.serial,
        not_after: i.notAfter,
        fingerprint_sha256: i.fingerprintSha256,
        audit_action: "arca_platform_key_pair",
      },
    });
    if (storeErr) return json({ ok: false, error: "store_failed" });
    return json({ ok: true, certificate: { environment: env, cuit: i.cuit, subject: i.subject, issuer: i.issuer, not_before: i.notBefore, not_after: i.notAfter } });
  }
  if (!p?.cuit) return json({ ok: false, error: "platform_cuit_missing" });
  if (action === "platform_generar_csr") {
    const alias = sanitizeAlias(String(body.alias ?? "")) || "ninjasoftpos";
    const keyPem = await generateKeyPem();
    const csr = buildCsr(keyPem, { cuit: p.cuit, organization: String(body.organization ?? "NinjaSoft"), alias });
    const keyEnc = await encryptSecret(keyPem, masterKey(), keyAad("platform", env));
    await admin.rpc("arca_platform_store", { p_user: userId, p_env: env, p: { csr_pem: csr, key_enc: keyEnc, audit_action: "arca_platform_csr" } });
    return json({ ok: true, csr_pem: csr, alias });
  }
  if (action === "platform_subir_certificado") {
    if (!p.key_enc) return json({ ok: false, error: "csr_faltante" });
    const keyPem = await decryptSecret(p.key_enc, masterKey(), keyAad("platform", env));
    const certPem = String(body.cert_pem ?? "");
    const chk = checkCertificate(certPem, keyPem, { cuit: p.cuit, issuerCn: EXPECTED_ISSUER_CN[env] });
    if (!chk.ok || !chk.info) {
      return json({ ok: false, error: "cert_check_failed", problems: chk.problems, messages: chk.problems.map((x) => ({ code: x, ...humanError(x) })) });
    }
    const i = chk.info;
    await admin.rpc("arca_platform_store", {
      p_user: userId,
      p_env: env,
      p: {
        cert_pem: certPem.trim() + "\n",
        subject: i.subject,
        issuer: i.issuer,
        serial: i.serial,
        not_after: i.notAfter,
        fingerprint_sha256: i.fingerprintSha256,
        audit_action: "arca_platform_certificate",
      },
    });
    return json({ ok: true, certificate: { environment: env, cuit: i.cuit, subject: i.subject, issuer: i.issuer, not_before: i.notBefore, not_after: i.notAfter } });
  }
  return json({ error: "invalid_action" }, 400);
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
    const { data: due, error } = await admin.rpc("arca_due_tenants", { p_limit: 20 });
    if (error) return json({ error: "query_failed", detail: error.message }, 500);
    const out: unknown[] = [];
    for (const d of (due ?? []) as { tenant_id: string }[]) {
      if (Date.now() - t0 > CRON_BUDGET_MS) break;
      try {
        const r = await runTenant(admin, d.tenant_id, { limit: 10, deadline: t0 + CRON_BUDGET_MS + 10_000 });
        out.push({ tenant: d.tenant_id, processed: r.processed.length });
      } catch (e) {
        console.error(JSON.stringify({ fn: "arca_wsfe", tenant: d.tenant_id, error: String(e) }));
        out.push({ tenant: d.tenant_id, error: "failed" });
      }
    }
    return json({ ok: true, tenants: out, ms: Date.now() - t0 });
  }

  // --- Usuario ----------------------------------------------------------------
  const authHeader = req.headers.get("Authorization") ?? "";
  const userClient = createClient(url, anonKey, {
    global: { headers: { Authorization: authHeader } },
    auth: { persistSession: false },
  });
  const {
    data: { user },
    error: authErr,
  } = await userClient.auth.getUser();
  if (authErr || !user) return json({ error: "unauthorized" }, 401);
  const action = String(body.action ?? "");

  if (action.startsWith("platform_")) {
    if (!(user.app_metadata as { is_internal?: boolean } | null)?.is_internal) return json({ error: "forbidden" }, 403);
    if (!masterKey()) return json({ error: "server_not_configured" }, 500);
    return await platformAction(admin, user.id, action, body);
  }

  const tenantId = (user.app_metadata as { current_tenant_id?: string } | null)?.current_tenant_id;
  if (!tenantId) return json({ error: "no_tenant" }, 400);
  const member = action === "emitir_venta";
  const { data: guard, error: guardErr } = await admin.rpc("arca_edge_guard", {
    p_tenant: tenantId,
    p_user: user.id,
    p_write: true,
    p_member: member,
  });
  if (guardErr) return json({ error: "guard_failed" }, 500);
  if (guard) return json({ error: guard }, 403);

  const audit = (act: string, after: Record<string, unknown>) =>
    admin.from("audit_logs").insert({ tenant_id: tenantId, actor_user_id: user.id, entity_type: "arca", entity_id: null, action: act, after_data: after });

  const docStatus = async (id: string) => {
    const { data } = await admin
      .from("fiscal_documents")
      .select("id, status, emission_type, cae, cbte_nro, pto_vta, cbte_tipo, last_error_code, last_error_msg")
      .eq("id", id)
      .maybeSingle();
    return data;
  };

  if (action === "emitir_venta") {
    const saleId = String(body.sale_id ?? "");
    if (!/^[0-9a-f-]{36}$/i.test(saleId)) return json({ error: "invalid_sale_id" }, 400);
    const { data: doc } = await admin
      .from("fiscal_documents")
      .select("id, status")
      .eq("tenant_id", tenantId)
      .eq("sale_id", saleId)
      .eq("origin", "sale")
      .neq("status", "cancelado")
      .order("created_at", { ascending: false })
      .limit(1)
      .maybeSingle();
    const d = doc as { id: string; status: string } | null;
    if (!d) return json({ ok: true, outcome: "sin_factura" });
    if (d.status === "pendiente") {
      const r = await runTenant(admin, tenantId, { ids: [d.id], limit: 1, caea: false });
      return json({ ok: true, outcome: r.processed[0]?.outcome ?? "en_cola", document: await docStatus(d.id) });
    }
    return json({ ok: true, outcome: d.status, document: await docStatus(d.id) });
  }

  if (action === "emitir") {
    const id = typeof body.document_id === "string" ? body.document_id : null;
    const r = await runTenant(admin, tenantId, { ids: id ? [id] : undefined, limit: id ? 1 : 10 });
    await audit("arca_emit_manual", { document_id: id, processed: r.processed.length });
    return json({ ok: true, processed: r.processed, caea: r.caea });
  }

  if (action === "reintentar") {
    const id = String(body.document_id ?? "");
    if (!/^[0-9a-f-]{36}$/i.test(id)) return json({ error: "invalid_document_id" }, 400);
    // Como el usuario: la RPC valida rol, feature y estado, y audita.
    const { data: rr, error: rErr } = await userClient.rpc("arca_document_retry", { p_id: id });
    if (rErr) return json({ ok: false, error: rErr.message }, 400);
    const res = rr as { status: string };
    if (res.status !== "pendiente") return json({ ok: true, outcome: res.status, document: await docStatus(id) });
    const r = await runTenant(admin, tenantId, { ids: [id], limit: 1, caea: false });
    return json({ ok: true, outcome: r.processed[0]?.outcome ?? "en_cola", document: await docStatus(id) });
  }

  if (action === "caea_tareas") {
    const s = await loadSettings(admin, tenantId);
    if (!s?.caea_enabled) return json({ ok: false, error: "caea_disabled" });
    const emitter = await emitterOf(admin, tenantId);
    const run = await runCaeaTasks(makeDeps(admin, tenantId, s, emitter), caeaDb(admin, tenantId), emitter.iva_condition);
    await audit("arca_caea_manual", { run });
    return json({ ok: true, run });
  }

  const env: ArcaEnv = isEnv(body.environment) ? body.environment : ((await loadSettings(admin, tenantId))?.environment ?? "homologacion");

  if (action === "test_conexion") {
    const r = await testConnection(admin, tenantId, env, user.id);
    await audit("arca_connection_test", { environment: env, ok: r.ok, steps: r.steps.map((x) => ({ key: x.key, ok: x.ok, code: x.code ?? null })) });
    return json(r);
  }

  if (action === "generar_csr") {
    const r = await generateCsr(admin, tenantId, user.id, env, body);
    return json(r, r.ok ? 200 : 400);
  }

  if (action === "subir_certificado") {
    const r = await uploadCertificate(admin, tenantId, user.id, env, String(body.cert_pem ?? ""));
    return json(r);
  }

  if (action === "param" || action === "ultimo_autorizado") {
    const s = await loadSettings(admin, tenantId);
    const emitter = await emitterOf(admin, tenantId);
    const a = await authFor(admin, tenantId, env, s?.auth_mode ?? "propio", emitter.cuit);
    if (!a.ok) return json({ ok: false, error: a.code, message: a.message, ...humanError(a.code, a.message) });
    const ws = createWsfeClient({ fetch: fetcher, endpoints: endpointsFor(env, envVars()) });
    if (action === "ultimo_autorizado") {
      const pv = Number(body.pto_vta);
      const tipo = Number(body.cbte_tipo);
      if (!Number.isInteger(pv) || pv < 1 || !Number.isInteger(tipo)) return json({ error: "invalid_request" }, 400);
      const u = await ws.ultimo(a.auth as WsfeAuth, pv, tipo);
      if (u.transport || !u.parsed) return json({ ok: false, error: "sin_respuesta", ...humanError("sin_respuesta") });
      if (u.parsed.errors.length) {
        const k = classifyWsfeErrors(u.parsed.errors);
        return json({ ok: false, error: u.parsed.errors[0]?.code, kind: k, message: joinMsgs(u.parsed.errors) });
      }
      return json({ ok: true, nro: u.parsed.nro ?? 0 });
    }
    const table = String(body.table ?? "") as ParamTable;
    if (!(table in PARAM_OPS)) return json({ error: "invalid_table" }, 400);
    const p = await ws.param(a.auth as WsfeAuth, table, typeof body.clase === "string" ? body.clase : undefined);
    if (p.transport || !p.parsed) return json({ ok: false, error: "sin_respuesta", ...humanError("sin_respuesta") });
    const errs = p.parsed.errors.filter((e) => e.code !== "602");
    if (errs.length) return json({ ok: false, error: errs[0]?.code, message: joinMsgs(errs) });
    if (table === "ptos_venta") {
      const pos = activePointsOfSale(p.parsed.items);
      if (env === "produccion") {
        await admin.rpc("arca_record_connection", {
          p_tenant: tenantId,
          p_env: env,
          p: { ok: true, action: "param_ptos_venta", message: "Puntos de venta consultados", user_id: user.id, pos: pos.filter((x) => !/caea/i.test(x.emisionTipo)).map((x) => x.nro) },
        });
      }
      return json({ ok: true, items: p.parsed.items, pos });
    }
    return json({ ok: true, items: p.parsed.items });
  }

  return json({ error: "invalid_action", envs: ENVS }, 400);
});
