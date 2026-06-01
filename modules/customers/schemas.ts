import { z } from "zod";

export const DOC_TYPES = ["cuit", "dni", "cuil", "passport", "other"] as const;
export const DOC_TYPE_LABELS: Record<(typeof DOC_TYPES)[number], string> = {
  cuit: "CUIT",
  dni: "DNI",
  cuil: "CUIL",
  passport: "Pasaporte",
  other: "Otro",
};

export const IVA_CONDITIONS = [
  "consumidor_final",
  "responsable_inscripto",
  "monotributo",
  "exento",
  "no_responsable",
] as const;
export const IVA_LABELS: Record<(typeof IVA_CONDITIONS)[number], string> = {
  consumidor_final: "Consumidor final",
  responsable_inscripto: "Responsable inscripto",
  monotributo: "Monotributo",
  exento: "Exento",
  no_responsable: "No responsable",
};

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
    email: z
      .string()
      .email("Email inválido")
      .optional()
      .or(z.literal(""))
      .transform((v) => (v ? v : null)),
    phone: optional(40),
    address: optional(160),
    notes: optional(300),
    is_active: z.boolean().default(true),
    group_id: z
      .string()
      .uuid()
      .or(z.literal(""))
      .nullable()
      .optional()
      .transform((v) => (v ? v : null)),
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
