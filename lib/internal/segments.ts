// =============================================================================
// Segmentos de negocios para anuncios desde /internal/notificaciones
// (F7 · H13b, ADR-084). Misma regla que la RPC internal_segment_tenants: la UI
// previsualiza a quién llega y el servidor vuelve a resolverlo al enviar.
// =============================================================================

export const SEGMENT_PLANS = ["start", "pro", "business", "enterprise"] as const;
export const SEGMENT_STATUSES = ["trial", "active", "past_due", "suspended", "cancelled"] as const;

export const SEGMENT_PLAN_LABELS: Record<string, string> = {
  start: "Start",
  pro: "Pro",
  business: "Business",
  enterprise: "Enterprise",
};

export const SEGMENT_STATUS_LABELS: Record<string, string> = {
  trial: "Trial",
  active: "Activo",
  past_due: "Pago pendiente",
  suspended: "Suspendido",
  cancelled: "Cancelado",
};

export interface Segment {
  plans: string[];
  statuses: string[];
  industries: string[];
  /** YYYY-MM-DD inclusive, "" sin límite. */
  createdFrom: string;
  createdTo: string;
}

export const EMPTY_SEGMENT: Segment = {
  plans: [],
  statuses: [],
  industries: [],
  createdFrom: "",
  createdTo: "",
};

export interface SegmentTenant {
  id: string;
  name: string;
  status: string;
  subStatus: string | null;
  planFamily: string | null;
  industry: string | null;
  created_at: string;
  deletedAt: string | null;
}

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

export function isEmptySegment(s: Segment): boolean {
  return (
    s.plans.length === 0 &&
    s.statuses.length === 0 &&
    s.industries.length === 0 &&
    !s.createdFrom &&
    !s.createdTo
  );
}

export function segmentError(s: Segment): string | null {
  if (isEmptySegment(s)) return "Elegí al menos un criterio (plan, estado, rubro o fecha de alta).";
  if (s.createdFrom && !DATE_RE.test(s.createdFrom)) return "Fecha desde inválida.";
  if (s.createdTo && !DATE_RE.test(s.createdTo)) return "Fecha hasta inválida.";
  if (s.createdFrom && s.createdTo && s.createdFrom > s.createdTo)
    return "La fecha desde es posterior a la fecha hasta.";
  return null;
}

// Fecha de alta del negocio en la zona del navegador del staff es ambigua;
// se compara con el día UTC como hace la RPC (created_at >= from::date).
function dayOf(iso: string): string {
  return iso.slice(0, 10);
}

export function matchesSegment(t: SegmentTenant, s: Segment): boolean {
  if (t.deletedAt) return false;
  if (s.plans.length && !(t.planFamily && s.plans.includes(t.planFamily))) return false;
  const status = t.subStatus ?? t.status;
  if (s.statuses.length && !s.statuses.includes(status)) return false;
  if (s.industries.length && !s.industries.includes(t.industry ?? "otro")) return false;
  const day = dayOf(t.created_at);
  if (s.createdFrom && day < s.createdFrom) return false;
  if (s.createdTo && day > s.createdTo) return false;
  return true;
}

export function segmentTenants<T extends SegmentTenant>(tenants: T[], s: Segment): T[] {
  if (isEmptySegment(s)) return [];
  return tenants.filter((t) => matchesSegment(t, s));
}

// Payload de la RPC: sólo los criterios usados (un array vacío = sin filtro).
export function toRpcSegment(s: Segment): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  if (s.plans.length) out.plans = [...s.plans];
  if (s.statuses.length) out.statuses = [...s.statuses];
  if (s.industries.length) out.industries = [...s.industries];
  if (s.createdFrom) out.created_from = s.createdFrom;
  if (s.createdTo) out.created_to = s.createdTo;
  return out;
}

export function fromRpcSegment(raw: unknown): Segment {
  const o = (raw && typeof raw === "object" ? raw : {}) as Record<string, unknown>;
  const arr = (v: unknown) => (Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : []);
  return {
    plans: arr(o.plans),
    statuses: arr(o.statuses),
    industries: arr(o.industries),
    createdFrom: typeof o.created_from === "string" ? o.created_from : "",
    createdTo: typeof o.created_to === "string" ? o.created_to : "",
  };
}

export function segmentSummary(s: Segment, industryLabels: Record<string, string> = {}): string {
  const parts: string[] = [];
  if (s.plans.length) parts.push(`Plan ${s.plans.map((p) => SEGMENT_PLAN_LABELS[p] ?? p).join(" o ")}`);
  if (s.statuses.length)
    parts.push(`Estado ${s.statuses.map((x) => SEGMENT_STATUS_LABELS[x] ?? x).join(" o ")}`);
  if (s.industries.length)
    parts.push(`Rubro ${s.industries.map((x) => industryLabels[x] ?? x).join(" o ")}`);
  if (s.createdFrom && s.createdTo) parts.push(`Alta entre ${s.createdFrom} y ${s.createdTo}`);
  else if (s.createdFrom) parts.push(`Alta desde ${s.createdFrom}`);
  else if (s.createdTo) parts.push(`Alta hasta ${s.createdTo}`);
  return parts.length ? parts.join(" · ") : "Sin criterios";
}

export function toggleValue(list: string[], value: string): string[] {
  return list.includes(value) ? list.filter((v) => v !== value) : [...list, value];
}

// Historial: agrupa las filas del mismo lote de segmento en una sola entrada.
export function groupByBatch<T extends { id: string; segmentBatchId: string | null }>(
  rows: T[],
): { row: T; count: number; ids: string[] }[] {
  const out: { row: T; count: number; ids: string[] }[] = [];
  const idx = new Map<string, number>();
  for (const r of rows) {
    if (!r.segmentBatchId) {
      out.push({ row: r, count: 1, ids: [r.id] });
      continue;
    }
    const at = idx.get(r.segmentBatchId);
    if (at === undefined) {
      idx.set(r.segmentBatchId, out.length);
      out.push({ row: r, count: 1, ids: [r.id] });
    } else {
      const g = out[at]!;
      g.count += 1;
      g.ids.push(r.id);
    }
  }
  return out;
}
