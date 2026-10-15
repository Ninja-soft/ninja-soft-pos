// Cómo se calcula el precio de una lista, en palabras (ADR-151). PURO.
//
// Lo usan la ficha del producto y la pantalla de listas para que el dueño
// entienda de dónde sale cada precio sin abrir la configuración de la lista.
// Sigue el mismo orden que el resolver (`resolveUnitPrice`): precio fijo del
// producto en la lista, si no la regla del tipo, después el redondeo.

import { describeRounding, isRounding, type RoundingRule } from "./rounding";
import type { ListCostBasis, ListKind, MarkupMode } from "./resolve";

export interface ExplainList {
  id: string;
  name: string;
  kind?: ListKind | string | null;
  adjustment_pct?: number | string | null;
  adjustment_amount?: number | string | null;
  base_list_id?: string | null;
  cost_basis?: ListCostBasis | string | null;
  markup_mode?: MarkupMode | string | null;
  markup_value?: number | string | null;
  currency?: string | null;
  fx_source?: string | null;
  rounding?: RoundingRule | null;
  prices_include_tax?: boolean | null;
}

const COST_LABEL: Record<string, string> = {
  cost: "Costo",
  replacement: "Costo de reposición",
  average: "Costo promedio",
  last: "Último costo",
  final: "Costo final",
};

const FX_LABEL: Record<string, string> = {
  oficial: "dólar oficial",
  bna: "dólar BNA",
  mep: "dólar MEP",
  manual: "cotización manual",
};

function n(v: unknown): number | null {
  if (v == null || v === "") return null;
  const x = Number(v);
  return Number.isFinite(x) ? x : null;
}

function fmtNum(v: number): string {
  return v.toLocaleString("es-AR", { maximumFractionDigits: 2 });
}

/** "−10 %", "+5 %", "+ $200", "−10 % − $50". Vacío si no hay ajuste. */
export function describeAdjustment(pct: unknown, amount: unknown): string {
  const p = n(pct);
  const a = n(amount);
  const parts: string[] = [];
  if (p != null && p !== 0) parts.push(`${p > 0 ? "+" : "−"}${fmtNum(Math.abs(p))} %`);
  if (a != null && a !== 0) parts.push(`${a > 0 ? "+" : "−"} $${fmtNum(Math.abs(a))}`);
  return parts.join(" ");
}

/**
 * Regla de la lista en una frase corta. `hasItem` = el producto tiene precio
 * fijo cargado en esa lista (pisa la regla). Sin PRO toda lista se calcula
 * como fija (% y monto sobre el precio de venta).
 */
export function describeListRule(
  list: ExplainList,
  lists: ExplainList[] = [],
  opts: { hasItem?: boolean; pro?: boolean } = {},
): string {
  const pro = opts.pro ?? true;
  const kind = pro ? (list.kind ?? "fixed") : "fixed";
  const extras: string[] = [];
  let main: string;
  if (opts.hasItem && kind !== "currency") {
    main = "Precio fijo para este producto";
  } else if (kind === "derived") {
    const parent = lists.find((l) => l.id === list.base_list_id);
    const adj = describeAdjustment(list.adjustment_pct, list.adjustment_amount);
    main = `Sale de ${parent?.name ?? "otra lista"}${adj ? ` ${adj}` : ""}`;
  } else if (kind === "cost") {
    const base = COST_LABEL[String(list.cost_basis ?? "cost")] ?? "Costo";
    const v = n(list.markup_value);
    main =
      v == null
        ? `${base} (sin markup cargado)`
        : `${base} + ${fmtNum(v)} % de ${list.markup_mode === "margin" ? "margen" : "markup"}`;
  } else if (kind === "currency") {
    const cur = (list.currency ?? "USD").toUpperCase();
    main = `${opts.hasItem ? "Precio fijo en" : "En"} ${cur} con ${FX_LABEL[String(list.fx_source ?? "oficial")] ?? "la cotización del día"}`;
  } else {
    const adj = describeAdjustment(list.adjustment_pct, list.adjustment_amount);
    main = adj ? `Precio de venta ${adj}` : "Igual al precio de venta";
  }
  // El redondeo sólo se aplica a precios calculados (uno cargado a mano se respeta).
  if (pro && isRounding(list.rounding) && !(opts.hasItem && kind !== "currency")) {
    extras.push(describeRounding(list.rounding).toLowerCase());
  }
  if (list.prices_include_tax === false) extras.push("sin IVA (al vender se suma)");
  return extras.length ? `${main} · ${extras.join(" · ")}` : main;
}
