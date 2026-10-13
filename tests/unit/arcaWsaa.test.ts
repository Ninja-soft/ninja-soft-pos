// @vitest-environment node
// WSAA, firma CMS, certificados, cifrado de la clave y QR fiscal (ADR-072).
// El certificado y la clave se generan acá (autofirmados con node-forge):
// nunca se usan certificados reales en los tests.
import { describe, expect, it, beforeAll } from "vitest";
import forge from "node-forge";
import {
  buildLoginCms,
  buildTra,
  classifyWsaaFault,
  isoAr,
  parseLoginCmsResponse,
  ticketUsable,
} from "@/supabase/functions/_shared/arca/wsaa";
import {
  buildCsr,
  checkCertificate,
  csrInfo,
  keyMatchesCert,
  normalizePem,
  parseCertificate,
  readCms,
  sanitizeAlias,
  signCms,
} from "@/supabase/functions/_shared/arca/pki";
import { decryptSecret, encryptSecret, keyAad } from "@/supabase/functions/_shared/arca/crypto";
import { decodeQrUrl, qrPayload, qrUrl } from "@/supabase/functions/_shared/arca/qr";
import * as F from "../fixtures/arcaSoap";

function selfSigned(cuit: string, issuerCn: string, opts: { daysValid?: number } = {}) {
  const keys = forge.pki.rsa.generateKeyPair({ bits: 1024, e: 0x10001 });
  const cert = forge.pki.createCertificate();
  cert.publicKey = keys.publicKey;
  cert.serialNumber = "0a1b2c3d4e5f";
  const now = new Date();
  cert.validity.notBefore = new Date(now.getTime() - 86_400_000);
  cert.validity.notAfter = new Date(now.getTime() + (opts.daysValid ?? 365) * 86_400_000);
  cert.setSubject([
    { shortName: "CN", value: "ninjaposhomo" },
    { name: "serialNumber", value: `CUIT ${cuit}` },
  ]);
  cert.setIssuer([
    { shortName: "CN", value: issuerCn },
    { shortName: "O", value: "AFIP" },
    { shortName: "C", value: "AR" },
    { name: "serialNumber", value: "CUIT 33693450239" },
  ]);
  cert.sign(keys.privateKey, forge.md.sha256.create());
  return { certPem: forge.pki.certificateToPem(cert), keyPem: forge.pki.privateKeyToPem(keys.privateKey) };
}

let homo: { certPem: string; keyPem: string };
let other: { certPem: string; keyPem: string };

beforeAll(() => {
  homo = selfSigned("20378923450", "Computadores Test");
  other = selfSigned("20378923450", "Computadores", { daysValid: -1 });
}, 60_000);

describe("WSAA", () => {
  it("TRA con ventana de 10 minutos y hora de Argentina", () => {
    const now = new Date("2026-10-13T15:00:00Z");
    const tra = buildTra("wsfe", now);
    expect(tra).toContain("<service>wsfe</service>");
    expect(tra).toContain("<generationTime>2026-10-13T11:50:00-03:00</generationTime>");
    expect(tra).toContain("<expirationTime>2026-10-13T12:10:00-03:00</expirationTime>");
    expect(tra).toContain(`<uniqueId>${Math.floor(now.getTime() / 1000)}</uniqueId>`);
    expect(isoAr(new Date("2026-01-01T02:00:00Z"))).toBe("2025-12-31T23:00:00-03:00");
  });

  it("firma CMS con contenido adentro, verificable con el certificado", () => {
    const tra = buildTra("wsfe");
    const cms = signCms(tra, homo.certPem, homo.keyPem);
    expect(cms).toMatch(/^[A-Za-z0-9+/]+=*$/);
    const read = readCms(cms);
    expect(read.content).toBe(tra);
    expect(read.signerCuit).toBe("20378923450");
    // Verificación criptográfica de la firma: digest de los atributos firmados.
    const msg = forge.pkcs7.messageFromAsn1(forge.asn1.fromDer(forge.util.decode64(cms))) as unknown as {
      rawCapture: { authenticatedAttributes: forge.asn1.Asn1[]; signature: string; digestAlgorithm: string };
    };
    const attrs = forge.asn1.create(forge.asn1.Class.UNIVERSAL, forge.asn1.Type.SET, true, msg.rawCapture.authenticatedAttributes);
    const md = forge.md.sha256.create();
    md.update(forge.asn1.toDer(attrs).getBytes());
    const pub = forge.pki.certificateFromPem(homo.certPem).publicKey as forge.pki.rsa.PublicKey;
    expect(pub.verify(md.digest().getBytes(), msg.rawCapture.signature)).toBe(true);
    expect(buildLoginCms(cms)).toContain(`<wsaa:in0>${cms}</wsaa:in0>`);
  });

  it("loginCmsReturn: token, sign y vencimiento", () => {
    const r = parseLoginCmsResponse(F.WSAA_LOGIN_OK());
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.ticket.token.startsWith("PD94")).toBe(true);
      expect(r.ticket.sign).toBe("bWkgZmlybWEgZGUgcHJ1ZWJh+/=");
      expect(r.ticket.expirationTime).toBe("2026-10-14T00:05:12.345-03:00");
      expect(r.ticket.destination).toContain("20378923450");
    }
  });

  it("faults: TA vigente, certificado vencido, no autorizado", () => {
    const a = parseLoginCmsResponse(F.WSAA_FAULT_ALREADY);
    expect(a).toEqual({ ok: false, code: "coe.alreadyAuthenticated", message: "El CEE ya posee un TA valido para el acceso al WSN solicitado" });
    expect(classifyWsaaFault("coe.alreadyAuthenticated")).toBe("already");
    const e = parseLoginCmsResponse(F.WSAA_FAULT_EXPIRED);
    expect(!e.ok && e.code).toBe("cms.cert.expired");
    expect(classifyWsaaFault("cms.cert.expired")).toBe("action");
    expect(classifyWsaaFault("coe.notAuthorized")).toBe("action");
    expect(classifyWsaaFault("xml.generationTime.invalid")).toBe("transient");
  });

  it("ticket cacheado: sirve hasta 10 minutos antes de vencer", () => {
    const now = new Date("2026-10-13T12:00:00-03:00");
    expect(ticketUsable("2026-10-13T23:59:00-03:00", now)).toBe(true);
    expect(ticketUsable("2026-10-13T12:05:00-03:00", now)).toBe(false);
    expect(ticketUsable(null, now)).toBe(false);
  });
});

describe("certificados", () => {
  it("lee CUIT, emisor, vigencia y huella", () => {
    const i = parseCertificate(homo.certPem);
    expect(i.cuit).toBe("20378923450");
    expect(i.issuerCn).toBe("Computadores Test");
    expect(i.fingerprintSha256).toMatch(/^[0-9a-f]{64}$/);
    expect(new Date(i.notAfter).getTime()).toBeGreaterThan(Date.now());
  });

  it("clave y certificado: corresponden o no", () => {
    expect(keyMatchesCert(homo.certPem, homo.keyPem)).toBe(true);
    expect(keyMatchesCert(homo.certPem, other.keyPem)).toBe(false);
  });

  it("validación al pegar: emisor por ambiente, vencido, CUIT", () => {
    expect(checkCertificate(homo.certPem, homo.keyPem, { cuit: "20378923450", issuerCn: "Computadores Test" })).toMatchObject({ ok: true, problems: [] });
    expect(checkCertificate(homo.certPem, homo.keyPem, { cuit: "20378923450", issuerCn: "Computadores" }).problems).toEqual(["cert_emisor_incorrecto"]);
    expect(checkCertificate(homo.certPem, other.keyPem, { cuit: "30500000003" }).problems).toEqual(["cert_no_corresponde", "cert_cuit_distinto"]);
    expect(checkCertificate(other.certPem, other.keyPem, {}).problems).toContain("cert_vencido");
    expect(checkCertificate("basura", null, {}).problems).toEqual(["cert_invalido"]);
  });

  it("PEM pegado sin encabezado se normaliza", () => {
    const body = homo.certPem.replace(/-----[A-Z ]+-----/g, "").replace(/\n/g, " ");
    expect(parseCertificate(normalizePem(body, "CERTIFICATE")).cuit).toBe("20378923450");
  });

  it("CSR con el formato de ARCA", () => {
    const csr = buildCsr(homo.keyPem, { cuit: "20378923450", organization: "Kiosco Ñandú S.A.", alias: "Ninja POS homo!" });
    const info = csrInfo(csr);
    expect(info.verified).toBe(true);
    expect(info.subject).toContain("C=AR");
    expect(info.subject).toContain("CN=ninjaposhomo");
    expect(info.subject).toContain("serialNumber=CUIT 20378923450");
    expect(sanitizeAlias("Café Ñoño 2")).toBe("cafenono2");
  });
});

describe("cifrado de la clave (AES-GCM)", () => {
  const master = Buffer.alloc(32, 7).toString("base64");

  it("ida y vuelta, IV distinto cada vez", async () => {
    const a = await encryptSecret(homo.keyPem, master, keyAad("t1", "homologacion"));
    const b = await encryptSecret(homo.keyPem, master, keyAad("t1", "homologacion"));
    expect(a.startsWith("v1:")).toBe(true);
    expect(a).not.toBe(b);
    expect(a).not.toContain("PRIVATE");
    expect(await decryptSecret(a, master, keyAad("t1", "homologacion"))).toBe(homo.keyPem);
  });

  it("otro negocio, otro ambiente u otra clave maestra no descifran", async () => {
    const a = await encryptSecret("secreto", master, keyAad("t1", "homologacion"));
    await expect(decryptSecret(a, master, keyAad("t2", "homologacion"))).rejects.toThrow("arca_decrypt_failed");
    await expect(decryptSecret(a, master, keyAad("t1", "produccion"))).rejects.toThrow("arca_decrypt_failed");
    await expect(decryptSecret(a, Buffer.alloc(32, 8).toString("base64"), keyAad("t1", "homologacion"))).rejects.toThrow();
    await expect(encryptSecret("x", "corta", "a")).rejects.toThrow("arca_key_enc_invalid");
  });
});

describe("QR fiscal (RG 4892)", () => {
  it("JSON en el orden de la RG y URL con base64", () => {
    const input = {
      fecha: "20261013",
      cuit: "30-50000000-3",
      ptoVta: 3,
      tipoCmp: 6,
      nroCmp: 12,
      importe: 121,
      tipoDocRec: 96,
      nroDocRec: "30.123.456",
      tipoCodAut: "E" as const,
      codAut: "76412345678901",
    };
    expect(JSON.stringify(qrPayload(input))).toBe(
      '{"ver":1,"fecha":"2026-10-13","cuit":30500000003,"ptoVta":3,"tipoCmp":6,"nroCmp":12,"importe":121,"moneda":"PES","ctz":1,"tipoDocRec":96,"nroDocRec":30123456,"tipoCodAut":"E","codAut":76412345678901}',
    );
    const url = qrUrl(input);
    expect(url.startsWith("https://www.afip.gob.ar/fe/qr/?p=")).toBe(true);
    expect(decodeQrUrl(url)).toEqual(qrPayload(input));
  });

  it("consumidor final sin documento: sin receptor; CAEA con tipoCodAut A", () => {
    const p = qrPayload({ fecha: "2026-10-13", cuit: 30500000003, ptoVta: 90, tipoCmp: 6, nroCmp: 1, importe: 50.5, tipoDocRec: 99, nroDocRec: "0", tipoCodAut: "A", codAut: "31423456789012" });
    expect(p).not.toHaveProperty("tipoDocRec");
    expect(p.tipoCodAut).toBe("A");
    expect(p.importe).toBe(50.5);
  });
});
