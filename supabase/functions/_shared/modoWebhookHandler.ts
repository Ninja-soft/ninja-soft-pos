// =============================================================================
// _shared/modoWebhookHandler.ts (SEC-63)
//
// Lógica del webhook de MODO (modo_webhook), separada de Deno.serve para que
// la prueben los tests de Vitest (tests/unit/modoWebhook.test.ts) con una base
// y una API de MODO falsas. Mismo patrón que _shared/mpWebhookHandlers.ts
// (OPS-23): sin imports de URL ni Deno.*; la base, la credencial, la red y el
// log llegan por `deps`. modo_webhook/index.ts arma las deps reales y llama al
// handler dentro de withWebhookLog.
//
// ANTIFRAUDE — NO se aplica ningún estado sobre la sola palabra del cuerpo:
//   1. (obligatorio) el evento DEBE referenciar ESTE intent: la referencia
//      externa del comercio (external_intention_id, que seteamos = intent.id en
//      modo_create_qr) tiene que estar presente y matchear el intentId del
//      query. Si no, 200 sin escribir.
//   2. (obligatorio) re-consulta a la API de MODO con un token del comercio
//      (client_credentials, las mismas credenciales que usó el checkout) la
//      intención por su id. El ÚNICO estado que se aplica es el que devuelve
//      esa consulta; "approved" además exige el monto esperado
//      (mp_payment_intents.amount, tolerancia de centavos).
//   3. SEC-63: si la re-consulta falla (red, timeout, HTTP no-2xx del token o
//      de la intención, respuesta ilegible) se responde 503 para que MODO
//      reintente y NO se escribe nada. Antes se aplicaban rejected / cancelled
//      / expired del cuerpo sin verificar: quien conociera el uuid del intent
//      podía cancelar un cobro pendiente.
//      Sin credenciales del negocio o sin id de intención de MODO no hay
//      re-consulta posible y reintentar no lo arregla: 200 sin escribir,
//      registrado como error (wh.fail). Una respuesta 2xx de MODO sin estado
//      legible tampoco aplica nada (200 + wh.fail).
//
// ⚠️ LIMITACIÓN DOCUMENTADA — API DE MODO ⚠️
// MODO no publica abiertamente el contrato de su API de e-commerce/QR para
// comercios (ver modo_create_qr). Base URL, paths, headers, nombres de campos y
// códigos de estado están marcados "VALIDAR MODO" y deben confirmarse contra la
// doc/credenciales reales. Mientras tanto, el webhook sólo cambia el estado del
// intent cuando la re-consulta lo confirma; si no, el intent queda como estaba
// (el POS sigue consultando con modo_status / vence solo).
// =============================================================================
import { readJsonLimited } from "./requestGuard.ts";
import type { WebhookCtx } from "./webhookLog.ts";

// ---------------------------------------------------------------------------
// Puertos
// ---------------------------------------------------------------------------

export type ModoDbResult = { data: unknown; error?: unknown };

/** Lo mínimo del query builder de supabase-js que usa el webhook. */
export interface ModoWebhookQuery extends PromiseLike<ModoDbResult> {
  select(columns: string): ModoWebhookQuery;
  update(values: Record<string, unknown>): ModoWebhookQuery;
  eq(column: string, value: unknown): ModoWebhookQuery;
  neq(column: string, value: unknown): ModoWebhookQuery;
  maybeSingle(): PromiseLike<ModoDbResult>;
}

/** Cliente service_role (en la Edge, el de createClient). */
export interface ModoWebhookDb {
  from(table: string): ModoWebhookQuery;
}

export type ModoSecrets = { client_id?: string; client_secret?: string };

export interface ModoWebhookDeps {
  /** Crea el cliente service_role (se llama recién al procesar). */
  db: () => ModoWebhookDb;
  /**
   * Credencial MODO con la que se creó el cobro (loadProviderSecret con el
   * alcance de intentSecretScope). null si no hay.
   */
  loadSecret: (db: ModoWebhookDb, tenantId: string, intentId: string) => Promise<ModoSecrets | null>;
  fetch: (url: string, init: RequestInit) => Promise<Response>;
  /** ⚠️ VALIDAR MODO — endpoints (mismos overrides que modo_create_qr). */
  tokenUrl: string;
  intentUrl: string;
  log: { error(message: string, data?: unknown): void };
  /** Tope de cada llamada a MODO (default MODO_READ_TIMEOUT_MS). */
  timeoutMs?: number;
}

export const AMOUNT_TOLERANCE = 0.01;
/** Tope de cada llamada a MODO (token y consulta de la intención). */
export const MODO_READ_TIMEOUT_MS = 8000;

// ⚠️ VALIDAR MODO — valores de estado de MODO → estado interno.
export function mapModoStatus(raw: string): string {
  const s = (raw ?? "").toString().trim().toLowerCase();
  if (["approved", "accredited", "aprobado", "acreditado", "success", "paid"].includes(s)) return "approved";
  if (["rejected", "rechazado", "failed", "error", "declined"].includes(s)) return "rejected";
  if (["cancelled", "canceled", "cancelado", "expired", "expirado"].includes(s))
    return s.startsWith("exp") ? "expired" : "cancelled";
  // pending / processing / created / in_process / etc.
  return "pending";
}

// ⚠️ VALIDAR MODO — extrae estado/monto/referencia de la respuesta de la
// re-consulta de la intención, probando los nombres de campo más probables.
export type ModoView = { status: string; amount: number | null; extRef: string };
export function readModo(obj: Record<string, unknown> | undefined): ModoView {
  const o = obj ?? {};
  const status = (o.status as string) ?? (o.state as string) ?? (o.estado as string) ?? "";
  const amountRaw = o.amount ?? o.price ?? o.total ?? o.paid_amount ?? o.transaction_amount ?? null;
  const amount = amountRaw == null || amountRaw === "" ? null : Number(amountRaw);
  const extRef =
    (o.external_intention_id as string) ?? (o.external_reference as string) ?? (o.reference as string) ?? "";
  return { status, amount: Number.isFinite(amount as number) ? (amount as number) : null, extRef };
}

const ok = () =>
  new Response(JSON.stringify({ ok: true }), {
    status: 200,
    headers: { "Content-Type": "application/json" },
  });

/** SEC-63: no se pudo re-consultar a MODO → MODO reintenta; nada se escribió. */
const retryLater = () =>
  new Response(JSON.stringify({ ok: false, retry: true }), {
    status: 503,
    headers: { "Content-Type": "application/json", "Retry-After": "60" },
  });

/** fetch con tope (AbortController). Lanza ante red caída o timeout. */
async function fetchWithTimeout(
  doFetch: ModoWebhookDeps["fetch"],
  url: string,
  init: RequestInit,
  ms: number,
): Promise<Response> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), ms);
  try {
    return await doFetch(url, { ...init, signal: ctrl.signal });
  } finally {
    clearTimeout(timer);
  }
}

type Reconsult = { ok: true; view: ModoView } | { ok: false; reason: string };

/** Token client_credentials + GET de la intención. Cualquier falla → ok:false. */
async function reconsultModo(
  deps: ModoWebhookDeps,
  sec: Required<ModoSecrets>,
  modoIntentId: string,
  intentId: string,
): Promise<Reconsult> {
  const ms = deps.timeoutMs ?? MODO_READ_TIMEOUT_MS;
  try {
    // Paso 1: token client_credentials (igual que modo_create_qr).
    const tokRes = await fetchWithTimeout(
      deps.fetch,
      deps.tokenUrl,
      {
        method: "POST",
        headers: { "Content-Type": "application/json", Accept: "application/json" },
        body: JSON.stringify({
          client_id: sec.client_id,
          client_secret: sec.client_secret,
          grant_type: "client_credentials",
        }),
      },
      ms,
    );
    if (!tokRes.ok) {
      deps.log.error("[modo_webhook] reconsult_auth_error", { intentId, status: tokRes.status });
      return { ok: false, reason: `MODO rechazó el token (${tokRes.status})` };
    }
    const tok = (await tokRes.json()) as { access_token?: string; token?: string };
    const accessToken = tok.access_token ?? tok.token ?? "";
    if (!accessToken) {
      deps.log.error("[modo_webhook] reconsult_auth_without_token", { intentId });
      return { ok: false, reason: "MODO no devolvió token" };
    }

    // Paso 2: GET de la intención por su id de MODO.
    const qRes = await fetchWithTimeout(
      deps.fetch,
      `${deps.intentUrl}/${encodeURIComponent(modoIntentId)}`,
      { headers: { Authorization: `Bearer ${accessToken}`, Accept: "application/json" } },
      ms,
    );
    if (!qRes.ok) {
      deps.log.error("[modo_webhook] reconsult_http_error", { intentId, status: qRes.status });
      return { ok: false, reason: `MODO respondió ${qRes.status} al re-consultar` };
    }
    const raw = (await qRes.json()) as Record<string, unknown>;
    const inner =
      (raw.data as Record<string, unknown> | undefined) ??
      (raw.payment_intention as Record<string, unknown> | undefined) ??
      raw;
    return { ok: true, view: readModo(inner) };
  } catch (e) {
    deps.log.error("[modo_webhook] reconsult_unreachable", { intentId, detail: String(e).slice(0, 200) });
    return { ok: false, reason: `MODO no respondió: ${String(e).slice(0, 200)}` };
  }
}

type ModoBodyRef = {
  status?: string;
  state?: string;
  payment_id?: string;
  id?: string;
  payment_intention_id?: string;
  external_intention_id?: string;
};
// ⚠️ VALIDAR MODO — forma del body de la notificación.
type ModoBody = ModoBodyRef & { estado?: string; data?: ModoBodyRef };

type IntentRow = { id: string; tenant_id: string; amount: unknown; status: string; preference_id: string | null };

export async function handleModoWebhook(req: Request, wh: WebhookCtx, deps: ModoWebhookDeps): Promise<Response> {
  try {
    const reqUrl = new URL(req.url);
    const intentId = reqUrl.searchParams.get("intent");
    if (!intentId || req.method !== "POST") return ok();
    wh.ref(intentId);

    let body: ModoBody;
    try {
      body = (await readJsonLimited(req)) as ModoBody;
    } catch {
      return ok();
    }
    if (!body || typeof body !== "object") return ok();

    const d: ModoBodyRef = body.data ?? body;

    // Antifraude #1 (OBLIGATORIO): el evento tiene que referenciar ESTE intent.
    const extRef = d.external_intention_id ?? body.external_intention_id;
    if (!extRef || extRef !== intentId) {
      deps.log.error("[modo_webhook] missing_or_mismatched_external_ref, ignoring", {
        intentId,
        extRef: extRef ?? null,
      });
      return ok();
    }

    const admin = deps.db();
    const { data } = await admin
      .from("mp_payment_intents")
      .select("id, tenant_id, amount, status, preference_id")
      .eq("id", intentId)
      .eq("provider_key", "modo")
      .maybeSingle();
    const intent = data as IntentRow | null;
    if (!intent) return ok();
    wh.tenant(intent.tenant_id);
    if (intent.status === "approved") return ok(); // idempotencia barata.

    const modoPaymentId = d.payment_id ?? d.id ?? body.payment_id ?? body.id ?? null;
    const modoIntentId = intent.preference_id ?? d.payment_intention_id ?? body.payment_intention_id ?? null;

    // ── Antifraude #2: re-consulta a MODO (única fuente del estado). ─────────
    const sec = (await deps.loadSecret(admin, intent.tenant_id, intent.id)) ?? {};
    if (!sec.client_id || !sec.client_secret || !modoIntentId) {
      // Sin re-consulta posible y reintentar no lo arregla: no se aplica nada.
      deps.log.error("[modo_webhook] unverifiable_no_credentials, ignoring body status", {
        intentId,
        hasCredentials: Boolean(sec.client_id && sec.client_secret),
        hasModoIntentId: Boolean(modoIntentId),
      });
      wh.fail("unverifiable: sin credenciales de MODO o sin id de intención");
      return ok();
    }

    const r = await reconsultModo(
      deps,
      { client_id: sec.client_id, client_secret: sec.client_secret },
      String(modoIntentId),
      intentId,
    );
    if (!r.ok) {
      // SEC-63: nada del cuerpo se aplica; MODO reintenta.
      wh.fail(r.reason);
      return retryLater();
    }
    const verified = r.view;

    if (verified.extRef && verified.extRef !== intentId) {
      deps.log.error("[modo_webhook] reconsult_reference_mismatch, leaving pending", {
        intentId,
        extRef: verified.extRef,
      });
      wh.fail("reference_mismatch");
      return ok();
    }
    if (!verified.status) {
      // Respuesta 2xx sin estado legible (contrato "VALIDAR MODO"): no se
      // completa con el estado del cuerpo.
      deps.log.error("[modo_webhook] reconsult_without_status, ignoring body status", { intentId });
      wh.fail("reconsult_without_status");
      return ok();
    }

    const finalStatus = mapModoStatus(verified.status);
    if (finalStatus === "approved") {
      const paid = verified.amount;
      const expected = Number(intent.amount);
      if (paid == null || Math.abs(paid - expected) > AMOUNT_TOLERANCE) {
        deps.log.error("[modo_webhook] reconsult_amount_mismatch, leaving pending (NOT crediting)", {
          intentId,
          paid,
          expected,
        });
        wh.fail("amount_mismatch");
        return ok();
      }
    }

    await admin
      .from("mp_payment_intents")
      .update({
        status: finalStatus,
        mp_payment_id: modoPaymentId ? String(modoPaymentId) : intent.preference_id,
      })
      .eq("id", intentId)
      .neq("status", "approved");

    wh.done();
    return ok();
  } catch (e) {
    deps.log.error("[modo_webhook] unexpected", String(e).slice(0, 200));
    wh.fail(e);
    return ok();
  }
}
