// Maestro de motivos de reclamo de Mercado Libre (ADR-145): búsqueda,
// agrupado por tipo y título para mostrar. Puro y testeado.

import {
  FAMILY_LABELS,
  FAMILY_ORDER,
  RECOMMENDED_REASONS,
  reasonFamily,
  type ReasonFamily,
} from "@/supabase/functions/_shared/mercadolibre/reasons";

export { FAMILY_LABELS, RECOMMENDED_REASONS, reasonFamily, type ReasonFamily };
export { parseReasonCodes, REASON_CODE_RE } from "@/supabase/functions/_shared/mercadolibre/reasons";

/** Lo que lee la UI de `ml_claim_reasons`. */
export type ClaimReason = {
  id: string;
  family: ReasonFamily;
  title: string;
  description: string | null;
  flow: string | null;
  alias_of: string | null;
  excludable: boolean;
  recommended: boolean;
  active: boolean;
};

export type ReasonIndex = Map<string, ClaimReason>;

export const indexReasons = (rows: ClaimReason[] | undefined): ReasonIndex => new Map((rows ?? []).map((r) => [r.id, r]));

const fold = (s: string) =>
  s
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase();

/** Título del motivo; si no está en el maestro, la familia (PDD, PNR, CS). */
export function reasonTitleOf(index: ReasonIndex | undefined, id: string | null | undefined): string {
  if (!id) return "Sin motivo";
  const r = index?.get(id.toUpperCase());
  if (r) return r.title;
  const f = reasonFamily(id);
  return f === "OTRO" ? "Otro motivo" : FAMILY_LABELS[f];
}

/**
 * Busca por código, título o descripción (sin acentos ni mayúsculas, todas
 * las palabras). Ordena: código exacto, recomendados, que suelen excluirse,
 * activos y por título.
 */
export function searchReasons(rows: ClaimReason[], query: string, opts: { onlyExcludable?: boolean; limit?: number } = {}): ClaimReason[] {
  const q = fold(query.trim());
  const words = q.split(/\s+/).filter(Boolean);
  const exact = query.trim().toUpperCase();
  const out = rows.filter((r) => {
    if (opts.onlyExcludable && !r.excludable) return false;
    if (!words.length) return true;
    const hay = fold(`${r.id} ${r.title} ${r.description ?? ""}`);
    return words.every((w) => hay.includes(w));
  });
  const score = (r: ClaimReason) => (r.id === exact ? 0 : 10) + (r.recommended ? 0 : 4) + (r.excludable ? 0 : 2) + (r.active ? 0 : 1);
  out.sort((a, b) => score(a) - score(b) || a.title.localeCompare(b.title, "es") || a.id.localeCompare(b.id));
  return opts.limit ? out.slice(0, opts.limit) : out;
}

/** Agrupa por tipo en el orden PDD, PNR, CS, otros; sin grupos vacíos. */
export function groupByFamily(rows: ClaimReason[]): Array<{ family: ReasonFamily; label: string; items: ClaimReason[] }> {
  return FAMILY_ORDER.map((family) => ({ family, label: FAMILY_LABELS[family], items: rows.filter((r) => r.family === family) })).filter(
    (g) => g.items.length > 0,
  );
}

/** Códigos que no están en el maestro (para completarlos desde la API). */
export function missingReasons(index: ReasonIndex | undefined, ids: Array<string | null | undefined>): string[] {
  if (!index) return [];
  const out: string[] = [];
  for (const raw of ids) {
    const id = (raw ?? "").toUpperCase();
    if (id && /^[A-Z]{2,4}\d{3,5}$/.test(id) && !index.has(id) && !out.includes(id)) out.push(id);
  }
  return out;
}
