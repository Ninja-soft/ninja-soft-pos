import { describe, expect, it } from "vitest";
import { SignupAccountSchema, SignupBusinessSchema } from "@/modules/auth/signup-schemas";

describe("datos fiscales opcionales en el registro", () => {
  const base = { businessName: "Mi negocio", fullName: "Ana Pérez", email: "ana@ejemplo.com", password: "Segura12345" };
  it("deja avanzar sin datos fiscales (select en vacío)", () => {
    expect(SignupAccountSchema.safeParse({ ...base, cuit: "", legalName: "", ivaCondition: "", inviteCode: "" }).success).toBe(true);
    expect(SignupBusinessSchema.safeParse({ businessName: "Mi negocio", cuit: "", legalName: "", ivaCondition: "" }).success).toBe(true);
  });
  it("si se completa, valida", () => {
    expect(SignupAccountSchema.safeParse({ ...base, ivaCondition: "monotributo" }).success).toBe(true);
    expect(SignupAccountSchema.safeParse({ ...base, ivaCondition: "otra" }).success).toBe(false);
  });
});
