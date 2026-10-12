// Impresoras por sucursal y caja (F17 · ADR-049). Lógica pura.
//
// Cada perfil de impresión (lib/print/profiles.ts, heredado negocio ← grupo ←
// sucursal ← caja) puede apuntar a una impresora registrada y a una de
// respaldo. Al imprimir se resuelve:
//   1. La asignada, si está activa y es de esta sucursal (y de esta caja o
//      sin caja).
//   2. La de respaldo, con las mismas condiciones.
//   3. Una compatible por tipo: primero de la caja, después de la sucursal.
//   4. Ninguna: el navegador usa la impresora predeterminada del equipo.
// La salida sigue siendo por el diálogo del navegador (web print): el
// registro decide papel y formato y le dice al cajero dónde sale; la
// impresión directa ESC/POS queda para un conector local.

import type { PrintDocType, PrintPaper, PrintProfile } from "./profiles";
import { PRINT_DOC_META } from "./profiles";

export type PrinterKind = "thermal_58" | "thermal_80" | "a4" | "label" | "kitchen";
export type PrinterConnection = "browser" | "network" | "usb" | "bluetooth";

export interface Printer {
  id: string;
  store_id: string;
  cash_register_id: string | null;
  name: string;
  kind: PrinterKind;
  connection: PrinterConnection;
  address: string | null;
  active: boolean;
  notes: string | null;
  last_test_at: string | null;
  last_test_ok: boolean | null;
  deleted_at?: string | null;
}

export const PRINTER_KIND_LABEL: Record<PrinterKind, string> = {
  thermal_58: "Térmica 58 mm",
  thermal_80: "Térmica 80 mm",
  a4: "A4 / láser / PDF",
  label: "Etiquetadora",
  kitchen: "Comandera (cocina / barra)",
};

export const PRINTER_CONNECTION_LABEL: Record<PrinterConnection, string> = {
  browser: "Del equipo (navegador)",
  network: "Red / IP",
  usb: "USB",
  bluetooth: "Bluetooth",
};

/** Papel que imprime cada tipo de impresora. */
export function paperOf(kind: PrinterKind): PrintPaper {
  if (kind === "thermal_58" || kind === "label") return "58";
  if (kind === "a4") return "a4";
  return "80";
}

/** Tipos de impresora que sirven para un documento. */
export function kindsFor(doc: PrintDocType): PrinterKind[] {
  if (doc === "product_label") return ["label", "thermal_58", "thermal_80"];
  if (doc === "kitchen") return ["kitchen", "thermal_80", "thermal_58"];
  const papers = PRINT_DOC_META[doc].papers;
  const all: PrinterKind[] = ["thermal_80", "thermal_58", "a4"];
  return all.filter((k) => papers.includes(paperOf(k)));
}

export interface PrinterLocation {
  storeId: string | null;
  registerId: string | null;
}

export function printerAvailable(p: Printer | undefined | null, loc: PrinterLocation): p is Printer {
  return Boolean(
    p &&
      !p.deleted_at &&
      p.active &&
      (!loc.storeId || p.store_id === loc.storeId) &&
      (!p.cash_register_id || !loc.registerId || p.cash_register_id === loc.registerId),
  );
}

export type PrinterPickReason = "assigned" | "fallback" | "auto_register" | "auto_store" | "browser";

export interface PrintTarget {
  printer: Printer | null;
  reason: PrinterPickReason;
  /** La asignada no estaba disponible (se usó respaldo, automática o navegador). */
  degraded: boolean;
  /** Perfil con el papel de la impresora elegida. */
  profile: PrintProfile;
}

export function resolvePrintTarget(
  doc: PrintDocType,
  profile: PrintProfile,
  printers: Printer[],
  loc: PrinterLocation,
): PrintTarget {
  const byId = new Map(printers.map((p) => [p.id, p]));
  const withPaper = (printer: Printer | null): PrintProfile => {
    if (!printer) return profile;
    const paper = paperOf(printer.kind);
    return PRINT_DOC_META[doc].papers.includes(paper) ? { ...profile, paper } : profile;
  };
  const assigned = profile.printer_id ? byId.get(profile.printer_id) : undefined;
  if (printerAvailable(assigned, loc)) {
    return { printer: assigned, reason: "assigned", degraded: false, profile: withPaper(assigned) };
  }
  const wanted = Boolean(profile.printer_id);
  const fallback = profile.fallback_printer_id ? byId.get(profile.fallback_printer_id) : undefined;
  if (printerAvailable(fallback, loc)) {
    return { printer: fallback, reason: "fallback", degraded: wanted, profile: withPaper(fallback) };
  }
  const kinds = kindsFor(doc);
  const compatible = printers
    .filter((p) => printerAvailable(p, loc) && kinds.includes(p.kind))
    // Preferencia: el tipo que corresponde al papel del perfil.
    .sort(
      (a, b) =>
        Number(paperOf(b.kind) === profile.paper) - Number(paperOf(a.kind) === profile.paper) ||
        kinds.indexOf(a.kind) - kinds.indexOf(b.kind) ||
        a.name.localeCompare(b.name),
    );
  const ownReg = compatible.find((p) => loc.registerId && p.cash_register_id === loc.registerId);
  if (ownReg) return { printer: ownReg, reason: "auto_register", degraded: wanted, profile: withPaper(ownReg) };
  const store = compatible.find((p) => !p.cash_register_id);
  if (store) return { printer: store, reason: "auto_store", degraded: wanted, profile: withPaper(store) };
  return { printer: null, reason: "browser", degraded: wanted, profile };
}

/** Texto corto para el modal de impresión ("Sale por: Térmica Caja 1"). */
export function printTargetLabel(t: PrintTarget): string {
  if (!t.printer) return t.degraded ? "Impresora asignada no disponible: sale por la del equipo" : "Sale por la impresora del equipo";
  const base = `Sale por: ${t.printer.name}`;
  return t.degraded ? `${base} (respaldo)` : base;
}
