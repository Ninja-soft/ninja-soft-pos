// =============================================================================
// _shared/mpTransfers.ts: transferencias recibidas en un CVU de Mercado Pago
// (ADR-061, transferencias automáticas).
//
//  * isIncomingTransfer: un pago de /v1/payments/search que es una
//    transferencia ENTRANTE aprobada (bank_transfer / cvu / money_transfer /
//    account_fund) y no una que hizo la misma cuenta (payer.id = la cuenta).
//  * transferInfo: monto, fecha, nombre y documento de quien transfirió.
//  * pairTransfer: empareja una espera de la hoja de cobro con los
//    movimientos: monto dentro de la tolerancia (±), dentro de la ventana,
//    nunca un movimiento ya usado o rechazado. Un solo candidato y ninguna
//    otra espera que también lo acepte = matched; si no, ambiguous (nunca se
//    cierra solo, decide el cajero).
//
// Archivo PURO y SIN imports (Deno, Vitest y front).
// =============================================================================

type Obj = Record<string, unknown>;
const obj = (v: unknown): Obj | null => (typeof v === "object" && v !== null && !Array.isArray(v) ? (v as Obj) : null);
const str = (v: unknown): string | null => {
  if (typeof v === "string") return v.trim() || null;
  if (typeof v === "number" && Number.isFinite(v)) return String(v);
  return null;
};
const num = (v: unknown): number | null => {
  const n = typeof v === "number" ? v : typeof v === "string" && v.trim() ? Number(v) : NaN;
  return Number.isFinite(n) ? n : null;
};

const TRANSFER_TYPES = new Set(["bank_transfer"]);
const TRANSFER_METHODS = new Set(["cvu", "bank_transfer", "debin_transfer"]);
const TRANSFER_OPS = new Set(["money_transfer", "account_fund"]);

export function isIncomingTransfer(payment: unknown, ownUserId: string | null | undefined): boolean {
  const p = obj(payment);
  if (!p) return false;
  if ((str(p.status) ?? "").toLowerCase() !== "approved") return false;
  const type = (str(p.payment_type_id) ?? "").toLowerCase();
  const method = (str(p.payment_method_id) ?? "").toLowerCase();
  const op = (str(p.operation_type) ?? "").toLowerCase();
  if (!(TRANSFER_TYPES.has(type) || TRANSFER_METHODS.has(method) || TRANSFER_OPS.has(op))) return false;
  const payerId = str(obj(p.payer)?.id);
  if (ownUserId && payerId && payerId === String(ownUserId)) return false;
  const collector = str(p.collector_id);
  if (ownUserId && collector && collector !== String(ownUserId)) return false;
  return true;
}

export interface TransferInfo {
  id: string;
  amount: number;
  at: string;
  payer_name: string | null;
  payer_doc: string | null;
  bank: string | null;
}

export function transferInfo(payment: unknown): TransferInfo | null {
  const p = obj(payment);
  if (!p) return null;
  const id = str(p.id);
  const amount = num(p.transaction_amount) ?? num(obj(p.transaction_details)?.total_paid_amount);
  const atRaw = str(p.date_approved) ?? str(p.date_created);
  if (!id || amount == null || !atRaw) return null;
  const at = new Date(atRaw);
  if (Number.isNaN(at.getTime())) return null;
  const payer = obj(p.payer);
  const bankPayer = obj(obj(obj(obj(p.point_of_interaction)?.transaction_data)?.bank_info)?.payer);
  const name =
    [str(payer?.first_name), str(payer?.last_name)].filter(Boolean).join(" ") ||
    str(bankPayer?.long_name) ||
    null;
  const ident = obj(payer?.identification) ?? obj(bankPayer?.identification);
  const docNum = str(ident?.number);
  return {
    id,
    amount: Math.round(amount * 100) / 100,
    at: at.toISOString(),
    payer_name: name,
    payer_doc: docNum ? `${str(ident?.type) ?? "Doc"} ${docNum}` : null,
    bank: str(bankPayer?.long_name) ?? str(bankPayer?.account_id) ?? null,
  };
}

export interface WatchLite {
  id: string;
  amount: number;
  tolerance: number;
  created_at: string;
  expires_at: string;
  rejected_ids?: string[] | null;
}

export interface PairResult {
  status: "waiting" | "matched" | "ambiguous";
  match: TransferInfo | null;
  candidates: TransferInfo[];
}

const LEAD_MS = 2 * 60 * 1000;

/** ¿El movimiento le sirve a esta espera? (monto y ventana). */
export function fits(w: WatchLite, t: TransferInfo): boolean {
  const at = Date.parse(t.at);
  const from = Date.parse(w.created_at) - LEAD_MS;
  const to = Date.parse(w.expires_at);
  if (!(at >= from && at <= to)) return false;
  return Math.abs(t.amount - Number(w.amount)) <= Number(w.tolerance) + 0.005;
}

export function pairTransfer(
  watch: WatchLite,
  transfers: TransferInfo[],
  opts: { usedIds?: Iterable<string>; otherWatches?: WatchLite[] } = {},
): PairResult {
  const used = new Set(opts.usedIds ?? []);
  const rejected = new Set(watch.rejected_ids ?? []);
  const seen = new Set<string>();
  const candidates = transfers.filter((t) => {
    if (seen.has(t.id) || used.has(t.id) || rejected.has(t.id)) return false;
    seen.add(t.id);
    return fits(watch, t);
  });
  if (candidates.length === 0) return { status: "waiting", match: null, candidates: [] };
  if (candidates.length > 1) return { status: "ambiguous", match: null, candidates };
  const only = candidates[0]!;
  const contested = (opts.otherWatches ?? []).some(
    (o) => o.id !== watch.id && !(o.rejected_ids ?? []).includes(only.id) && fits(o, only),
  );
  return contested
    ? { status: "ambiguous", match: null, candidates }
    : { status: "matched", match: only, candidates };
}
