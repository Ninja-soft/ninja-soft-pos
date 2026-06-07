import { z } from "zod";
import { isValidCuit } from "@/modules/customers/schemas";

// Esquemas del wizard de registro (Fase A). El paso 1 ("Tu cuenta") valida
// credenciales + negocio + datos fiscales/código opcionales; el paso 2
// ("Tu negocio") aporta el rubro. Se validan por separado para poder avanzar
// de paso sin tener todo el formulario completo.

const passwordSchema = z
  .string()
  .min(10, "Mínimo 10 caracteres")
  .regex(/[A-Z]/, "Al menos una mayúscula")
  .regex(/[a-z]/, "Al menos una minúscula")
  .regex(/[0-9]/, "Al menos un número");

export const IVA_CONDITIONS = [
  "monotributo",
  "responsable_inscripto",
  "exento",
  "consumidor_final",
] as const;

export type IvaCondition = (typeof IVA_CONDITIONS)[number];

export const IVA_CONDITION_LABELS: Record<IvaCondition, string> = {
  monotributo: "Monotributo",
  responsable_inscripto: "Responsable Inscripto",
  exento: "Exento",
  consumidor_final: "Consumidor final",
};

// CUIT: 11 dígitos con dígito verificador. Reutilizamos el validador de
// clientes (modules/customers/schemas) para no duplicar la lógica.
const optionalCuit = z
  .string()
  .trim()
  .optional()
  .refine(
    (v) => !v || isValidCuit(v),
    "CUIT inválido (11 dígitos)",
  );

// Paso 1 — datos de la cuenta + negocio + fiscales/código opcionales.
export const SignupAccountSchema = z
  .object({
    businessName: z.string().min(2, "Requerido").max(120),
    fullName: z.string().min(2, "Requerido").max(120),
    email: z.string().email("Email inválido"),
    password: passwordSchema,
    // Datos fiscales (opcionales).
    cuit: optionalCuit,
    legalName: z.string().trim().max(200).optional(),
    ivaCondition: z.enum(IVA_CONDITIONS).optional(),
    // Código de invitación (opcional).
    inviteCode: z.string().trim().max(40).optional(),
  })
  .refine(
    (d) =>
      !d.password
        .toLowerCase()
        .includes(d.email.toLowerCase().split("@")[0] ?? " "),
    { message: "La contraseña no debe contener tu email", path: ["password"] },
  );

export type SignupAccountInput = z.infer<typeof SignupAccountSchema>;

// Paso "Tu negocio" en el flujo SSO (sin cuenta de email): solo negocio +
// fiscales/código, porque las credenciales ya vienen de Google.
export const SignupBusinessSchema = z.object({
  businessName: z.string().min(2, "Requerido").max(120),
  cuit: optionalCuit,
  legalName: z.string().trim().max(200).optional(),
  ivaCondition: z.enum(IVA_CONDITIONS).optional(),
  inviteCode: z.string().trim().max(40).optional(),
});

export type SignupBusinessInput = z.infer<typeof SignupBusinessSchema>;
