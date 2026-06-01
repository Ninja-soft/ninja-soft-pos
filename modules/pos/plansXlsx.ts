// Import/parse de planes de pago desde XLSX (H27).
import ExcelJS from "exceljs";
import type { PaymentPlanInput } from "./api";
import { ALL_BRANDS, BASE_LABEL, BRAND_LABEL, planLabel } from "./planConstants";

export type PlanRow = Omit<PaymentPlanInput, "provider_key">;
export interface PlanParseResult {
  rows: PlanRow[];
  errors: string[];
}

function stripAccents(s: string): string {
  return s.normalize("NFD").replace(new RegExp("[\u0300-\u036f]", "g"), "");
}
function norm(s: string): string {
  return stripAccents(s.trim().toLowerCase());
}

const BASE_BY_NORM: Record<string, string> = (() => {
  const m: Record<string, string> = {};
  for (const [key, label] of Object.entries(BASE_LABEL)) {
    m[key] = key;
    m[norm(label)] = key;
  }
  return m;
})();

const BRAND_BY_NORM: Record<string, string> = (() => {
  const m: Record<string, string> = {};
  for (const b of ALL_BRANDS) m[b] = b;
  for (const [key, label] of Object.entries(BRAND_LABEL)) m[norm(label)] = key;
  return m;
})();

function cellText(v: ExcelJS.CellValue): string {
  if (v == null) return "";
  if (typeof v === "object" && "text" in (v as object))
    return String((v as { text: unknown }).text ?? "");
  if (typeof v === "object" && "result" in (v as object))
    return String((v as { result: unknown }).result ?? "");
  return String(v);
}

// Columnas esperadas (header, insensible a may/acentos): base, marca, cuotas, recargo.
export async function parsePlansXlsx(buffer: ArrayBuffer): Promise<PlanParseResult> {
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.load(buffer);
  const ws = wb.worksheets[0];
  if (!ws) return { rows: [], errors: ["El archivo no tiene hojas."] };

  const grid: string[][] = [];
  ws.eachRow({ includeEmpty: false }, (row) => {
    const cells: string[] = [];
    row.eachCell({ includeEmpty: true }, (cell) => cells.push(cellText(cell.value).trim()));
    grid.push(cells);
  });
  if (grid.length < 2) return { rows: [], errors: ["El archivo no tiene filas de datos."] };

  const header = grid[0]!.map((h) => norm(h));
  const col = (...names: string[]) => header.findIndex((h) => names.includes(h));
  const iBase = col("base");
  const iBrand = col("marca", "brand");
  const iCuotas = col("cuotas", "installments", "cuota");
  const iRec = col("recargo", "recargo %", "recargo%", "surcharge", "recargo_pct");

  const errors: string[] = [];
  if (iBase < 0) errors.push('Falta la columna "base".');
  if (iCuotas < 0) errors.push('Falta la columna "cuotas".');
  if (errors.length) return { rows: [], errors };

  const rows: PlanRow[] = [];
  for (let r = 1; r < grid.length; r++) {
    const line = grid[r]!;
    const baseRaw = norm(line[iBase] ?? "");
    if (!baseRaw) continue;
    const base = BASE_BY_NORM[baseRaw];
    if (!base) {
      errors.push(`Fila ${r + 1}: base desconocida "${line[iBase]}".`);
      continue;
    }
    const brandRaw = iBrand >= 0 ? norm(line[iBrand] ?? "") : "";
    const brand = brandRaw ? (BRAND_BY_NORM[brandRaw] ?? null) : null;
    if (brandRaw && !brand) {
      errors.push(`Fila ${r + 1}: marca desconocida "${line[iBrand]}".`);
      continue;
    }
    const installments = Math.max(1, parseInt(line[iCuotas] ?? "1", 10) || 1);
    const surcharge_pct =
      iRec >= 0 ? Number((line[iRec] ?? "0").replace(",", ".").replace("%", "")) || 0 : 0;
    rows.push({
      base,
      brand,
      installments,
      surcharge_pct,
      label: planLabel(base, brand, installments),
    });
  }
  return { rows, errors };
}
