// Importación de ajustes y conteos de stock (ADR-137) en el motor único
// (lib/import, ADR-078). Una fila = un ajuste: producto (SKU o código de
// barras), sucursal y depósito opcionales, operación (Sumar, Restar o Fijar),
// cantidad y motivo. El servidor (import_stock_adjustments) resuelve cada
// fila con la misma regla que el alta manual (stock_adjustment_request):
// capacidad, sucursal, depósito, umbral de aprobación y auditoría.
//
// La "planilla para contar" que se descarga desde Inventario usa estas mismas
// columnas con Operación = Fijar y Motivo = Conteo ya completos: se llena la
// cantidad y se vuelve a subir. Las filas sin cantidad se omiten.
import { z } from "zod";
import type { ImportDefinition, ImportField } from "@/lib/import/types";
import { normalizeHeader } from "@/lib/utils/xlsxImport";
import {
  ADJUST_MODE_LABEL,
  ADJUST_REASONS,
  ADJUST_REASON_LABEL,
  type AdjustMode,
  type AdjustReason,
} from "@/lib/stock/adjustments";

export interface StockAdjustmentImportRow {
  store: string | null;
  warehouse: string | null;
  warehouse_code: string | null;
  sku: string | null;
  barcode: string | null;
  product: string | null;
  system_qty: number | null;
  op: AdjustMode;
  qty: number | null;
  reason: AdjustReason;
  notes: string | null;
}

export const OP_OPTIONS = [ADJUST_MODE_LABEL.add, ADJUST_MODE_LABEL.remove, ADJUST_MODE_LABEL.set];
export const REASON_OPTIONS = ADJUST_REASONS.map((r) => r.label);

const OP_WORDS: Record<string, AdjustMode> = {
  sumar: "add",
  agregar: "add",
  ingreso: "add",
  "+": "add",
  add: "add",
  restar: "remove",
  quitar: "remove",
  descontar: "remove",
  "-": "remove",
  remove: "remove",
  fijar: "set",
  "fijar cantidad": "set",
  conteo: "set",
  contar: "set",
  "=": "set",
  set: "set",
};

/** "Sumar", "restar", "+", "Fijar cantidad"... → modo. Vacío = Fijar. */
export function parseAdjustOp(raw: string | null | undefined): AdjustMode | null {
  const t = (raw ?? "").trim();
  if (t === "") return "set";
  if (t === "+" || t === "-" || t === "=") return OP_WORDS[t]!;
  return OP_WORDS[normalizeHeader(t)] ?? null;
}

/** Etiqueta o clave del motivo → clave. Vacío = Conteo. */
export function parseAdjustReason(raw: string | null | undefined): AdjustReason | null {
  const t = normalizeHeader(raw ?? "");
  if (t === "") return "conteo";
  for (const r of ADJUST_REASONS) {
    if (normalizeHeader(r.label) === t || normalizeHeader(r.value) === t) return r.value;
  }
  // Atajos frecuentes.
  if (t === "roto" || t === "rotura") return "rotura";
  if (t === "vencido") return "vencimiento";
  if (t === "robo" || t === "faltante") return "robo";
  if (t === "error") return "error_carga";
  if (t === "inventario" || t === "conteo fisico") return "conteo";
  return null;
}

const fields = (ctx: { stores?: string[]; warehouses?: string[] }): ImportField[] => [
  { header: "Sucursal", key: "store", type: "text", aliases: ["store", "local"], options: ctx.stores, help: "Nombre o código de la sucursal. Vacío = la principal.", width: 18 },
  { header: "Depósito", key: "warehouse", type: "text", aliases: ["warehouse", "deposito"], options: ctx.warehouses, help: "Opcional. Nombre del depósito dentro de la sucursal (Salón, Reserva...). Vacío = la sucursal entera.", width: 18 },
  { header: "Código de depósito", key: "warehouse_code", type: "text", aliases: ["warehouse code", "codigo deposito"], help: "Opcional. Código del depósito (en lugar de sucursal y nombre).", width: 14 },
  { header: "SKU", key: "sku", type: "text", aliases: ["sku", "codigo"], help: "SKU del producto o de la variante. Poné el SKU o el código de barras.", width: 14 },
  { header: "Código de barras", key: "barcode", type: "text", aliases: ["barcode", "ean", "codigo de barras"], help: "Código de barras del producto o de la variante.", width: 18 },
  { header: "Producto", key: "product", type: "text", aliases: ["name", "nombre", "descripcion"], help: "Sólo de referencia (no se usa para buscar).", width: 30 },
  { header: "Stock en sistema", key: "system_qty", type: "number", aliases: ["stock actual", "sistema", "stock sistema"], cellType: "number", help: "Sólo de referencia: lo que decía el sistema al descargar la planilla. No se importa.", width: 14 },
  {
    header: "Operación",
    key: "op",
    type: "text",
    aliases: ["op", "operacion", "accion", "tipo"],
    options: OP_OPTIONS,
    help: "Sumar, Restar o Fijar (dejar exactamente esa cantidad). Vacío = Fijar.",
    width: 12,
    transform: (_v: string | null, raw: string) => {
      const m = parseAdjustOp(raw);
      return m ? { value: m } : { error: "La operación tiene que ser Sumar, Restar o Fijar." };
    },
  },
  {
    header: "Cantidad",
    key: "qty",
    type: "number",
    aliases: ["qty", "cantidad contada", "conteo", "contado", "stock"],
    cellType: "number",
    help: "Unidades a sumar o restar, o la cantidad contada si la operación es Fijar. Vacío = la fila no se toca.",
    width: 12,
    transform: (v: number | null) => (v == null || v >= 0 ? { value: v } : { error: "La cantidad no puede ser negativa: usá Restar." }),
  },
  {
    header: "Motivo",
    key: "reason",
    type: "text",
    aliases: ["reason", "causa"],
    options: REASON_OPTIONS,
    help: `Uno de la lista: ${REASON_OPTIONS.join(", ")}. Vacío = Conteo.`,
    width: 22,
    transform: (_v: string | null, raw: string) => {
      const r = parseAdjustReason(raw);
      return r ? { value: r } : { error: `El motivo tiene que ser uno de la lista (${REASON_OPTIONS.join(", ")}).` };
    },
  },
  { header: "Nota", key: "notes", type: "text", aliases: ["notes", "nota", "observacion", "comentario"], help: "Opcional (obligatoria con el motivo Otro). Máx. 300.", width: 30 },
];

export const stockAdjustmentImportDefinition: ImportDefinition<StockAdjustmentImportRow> = {
  entity: "stock_adjustments",
  rpc: "import_stock_adjustments",
  title: "Ajustes y conteos de stock",
  singular: "ajuste",
  plural: "ajustes",
  sheetName: "Ajustes",
  fileSlug: "ajustes-stock",
  intro:
    "Cargá muchos ajustes o un conteo completo de una vez: cada fila suma, resta o fija el stock de un producto con su motivo.",
  matchRule:
    "El producto se busca por SKU o código de barras. Con Fijar, la cantidad reemplaza lo que hay; sin cantidad, la fila no se toca. Los ajustes que superan el umbral quedan esperando aprobación.",
  feature: "ajustes_stock",
  fields,
  example: (ctx) => [
    { store: ctx.stores?.[0] ?? "Central", warehouse: "", warehouse_code: "", sku: "COCA500", barcode: "7790895000990", product: "Coca Cola 500ml", system_qty: 24, op: ADJUST_MODE_LABEL.set, qty: 22, reason: ADJUST_REASON_LABEL.conteo, notes: "" },
    { store: ctx.stores?.[0] ?? "Central", warehouse: "", warehouse_code: "", sku: "YERBA1K", barcode: "", product: "Yerba 1 kg", system_qty: 10, op: ADJUST_MODE_LABEL.remove, qty: 2, reason: ADJUST_REASON_LABEL.rotura, notes: "Paquetes rotos" },
  ],
  schema: () =>
    z
      .object({
        sku: z.string().nullable(),
        barcode: z.string().nullable(),
        op: z.enum(["add", "remove", "set"]),
        qty: z.number().nullable(),
        reason: z.string(),
        notes: z.string().max(300, "La nota es demasiado larga (máx. 300).").nullable(),
      })
      .passthrough()
      .superRefine((row, ctx) => {
        if (!row.sku && !row.barcode) {
          ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["sku"], message: "Poné el SKU o el código de barras del producto." });
        }
        if (row.qty != null && row.op !== "set" && row.qty === 0) {
          ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["qty"], message: "Para sumar o restar, la cantidad tiene que ser mayor a cero." });
        }
        if (row.qty != null && row.reason === "otro" && !row.notes) {
          ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["notes"], message: "Con el motivo Otro, contá qué pasó en la nota." });
        }
      }),
  dedupeKey: ["store", "warehouse", "warehouse_code", "sku", "barcode"],
  preview: [
    { header: "Dónde", cell: (r) => [r.store ?? "Principal", r.warehouse_code ?? r.warehouse].filter(Boolean).join(" · ") },
    { header: "Código", cell: (r) => r.sku ?? r.barcode ?? "" },
    { header: "Producto", cell: (r) => r.product ?? "" },
    { header: "Operación", cell: (r) => ADJUST_MODE_LABEL[r.op] },
    { header: "Cantidad", align: "right", cell: (r) => (r.qty == null ? "" : String(r.qty).replace(".", ",")) },
    { header: "Motivo", cell: (r) => ADJUST_REASON_LABEL[r.reason] },
  ],
  toPayload: ({ product: _p, system_qty: _s, ...rest }) => rest,
  actionLabels: {
    create: "Va a aprobación",
    update: "Se ajusta",
    skip: "No se toca",
  },
  confirmText: (c, done) =>
    done
      ? `Se ajustaron ${c.update} productos${c.create > 0 ? ` y ${c.create} quedaron esperando aprobación` : ""}.`
      : `Se van a ajustar ${c.update} productos${c.create > 0 ? ` y ${c.create} van a quedar esperando aprobación` : ""}.`,
  invalidate: [["products"], ["inventory-sheet"], ["stock-adjustments"], ["inventory-movements"], ["inventory-valuation"], ["warehouse-overview"]],
};
