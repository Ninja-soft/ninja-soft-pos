// =============================================================================
// _shared/mercadolibre/claims.ts (H141 · ADR-132, parte B). PURO.
//
// Posventa: reclamos, mediaciones y devoluciones de la API
// /post-purchase/v1/claims (criterios tomados de ANDESMAR, `mapeo.ts` y
// `posventaMlAcciones.js`):
//   • el estado sale de claim.status, NUNCA del texto de /detail (en los
//     cerrados es una plantilla vieja);
//   • tipo del caso: cancelación, devolución (tipo returns o hay retorno),
//     mediación (stage dispute) o reclamo;
//   • vencimiento: detail.due_date o el due_date más temprano de las acciones
//     del vendedor (respondent / seller);
//   • "te toca" cuando action_responsible es respondent, o cuando no hay
//     responsable y alguna acción es obligatoria;
//   • resultado: reintegro parcial, a favor, en contra o cubierto por ML.
// =============================================================================

export interface MlClaimAction {
  action: string;
  mandatory?: boolean;
  due_date?: string | null;
}

export interface MlClaimPlayer {
  role?: string; // complainant | respondent | mediator
  type?: string; // buyer | seller | internal
  user_id?: number;
  available_actions?: MlClaimAction[];
}

export interface MlClaim {
  id: number;
  resource_id?: number | null;
  resource?: string | null; // order | shipment | payment
  status?: string; // opened | closed
  type?: string; // mediations | returns | cancel_purchase | cancel_sale | ...
  stage?: string; // claim | dispute | recontact | none
  reason_id?: string | null;
  fulfilled?: boolean | null;
  players?: MlClaimPlayer[];
  resolution?: {
    reason?: string | null;
    date_created?: string | null;
    benefited?: string[] | null;
    closed_by?: string | null;
    applied_coverage?: boolean | null;
    coverage_decision?: unknown;
  } | null;
  related_entities?: string[] | null;
  date_created?: string | null;
  last_updated?: string | null;
}

export interface MlClaimDetail {
  title?: string | null;
  description?: string | null;
  problem?: string | null;
  due_date?: string | null;
  action_responsible?: string | null; // respondent | complainant | mediator
}

export interface MlReturn {
  id?: number;
  status?: string | null;
  subtype?: string | null;
  status_money?: string | null;
}

export type ClaimKind = "reclamo" | "mediacion" | "devolucion" | "cancelacion";
export type ClaimResult = "a_favor" | "en_contra" | "reintegro" | "cubierto" | null;

export function claimKind(c: Pick<MlClaim, "type" | "stage">, hasReturn = false): ClaimKind {
  const t = (c.type ?? "").toLowerCase();
  if (t === "cancel_purchase" || t === "cancel_sale") return "cancelacion";
  if (t === "returns" || hasReturn) return "devolucion";
  if ((c.stage ?? "") === "dispute") return "mediacion";
  return "reclamo";
}

const isSeller = (p: MlClaimPlayer) => p.role === "respondent" || p.type === "seller";

/** Acciones que el vendedor puede hacer ahora (obligatorias primero, después por vencimiento). */
export function sellerActions(c: Pick<MlClaim, "players">): MlClaimAction[] {
  const list = (c.players ?? []).filter(isSeller).flatMap((p) => p.available_actions ?? []);
  const t = (a: MlClaimAction) => (a.due_date ? Date.parse(a.due_date) : Number.POSITIVE_INFINITY);
  return [...list].sort((a, b) => Number(Boolean(b.mandatory)) - Number(Boolean(a.mandatory)) || t(a) - t(b));
}

/** "Resolvé hasta": detail.due_date o la acción del vendedor que vence primero. */
export function claimDueDate(c: Pick<MlClaim, "players">, detail?: MlClaimDetail | null): string | null {
  if (detail?.due_date && Number.isFinite(Date.parse(detail.due_date))) return new Date(Date.parse(detail.due_date)).toISOString();
  const dues = sellerActions(c)
    .map((a) => (a.due_date ? Date.parse(a.due_date) : NaN))
    .filter((x) => Number.isFinite(x));
  return dues.length ? new Date(Math.min(...dues)).toISOString() : null;
}

/** ¿Le toca al vendedor? */
export function isMyTurn(c: Pick<MlClaim, "players" | "status">, detail?: MlClaimDetail | null): boolean {
  if ((c.status ?? "opened") !== "opened") return false;
  const resp = detail?.action_responsible ?? null;
  if (resp) return resp === "respondent";
  return sellerActions(c).some((a) => a.mandatory);
}

export function claimResult(c: Pick<MlClaim, "resolution" | "status">): ClaimResult {
  if ((c.status ?? "") !== "closed" || !c.resolution) return null;
  const r = c.resolution;
  if ((r.reason ?? "") === "partial_refunded") return "reintegro";
  const ben = (r.benefited ?? []).map((x) => String(x).toLowerCase());
  if (ben.some((b) => b === "respondent" || b === "seller")) return "a_favor";
  if (r.applied_coverage || r.coverage_decision) return "cubierto";
  if (ben.some((b) => b === "complainant" || b === "buyer")) return "en_contra";
  return null;
}

/** affects-reputation de ML -> booleano (null = no se sabe). */
export function affectsFlag(v: unknown): boolean | null {
  const s = typeof v === "object" && v ? String((v as { affects_reputation?: unknown }).affects_reputation ?? "") : String(v ?? "");
  if (s === "affected") return true;
  if (s === "not_affected") return false;
  return null;
}

/** Payload de ml_claim_upsert. Un retorno o un "afecta" que no se pudo leer viaja como undefined (no pisa lo conocido). */
export function claimPayload(c: MlClaim, detail?: MlClaimDetail | null, ret?: MlReturn | null, affects?: boolean | null) {
  const actions = sellerActions(c).slice(0, 20);
  return {
    claim_id: String(c.id),
    resource: c.resource ?? null,
    resource_id: c.resource_id != null ? String(c.resource_id) : null,
    type: c.type ?? null,
    stage: c.stage ?? null,
    status: c.status ?? "opened",
    reason_id: c.reason_id ?? null,
    kind: claimKind(c, Boolean(ret?.id)),
    due_at: claimDueDate(c, detail),
    action_responsible: detail?.action_responsible ?? (isMyTurn(c, detail) ? "respondent" : null),
    my_actions: actions.map((a) => ({ action: a.action, mandatory: Boolean(a.mandatory), due_date: a.due_date ?? null })),
    detail_title: detail?.title ? String(detail.title).slice(0, 300) : null,
    return_id: ret?.id != null ? String(ret.id) : undefined,
    return_status: ret ? (ret.status ?? null) : undefined,
    affects_reputation: affects === undefined ? undefined : affects,
    resolution_reason: c.resolution?.reason ?? null,
    resolution_result: claimResult(c),
    date_created: c.date_created ?? null,
    last_updated: c.last_updated ?? null,
  };
}

// -----------------------------------------------------------------------------
// Mensajes.
// -----------------------------------------------------------------------------
export interface MlClaimMessage {
  sender_role?: string; // complainant | respondent | mediator
  receiver_role?: string;
  message?: string | null;
  date_created?: string | null;
  attachments?: Array<{ filename?: string; original_filename?: string; type?: string }> | null;
  status?: string | null;
}

/** Texto plano de un mensaje (los del mediador vienen en HTML). */
export function plainText(html: string | null | undefined): string {
  return (html ?? "")
    .replace(/<\s*br\s*\/?>/gi, "\n")
    .replace(/<\/(p|div|li)>/gi, "\n")
    .replace(/<[^>]+>/g, "")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

export function normalizeMessages(list: MlClaimMessage[] | null | undefined) {
  return (list ?? [])
    .map((m) => ({
      from: (m.sender_role ?? "") as string,
      to: (m.receiver_role ?? "") as string,
      text: plainText(m.message),
      date: m.date_created ?? null,
      attachments: (m.attachments ?? []).map((a) => a.original_filename ?? a.filename ?? "adjunto"),
    }))
    .sort((a, b) => Date.parse(a.date ?? "") - Date.parse(b.date ?? ""));
}

// -----------------------------------------------------------------------------
// Escrituras: qué acción de ML corresponde y cómo se valida.
// -----------------------------------------------------------------------------
export type ClaimWrite = "message_complainant" | "message_mediator" | "open_dispute" | "allow_return" | "partial_refund";

/** Acción de ML que tiene que estar disponible para cada escritura. */
export const REQUIRED_ACTION: Record<ClaimWrite, string[]> = {
  message_complainant: ["send_message_to_complainant"],
  message_mediator: ["send_message_to_mediator"],
  open_dispute: ["open_dispute"],
  allow_return: ["allow_return"],
  partial_refund: ["allow_partial_refund"],
};

export function canDo(c: Pick<MlClaim, "players" | "status">, w: ClaimWrite): boolean {
  if ((c.status ?? "opened") !== "opened") return false;
  const have = new Set(sellerActions(c).map((a) => a.action));
  return REQUIRED_ACTION[w].some((a) => have.has(a));
}

/** ¿El error de ML deja el resultado incierto (no se sabe si llegó)? */
export function isUncertain(status: number): boolean {
  return status === 0 || status === 408 || status === 429 || status >= 500;
}

export const ATTACH_LIMITS = { max: 3, maxBytes: 5 * 1024 * 1024, totalBytes: 8 * 1024 * 1024, types: ["image/jpeg", "image/png", "application/pdf"] };

export function attachmentProblem(files: Array<{ type: string; size: number }>): string | null {
  if (files.length > ATTACH_LIMITS.max) return "Hasta 3 adjuntos.";
  if (files.some((f) => !ATTACH_LIMITS.types.includes(f.type))) return "Sólo JPG, PNG o PDF.";
  if (files.some((f) => f.size > ATTACH_LIMITS.maxBytes)) return "Cada adjunto hasta 5 MB.";
  if (files.reduce((s, f) => s + f.size, 0) > ATTACH_LIMITS.totalBytes) return "Entre todos, hasta 8 MB.";
  return null;
}
