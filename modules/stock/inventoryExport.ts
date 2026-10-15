"use client";

// Excel de Inventario (ADR-137): planilla de stock por sucursal (una hoja por
// sucursal, con el desglose por depósito y el costo si el usuario lo ve) y la
// planilla para contar en el formato de la importación de ajustes.

import { exportXlsx, xlsxFileSlug } from "@/lib/utils/xlsx";
import { templateSheets } from "@/lib/import/engine";
import {
  countSheetRows,
  fmtDateTimeAR,
  stockSheet,
  type SheetStore,
  type SheetWarehouse,
} from "@/lib/stock/inventorySheet";
import { stockAdjustmentImportDefinition } from "@/modules/imports/stockAdjustments";
import { warehousesApi } from "@/modules/stock/warehouses";
import { inventoryApi } from "./adjustments";

const MAX_ROWS = 5000;

async function warehousesOf(storeId: string, withWarehouses: boolean): Promise<SheetWarehouse[]> {
  if (!withWarehouses) return [];
  try {
    return (await warehousesApi.list(storeId)).map((w) => ({ id: w.id, name: w.name, kind: w.kind }));
  } catch {
    return [];
  }
}

export async function exportStockWorkbook(v: {
  stores: SheetStore[];
  showCost: boolean;
  withWarehouses: boolean;
  businessName?: string | null;
}): Promise<void> {
  const generatedAt = fmtDateTimeAR(new Date());
  const sheets = [];
  for (const store of v.stores) {
    const [rows, whs] = await Promise.all([
      inventoryApi.sheet({ storeId: store.id, limit: MAX_ROWS }),
      warehousesOf(store.id, v.withWarehouses),
    ]);
    sheets.push(stockSheet(store, rows, whs, { showCost: v.showCost, businessName: v.businessName, generatedAt }));
  }
  const day = new Date().toISOString().slice(0, 10);
  const slug = v.stores.length === 1 ? xlsxFileSlug(v.stores[0]!.name) : "todas";
  await exportXlsx(`stock-${slug}-${day}`, sheets);
}

/** Planilla para contar: la plantilla de ajustes con los productos ya listados. */
export async function downloadCountSheet(v: {
  store: SheetStore & { label: string };
  warehouse: SheetWarehouse | null;
  onlyWithStock: boolean;
  stores: string[];
  warehouses: string[];
}): Promise<{ rows: number; withoutCode: number }> {
  const rows = await inventoryApi.sheet({ storeId: v.store.id, onlyWithStock: v.onlyWithStock, limit: MAX_ROWS });
  const usable = rows.filter((r) => r.sku || r.barcode);
  const ctx = { stores: v.stores, warehouses: v.warehouses };
  const [data, help] = templateSheets(stockAdjustmentImportDefinition, ctx);
  const sheets = [{ ...data!, rows: countSheetRows(usable, v.store, v.warehouse) }, help!];
  const day = new Date().toISOString().slice(0, 10);
  const where = v.warehouse ? `${v.store.name}-${v.warehouse.name}` : v.store.name;
  await exportXlsx(`conteo-${xlsxFileSlug(where)}-${day}`, sheets);
  return { rows: usable.length, withoutCode: rows.length - usable.length };
}
