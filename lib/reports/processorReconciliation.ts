// =============================================================================
// Conciliación de procesadores (ADR-061): lógica pura de la pantalla
// /reportes/conciliacion?vista=procesadores. Sin red ni React.
//
//  * Estados en lenguaje simple: cruce (Conciliado, Cobro sin venta, Venta sin
//    cobro, Diferencia de monto, Revisado) y plata (Acreditado, Pendiente de
//    acreditación). Y por disputa (ADR-064): Devuelto, Devuelto parcial,
//    Contracargo, Reclamo abierto, con el neto efectivo (paymentDisputes.ts).
//  * Resumen para el dueño: "Vendiste $X con Mercado Pago, te cobró $Y de
//    comisiones e impuestos, te acreditó $Z, falta acreditar $W (fecha)".
//  * Datos de los gráficos, filas del XLSX.
//  * Importación de archivos (XLSX / CSV) de cualquier adquirente con mapeo de
//    columnas: detección por encabezado, números y fechas argentinas.
// =============================================================================
import type { ProcessorFee, SettlementLineInput } from "@/supabase/functions/_shared/processorData";
import {
  LINE_DISPUTE_LABEL,
  disputeSummary,
  effectiveNet,
  lineDisputeState,
  type DisputeIndex,
  type DisputeSummary,
  type LineDisputeState,
} from "./paymentDisputes";

export type LineMatchStatus = "matched" | "amount_diff" | "missing_in_pos" | "ignored";

export interface SettlementLineRow {
  id: string;
  provider_key: string;
  scope_store_id: string | null;
  external_id: string | null;
  order_id: string | null;
  external_reference: string | null;
  kind: string;
  status: string;
  operation_at: string;
  release_date: string | null;
  released: boolean;
  gross: number;
  fee: number;
  taxes: number;
  net: number;
  refunded: number;
  payment_method: string | null;
  payment_type: string | null;
  card_brand: string | null;
  last4: string | null;
  installments: number | null;
  lote: string | null;
  cupon: string | null;
  autorizacion: string | null;
  comercio: string | null;
  terminal: string | null;
  description: string | null;
  payer: string | null;
  fee_detail: ProcessorFee[];
  payment_id: string | null;
  intent_id: string | null;
  sale_id: string | null;
  match_status: LineMatchStatus;
  match_method: string | null;
  diff_amount: number;
  review_note: string | null;
  reviewed_at: string | null;
}

/** Cobro del POS sin línea de liquidación (lo devuelve la Edge al cruzar). */
export interface UnmatchedPayment {
  payment_id: string;
  sale_id: string | null;
  intent_id: string | null;
  provider_key: string | null;
  amount: number;
  created_at: string;
  provider_payment_id?: string | null;
  lote?: string | null;
  cupon?: string | null;
  last4?: string | null;
  sale_voided?: boolean;
}

// ── Proveedores ──────────────────────────────────────────────────────────────

export interface SettlementProvider {
  key: string;
  label: string;
  /** Liquidación por API (automática). */
  api: boolean;
  /** Logo (provider_key de lib/payments/logos). */
  logo: string | null;
}

export const SETTLEMENT_PROVIDERS: SettlementProvider[] = [
  { key: "mercadopago", label: "Mercado Pago", api: true, logo: "mercadopago" },
  { key: "payway", label: "Payway", api: false, logo: "payway" },
  { key: "getnet", label: "Getnet", api: false, logo: "getnet" },
  { key: "fiserv", label: "Fiserv / Posnet", api: false, logo: "fiserv" },
  { key: "nave", label: "Nave", api: false, logo: "nave" },
  { key: "otro", label: "Otro adquirente", api: false, logo: null },
];

export const providerLabel = (key: string) => SETTLEMENT_PROVIDERS.find((p) => p.key === key)?.label ?? key;

// ── Estados ──────────────────────────────────────────────────────────────────

export type MatchTone = "success" | "warning" | "danger" | "neutral";

export const MATCH_LABEL: Record<LineMatchStatus | "pos_only", { label: string; tone: MatchTone; help: string }> = {
  matched: {
    label: "Conciliado",
    tone: "success",
    help: "El cobro está en el procesador y en una venta, con el mismo monto.",
  },
  amount_diff: {
    label: "Diferencia de monto",
    tone: "warning",
    help: "El procesador y la venta no dicen lo mismo (devolución, recargo o venta anulada).",
  },
  missing_in_pos: {
    label: "Cobro sin venta",
    tone: "danger",
    help: "Te pagaron, pero no hay una venta registrada con ese cobro.",
  },
  ignored: { label: "Revisado", tone: "neutral", help: "Lo marcaste como revisado." },
  pos_only: {
    label: "Venta sin cobro",
    tone: "danger",
    help: "La venta dice que se cobró con este medio, pero el procesador no lo informa.",
  },
};

export type MoneyState = "released" | "pending" | "unknown";

export function moneyState(l: Pick<SettlementLineRow, "released" | "release_date">, now: Date = new Date()): MoneyState {
  if (l.released) return "released";
  if (l.release_date) return Date.parse(l.release_date) <= now.getTime() ? "released" : "pending";
  return "unknown";
}

export const MONEY_LABEL: Record<MoneyState, string> = {
  released: "Acreditado",
  pending: "Pendiente de acreditación",
  unknown: "Sin fecha de acreditación",
};

const METHOD_LABEL: Record<string, string> = {
  provider_id: "por el id del pago",
  voucher: "por lote y cupón",
  authorization: "por la autorización",
  amount_date: "por monto y día (revisalo)",
  manual: "a mano",
};
export const matchMethodLabel = (m: string | null) => (m ? (METHOD_LABEL[m] ?? m) : null);

// ── Filtros ──────────────────────────────────────────────────────────────────

export type LineFilter =
  | "all"
  | "exceptions"
  | LineMatchStatus
  | "pending_money"
  | "pos_only"
  | "disputes"
  | `d_${LineDisputeState}`;

const disputesOf = (l: SettlementLineRow, index?: DisputeIndex) => (l.external_id ? (index?.get(l.external_id) ?? []) : []);

/** Estado de disputa de una línea (ADR-064). */
export const lineDispute = (l: SettlementLineRow, index?: DisputeIndex) => lineDisputeState(l, disputesOf(l, index));

export function filterLines(
  lines: SettlementLineRow[],
  f: LineFilter,
  now: Date = new Date(),
  index?: DisputeIndex,
): SettlementLineRow[] {
  if (f === "disputes") return lines.filter((l) => lineDispute(l, index) !== null);
  if (f.startsWith("d_")) return lines.filter((l) => `d_${lineDispute(l, index)}` === f);
  switch (f) {
    case "all":
    case "pos_only":
      return f === "all" ? lines : [];
    case "exceptions":
      return lines.filter((l) => l.match_status === "missing_in_pos" || l.match_status === "amount_diff");
    case "pending_money":
      return lines.filter((l) => moneyState(l, now) === "pending");
    default:
      return lines.filter((l) => l.match_status === f);
  }
}

// ── Resumen para el dueño ────────────────────────────────────────────────────

const round2 = (n: number) => Math.round(n * 100) / 100;

export interface OwnerSummary {
  count: number;
  /** Lo que vendiste (bruto menos devoluciones). */
  sold: number;
  refunded: number;
  fees: number;
  taxes: number;
  /** Comisiones + impuestos. */
  charged: number;
  net: number;
  released: number;
  pending: number;
  /** Próxima fecha de acreditación (ISO) entre lo pendiente. */
  nextRelease: string | null;
  /** Pendiente por fecha (YYYY-MM-DD local). */
  pendingByDay: { day: string; amount: number }[];
  counts: Record<LineMatchStatus | "pos_only", number>;
  amounts: Record<LineMatchStatus | "pos_only", number>;
  /** Tasa efectiva de costo (comisiones + impuestos / vendido). */
  costPct: number;
  /** Devoluciones, contracargos y reclamos (ADR-064). */
  disputes: DisputeSummary;
}

export function localDay(iso: string): string {
  const d = new Date(iso);
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

export function summarize(
  lines: SettlementLineRow[],
  unmatched: UnmatchedPayment[] = [],
  now: Date = new Date(),
  index?: DisputeIndex,
): OwnerSummary {
  const counts = { matched: 0, amount_diff: 0, missing_in_pos: 0, ignored: 0, pos_only: 0 };
  const amounts = { matched: 0, amount_diff: 0, missing_in_pos: 0, ignored: 0, pos_only: 0 };
  let sold = 0;
  let refunded = 0;
  let fees = 0;
  let taxes = 0;
  let net = 0;
  let released = 0;
  let pending = 0;
  let nextRelease: string | null = null;
  const byDay = new Map<string, number>();
  for (const l of lines) {
    const eff = Number(l.gross) - Number(l.refunded);
    // Neto efectivo: devolución total o contracargo no ganado = 0 (ADR-064).
    const lineNet = effectiveNet(l, lineDispute(l, index));
    sold += eff;
    refunded += Number(l.refunded);
    fees += Number(l.fee);
    taxes += Number(l.taxes);
    net += lineNet;
    counts[l.match_status] += 1;
    amounts[l.match_status] += eff;
    const ms = moneyState(l, now);
    if (ms === "pending") {
      pending += lineNet;
      if (l.release_date && lineNet !== 0) {
        if (!nextRelease || l.release_date < nextRelease) nextRelease = l.release_date;
        const day = localDay(l.release_date);
        byDay.set(day, (byDay.get(day) ?? 0) + lineNet);
      }
    } else if (ms === "released") released += lineNet;
  }
  for (const u of unmatched) {
    counts.pos_only += 1;
    amounts.pos_only += Number(u.amount);
  }
  const r = (o: Record<string, number>) => {
    for (const k of Object.keys(o)) o[k] = round2(o[k]!);
  };
  r(amounts);
  sold = round2(sold);
  return {
    count: lines.length,
    sold,
    refunded: round2(refunded),
    fees: round2(fees),
    taxes: round2(taxes),
    charged: round2(fees + taxes),
    net: round2(net),
    released: round2(released),
    pending: round2(pending),
    nextRelease,
    pendingByDay: [...byDay.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([day, amount]) => ({ day, amount: round2(amount) })),
    counts,
    amounts,
    costPct: sold > 0 ? round2(((fees + taxes) / sold) * 100) : 0,
    disputes: disputeSummary(lines, index),
  };
}

/** Frases del resumen en lenguaje simple. */
export function summarySentences(
  s: OwnerSummary,
  provider: string,
  fmt: (n: number) => string,
  fmtDate: (iso: string) => string,
): string[] {
  const p = providerLabel(provider);
  if (s.count === 0) return [`No hay cobros de ${p} en este período.`];
  const out = [`Vendiste ${fmt(s.sold)} con ${p}.`];
  if (s.charged > 0) out.push(`${p} te cobró ${fmt(s.charged)} de comisiones e impuestos (${s.costPct.toLocaleString("es-AR")} % de lo vendido).`);
  if (s.released > 0) out.push(`Te acreditó ${fmt(s.released)}.`);
  if (s.pending > 0) {
    out.push(
      `Falta acreditar ${fmt(s.pending)}${s.nextRelease ? `, lo próximo el ${fmtDate(s.nextRelease)}` : ""}.`,
    );
  }
  const issues = s.counts.missing_in_pos + s.counts.amount_diff + s.counts.pos_only;
  out.push(issues === 0 ? "Todo cierra con tus ventas." : `Hay ${issues} ${issues === 1 ? "cobro para revisar" : "cobros para revisar"}.`);
  const d = s.disputes;
  if (d && d.counts.chargeback > 0) {
    out.push(
      `Tuviste ${d.counts.chargeback} ${d.counts.chargeback === 1 ? "contracargo" : "contracargos"} por ${fmt(d.amounts.chargeback)}.`,
    );
  }
  if (d && d.counts.refunded + d.counts.partially_refunded > 0) {
    const n = d.counts.refunded + d.counts.partially_refunded;
    out.push(`${p} devolvió ${fmt(d.amounts.refunded + d.amounts.partially_refunded)} en ${n} ${n === 1 ? "cobro" : "cobros"}.`);
  }
  if (d && d.atRisk > 0) out.push(`Hay ${fmt(d.atRisk)} en riesgo por contracargos o reclamos abiertos.`);
  return out;
}

// ── Gráficos ─────────────────────────────────────────────────────────────────

/** Por día de operación: neto, comisiones e impuestos (barras apiladas). */
export function dailySeries(lines: SettlementLineRow[]) {
  const map = new Map<string, { net: number; fees: number; taxes: number }>();
  for (const l of lines) {
    const day = localDay(l.operation_at);
    const cur = map.get(day) ?? { net: 0, fees: 0, taxes: 0 };
    cur.net += Number(l.net);
    cur.fees += Number(l.fee);
    cur.taxes += Number(l.taxes);
    map.set(day, cur);
  }
  const days = [...map.keys()].sort();
  return {
    days,
    labels: days.map((d) => `${d.slice(8, 10)}/${d.slice(5, 7)}`),
    net: days.map((d) => round2(map.get(d)!.net)),
    fees: days.map((d) => round2(map.get(d)!.fees)),
    taxes: days.map((d) => round2(map.get(d)!.taxes)),
  };
}

/** Comisiones e impuestos por concepto (dona). */
export function feeBreakdown(lines: SettlementLineRow[]): { label: string; value: number }[] {
  const map = new Map<string, number>();
  for (const l of lines) {
    const detail = Array.isArray(l.fee_detail) ? l.fee_detail : [];
    if (detail.length === 0) {
      if (Number(l.fee) > 0) map.set("Comisiones", (map.get("Comisiones") ?? 0) + Number(l.fee));
      if (Number(l.taxes) > 0) map.set("Impuestos", (map.get("Impuestos") ?? 0) + Number(l.taxes));
      continue;
    }
    for (const f of detail) map.set(f.label, (map.get(f.label) ?? 0) + Number(f.amount));
  }
  return [...map.entries()]
    .map(([label, value]) => ({ label, value: round2(value) }))
    .filter((d) => d.value > 0)
    .sort((a, b) => b.value - a.value);
}

// ── XLSX ─────────────────────────────────────────────────────────────────────

export const XLSX_LINE_COLUMNS = [
  { header: "Fecha", key: "fecha", width: 18 },
  { header: "Id del pago", key: "id", width: 18 },
  { header: "Medio", key: "medio", width: 18 },
  { header: "Cuotas", key: "cuotas", type: "number" as const, width: 8 },
  { header: "Bruto", key: "bruto", type: "money" as const, width: 14 },
  { header: "Devuelto", key: "devuelto", type: "money" as const, width: 12 },
  { header: "Comisiones", key: "comisiones", type: "money" as const, width: 13 },
  { header: "Impuestos", key: "impuestos", type: "money" as const, width: 13 },
  { header: "Neto", key: "neto", type: "money" as const, width: 14 },
  { header: "Acreditación", key: "acreditacion", width: 14 },
  { header: "Plata", key: "plata", width: 22 },
  { header: "Venta", key: "venta", width: 12 },
  { header: "Estado", key: "estado", width: 20 },
  { header: "Disputa", key: "disputa", width: 18 },
  { header: "Diferencia", key: "diferencia", type: "money" as const, width: 12 },
  { header: "Nota", key: "nota", width: 30 },
];

const fmtDay = (iso: string | null) => (iso ? `${localDay(iso).slice(8, 10)}/${localDay(iso).slice(5, 7)}/${localDay(iso).slice(0, 4)}` : "");

export function xlsxLineRows(
  lines: SettlementLineRow[],
  saleLabel: (saleId: string | null) => string,
  now: Date = new Date(),
  index?: DisputeIndex,
): Record<string, unknown>[] {
  return lines.map((l) => ({
    fecha: new Date(l.operation_at).toLocaleString("es-AR", { dateStyle: "short", timeStyle: "short" }),
    id: l.external_id ?? [l.lote, l.cupon].filter(Boolean).join("/"),
    medio: [l.card_brand, l.last4 ? `**** ${l.last4}` : null].filter(Boolean).join(" "),
    cuotas: l.installments ?? "",
    bruto: Number(l.gross),
    devuelto: Number(l.refunded),
    comisiones: Number(l.fee),
    impuestos: Number(l.taxes),
    neto: Number(l.net),
    acreditacion: fmtDay(l.release_date),
    plata: MONEY_LABEL[moneyState(l, now)],
    venta: saleLabel(l.sale_id),
    estado: MATCH_LABEL[l.match_status].label,
    disputa: (() => {
      const st = lineDispute(l, index);
      return st ? LINE_DISPUTE_LABEL[st].label : "";
    })(),
    diferencia: l.match_status === "amount_diff" ? Number(l.diff_amount) : "",
    nota: l.review_note ?? "",
  }));
}

// ── Importación de archivos ──────────────────────────────────────────────────

export type ImportField =
  | "operation_at"
  | "gross"
  | "fee"
  | "taxes"
  | "net"
  | "release_date"
  | "lote"
  | "cupon"
  | "autorizacion"
  | "comercio"
  | "last4"
  | "card_brand"
  | "installments"
  | "external_id"
  | "terminal";

export const IMPORT_FIELDS: { key: ImportField; label: string; required?: boolean; synonyms: string[] }[] = [
  { key: "operation_at", label: "Fecha de la operación", required: true, synonyms: ["fecha de operacion", "fecha operacion", "fecha de compra", "fecha de venta", "fecha origen", "fecha presentacion", "fecha"] },
  { key: "gross", label: "Importe bruto", required: true, synonyms: ["importe bruto", "monto bruto", "bruto", "importe venta", "importe", "monto", "total"] },
  { key: "fee", label: "Arancel / comisión", synonyms: ["arancel", "comision", "cargo", "costo financiero", "costo"] },
  { key: "taxes", label: "Impuestos y retenciones", synonyms: ["retenciones", "retencion", "impuestos", "iva", "percepciones", "iibb"] },
  { key: "net", label: "Neto", synonyms: ["importe neto", "neto a cobrar", "neto liquidado", "neto"] },
  { key: "release_date", label: "Fecha de pago / acreditación", synonyms: ["fecha de pago", "fecha pago", "fecha de acreditacion", "fecha acreditacion", "fecha de liquidacion", "fecha liquidacion"] },
  { key: "lote", label: "Lote", synonyms: ["lote", "nro lote", "numero de lote", "batch"] },
  { key: "cupon", label: "Cupón", synonyms: ["cupon", "nro cupon", "ticket", "comprobante"] },
  { key: "autorizacion", label: "Autorización", synonyms: ["autorizacion", "cod autorizacion", "codigo de autorizacion", "auth"] },
  { key: "comercio", label: "N° de comercio", synonyms: ["nro comercio", "numero de comercio", "n comercio", "comercio", "establecimiento", "merchant"] },
  { key: "last4", label: "Últimos 4 de la tarjeta", synonyms: ["ultimos 4", "ultimos digitos", "tarjeta", "nro tarjeta", "numero de tarjeta"] },
  { key: "card_brand", label: "Marca", synonyms: ["marca", "tarjeta marca", "producto", "medio de pago"] },
  { key: "installments", label: "Cuotas", synonyms: ["cuotas", "plan", "cant cuotas"] },
  { key: "external_id", label: "Id de la operación", synonyms: ["id operacion", "id transaccion", "nro operacion", "numero de operacion", "id"] },
  { key: "terminal", label: "Terminal", synonyms: ["terminal", "nro terminal", "pos"] },
];

export type ColumnMapping = Partial<Record<ImportField, number>>;

export const normHeader = (s: string) =>
  s
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/[°º#.:_/-]/g, " ")
    .replace(/\s+/g, " ")
    .trim();

/** Mapeo sugerido por encabezado: el sinónimo más largo que coincide gana. */
export function guessMapping(header: string[]): ColumnMapping {
  const cols = header.map(normHeader);
  const taken = new Set<number>();
  const out: ColumnMapping = {};
  const candidates: { field: ImportField; col: number; score: number }[] = [];
  for (const f of IMPORT_FIELDS) {
    for (const syn of f.synonyms) {
      cols.forEach((c, i) => {
        if (c === syn) candidates.push({ field: f.key, col: i, score: 100 + syn.length });
        else if (c.includes(syn)) candidates.push({ field: f.key, col: i, score: syn.length });
      });
    }
  }
  candidates.sort((a, b) => b.score - a.score);
  for (const c of candidates) {
    if (out[c.field] != null || taken.has(c.col)) continue;
    out[c.field] = c.col;
    taken.add(c.col);
  }
  return out;
}

/** Número argentino o internacional: "1.234,56", "1,234.56", "-12,5", "$ 100". */
export function parseAmount(raw: unknown): number | null {
  if (typeof raw === "number") return Number.isFinite(raw) ? raw : null;
  let s = String(raw ?? "").trim();
  if (!s) return null;
  const neg = /^\(.*\)$/.test(s) || s.includes("-");
  s = s.replace(/[^\d.,]/g, "");
  if (!s) return null;
  const lastComma = s.lastIndexOf(",");
  const lastDot = s.lastIndexOf(".");
  if (lastComma > lastDot) s = s.replace(/\./g, "").replace(",", ".");
  else if (lastDot > lastComma && lastComma >= 0) s = s.replace(/,/g, "");
  else if (lastComma === -1 && (s.match(/\./g) ?? []).length > 1) s = s.replace(/\./g, "");
  const n = Number(s);
  if (!Number.isFinite(n)) return null;
  return neg ? -Math.abs(n) : n;
}

/** Fecha dd/mm/aaaa [hh:mm[:ss]], aaaa-mm-dd o ISO; hora de Argentina. */
export function parseArDate(raw: unknown): string | null {
  const s = String(raw ?? "").trim();
  if (!s) return null;
  let m = s.match(/^(\d{1,2})[/.-](\d{1,2})[/.-](\d{2,4})(?:[ T](\d{1,2}):(\d{2})(?::(\d{2}))?)?$/);
  if (m) {
    const year = m[3]!.length === 2 ? 2000 + Number(m[3]) : Number(m[3]);
    return arIso(year, Number(m[2]), Number(m[1]), Number(m[4] ?? 12), Number(m[5] ?? 0), Number(m[6] ?? 0));
  }
  m = s.match(/^(\d{4})-(\d{2})-(\d{2})(?:[ T](\d{2}):(\d{2})(?::(\d{2}))?)?$/);
  if (m) return arIso(Number(m[1]), Number(m[2]), Number(m[3]), Number(m[4] ?? 12), Number(m[5] ?? 0), Number(m[6] ?? 0));
  const d = new Date(s);
  return Number.isNaN(d.getTime()) ? null : d.toISOString();
}

function arIso(y: number, mo: number, d: number, h: number, mi: number, se: number): string | null {
  if (mo < 1 || mo > 12 || d < 1 || d > 31 || h > 23 || mi > 59) return null;
  // Argentina: UTC-3 todo el año.
  const t = Date.UTC(y, mo - 1, d, h + 3, mi, se);
  const check = new Date(t - 3 * 3600_000);
  if (check.getUTCDate() !== d) return null;
  return new Date(t).toISOString();
}

/** Parser CSV simple (comillas, separador ; , o tab detectado en la 1ra línea). */
export function parseCsv(text: string): string[][] {
  const clean = text.replace(/^﻿/, "");
  const first = clean.split(/\r?\n/, 1)[0] ?? "";
  const sep = [";", "\t", ","].sort((a, b) => first.split(b).length - first.split(a).length)[0]!;
  const rows: string[][] = [];
  let row: string[] = [];
  let cell = "";
  let quoted = false;
  for (let i = 0; i < clean.length; i++) {
    const c = clean[i]!;
    if (quoted) {
      if (c === '"' && clean[i + 1] === '"') {
        cell += '"';
        i++;
      } else if (c === '"') quoted = false;
      else cell += c;
      continue;
    }
    if (c === '"') quoted = true;
    else if (c === sep) {
      row.push(cell.trim());
      cell = "";
    } else if (c === "\n" || c === "\r") {
      if (c === "\r" && clean[i + 1] === "\n") i++;
      row.push(cell.trim());
      if (row.some((x) => x !== "")) rows.push(row);
      row = [];
      cell = "";
    } else cell += c;
  }
  row.push(cell.trim());
  if (row.some((x) => x !== "")) rows.push(row);
  return rows;
}

export interface ImportRowResult {
  line: SettlementLineInput | null;
  error: string | null;
  row: number;
}

const txt = (v: unknown, max = 40) => {
  const s = String(v ?? "").trim();
  return s ? s.slice(0, max) : null;
};

/** Filas del archivo (sin encabezado) a líneas de liquidación. */
export function rowsToLines(
  provider: string,
  body: string[][],
  map: ColumnMapping,
  firstRow = 2,
): ImportRowResult[] {
  const get = (r: string[], f: ImportField) => (map[f] != null ? r[map[f]!] : undefined);
  return body.map((r, i) => {
    const row = firstRow + i;
    const at = parseArDate(get(r, "operation_at"));
    const gross = parseAmount(get(r, "gross"));
    if (!at) return { line: null, error: "Fecha inválida", row };
    if (gross == null) return { line: null, error: "Importe inválido", row };
    const fee = Math.abs(parseAmount(get(r, "fee")) ?? 0);
    const taxes = Math.abs(parseAmount(get(r, "taxes")) ?? 0);
    const netRaw = parseAmount(get(r, "net"));
    const net = netRaw ?? round2(gross - fee - taxes);
    const release = parseArDate(get(r, "release_date"));
    const last4 = String(get(r, "last4") ?? "").replace(/\D/g, "").slice(-4) || null;
    const inst = parseAmount(get(r, "installments"));
    const fees: ProcessorFee[] = [];
    if (fee > 0) fees.push({ label: "Arancel", amount: round2(fee), kind: "fee" });
    if (taxes > 0) fees.push({ label: "Impuestos y retenciones", amount: round2(taxes), kind: "tax" });
    return {
      row,
      error: null,
      line: {
        provider_key: provider,
        line_key: "",
        external_id: txt(get(r, "external_id"), 80),
        order_id: null,
        external_reference: null,
        kind: gross < 0 ? "refund" : "payment",
        status: gross < 0 ? "refunded" : "approved",
        operation_at: at,
        release_date: release,
        released: release ? Date.parse(release) <= Date.now() : false,
        gross: round2(gross),
        fee: round2(fee),
        taxes: round2(taxes),
        net: round2(net),
        refunded: 0,
        currency: "ARS",
        payment_method: null,
        payment_type: null,
        card_brand: txt(get(r, "card_brand")),
        last4,
        installments: inst && inst > 0 ? Math.round(inst) : null,
        lote: txt(get(r, "lote"), 12),
        cupon: txt(get(r, "cupon"), 16),
        autorizacion: txt(get(r, "autorizacion"), 20)?.toUpperCase() ?? null,
        comercio: txt(get(r, "comercio"), 20),
        terminal: txt(get(r, "terminal"), 30),
        pos_id: null,
        store_ext_id: null,
        description: null,
        payer: null,
        fee_detail: fees,
      },
    };
  });
}

/** Payload para settlement_import_lines (sin line_key vacío: lo calcula el servidor). */
export function toImportPayload(lines: SettlementLineInput[]): Record<string, unknown>[] {
  return lines.map(({ line_key, ...rest }) => (line_key ? { line_key, ...rest } : rest));
}
