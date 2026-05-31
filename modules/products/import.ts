// Import masivo de productos. Estándar XLSX (TX-4); se mantiene el parser de
// grilla para reusarlo. Ver docs/02-roadmap.md TX-4.
import ExcelJS from "exceljs";

export interface ParsedProduct {
  name: string;
  sku: string | null;
  barcode: string | null;
  price: number;
  cost: number | null;
  stock: number;
  stock_min: number;
  unit: string;
  category: string | null;
}

export interface ParseResult {
  rows: ParsedProduct[];
  errors: string[];
}

export const CSV_TEMPLATE =
  "name,sku,barcode,price,cost,stock,stock_min,unit,category\n" +
  "Coca Cola 500ml,COCA500,7790001,800,500,24,6,un,Bebidas\n";

/** Parser CSV mínimo con soporte de comillas dobles. */
function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = "";
  let inQuotes = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (inQuotes) {
      if (c === '"') {
        if (text[i + 1] === '"') {
          field += '"';
          i++;
        } else inQuotes = false;
      } else field += c;
    } else if (c === '"') {
      inQuotes = true;
    } else if (c === ",") {
      row.push(field);
      field = "";
    } else if (c === "\n" || c === "\r") {
      if (c === "\r" && text[i + 1] === "\n") i++;
      row.push(field);
      if (row.some((f) => f.trim() !== "")) rows.push(row);
      row = [];
      field = "";
    } else field += c;
  }
  if (field !== "" || row.length > 0) {
    row.push(field);
    if (row.some((f) => f.trim() !== "")) rows.push(row);
  }
  return rows;
}

const numOr = (v: string, def: number): number => {
  const n = Number(String(v).replace(",", ".").trim());
  return Number.isFinite(n) ? n : def;
};
const txtOrNull = (v: string | undefined): string | null => {
  const t = (v ?? "").trim();
  return t === "" ? null : t;
};

/** Columnas de la plantilla/export de productos (XLSX). */
export const PRODUCT_IMPORT_COLUMNS = [
  { header: "name", key: "name" },
  { header: "sku", key: "sku" },
  { header: "barcode", key: "barcode" },
  { header: "price", key: "price", type: "money" as const },
  { header: "cost", key: "cost", type: "money" as const },
  { header: "stock", key: "stock", type: "number" as const },
  { header: "stock_min", key: "stock_min", type: "number" as const },
  { header: "unit", key: "unit" },
  { header: "category", key: "category" },
];
export const PRODUCT_TEMPLATE_ROW = {
  name: "Coca Cola 500ml",
  sku: "COCA500",
  barcode: "7790001",
  price: 800,
  cost: 500,
  stock: 24,
  stock_min: 6,
  unit: "un",
  category: "Bebidas",
};

/** Valida una grilla (header + filas) en filas de producto. */
function rowsFromGrid(grid: string[][]): ParseResult {
  const errors: string[] = [];
  if (grid.length < 2) {
    return { rows: [], errors: ["El archivo no tiene filas de datos."] };
  }
  const header = grid[0]!.map((h) => h.trim().toLowerCase());
  const idx = (name: string) => header.indexOf(name);
  if (idx("name") === -1 || idx("price") === -1) {
    return {
      rows: [],
      errors: ['Faltan columnas obligatorias: "name" y "price".'],
    };
  }

  const rows: ParsedProduct[] = [];
  for (let r = 1; r < grid.length; r++) {
    const cols = grid[r]!;
    const get = (name: string) => cols[idx(name)] ?? "";
    const name = get("name").trim();
    if (!name) {
      errors.push(`Fila ${r + 1}: sin nombre, omitida.`);
      continue;
    }
    const priceRaw = get("price").trim();
    const price = priceRaw === "" ? -1 : numOr(priceRaw, -1);
    if (price < 0) {
      errors.push(`Fila ${r + 1} (${name}): precio inválido, omitida.`);
      continue;
    }
    rows.push({
      name,
      sku: txtOrNull(get("sku")),
      barcode: txtOrNull(get("barcode")),
      price,
      cost: idx("cost") > -1 && get("cost").trim() ? numOr(get("cost"), 0) : null,
      stock: numOr(get("stock"), 0),
      stock_min: numOr(get("stock_min"), 0),
      unit: txtOrNull(get("unit")) ?? "un",
      category: txtOrNull(get("category")),
    });
  }
  return { rows, errors };
}

/** Convierte el texto CSV en filas de producto validadas. */
export function parseProductsCsv(text: string): ParseResult {
  return rowsFromGrid(parseCsv(text));
}

/** Lee un XLSX y devuelve filas de producto validadas. */
export async function parseProductsXlsx(buffer: ArrayBuffer): Promise<ParseResult> {
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.load(buffer);
  const ws = wb.worksheets[0];
  if (!ws) return { rows: [], errors: ["El archivo no tiene hojas."] };
  const grid: string[][] = [];
  ws.eachRow({ includeEmpty: false }, (row) => {
    const cells: string[] = [];
    row.eachCell({ includeEmpty: true }, (cell) => {
      const v = cell.value;
      const text =
        v == null
          ? ""
          : typeof v === "object" && "text" in (v as object)
            ? String((v as { text: unknown }).text ?? "")
            : typeof v === "object" && "result" in (v as object)
              ? String((v as { result: unknown }).result ?? "")
              : String(v);
      cells.push(text.trim());
    });
    grid.push(cells);
  });
  return rowsFromGrid(grid);
}
