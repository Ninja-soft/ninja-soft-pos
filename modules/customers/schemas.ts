import { z } from "zod";
import { FISCAL_CONDITIONS, FISCAL_CONDITION_LABEL } from "@/lib/tax/catalog";

export const DOC_TYPES = ["cuit", "dni", "cuil", "passport", "other"] as const;
export const DOC_TYPE_LABELS: Record<(typeof DOC_TYPES)[number], string> = {
  cuit: "CUIT",
  dni: "DNI",
  cuil: "CUIL",
  passport: "Pasaporte",
  other: "Otro",
};

// Condición fiscal ampliada (ADR-068): mismo catálogo que lib/tax/catalog.ts
// y el check de customers.iva_condition.
export const IVA_CONDITIONS = FISCAL_CONDITIONS;
export const IVA_LABELS: Record<(typeof IVA_CONDITIONS)[number], string> = FISCAL_CONDITION_LABEL;

/** Valida dígito verificador de CUIT/CUIL (11 dígitos). */
export function isValidCuit(value: string): boolean {
  const digits = value.replace(/\D/g, "");
  if (digits.length !== 11) return false;
  const weights = [5, 4, 3, 2, 7, 6, 5, 4, 3, 2];
  let sum = 0;
  for (let i = 0; i < 10; i++) sum += Number(digits[i]) * weights[i]!;
  let check = 11 - (sum % 11);
  if (check === 11) check = 0;
  if (check === 10) check = 9;
  return check === Number(digits[10]);
}

const optional = (max: number) =>
  z
    .string()
    .max(max)
    .optional()
    .or(z.literal(""))
    .transform((v) => (v ? v : null));

export const CustomerSchema = z
  .object({
    name: z.string().min(1, "Requerido").max(120),
    document_type: z.enum(DOC_TYPES).nullable().optional(),
    document_number: optional(20),
    iva_condition: z.enum(IVA_CONDITIONS).nullable().optional(),
    // Jurisdicción de IIBB del domicilio fiscal (ADR-068). "" → null.
    iibb_jurisdiction: z
      .string()
      .regex(/^9\d{2}$/)
      .or(z.literal(""))
      .nullable()
      .optional()
      .transform((v) => (v ? v : null)),
    email: z
      .string()
      .email("Email inválido")
      .optional()
      .or(z.literal(""))
      .transform((v) => (v ? v : null)),
    phone: optional(40),
    address: optional(160),
    birth_date: optional(10),
    notes: optional(300),
    // Preferencias / gustos del cliente (H40): texto libre, distinto de notes.
    preferences: optional(600),
    is_active: z.boolean().default(true),
    credit_limit: z.coerce.number().min(0).default(0),
    group_id: z
      .string()
      .uuid()
      .or(z.literal(""))
      .nullable()
      .optional()
      .transform((v) => (v ? v : null)),
    // ADR-133: "padron" lo valida el servidor contra una consulta real a ARCA
    // (trigger de customers); fiscal_verified_at distinto del guardado pide
    // reverificar. Sólo viajan si el formulario los tocó.
    fiscal_verification: z.enum(["padron", "manual"]).nullable().optional(),
    fiscal_verified_at: z.string().nullable().optional(),
  })
  .refine(
    (d) =>
      !(
        (d.document_type === "cuit" || d.document_type === "cuil") &&
        d.document_number &&
        !isValidCuit(d.document_number)
      ),
    { message: "CUIT/CUIL inválido", path: ["document_number"] },
  )
  .refine(
    (d) =>
      !(
        d.document_type === "dni" &&
        d.document_number &&
        !/^\d{7,8}$/.test(d.document_number.replace(/\D/g, ""))
      ),
    { message: "DNI inválido (7-8 dígitos)", path: ["document_number"] },
  );

export type CustomerInput = z.input<typeof CustomerSchema>;
export type CustomerOutput = z.output<typeof CustomerSchema>;

// Campos del cliente que el dueño puede marcar como obligatorios (H31).
export const CUSTOMER_FIELDS = [
  { key: "document_number", label: "Documento" },
  { key: "iva_condition", label: "Condición IVA" },
  { key: "phone", label: "Teléfono" },
  { key: "email", label: "Email" },
  { key: "address", label: "Dirección" },
  { key: "birth_date", label: "Fecha de nacimiento" },
] as const;
export type CustomerFieldKey = (typeof CUSTOMER_FIELDS)[number]["key"];
export type CustomerRequired = Partial<Record<CustomerFieldKey, boolean>>;
