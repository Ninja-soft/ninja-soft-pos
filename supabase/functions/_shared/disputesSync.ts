// =============================================================================
// Contracargos, reclamos y devoluciones de Mercado Pago (ADR-064): lado Deno.
//
//  * syncDisputes(admin, tenant, scope, token, pagos): a partir de los pagos
//    que ya trajo la sincronización (payments/search) arma las disputas,
//    cierra las que dejaron de estar abiertas, completa los contracargos con
//    GET /v1/chargebacks/{id} y las guarda con _payment_disputes_upsert
//    (service_role: vincula con la venta, audita y avisa).
//  * scanRecentPayments(token, desde): pagos actualizados en la ventana
//    (range = date_last_updated). Lo usa el cron para los negocios sin la
//    conciliación: los contracargos llegan semanas después de la venta.
//  * fetchChargeback / findChargebackForPayment / fetchClaim: API de MP.
//
// Nunca se confía en un aviso: todo se vuelve a leer con la credencial del
// negocio.
// =============================================================================
import { MP_API, mpHeaders } from "./mpAuth.ts";
import {
  type DisputeInput,
  type OpenDispute,
  dedupeDisputes,
  mergeMpChargeback,
  mpDisputesFromPayment,
  staleDisputeUpdates,
} from "./paymentDisputes.ts";

// deno-lint-ignore no-explicit-any
type Admin = any;

const PAGE = 100;
/** Consultas de casos de contracargo por corrida y alcance (límite de tasa de MP). */
const MAX_CASE_LOOKUPS = 15;

export type DisputeSyncResult = {
  items: number;
  inserted: number;
  updated: number;
  notified: number;
  error?: string;
};

async function callerId(token: string): Promise<string | null> {
  try {
    const r = await fetch(`${MP_API}/users/me`, { headers: mpHeaders(token) });
    if (!r.ok) return null;
    const b = (await r.json().catch(() => null)) as { id?: number | string } | null;
    return b?.id != null ? String(b.id) : null;
  } catch {
    return null;
  }
}

function cbHeaders(token: string, caller: string | null): Record<string, string> {
  const h = mpHeaders(token);
  if (caller) h["X-Caller-Id"] = caller;
  return h;
}

/** GET /v1/chargebacks/{id} (documentado). */
export async function fetchChargeback(token: string, id: string, caller: string | null): Promise<unknown | null> {
  if (!/^[0-9A-Za-z_-]{1,64}$/.test(id)) return null;
  try {
    const r = await fetch(`${MP_API}/v1/chargebacks/${id}`, { headers: cbHeaders(token, caller) });
    return r.ok ? await r.json().catch(() => null) : null;
  } catch {
    return null;
  }
}

/**
 * Caso de contracargo de un pago. MP no documenta una búsqueda por pago:
 * se prueba GET /v1/chargebacks/search?payment_id= y, si no responde, queda
 * el contracargo armado desde el pago (sin plazo) hasta que llegue el aviso.
 */
export async function findChargebackForPayment(token: string, paymentId: string, caller: string | null): Promise<unknown | null> {
  if (!/^\d{1,30}$/.test(paymentId)) return null;
  try {
    const r = await fetch(`${MP_API}/v1/chargebacks/search?payment_id=${paymentId}`, { headers: cbHeaders(token, caller) });
    if (!r.ok) return null;
    const b = (await r.json().catch(() => null)) as { results?: unknown[]; elements?: unknown[] } | unknown[] | null;
    const list = Array.isArray(b) ? b : (b?.results ?? b?.elements ?? []);
    return list[0] ?? null;
  } catch {
    return null;
  }
}

/** GET /post-purchase/v1/claims/{id}. */
export async function fetchClaim(token: string, id: string): Promise<unknown | null> {
  if (!/^\d{1,30}$/.test(id)) return null;
  try {
    const r = await fetch(`${MP_API}/post-purchase/v1/claims/${id}`, { headers: mpHeaders(token) });
    return r.ok ? await r.json().catch(() => null) : null;
  } catch {
    return null;
  }
}

/** GET /v1/payments/{id}. */
export async function fetchPayment(token: string, id: string): Promise<unknown | null> {
  if (!/^\d{1,30}$/.test(id)) return null;
  try {
    const r = await fetch(`${MP_API}/v1/payments/${id}`, { headers: mpHeaders(token) });
    return r.ok ? await r.json().catch(() => null) : null;
  } catch {
    return null;
  }
}

/** Pagos actualizados desde `from` (date_last_updated), con tope. */
export async function scanRecentPayments(
  token: string,
  from: Date,
  to: Date,
  max = 1000,
): Promise<{ results: unknown[]; error?: string }> {
  const results: unknown[] = [];
  for (let offset = 0; offset < max; offset += PAGE) {
    const q = new URLSearchParams({
      sort: "date_last_updated",
      criteria: "desc",
      range: "date_last_updated",
      begin_date: from.toISOString(),
      end_date: to.toISOString(),
      limit: String(PAGE),
      offset: String(offset),
    });
    const r = await fetch(`${MP_API}/v1/payments/search?${q.toString()}`, { headers: mpHeaders(token) });
    if (!r.ok) return { results, error: `mp_search_${r.status}` };
    const body = (await r.json().catch(() => null)) as { results?: unknown[]; paging?: { total?: number } } | null;
    const page = body?.results ?? [];
    results.push(...page);
    if (page.length < PAGE || offset + PAGE >= Number(body?.paging?.total ?? 0)) break;
  }
  return { results };
}

async function openDisputes(admin: Admin, tenantId: string): Promise<OpenDispute[]> {
  const { data, error } = await admin
    .from("payment_disputes")
    .select("dispute_key, kind, provider_payment_id, provider_case_id, status")
    .eq("tenant_id", tenantId)
    .eq("provider_key", "mercadopago")
    .is("resolved_at", null)
    .in("kind", ["chargeback", "claim"])
    .limit(1000);
  if (error) return [];
  return (data ?? []) as OpenDispute[];
}

/** El negocio recibe alertas (feature BASE alertas_contracargos). */
export async function disputesEnabled(admin: Admin, tenantId: string): Promise<boolean> {
  const { data } = await admin.rpc("tenant_has_feature_for", { p_tenant: tenantId, p_key: "alertas_contracargos" });
  return data === true;
}

export async function saveDisputes(
  admin: Admin,
  tenantId: string,
  scope: string | null,
  items: DisputeInput[],
  actor: string | null,
): Promise<Omit<DisputeSyncResult, "items">> {
  const acc = { inserted: 0, updated: 0, notified: 0 };
  for (let i = 0; i < items.length; i += 500) {
    const { data, error } = await admin.rpc("_payment_disputes_upsert", {
      p_tenant: tenantId,
      p_items: items.slice(i, i + 500),
      p_scope: scope,
      p_actor: actor,
    });
    if (error) return { ...acc, error: `disputes_failed: ${error.message}` };
    const d = (data ?? {}) as Partial<typeof acc>;
    acc.inserted += d.inserted ?? 0;
    acc.updated += d.updated ?? 0;
    acc.notified += d.notified ?? 0;
  }
  return acc;
}

/**
 * Disputas de los pagos traídos: arma, cierra lo viejo, completa contracargos
 * y guarda. Sin pagos con disputas y sin nada abierto, no llama a la RPC.
 */
export async function syncDisputes(
  admin: Admin,
  tenantId: string,
  scope: string | null,
  token: string,
  payments: unknown[],
  actor: string | null,
): Promise<DisputeSyncResult> {
  const fresh = payments.flatMap(mpDisputesFromPayment);
  const open = await openDisputes(admin, tenantId);
  const stale = staleDisputeUpdates(open, payments);
  let items = dedupeDisputes([...fresh, ...stale]);
  if (items.length === 0) return { items: 0, inserted: 0, updated: 0, notified: 0 };

  // Contracargos abiertos: completar con el caso (plazo, cobertura, motivo).
  const knownCase = new Map(open.filter((o) => o.provider_case_id).map((o) => [o.dispute_key, o.provider_case_id!]));
  const toEnrich = items.filter((d) => d.kind === "chargeback" && !d.resolved).slice(0, MAX_CASE_LOOKUPS);
  if (toEnrich.length > 0) {
    const caller = await callerId(token);
    const enriched = new Map<string, DisputeInput>();
    for (const d of toEnrich) {
      const caseId = d.provider_case_id ?? knownCase.get(d.dispute_key) ?? null;
      const cb = caseId
        ? await fetchChargeback(token, caseId, caller)
        : await findChargebackForPayment(token, d.provider_payment_id, caller);
      const merged = cb ? mergeMpChargeback(d, cb) : null;
      if (merged) enriched.set(d.dispute_key, merged);
    }
    items = items.map((d) => enriched.get(d.dispute_key) ?? d);
  }

  const saved = await saveDisputes(admin, tenantId, scope, items, actor);
  return { items: items.length, ...saved };
}
