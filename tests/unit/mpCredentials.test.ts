import { describe, expect, it } from "vitest";
import {
  credentialEnvironment,
  secretHint,
  validateMpCredential,
} from "@/supabase/functions/_shared/mpCredentials";

describe("credenciales de Mercado Pago de la plataforma", () => {
  it("el Client ID es numérico: un email da un error claro", () => {
    expect(validateMpCredential("client_id", "971231514820445")).toBeNull();
    expect(validateMpCredential("client_id", "lucasponzoni@gmail.com")).toMatch(/email/);
    expect(validateMpCredential("client_id", "abc123")).toMatch(/números/);
  });

  it("Access Token y Public Key con prefijo de ambiente", () => {
    expect(validateMpCredential("access_token", "APP_USR-1234567890-abcdef")).toBeNull();
    expect(validateMpCredential("access_token", "TEST-1234567890-abcdef")).toBeNull();
    expect(validateMpCredential("access_token", "1234567890abcdef")).toMatch(/APP_USR-/);
    expect(validateMpCredential("public_key", "APP_USR-0f1e2d3c-aaaa")).toBeNull();
    expect(validateMpCredential("public_key", "pk_live_123")).toMatch(/APP_USR-/);
  });

  it("Redirect URI https, clave del webhook y ambiente", () => {
    expect(validateMpCredential("redirect_uri", "https://pos.soft.ninja/api/mp/oauth/callback")).toBeNull();
    expect(validateMpCredential("redirect_uri", "http://pos.soft.ninja/cb")).toMatch(/https/);
    expect(validateMpCredential("redirect_uri", "https://tu-dominio")).toBeNull();
    expect(validateMpCredential("redirect_uri", "no es url")).toMatch(/URL/);
    expect(validateMpCredential("webhook_secret", "corta")).toMatch(/16/);
    expect(validateMpCredential("webhook_secret", "a".repeat(64))).toBeNull();
    expect(validateMpCredential("environment", "production")).toBeNull();
    expect(validateMpCredential("environment", "staging")).toMatch(/inválido/);
  });

  it("vacío no es error (no se envía)", () => {
    expect(validateMpCredential("client_id", "  ")).toBeNull();
  });

  it("ambiente por prefijo y pista de 4 caracteres", () => {
    expect(credentialEnvironment("TEST-123")).toBe("test");
    expect(credentialEnvironment("APP_USR-123")).toBe("production");
    expect(credentialEnvironment("otro")).toBeNull();
    expect(secretHint("APP_USR-123456789a91f")).toBe("…a91f");
    expect(secretHint("corto")).toBeNull();
  });
});
