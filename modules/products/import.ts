// Import masivo de productos por CSV (deseable Fase 1, docs/01-mvp.md §4.2).

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

/** Convierte el texto CSV en filas de producto validadas. */
export function parseProductsCsv(text: string): ParseResult {
  const grid = parseCsv(text);
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
    const price = numOr(get("price"), -1);
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
