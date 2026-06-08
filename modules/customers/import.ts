// Import masivo de clientes en XLSX (TX-3). Usa el helper genérico `parseXlsx`
// y normaliza tipo de documento e IVA a los enums internos (DNI→dni,
// "Consumidor Final"→consumidor_final, etc.). El modal de preview consume las
// filas válidas/ inválidas; la inserción la hace `customersApi.bulkImport`.
import {
  parseXlsx,
  type ImportColumn,
  type ParseXlsxResult,
} from "@/lib/utils/xlsxImport";
import type { XlsxColumn } from "@/lib/utils/xlsx";
import {
  DOC_TYPES,
  DOC_TYPE_LABELS,
  IVA_CONDITIONS,
  IVA_LABELS,
  isValidCuit,
} from "./schemas";

/** Fila de cliente ya tipada lista para insertar. */
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

/** Columnas de la plantilla/export de clientes (XLSX). */
export const CUSTOMER_IMPORT_COLUMNS: XlsxColumn[] = [
  { header: "name", key: "name" },
  { header: "document_type", key: "document_type" },
  { header: "document_number", key: "document_number" },
  { header: "iva_condition", key: "iva_condition" },
  { header: "email", key: "email" },
  { header: "phone", key: "phone" },
  { header: "address", key: "address" },
  { header: "notes", key: "notes" },
];

/** Fila de ejemplo para la plantilla. */
export const CUSTOMER_TEMPLATE_ROW: Record<string, unknown> = {
  name: "Juan Pérez",
  document_type: "DNI",
  document_number: "30123456",
  iva_condition: "Consumidor Final",
  email: "juan@ejemplo.com",
  phone: "1122334455",
  address: "Av. Siempreviva 742",
  notes: "",
};

// Mapa etiqueta/alias → valor de enum interno para tipo de documento.
// Acepta el código (dni), la etiqueta (DNI) y variantes comunes.
const DOC_TYPE_BY_LABEL = new Map<string, string>();
for (const code of DOC_TYPES) {
  DOC_TYPE_BY_LABEL.set(code, code);
  DOC_TYPE_BY_LABEL.set(DOC_TYPE_LABELS[code].toLowerCase(), code);
}
DOC_TYPE_BY_LABEL.set("pasaporte", "passport");

// Mapa etiqueta/alias → valor de enum interno para condición de IVA.
const IVA_BY_LABEL = new Map<string, string>();
for (const code of IVA_CONDITIONS) {
  IVA_BY_LABEL.set(code, code);
  IVA_BY_LABEL.set(IVA_LABELS[code].toLowerCase(), code);
}
// Alias frecuentes.
IVA_BY_LABEL.set("consumidor final", "consumidor_final");
IVA_BY_LABEL.set("cf", "consumidor_final");
IVA_BY_LABEL.set("responsable inscripto", "responsable_inscripto");
IVA_BY_LABEL.set("ri", "responsable_inscripto");
IVA_BY_LABEL.set("mono", "monotributo");
IVA_BY_LABEL.set("no responsable", "no_responsable");

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

// Construye el spec. `requireDoc` viene de la config del tenant
// (require_customer_doc): cuando es true, tipo y número de documento pasan a ser
// obligatorios y se validan en conjunto.
function buildSpec(requireDoc: boolean): ImportColumn[] {
  return [
    { header: "name", key: "name", type: "text", required: true, aliases: ["nombre", "razon social", "razón social"] },
    {
      header: "document_type",
      key: "document_type",
      type: "text",
      required: requireDoc,
      aliases: ["tipo documento", "tipo de documento", "tipo_doc"],
      transform: (v: string | null) => {
        if (v == null || v === "") {
          return requireDoc
            ? { error: "Falta el tipo de documento." }
            : { value: null };
        }
        const code = DOC_TYPE_BY_LABEL.get(v.trim().toLowerCase());
        if (!code) {
          return {
            error: `Tipo de documento no reconocido ("${v}"). Usá DNI, CUIT, CUIL, Pasaporte u Otro.`,
          };
        }
        return { value: code };
      },
    },
    {
      header: "document_number",
      key: "document_number",
      type: "text",
      required: requireDoc,
      aliases: ["nro documento", "número documento", "numero documento", "documento", "doc"],
      transform: (v: string | null) => {
        const t = (v ?? "").trim();
        if (t === "") {
          return requireDoc
            ? { error: "Falta el número de documento." }
            : { value: null };
        }
        return { value: t };
      },
    },
    {
      header: "iva_condition",
      key: "iva_condition",
      type: "text",
      aliases: ["condicion iva", "condición iva", "iva", "condicion frente al iva"],
      transform: (v: string | null) => {
        if (v == null || v === "") return { value: null };
        const code = IVA_BY_LABEL.get(v.trim().toLowerCase());
        if (!code) {
          return {
            error: `Condición de IVA no reconocida ("${v}").`,
          };
        }
        return { value: code };
      },
    },
    {
      header: "email",
      key: "email",
      type: "text",
      aliases: ["correo", "e-mail"],
      transform: (v: string | null) => {
        const t = (v ?? "").trim();
        if (t === "") return { value: null };
        return EMAIL_RE.test(t)
          ? { value: t }
          : { error: `Email inválido ("${t}").` };
      },
    },
    { header: "phone", key: "phone", type: "text", aliases: ["telefono", "teléfono", "tel", "celular"] },
    { header: "address", key: "address", type: "text", aliases: ["direccion", "dirección", "domicilio"] },
    { header: "notes", key: "notes", type: "text", aliases: ["notas", "observaciones"] },
  ];
}

/**
 * Lee un XLSX de clientes y devuelve filas tipadas + errores por fila.
 * Normaliza tipo de documento e IVA a los enums internos y valida el dígito
 * verificador de CUIT/CUIL. Detecta documentos duplicados dentro del archivo.
 *
 * @param requireDoc si el tenant exige documento (require_customer_doc).
 */
export async function parseCustomersXlsx(
  buffer: ArrayBuffer,
  requireDoc = false,
): Promise<ParseXlsxResult<ParsedCustomer>> {
  const result = await parseXlsx<ParsedCustomer>(buffer, buildSpec(requireDoc), {
    dedupeKey: "document_number",
  });

  // Validación cruzada tipo+número (CUIT/CUIL: dígito verificador; DNI: 7-8
  // dígitos). Se hace acá porque depende de dos columnas a la vez.
  for (const row of result.rows) {
    const { document_type: dt, document_number: dn } = row.data;
    if (!dt || !dn) continue;
    if ((dt === "cuit" || dt === "cuil") && !isValidCuit(dn)) {
      row.errors.push(`${dt.toUpperCase()} inválido (dígito verificador).`);
    } else if (dt === "dni" && !/^\d{7,8}$/.test(dn.replace(/\D/g, ""))) {
      row.errors.push("DNI inválido (debe tener 7-8 dígitos).");
    }
  }

  return result;
}
