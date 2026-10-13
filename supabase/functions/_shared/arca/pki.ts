// =============================================================================
// Certificados, claves y firma CMS para WSAA (ADR-072).
//
// node-forge por import "desnudo": en la Edge lo resuelve el deno.json de la
// función (npm:node-forge@1.3.1) y en los tests el node_modules. Sin efectos
// de red ni de base: todo es determinístico salvo la generación de claves.
//
//   · signCms: CMS PKCS#7 SignedData con el TRA ADENTRO (attached), SHA-256,
//     DER en base64 (lo que espera loginCms).
//   · parseCertificate: CUIT del sujeto (serialNumber "CUIT 20123456789"),
//     emisor, vigencia, serie y huella.
//   · keyMatchesCert: la clave privada corresponde al certificado.
//   · buildCsr: pedido de certificado con C=AR, O=razón social, CN=alias y
//     serialNumber=CUIT n (formato de ARCA).
// =============================================================================
import forge from "node-forge";

export interface CertInfo {
  cuit: string | null;
  subject: string;
  issuer: string;
  issuerCn: string | null;
  subjectCn: string | null;
  serial: string;
  notBefore: string;
  notAfter: string;
  fingerprintSha256: string;
}

function attrsToString(attrs: forge.pki.CertificateField[]): string {
  return attrs
    .map((a) => `${a.shortName ?? a.name ?? a.type}=${String(a.value)}`)
    .join(", ");
}

function attrValue(attrs: forge.pki.CertificateField[], ...names: string[]): string | null {
  const f = attrs.find((a) => names.includes(String(a.shortName ?? "")) || names.includes(String(a.name ?? "")));
  return f ? String(f.value) : null;
}

/** Normaliza un PEM pegado (espacios, \r, base64 sin encabezado). */
export function normalizePem(input: string, label: "CERTIFICATE" | "CERTIFICATE REQUEST" | "PRIVATE KEY" | "RSA PRIVATE KEY"): string {
  const t = String(input ?? "").replace(/\r/g, "").trim();
  if (t.includes("-----BEGIN")) return t + "\n";
  const b64 = t.replace(/\s+/g, "");
  const lines = b64.match(/.{1,64}/g) ?? [];
  return `-----BEGIN ${label}-----\n${lines.join("\n")}\n-----END ${label}-----\n`;
}

export function parseCertificate(pem: string): CertInfo {
  const cert = forge.pki.certificateFromPem(normalizePem(pem, "CERTIFICATE"));
  const serialNumber = attrValue(cert.subject.attributes, "serialNumber");
  const m = serialNumber ? /CUIT\s*(\d{11})/i.exec(serialNumber) : null;
  const der = forge.asn1.toDer(forge.pki.certificateToAsn1(cert)).getBytes();
  const md = forge.md.sha256.create();
  md.update(der);
  return {
    cuit: m ? (m[1] as string) : null,
    subject: attrsToString(cert.subject.attributes),
    issuer: attrsToString(cert.issuer.attributes),
    issuerCn: attrValue(cert.issuer.attributes, "CN", "commonName"),
    subjectCn: attrValue(cert.subject.attributes, "CN", "commonName"),
    serial: cert.serialNumber,
    notBefore: cert.validity.notBefore.toISOString(),
    notAfter: cert.validity.notAfter.toISOString(),
    fingerprintSha256: md.digest().toHex(),
  };
}

export function keyMatchesCert(certPem: string, keyPem: string): boolean {
  try {
    const cert = forge.pki.certificateFromPem(normalizePem(certPem, "CERTIFICATE"));
    const key = forge.pki.privateKeyFromPem(keyPem) as forge.pki.rsa.PrivateKey;
    const pub = cert.publicKey as forge.pki.rsa.PublicKey;
    return pub.n.equals(key.n) && pub.e.equals(key.e);
  } catch {
    return false;
  }
}

/** Firma el TRA: CMS SignedData con contenido, SHA-256, base64 del DER. */
export function signCms(content: string, certPem: string, keyPem: string): string {
  const p7 = forge.pkcs7.createSignedData();
  p7.content = forge.util.createBuffer(content, "utf8");
  const cert = forge.pki.certificateFromPem(normalizePem(certPem, "CERTIFICATE"));
  p7.addCertificate(cert);
  p7.addSigner({
    key: forge.pki.privateKeyFromPem(keyPem),
    certificate: cert,
    digestAlgorithm: forge.pki.oids.sha256 as string,
    authenticatedAttributes: [
      { type: forge.pki.oids.contentType as string, value: forge.pki.oids.data as string },
      { type: forge.pki.oids.messageDigest as string },
      { type: forge.pki.oids.signingTime as string, value: new Date() as unknown as string },
    ],
  });
  p7.sign();
  const der = forge.asn1.toDer(p7.toAsn1()).getBytes();
  return forge.util.encode64(der);
}

/** Lee un CMS firmado (para los tests): contenido y CUIT del firmante. */
export function readCms(b64: string): { content: string; signerCuit: string | null } {
  const der = forge.util.decode64(b64);
  const msg = forge.pkcs7.messageFromAsn1(forge.asn1.fromDer(der)) as forge.pkcs7.PkcsSignedData & {
    rawCapture?: { content?: forge.asn1.Asn1 };
  };
  const contentAsn1 = msg.rawCapture?.content;
  let content = "";
  if (contentAsn1 && Array.isArray(contentAsn1.value)) {
    for (const part of contentAsn1.value as forge.asn1.Asn1[]) content += String(part.value);
  } else if (contentAsn1) {
    content = String(contentAsn1.value);
  }
  const cert = msg.certificates[0];
  const sn = cert ? attrValue(cert.subject.attributes, "serialNumber") : null;
  const m = sn ? /CUIT\s*(\d{11})/i.exec(sn) : null;
  return { content: forge.util.decodeUtf8(content), signerCuit: m ? (m[1] as string) : null };
}

export interface CsrSubject {
  cuit: string;
  /** Razón social u organización. */
  organization: string;
  /** Alias del computador fiscal (CN). */
  alias: string;
}

/** Alias válido para WSASS y el administrador de certificados. */
export function sanitizeAlias(v: string): string {
  return String(v ?? "")
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/[^A-Za-z0-9]/g, "")
    .slice(0, 30)
    .toLowerCase();
}

export function buildCsr(keyPem: string, s: CsrSubject): string {
  const key = forge.pki.privateKeyFromPem(keyPem) as forge.pki.rsa.PrivateKey;
  const csr = forge.pki.createCertificationRequest();
  csr.publicKey = forge.pki.setRsaPublicKey(key.n, key.e);
  csr.setSubject([
    { shortName: "C", value: "AR" },
    { shortName: "O", value: s.organization.slice(0, 64) || s.alias },
    { shortName: "CN", value: sanitizeAlias(s.alias) || `ninjapos${s.cuit}` },
    { name: "serialNumber", value: `CUIT ${s.cuit}` },
  ]);
  csr.sign(key, forge.md.sha256.create());
  return forge.pki.certificationRequestToPem(csr);
}

export function csrInfo(csrPem: string): { subject: string; verified: boolean } {
  const csr = forge.pki.certificationRequestFromPem(csrPem);
  return { subject: attrsToString(csr.subject.attributes), verified: csr.verify() };
}

/**
 * Clave RSA 2048. Con WebCrypto (rápido en Deno) si está; si no, forge.
 * Devuelve el PEM PKCS#8 ("PRIVATE KEY").
 */
export async function generateKeyPem(): Promise<string> {
  const subtle = globalThis.crypto?.subtle;
  if (subtle) {
    const kp = (await subtle.generateKey(
      { name: "RSASSA-PKCS1-v1_5", modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: "SHA-256" },
      true,
      ["sign", "verify"],
    )) as CryptoKeyPair;
    const pkcs8 = new Uint8Array(await subtle.exportKey("pkcs8", kp.privateKey));
    let bin = "";
    for (const b of pkcs8) bin += String.fromCharCode(b);
    return normalizePem(btoa(bin), "PRIVATE KEY");
  }
  const kp = forge.pki.rsa.generateKeyPair({ bits: 2048, e: 0x10001 });
  return forge.pki.privateKeyToPem(kp.privateKey);
}

/** Validación del certificado que pega el usuario contra lo esperado. */
export interface CertCheck {
  ok: boolean;
  problems: string[];
  info: CertInfo | null;
}

export function checkCertificate(
  certPem: string,
  keyPem: string | null,
  expected: { cuit?: string | null; issuerCn?: string | null; now?: Date },
): CertCheck {
  let info: CertInfo;
  try {
    info = parseCertificate(certPem);
  } catch {
    return { ok: false, problems: ["cert_invalido"], info: null };
  }
  const problems: string[] = [];
  const now = expected.now ?? new Date();
  if (keyPem && !keyMatchesCert(certPem, keyPem)) problems.push("cert_no_corresponde");
  if (new Date(info.notAfter).getTime() <= now.getTime()) problems.push("cert_vencido");
  if (new Date(info.notBefore).getTime() > now.getTime() + 86_400_000) problems.push("cert_no_vigente");
  if (expected.issuerCn && info.issuerCn !== expected.issuerCn) problems.push("cert_emisor_incorrecto");
  if (!info.cuit) problems.push("cert_sin_cuit");
  else if (expected.cuit && info.cuit !== expected.cuit) problems.push("cert_cuit_distinto");
  return { ok: problems.length === 0, problems, info };
}
