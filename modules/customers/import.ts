// Import masivo de clientes en XLSX (TX-4, ADR-078). Definición para el motor
// único (lib/import): normaliza tipo de documento e IVA a los enums internos
// (DNI→dni, "Consumidor final"→consumidor_final), valida email y CUIT/CUIL/DNI
// con Zod y manda las filas a import_customers (dry-run + aplicación en el
// servidor: documento existente → actualiza; si no, crea).
import { z } from "zod";
import { exportColumns, parseImportFile } from "@/lib/import/engine";
import type { ImportContext, ImportDefinition, ImportField } from "@/lib/import/types";
import { normalizeHeader, type ParseXlsxResult } from "@/lib/utils/xlsxImport";
import type { XlsxColumn } from "@/lib/utils/xlsx";
import {
  DOC_TYPES,
  DOC_TYPE_LABELS,
  IVA_CONDITIONS,
  IVA_LABELS,
  isValidCuit,
} from "./schemas";

/** Fila de cliente ya tipada lista para importar. */
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

// Etiqueta/alias (normalizados) → valor de enum interno.
const DOC_TYPE_BY_LABEL = new Map<string, string>();
for (const code of DOC_TYPES) {
  DOC_TYPE_BY_LABEL.set(normalizeHeader(code), code);
  DOC_TYPE_BY_LABEL.set(normalizeHeader(DOC_TYPE_LABELS[code]), code);
}
DOC_TYPE_BY_LABEL.set("pasaporte", "passport");

const IVA_BY_LABEL = new Map<string, string>();
for (const code of IVA_CONDITIONS) {
  IVA_BY_LABEL.set(normalizeHeader(code), code);
  IVA_BY_LABEL.set(normalizeHeader(IVA_LABELS[code]), code);
}
for (const [alias, code] of [
  ["cf", "consumidor_final"],
  ["ri", "responsable_inscripto"],
  ["mono", "monotributo"],
  ["exento", "exento"],
] as const) {
  IVA_BY_LABEL.set(alias, code);
}

const DOC_OPTIONS = DOC_TYPES.map((c) => DOC_TYPE_LABELS[c]);
const IVA_OPTIONS = IVA_CONDITIONS.map((c) => IVA_LABELS[c]);

function customerFields(ctx: ImportContext): ImportField[] {
  const requireDoc = Boolean(ctx.requireCustomerDoc);
  return [
    { header: "Nombre", key: "name", type: "text", required: true, aliases: ["name", "razon social", "cliente"], help: "Nombre y apellido o razón social.", width: 28 },
    {
      header: "Tipo de documento",
      key: "document_type",
      type: "text",
      required: requireDoc,
      aliases: ["document_type", "tipo documento", "tipo doc"],
      options: DOC_OPTIONS,
      help: requireDoc ? "Obligatorio en tu negocio. DNI, CUIT, CUIL, Pasaporte u Otro." : "DNI, CUIT, CUIL, Pasaporte u Otro.",
      transform: (v: string | null) => {
        if (v == null || v === "") {
          return requireDoc ? { error: "Falta el tipo de documento." } : { value: null };
        }
        const code = DOC_TYPE_BY_LABEL.get(normalizeHeader(v));
        return code
          ? { value: code }
          : { error: `Tipo de documento no reconocido ("${v}"). Usá DNI, CUIT, CUIL, Pasaporte u Otro.` };
      },
    },
    {
      header: "Número de documento",
      key: "document_number",
      type: "text",
      required: requireDoc,
      aliases: ["document_number", "nro documento", "numero documento", "documento", "doc", "cuit", "dni"],
      help: "Sin puntos ni guiones. Si ya hay un cliente con ese documento, se actualiza.",
      width: 18,
      transform: (v: string | null) => {
        const t = (v ?? "").trim();
        if (t === "") return requireDoc ? { error: "Falta el número de documento." } : { value: null };
        return { value: t };
      },
    },
    {
      header: "Condición IVA",
      key: "iva_condition",
      type: "text",
      aliases: ["iva_condition", "condicion iva", "iva", "condicion frente al iva"],
      options: IVA_OPTIONS,
      help: "Condición frente al IVA (Consumidor final, Responsable inscripto, Monotributo...).",
      width: 22,
      transform: (v: string | null) => {
        if (v == null || v === "") return { value: null };
        const code = IVA_BY_LABEL.get(normalizeHeader(v));
        return code ? { value: code } : { error: `Condición de IVA no reconocida ("${v}").` };
      },
    },
    { header: "Email", key: "email", type: "text", aliases: ["email", "correo", "e-mail", "mail"], help: "Para mandarle comprobantes.", width: 26 },
    { header: "Teléfono", key: "phone", type: "text", aliases: ["phone", "tel", "celular", "whatsapp"], help: "Con código de área.", width: 16 },
    { header: "Dirección", key: "address", type: "text", aliases: ["address", "domicilio"], help: "Domicilio.", width: 28 },
    { header: "Notas", key: "notes", type: "text", aliases: ["notes", "observaciones"], help: "Notas internas.", width: 28 },
  ];
}

const customerSchema = z
  .object({
    name: z.string().max(200, "El nombre es demasiado largo (máx. 200)."),
    document_type: z.string().nullable(),
    document_number: z.string().max(20, "El documento es demasiado largo (máx. 20).").nullable(),
    email: z
      .string()
      .nullable()
      .refine((v) => v == null || /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(v.trim()), (v) => ({
        message: `Email inválido ("${v}").`,
      })),
  })
  .passthrough()
  .superRefine((row, ctx) => {
    // Validación cruzada tipo + número (CUIT/CUIL: dígito verificador; DNI: 7 u 8 dígitos).
    const dt = row.document_type;
    const dn = row.document_number;
    if (!dt || !dn) return;
    if ((dt === "cuit" || dt === "cuil") && !isValidCuit(dn)) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["document_number"], message: `${dt.toUpperCase()} inválido (dígito verificador).` });
    } else if (dt === "dni" && !/^\d{7,8}$/.test(dn.replace(/\D/g, ""))) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["document_number"], message: "DNI inválido (debe tener 7 u 8 dígitos)." });
    }
  });

const docLabel = (code: string | null) =>
  code ? (DOC_TYPE_LABELS[code as keyof typeof DOC_TYPE_LABELS] ?? code) : "";
const ivaLabel = (code: string | null) =>
  code ? (IVA_LABELS[code as keyof typeof IVA_LABELS] ?? code) : "";

export const customerImportDefinition: ImportDefinition<ParsedCustomer> = {
  entity: "customers",
  rpc: "import_customers",
  title: "Clientes",
  singular: "cliente",
  plural: "clientes",
  sheetName: "Clientes",
  fileSlug: "clientes",
  intro: "Cargá o actualizá tu base de clientes con sus datos fiscales y de contacto.",
  matchRule: "Si ya hay un cliente con ese número de documento, se actualiza; si no, se crea uno nuevo.",
  feature: "clientes",
  fields: customerFields,
  example: () => [
    { name: "Juan Pérez", document_type: "DNI", document_number: "30123456", iva_condition: "Consumidor final", email: "juan@ejemplo.com", phone: "1122334455", address: "Av. Siempreviva 742", notes: "" },
  ],
  schema: () => customerSchema,
  dedupeKey: "document_number",
  preview: [
    { header: "Nombre", cell: (r) => r.name },
    { header: "Documento", cell: (r) => (r.document_number ? `${docLabel(r.document_type)} ${r.document_number}`.trim() : "") },
    { header: "IVA", cell: (r) => ivaLabel(r.iva_condition) },
    { header: "Email", cell: (r) => r.email ?? "" },
    { header: "Teléfono", cell: (r) => r.phone ?? "" },
  ],
  invalidate: [["customers"]],
};

/** Columnas de la plantilla/export de clientes (XLSX). */
export const CUSTOMER_IMPORT_COLUMNS: XlsxColumn[] = exportColumns(customerImportDefinition);

/** Fila de ejemplo para la plantilla. */
export const CUSTOMER_TEMPLATE_ROW: Record<string, unknown> = customerImportDefinition.example({})[0]!;

/**
 * Lee un XLSX de clientes y devuelve filas tipadas + errores por fila.
 * @param requireDoc si el negocio exige documento (require_customer_doc).
 */
export function parseCustomersXlsx(
  buffer: ArrayBuffer,
  requireDoc = false,
): Promise<ParseXlsxResult<ParsedCustomer>> {
  return parseImportFile(customerImportDefinition, buffer, { requireCustomerDoc: requireDoc });
}
