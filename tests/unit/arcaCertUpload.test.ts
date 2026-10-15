// Carga del certificado de ARCA de la plataforma (ADR-133, rediseño 2026-10):
// validaciones del navegador antes de mandar el par a la Edge.
import { describe, expect, it } from "vitest";
import {
  certHolder,
  certIssuerLabel,
  certServiceState,
  checkCertificateFile,
  checkKeyFile,
  cuitFieldError,
  cuitReady,
  extractPem,
  formatCuit,
  pemKind,
  uploadProblem,
  uploadProblems,
} from "@/lib/arca/certUpload";

const B64 = "MIIBszCCAVmgAwIBAgIUQ2sZ" + "A".repeat(120);
const CERT = `-----BEGIN CERTIFICATE-----\n${B64}\n-----END CERTIFICATE-----\n`;
const KEY = `-----BEGIN PRIVATE KEY-----\n${B64}\n-----END PRIVATE KEY-----\n`;
const RSA_KEY = `-----BEGIN RSA PRIVATE KEY-----\n${B64}\n-----END RSA PRIVATE KEY-----\n`;
const ENC_KEY = `-----BEGIN ENCRYPTED PRIVATE KEY-----\n${B64}\n-----END ENCRYPTED PRIVATE KEY-----\n`;
const CSR = `-----BEGIN CERTIFICATE REQUEST-----\n${B64}\n-----END CERTIFICATE REQUEST-----\n`;
const PUB = `-----BEGIN PUBLIC KEY-----\n${B64}\n-----END PUBLIC KEY-----\n`;

describe("CUIT", () => {
  it("valida el dígito verificador sin marcar error mientras se escribe", () => {
    expect(cuitFieldError("")).toBeNull();
    expect(cuitFieldError("3071")).toBeNull();
    expect(cuitFieldError("20-12345678-6")).toBeNull();
    expect(cuitReady("20-12345678-6")).toBe(true);
    expect(cuitFieldError("20-12345678-5")).toMatch(/dígito verificador/);
    expect(cuitReady("20-12345678-5")).toBe(false);
    expect(cuitFieldError("201234567890")).toMatch(/11 números/);
  });
  it("formatea 11 números con guiones", () => {
    expect(formatCuit("20123456786")).toBe("20-12345678-6");
    expect(formatCuit("123")).toBe("123");
  });
});

describe("PEM", () => {
  it("reconoce cada tipo de archivo", () => {
    expect(pemKind("")).toBe("empty");
    expect(pemKind(CERT)).toBe("certificate");
    expect(pemKind(KEY)).toBe("private_key");
    expect(pemKind(RSA_KEY)).toBe("private_key");
    expect(pemKind(ENC_KEY)).toBe("encrypted_private_key");
    expect(pemKind(CSR)).toBe("csr");
    expect(pemKind(PUB)).toBe("public_key");
    expect(pemKind("hola")).toBe("unknown");
    expect(pemKind("0\u0082\u0001\u0003binario")).toBe("binary");
    expect(pemKind(String.fromCharCode(0xfffd, 0xfffd) + "PK")).toBe("binary");
  });

  it("saca el bloque PEM del texto alrededor (Bag Attributes de openssl)", () => {
    const withBag = `Bag Attributes\n    localKeyID: 01 02\n${KEY}`;
    expect(extractPem(withBag, "private_key")).toBe(KEY);
    expect(extractPem(CERT + KEY, "certificate")).toBe(CERT);
    expect(extractPem("nada", "certificate")).toBeNull();
  });

  it("acepta el certificado y rechaza lo que no es", () => {
    const ok = checkCertificateFile(`\r\n${CERT}`);
    expect(ok.ok).toBe(true);
    if (ok.ok) expect(ok.pem).toBe(CERT);
    const bad = (t: string) => {
      const r = checkCertificateFile(t);
      return r.ok ? "ok" : r.code;
    };
    expect(bad("")).toBe("vacio");
    expect(bad(KEY)).toBe("es_clave");
    expect(bad(CSR)).toBe("es_pedido");
    expect(bad("0\u0082binario")).toBe("binario");
    expect(bad("texto cualquiera")).toBe("no_pem");
    expect(bad(CERT + "x".repeat(25_000))).toBe("muy_grande");
  });

  it("acepta la clave sin contraseña y explica los errores", () => {
    expect(checkKeyFile(KEY).ok).toBe(true);
    expect(checkKeyFile(RSA_KEY).ok).toBe(true);
    const code = (t: string) => {
      const r = checkKeyFile(t);
      return r.ok ? "ok" : r.code;
    };
    expect(code(ENC_KEY)).toBe("con_contrasena");
    expect(code(CERT)).toBe("es_certificado");
    expect(code(CSR)).toBe("es_pedido");
    expect(code(PUB)).toBe("es_publica");
    expect(code("")).toBe("vacio");
  });
});

describe("datos del certificado", () => {
  it("lee titular, alias y CUIT del sujeto", () => {
    expect(certHolder("C=AR, O=NinjaSoft SAS, CN=ninjasoftpos, serialNumber=CUIT 30712345678")).toEqual({
      name: "NinjaSoft SAS",
      alias: "ninjasoftpos",
      cuit: "30712345678",
    });
    expect(certHolder("CN=solo")).toEqual({ name: "solo", alias: "solo", cuit: null });
    expect(certHolder(null)).toEqual({ name: null, alias: null, cuit: null });
  });
  it("nombra el emisor de ARCA", () => {
    expect(certIssuerLabel("C=AR, O=AFIP, CN=Computadores, serialNumber=CUIT 33693450239")).toMatch(/producción/);
    expect(certIssuerLabel("CN=Computadores Test")).toMatch(/homologación/);
    expect(certIssuerLabel(null)).toBeNull();
  });
});

describe("estado del servicio", () => {
  const now = new Date("2026-10-15T12:00:00Z");
  const days = (n: number) => new Date(now.getTime() + n * 86_400_000).toISOString();
  it("Falta certificado, Vencido, Vence pronto y Activo", () => {
    expect(certServiceState(undefined, now).state).toBe("missing");
    expect(certServiceState({ has_cert: true, has_key: false, not_after: days(200) }, now).state).toBe("missing");
    expect(certServiceState({ has_cert: true, has_key: true, not_after: days(-2) }, now).state).toBe("expired");
    expect(certServiceState({ has_cert: true, has_key: true, not_after: days(10) }, now).state).toBe("expiring");
    expect(certServiceState({ has_cert: true, has_key: true, not_after: days(200) }, now).state).toBe("active");
  });
});

describe("errores de la Edge", () => {
  it("explica la CUIT distinta con las dos CUITs", () => {
    const p = uploadProblem("cert_cuit_distinto", { typedCuit: "20123456786", certCuit: "30712345678" });
    expect(p.title).toMatch(/no coincide/);
    expect(p.action).toContain("30-71234567-8");
    expect(p.action).toContain("20-12345678-6");
  });
  it("par que no coincide y emisor de homologación", () => {
    expect(uploadProblem("cert_no_corresponde", { pair: true }).title).toMatch(/clave privada no corresponde/);
    expect(uploadProblem("cert_emisor_incorrecto").title).toMatch(/no es de producción/);
  });
  it("usa el texto de la Edge para códigos que no conoce", () => {
    const list = uploadProblems(
      { error: "cert_check_failed", problems: ["clave_con_contrasena"], messages: [{ code: "clave_con_contrasena", title: "Tiene contraseña", action: "Sacala" }] },
      { pair: true },
    );
    expect(list).toEqual([{ code: "clave_con_contrasena", title: "Tiene contraseña", action: "Sacala" }]);
    expect(uploadProblems({ error: "store_failed" })[0]?.title).toMatch(/No se pudo guardar/);
  });
});
