// Import masivo de clientes (XLSX, TX-4). Ver docs/02-roadmap.md TX-4.
import ExcelJS from "exceljs";

export interface ParsedCustomer {
  name: string;
  document_type: string | null;
  document_number: string | null;
  iva_condition: string | null;
  email: string | null;
  phone: string | null;
  address: string | null;
  notes: string | null;
}

export interface CustomerParseResult {
  rows: ParsedCustomer[];
  errors: string[];
}

export const CUSTOMER_IMPORT_COLUMNS = [
  { header: "name", key: "name" },
  { header: "document_type", key: "document_type" },
  { header: "document_number", key: "document_number" },
  { header: "iva_condition", key: "iva_condition" },
  { header: "email", key: "email" },
  { header: "phone", key: "phone" },
  { header: "address", key: "address" },
  { header: "notes", key: "notes" },
];
export const CUSTOMER_TEMPLATE_ROW = {
  name: "Juan Pérez",
  document_type: "DNI",
  document_number: "30123456",
  iva_condition: "Consumidor Final",
  email: "juan@ejemplo.com",
  phone: "1122334455",
  address: "Av. Siempreviva 742",
  notes: "",
};

const txtOrNull = (v: string | undefined): string | null => {
  const t = (v ?? "").trim();
  return t === "" ? null : t;
};

function rowsFromGrid(grid: string[][]): CustomerParseResult {
  const errors: string[] = [];
  if (grid.length < 2) return { rows: [], errors: ["El archivo no tiene filas de datos."] };
  const header = grid[0]!.map((h) => h.trim().toLowerCase());
  const idx = (n: string) => header.indexOf(n);
  if (idx("name") === -1) {
    return { rows: [], errors: ['Falta la columna obligatoria: "name".'] };
  }
  const rows: ParsedCustomer[] = [];
  for (let r = 1; r < grid.length; r++) {
    const cols = grid[r]!;
    const get = (n: string) => cols[idx(n)] ?? "";
    const name = get("name").trim();
    if (!name) {
      errors.push(`Fila ${r + 1}: sin nombre, omitida.`);
      continue;
    }
    rows.push({
      name,
      document_type: txtOrNull(get("document_type")),
      document_number: txtOrNull(get("document_number")),
      iva_condition: txtOrNull(get("iva_condition")),
      email: txtOrNull(get("email")),
      phone: txtOrNull(get("phone")),
      address: txtOrNull(get("address")),
      notes: txtOrNull(get("notes")),
    });
  }
  return { rows, errors };
}

export async function parseCustomersXlsx(
  buffer: ArrayBuffer,
): Promise<CustomerParseResult> {
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
