// =============================================================================
// _shared/mercadolibre/gestorWorker.ts (H141 · ADR-132, parte B). PURO
// (base y API inyectadas, como worker.ts).
//
//   refreshClaim     GET del reclamo + /detail + /v2/returns (siempre) +
//                    /affects-reputation -> ml_claim_upsert. Un /detail,
//                    retorno o "afecta" que falla no pisa lo conocido.
//   reconcileClaims  abiertos (sort=date_created:desc, sin sort ML repite
//                    filas) y cerrados de los últimos 3 días; relee sólo los
//                    que cambiaron en ML.
//   takeReputation   GET /users/{id} -> foto del día + avisos si una métrica
//                    empeoró contra la foto anterior.
// =============================================================================
import { MlApiError, type MlClient } from "./client.ts";
import { affectsFlag, claimPayload, type MlClaim, type MlClaimDetail, type MlReturn } from "./claims.ts";
import {
  METRIC_LABEL,
  cleanThresholds,
  crossings,
  snapshotFromReputation,
  type MlSellerReputation,
  type ReputationSnap,
  type Thresholds,
} from "./reputation.ts";

// deno-lint-ignore no-explicit-any
type Rpc = (fn: string, args: Record<string, unknown>) => Promise<any>;

export interface GestorDeps {
  rpc: Rpc;
  client(accountId: string): MlClient;
  now?: () => number;
}

const soft = async <T>(p: Promise<T>): Promise<T | null> => {
  try {
    return await p;
  } catch (e) {
    if (e instanceof MlApiError && e.code === "rate_limited") throw e;
    return null;
  }
};

export interface ClaimRefresh {
  status: "done" | "ignored";
  note?: string;
}

/** Relee un reclamo completo y lo guarda. `fallback`: la fila de la búsqueda si GET /claims/{id} da 403. */
export async function refreshClaim(deps: GestorDeps, accountId: string, claimId: string, fallback?: MlClaim | null): Promise<ClaimRefresh> {
  const client = deps.client(accountId);
  let claim: MlClaim | null = null;
  try {
    claim = await client.get<MlClaim>(`/post-purchase/v1/claims/${encodeURIComponent(claimId)}`);
  } catch (e) {
    if (e instanceof MlApiError && (e.code === "forbidden" || e.code === "not_found") && fallback) claim = fallback;
    else if (e instanceof MlApiError && e.code === "not_found") return { status: "ignored", note: "claim_not_found" };
    else throw e;
  }
  if (!claim) return { status: "ignored", note: "claim_not_found" };
  const [detail, ret, affects] = await Promise.all([
    soft(client.get<MlClaimDetail>(`/post-purchase/v1/claims/${claim.id}/detail`)),
    soft(client.get<MlReturn | MlReturn[]>(`/post-purchase/v2/claims/${claim.id}/returns`)),
    soft(client.get<unknown>(`/post-purchase/v1/claims/${claim.id}/affects-reputation`)),
  ]);
  const r = Array.isArray(ret) ? (ret[0] ?? null) : ret;
  // null de soft() = no se pudo leer: undefined para no pisar lo conocido.
  const payload = claimPayload(claim, detail, r ?? undefined, affects === null ? undefined : affectsFlag(affects));
  if (ret === null) {
    delete (payload as Record<string, unknown>).return_id;
    delete (payload as Record<string, unknown>).return_status;
  }
  const res = (await deps.rpc("ml_claim_upsert", { p_account: accountId, p: payload })) as { ok?: boolean; error?: string } | null;
  if (res && res.ok === false) return { status: "ignored", note: res.error ?? "ignored" };
  return { status: "done" };
}

interface ClaimSearch {
  paging?: { total?: number; offset?: number; limit?: number };
  data?: MlClaim[];
}

/** Reconciliación de reclamos de una cuenta (abiertos + cerrados recientes). */
export async function reconcileClaims(
  deps: GestorDeps,
  accountId: string,
  opts: { maxOpen?: number; budgetMs?: number } = {},
): Promise<{ seen: number; refreshed: number }> {
  const client = deps.client(accountId);
  const now = deps.now ?? Date.now;
  const t0 = now();
  const max = opts.maxOpen ?? 200;
  const rows = new Map<string, MlClaim>();
  for (let offset = 0; offset < max; offset += 50) {
    const page = await client.get<ClaimSearch>("/post-purchase/v1/claims/search", {
      status: "opened",
      sort: "date_created:desc",
      limit: 50,
      offset,
    });
    for (const c of page.data ?? []) rows.set(String(c.id), c);
    if ((page.data ?? []).length < 50) break;
  }
  const since = new Date(now() - 3 * 86400_000).toISOString();
  const closed = await soft(
    client.get<ClaimSearch>("/post-purchase/v1/claims/search", {
      status: "closed",
      range: `last_updated:after:${since}`,
      sort: "date_created:desc",
      limit: 50,
    }),
  );
  for (const c of closed?.data ?? []) rows.set(String(c.id), c);
  if (rows.size === 0) return { seen: 0, refreshed: 0 };

  const ids = [...rows.keys()].map(Number);
  const known = ((await deps.rpc("ml_claims_stamp", { p_account: accountId, p_ids: ids })) ?? []) as Array<{
    claim_id: number | string;
    ml_last_updated: string | null;
    status: string;
  }>;
  const stamp = new Map(known.map((k) => [String(k.claim_id), k]));
  let refreshed = 0;
  for (const [id, row] of rows) {
    if (opts.budgetMs && now() - t0 > opts.budgetMs) break;
    const k = stamp.get(id);
    const changed =
      !k || !k.ml_last_updated || !row.last_updated || Date.parse(row.last_updated) > Date.parse(k.ml_last_updated) || k.status !== row.status;
    if (!changed) continue;
    const r = await refreshClaim(deps, accountId, id, row);
    if (r.status === "ignored" && r.note === "feature_off") break;
    refreshed++;
  }
  return { seen: rows.size, refreshed };
}

/** Foto de reputación del día con los avisos de métricas que empeoraron. */
export async function takeReputation(
  deps: GestorDeps,
  accountId: string,
  mlUserId: number | string,
  thresholds?: Partial<Thresholds> | null,
): Promise<{ snap: ReputationSnap; alerts: number; saved: boolean }> {
  const user = await deps.client(accountId).get<{ seller_reputation?: MlSellerReputation }>(`/users/${encodeURIComponent(String(mlUserId))}`);
  const snap = snapshotFromReputation(user.seller_reputation);
  const prev = ((await deps.rpc("ml_reputation_last", { p_account: accountId })) ?? null) as ReputationSnap | null;
  const alerts = crossings(prev, snap, cleanThresholds(thresholds)).map((c) => ({
    key: c.key,
    from: c.from,
    to: c.to === "rojo" ? "rojo" : "ámbar",
    label: METRIC_LABEL[c.key],
  }));
  const res = (await deps.rpc("ml_reputation_snapshot_save", { p_account: accountId, p: snap, p_alerts: alerts })) as { ok?: boolean } | null;
  return { snap, alerts: alerts.length, saved: res?.ok !== false };
}
