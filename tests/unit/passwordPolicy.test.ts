import { describe, expect, it } from "vitest";
import { AuthApiError, AuthWeakPasswordError } from "@supabase/supabase-js";
import {
  PASSWORD_HINT,
  PASSWORD_MESSAGES,
  PASSWORD_MIN_LENGTH,
  passwordSchema,
  validatePassword,
} from "@/modules/auth/password";
import {
  PASSWORD_ERROR_MESSAGES,
  authPasswordErrorMessage,
  passwordErrorMessage,
} from "@/lib/auth/passwordErrors";
import { SignupSchema } from "@/modules/auth/schemas";
import { SignupAccountSchema } from "@/modules/auth/signup-schemas";

describe("passwordSchema (SEC-22)", () => {
  it("acepta una contraseña que cumple la política", () => {
    expect(passwordSchema.safeParse("Segura12345").success).toBe(true);
    expect(validatePassword("Segura12345")).toBeNull();
  });

  it("exige el mínimo de caracteres", () => {
    const corta = "Ab1".padEnd(PASSWORD_MIN_LENGTH - 1, "x");
    expect(validatePassword(corta)).toBe(PASSWORD_MESSAGES.length);
    expect(validatePassword("Ab1".padEnd(PASSWORD_MIN_LENGTH, "x"))).toBeNull();
  });

  it("exige mayúscula, minúscula y número, en ese orden de aviso", () => {
    expect(validatePassword("segura12345")).toBe(PASSWORD_MESSAGES.upper);
    expect(validatePassword("SEGURA12345")).toBe(PASSWORD_MESSAGES.lower);
    expect(validatePassword("SeguraSegura")).toBe(PASSWORD_MESSAGES.digit);
  });

  it("el hint menciona el mínimo vigente", () => {
    expect(PASSWORD_HINT).toContain(String(PASSWORD_MIN_LENGTH));
  });

  it("los schemas de registro usan la misma política", () => {
    const base = { fullName: "Ana Pérez", email: "ana@example.com" };
    expect(
      SignupSchema.safeParse({ ...base, password: "segura12345", confirmPassword: "segura12345" }).success,
    ).toBe(false);
    expect(
      SignupSchema.safeParse({ ...base, password: "Segura12345", confirmPassword: "Segura12345" }).success,
    ).toBe(true);

    const account = { businessName: "Kiosco", ...base };
    const weak = SignupAccountSchema.safeParse({ ...account, password: "Corta1" });
    expect(weak.success).toBe(false);
    if (!weak.success) {
      expect(weak.error.issues.map((i) => i.message)).toContain(PASSWORD_MESSAGES.length);
    }
    expect(SignupAccountSchema.safeParse({ ...account, password: "Segura12345" }).success).toBe(true);
  });
});

describe("passwordErrorMessage (weak_password de Supabase)", () => {
  it("filtrada (pwned) tiene prioridad", () => {
    const err = new AuthWeakPasswordError("Password is known to be weak", 422, ["characters", "pwned"]);
    expect(passwordErrorMessage(err)).toBe(PASSWORD_ERROR_MESSAGES.pwned);
    expect(passwordErrorMessage(err)).toBe("Esta contraseña apareció en filtraciones de datos; elegí otra.");
  });

  it("longitud y caracteres", () => {
    expect(passwordErrorMessage(new AuthWeakPasswordError("short", 422, ["length"]))).toBe(
      PASSWORD_ERROR_MESSAGES.length,
    );
    expect(passwordErrorMessage(new AuthWeakPasswordError("chars", 422, ["characters"]))).toBe(
      PASSWORD_ERROR_MESSAGES.characters,
    );
    expect(PASSWORD_ERROR_MESSAGES.length).toContain(String(PASSWORD_MIN_LENGTH));
  });

  it("reconoce el error por code aunque no sea la clase de auth-js", () => {
    expect(passwordErrorMessage({ code: "weak_password", message: "x", reasons: ["pwned"] })).toBe(
      PASSWORD_ERROR_MESSAGES.pwned,
    );
    expect(passwordErrorMessage({ code: "weak_password", message: "x" })).toBe(PASSWORD_ERROR_MESSAGES.weak);
  });

  it("same_password", () => {
    const err = new AuthApiError("New password should be different", 422, "same_password");
    expect(passwordErrorMessage(err)).toBe(PASSWORD_ERROR_MESSAGES.same);
  });

  it("otros errores no se mapean y caen al mensaje original", () => {
    const err = new AuthApiError("User already registered", 422, "user_already_exists");
    expect(passwordErrorMessage(err)).toBeNull();
    expect(authPasswordErrorMessage(err)).toBe("User already registered");
    expect(passwordErrorMessage(null)).toBeNull();
    expect(authPasswordErrorMessage(undefined, "fallback")).toBe("fallback");
  });
});
