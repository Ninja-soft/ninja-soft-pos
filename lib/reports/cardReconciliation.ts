// Conciliación de tarjetas (ADR-044): lógica pura de normalización, filtros,
// agrupado día → n° de comercio → lote con subtotales y filas para el XLSX.
// Sin red ni React: la usa la pantalla /reportes/conciliacion y sus tests.
//
// Los datos del cupón vienen de payments.card_voucher (jsonb, todo opcional):
// { lote, cupon, autorizacion, marca, ultimos4, comercio, cuotas?, adquirente? }
// (adquirente: terminal del posnet offline, ADR-054). `marca`
// se guarda con la etiqueta de la entidad ("Visa", "Mastercard"); acá se
// traduce a la clave de lib/pos/cardBrands para el logo.

import { CARD_BRANDS } from "@/lib/pos/cardBrands";
import { acquirerLabel } from "@/lib/payments/acquirers";

export type CardKind = "debit" | "credit";
export type ReconcileStatus = "all" | "pending" | "reconciled";

/** Fila cruda: payments + sales (lo que devuelve el SELECT de la pantalla). */
export interface RawCardPayment {
  id: string;
  method: string;
  amount: number | string;
  reference: string | null;
  created_at: string;
  reconciled_at: string | null;
  card_voucher: unknown;
  metadata?: unknown;
  sales: {
    number: number | string | null;
    /** Turno de caja de la venta (para saber si el cobro es de "mi caja"). */
    cash_shift?: { opened_by: string | null } | null;
  } | null;
}

export interface CardRecRow {
  id: string;
  createdAt: string;
  /** Día local (yyyy-MM-dd) del cobro. */
  day: string;
  ticket: number | null;
  kind: CardKind;
  brandKey: string | null;
  brandLabel: string;
  installments: number | null;
  lote: string;
  cupon: string;
  autorizacion: string;
  ultimos4: string;
  comercio: string;
  /** Adquirente de la terminal (getnet, payway...; "" = sin dato). ADR-054. */
  adquirente: string;
  amount: number;
  /** Referencia del proveedor integrado (intent / operación), si hay. */
  reference: string | null;
  reconciledAt: string | null;
  /** Usuario que abrió el turno de caja de la venta (null si no hay turno). */
  shiftOpenedBy: string | null;
}

export interface CardRecFilters {
  kind: "all" | CardKind;
  /** "all", una clave de CARD_BRANDS, o `NO_BRAND`. */
  brand: string;
  /** "all", un número de comercio, o `NO_MERCHANT`. */
  comercio: string;
  status: ReconcileStatus;
  /** "all" (o ausente), una clave de adquirente, o `NO_ACQUIRER`. ADR-054. */
  acquirer?: string;
}

export const NO_BRAND = "__sin_marca__";
export const NO_MERCHANT = "__sin_comercio__";
export const NO_ACQUIRER = "__sin_adquirente__";
export const DEFAULT_FILTERS: CardRecFilters = { kind: "all", brand: "all", comercio: "all", status: "all" };

export const KIND_LABEL: Record<CardKind, string> = { debit: "Débito", credit: "Crédito" };

function str(v: unknown): string {
  if (v == null) return "";
  return String(v).trim();
}

function obj(v: unknown): Record<string, unknown> {
  return v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : {};
}

function pad(n: number): string {
  return String(n).padStart(2, "0");
}

/** Día local yyyy-MM-dd de un timestamp ISO. */
export function localDay(iso: string): string {
  const d = new Date(iso);
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

/** Hora local HH:mm de un timestamp ISO. */
export function localTime(iso: string): string {
  const d = new Date(iso);
  return `${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

const BRAND_ALIASES: Record<string, string> = {
  mastercard: "master",
  "master card": "master",
  "american express": "amex",
  "naranja x": "naranja",
  "diners club": "diners",
  "visa debito": "visa",
  "visa débito": "visa",
};

/** Clave de entidad (visa, master, amex…) a partir de la marca guardada. */
export function brandKeyFrom(marca: unknown): string | null {
  const m = str(marca).toLowerCase();
  if (!m) return null;
  const alias = BRAND_ALIASES[m];
  if (alias) return alias;
  const hit = CARD_BRANDS.find((b) => b.key === m || b.label.toLowerCase() === m || b.short?.toLowerCase() === m);
  return hit?.key ?? null;
}

function installmentsFrom(v: Record<string, unknown>): number | null {
  const raw = v.cuotas ?? v.installments;
  const n = Number(raw);
  return Number.isFinite(n) && n > 0 ? Math.trunc(n) : null;
}

/** Clave del adquirente guardado, en minúsculas (las desconocidas se conservan). */
export function acquirerFrom(v: unknown): string {
  return str(v).toLowerCase();
}

/** Normaliza un pago de tarjeta crudo. null si no es débito ni crédito. */
export function normalizeCardPayment(p: RawCardPayment): CardRecRow | null {
  if (p.method !== "debit" && p.method !== "credit") return null;
  const v = obj(p.card_voucher);
  const meta = obj(p.metadata);
  const marca = str(v.marca) || str(meta.card_brand) || str(meta.brand);
  const brandKey = brandKeyFrom(marca);
  const brandLabel = brandKey ? (CARD_BRANDS.find((b) => b.key === brandKey)?.label ?? marca) : marca;
  const ticket = p.sales?.number != null && p.sales.number !== "" ? Number(p.sales.number) : null;
  return {
    id: p.id,
    createdAt: p.created_at,
    day: localDay(p.created_at),
    ticket: Number.isFinite(ticket) ? ticket : null,
    kind: p.method,
    brandKey,
    brandLabel,
    installments: installmentsFrom(v),
    lote: str(v.lote),
    cupon: str(v.cupon),
    autorizacion: str(v.autorizacion),
    ultimos4: str(v.ultimos4),
    comercio: str(v.comercio),
    adquirente: acquirerFrom(v.adquirente),
    amount: Number(p.amount) || 0,
    reference: str(p.reference) || null,
    reconciledAt: p.reconciled_at,
    shiftOpenedBy: p.sales?.cash_shift?.opened_by ?? null,
  };
}

export function normalizeCardPayments(list: RawCardPayment[]): CardRecRow[] {
  const out: CardRecRow[] = [];
  for (const p of list) {
    const r = normalizeCardPayment(p);
    if (r) out.push(r);
  }
  return out;
}

export function filterCardRows(rows: CardRecRow[], f: CardRecFilters): CardRecRow[] {
  return rows.filter((r) => {
    if (f.kind !== "all" && r.kind !== f.kind) return false;
    if (f.brand !== "all") {
      if (f.brand === NO_BRAND ? r.brandKey !== null : r.brandKey !== f.brand) return false;
    }
    if (f.comercio !== "all") {
      if (f.comercio === NO_MERCHANT ? r.comercio !== "" : r.comercio !== f.comercio) return false;
    }
    if (f.acquirer && f.acquirer !== "all") {
      if (f.acquirer === NO_ACQUIRER ? r.adquirente !== "" : r.adquirente !== f.acquirer) return false;
    }
    if (f.status === "pending" && r.reconciledAt) return false;
    if (f.status === "reconciled" && !r.reconciledAt) return false;
    return true;
  });
}

// ── Agrupado ──────────────────────────────────────────────────────────────────

export interface Totals {
  count: number;
  amount: number;
}

export interface BatchGroup extends Totals {
  key: string;
  lote: string;
  rows: CardRecRow[];
  reconciledCount: number;
}

export interface MerchantGroup extends Totals {
  key: string;
  comercio: string;
  batches: BatchGroup[];
}

export interface DayGroup extends Totals {
  day: string;
  merchants: MerchantGroup[];
}

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

/** Orden natural ("2" antes que "10"), vacíos al final. */
function compareCode(a: string, b: string): number {
  if (a === b) return 0;
  if (!a) return 1;
  if (!b) return -1;
  return a.localeCompare(b, "es", { numeric: true });
}

/**
 * Agrupa como una liquidación del adquirente: día (más nuevo primero) → n° de
 * comercio → lote, con cantidad y monto en cada nivel. Dentro del lote, por hora.
 */
export function groupCardRows(rows: CardRecRow[]): DayGroup[] {
  const days = new Map<string, Map<string, Map<string, CardRecRow[]>>>();
  for (const r of rows) {
    let merchants = days.get(r.day);
    if (!merchants) days.set(r.day, (merchants = new Map()));
    let batches = merchants.get(r.comercio);
    if (!batches) merchants.set(r.comercio, (batches = new Map()));
    const list = batches.get(r.lote);
    if (list) list.push(r);
    else batches.set(r.lote, [r]);
  }

  return [...days.entries()]
    .sort(([a], [b]) => (a < b ? 1 : a > b ? -1 : 0))
    .map(([day, merchants]) => {
      const merchantGroups: MerchantGroup[] = [...merchants.entries()]
        .sort(([a], [b]) => compareCode(a, b))
        .map(([comercio, batches]) => {
          const batchGroups: BatchGroup[] = [...batches.entries()]
            .sort(([a], [b]) => compareCode(a, b))
            .map(([lote, list]) => {
              const sorted = [...list].sort((x, y) => (x.createdAt < y.createdAt ? -1 : x.createdAt > y.createdAt ? 1 : 0));
              return {
                key: `${day}|${comercio}|${lote}`,
                lote,
                rows: sorted,
                count: sorted.length,
                amount: round2(sorted.reduce((a, x) => a + x.amount, 0)),
                reconciledCount: sorted.filter((x) => x.reconciledAt).length,
              };
            });
          return {
            key: `${day}|${comercio}`,
            comercio,
            batches: batchGroups,
            count: batchGroups.reduce((a, b) => a + b.count, 0),
            amount: round2(batchGroups.reduce((a, b) => a + b.amount, 0)),
          };
        });
      return {
        day,
        merchants: merchantGroups,
        count: merchantGroups.reduce((a, m) => a + m.count, 0),
        amount: round2(merchantGroups.reduce((a, m) => a + m.amount, 0)),
      };
    });
}

export interface CardRecSummary {
  total: Totals;
  reconciled: Totals;
  pending: Totals;
}

export function summarizeCardRows(rows: CardRecRow[]): CardRecSummary {
  const s: CardRecSummary = {
    total: { count: 0, amount: 0 },
    reconciled: { count: 0, amount: 0 },
    pending: { count: 0, amount: 0 },
  };
  for (const r of rows) {
    const bucket = r.reconciledAt ? s.reconciled : s.pending;
    s.total.count += 1;
    s.total.amount += r.amount;
    bucket.count += 1;
    bucket.amount += r.amount;
  }
  s.total.amount = round2(s.total.amount);
  s.reconciled.amount = round2(s.reconciled.amount);
  s.pending.amount = round2(s.pending.amount);
  return s;
}

/** Estado de un grupo para su checkbox: todos, algunos o ninguno conciliado. */
export function groupCheckState(rows: CardRecRow[]): "all" | "some" | "none" {
  const n = rows.filter((r) => r.reconciledAt).length;
  if (n === 0) return "none";
  return n === rows.length ? "all" : "some";
}

/** Ids que hay que mandar a la RPC para dejar el grupo en `target`. */
export function idsToToggle(rows: CardRecRow[], target: boolean): string[] {
  return rows.filter((r) => Boolean(r.reconciledAt) !== target).map((r) => r.id);
}

// ── Opciones de filtros ──────────────────────────────────────────────────────

export interface FilterOption {
  value: string;
  label: string;
}

export function brandOptions(rows: CardRecRow[]): FilterOption[] {
  const seen = new Map<string, string>();
  let none = false;
  for (const r of rows) {
    if (r.brandKey) seen.set(r.brandKey, r.brandLabel);
    else none = true;
  }
  const out = [...seen.entries()]
    .sort(([, a], [, b]) => a.localeCompare(b, "es"))
    .map(([value, label]) => ({ value, label }));
  if (none) out.push({ value: NO_BRAND, label: "Sin marca" });
  return out;
}

/** Adquirentes presentes en los cobros (filtro "Adquirente"). */
export function acquirerOptions(rows: CardRecRow[]): FilterOption[] {
  const seen = new Set<string>();
  let none = false;
  for (const r of rows) {
    if (r.adquirente) seen.add(r.adquirente);
    else none = true;
  }
  const out = [...seen]
    .map((value) => ({ value, label: acquirerLabel(value) }))
    .sort((a, b) => a.label.localeCompare(b.label, "es"));
  if (none) out.push({ value: NO_ACQUIRER, label: "Sin adquirente" });
  return out;
}

export function merchantOptions(rows: CardRecRow[]): FilterOption[] {
  const seen = new Set<string>();
  let none = false;
  for (const r of rows) {
    if (r.comercio) seen.add(r.comercio);
    else none = true;
  }
  const out = [...seen].sort(compareCode).map((c) => ({ value: c, label: c }));
  if (none) out.push({ value: NO_MERCHANT, label: "Sin n° de comercio" });
  return out;
}

// ── Etiquetas y export ───────────────────────────────────────────────────────

export function merchantLabel(comercio: string): string {
  return comercio ? `Comercio ${comercio}` : "Sin n° de comercio";
}

export function batchLabel(lote: string): string {
  return lote ? `Lote ${lote}` : "Sin lote";
}

/** dd/MM/yyyy de un día yyyy-MM-dd. */
export function dayLabel(day: string): string {
  const [y, m, d] = day.split("-");
  return `${d}/${m}/${y}`;
}

const WEEKDAYS = ["Domingo", "Lunes", "Martes", "Miércoles", "Jueves", "Viernes", "Sábado"];

/** "Lunes 12/10/2026" de un día yyyy-MM-dd (independiente de la zona horaria). */
export function dayLongLabel(day: string): string {
  const [y, m, d] = day.split("-").map(Number);
  const wd = new Date(Date.UTC(y!, (m ?? 1) - 1, d ?? 1)).getUTCDay();
  return `${WEEKDAYS[wd]} ${dayLabel(day)}`;
}

export const XLSX_COLUMNS = [
  { header: "Fecha", key: "fecha", width: 14 },
  { header: "Hora", key: "hora", width: 8 },
  { header: "Ticket", key: "ticket", type: "number" as const, width: 10 },
  { header: "Adquirente", key: "adquirente", width: 16 },
  { header: "Marca", key: "marca", width: 16 },
  { header: "Tipo", key: "tipo", width: 10 },
  { header: "Cuotas", key: "cuotas", type: "number" as const, width: 8 },
  { header: "Comercio", key: "comercio", width: 14 },
  { header: "Lote", key: "lote", width: 10 },
  { header: "Cupón", key: "cupon", width: 10 },
  { header: "Autorización", key: "autorizacion", width: 14 },
  { header: "Últimos 4", key: "ultimos4", width: 10 },
  { header: "Cobros", key: "cantidad", type: "number" as const, width: 9 },
  { header: "Monto", key: "monto", type: "money" as const, width: 14 },
  { header: "Estado", key: "estado", width: 13 },
];

/**
 * Filas del XLSX con el mismo agrupado de la pantalla: los cobros de cada lote
 * y, debajo, el subtotal del lote; luego el del comercio y el del día.
 */
export function xlsxDetailRows(groups: DayGroup[]): Array<Record<string, unknown>> {
  const out: Array<Record<string, unknown>> = [];
  for (const d of groups) {
    for (const m of d.merchants) {
      for (const b of m.batches) {
        for (const r of b.rows) {
          out.push({
            fecha: dayLabel(r.day),
            hora: localTime(r.createdAt),
            ticket: r.ticket,
            adquirente: r.adquirente ? acquirerLabel(r.adquirente) : "",
            marca: r.brandLabel || "Sin marca",
            tipo: KIND_LABEL[r.kind],
            cuotas: r.installments,
            comercio: r.comercio,
            lote: r.lote,
            cupon: r.cupon,
            autorizacion: r.autorizacion,
            ultimos4: r.ultimos4,
            monto: r.amount,
            estado: r.reconciledAt ? "Conciliado" : "Pendiente",
          });
        }
        out.push({
          fecha: `Subtotal ${batchLabel(b.lote).toLowerCase()}`,
          comercio: m.comercio,
          lote: b.lote,
          cantidad: b.count,
          monto: b.amount,
        });
      }
      out.push({ fecha: `Subtotal ${merchantLabel(m.comercio).toLowerCase()}`, comercio: m.comercio, cantidad: m.count, monto: m.amount });
    }
    out.push({ fecha: `Total ${dayLabel(d.day)}`, cantidad: d.count, monto: d.amount });
  }
  return out;
}

/** Hoja resumen: una fila por lote (día, comercio, lote) como la liquidación. */
export function xlsxBatchRows(groups: DayGroup[]): Array<Record<string, unknown>> {
  const out: Array<Record<string, unknown>> = [];
  for (const d of groups) {
    for (const m of d.merchants) {
      for (const b of m.batches) {
        const rec = b.rows.filter((r) => r.reconciledAt).reduce((a, r) => a + r.amount, 0);
        out.push({
          fecha: dayLabel(d.day),
          comercio: m.comercio || "Sin n° de comercio",
          lote: b.lote || "Sin lote",
          cantidad: b.count,
          monto: b.amount,
          conciliado: round2(rec),
          pendiente: round2(b.amount - rec),
        });
      }
    }
  }
  return out;
}
