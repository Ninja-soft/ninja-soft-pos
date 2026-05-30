import { z } from "zod";

export const INDUSTRIES = [
  "kiosco",
  "textil",
  "retail",
  "restaurante",
  "pyme",
  "otro",
] as const;

export const INDUSTRY_LABELS: Record<(typeof INDUSTRIES)[number], string> = {
  kiosco: "Kiosco",
  textil: "Textil / Indumentaria",
  retail: "Retail",
  restaurante: "Restaurante",
  pyme: "Pyme",
  otro: "Otro",
};

export const CreateTenantSchema = z.object({
  name: z.string().min(2, "Mínimo 2 caracteres").max(120, "Máximo 120"),
  industry: z.enum(INDUSTRIES),
});
export type CreateTenantInput = z.infer<typeof CreateTenantSchema>;
