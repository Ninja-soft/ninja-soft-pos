// =============================================================================
// Carga del certificado de ARCA de la plataforma (ADR-133, rediseño 2026-10).
// PURO: validaciones que hace el navegador ANTES de mandar los archivos a la
// Edge `arca_wsfe` (`platform_subir_par`). La Edge vuelve a validar todo
// (par clave/certificado, CUIT, emisor de ARCA, vigencia): esto sólo evita
// viajes inútiles y da errores claros. Nunca se loguea el contenido.
// =============================================================================
import { isValidCuit } from "@/lib/tax/catalog";
import { certExpiry, type CertExpiry } from "@/lib/arca/labels";

/** Tope de tamaño de un PEM (la Edge corta la clave en 20.000 caracteres). */
export const MAX_PEM_CHARS = 20_000;

export type PemKind =
  | "empty"
  | "binary"
  | "certificate"
  | "private_key"
  | "encrypted_private_key"
  | "csr"
  | "public_key"
  | "unknown";

const BLOCK = /-----BEGIN ([A-Z0-9 ]+)-----[\s\S]*?-----END \1-----/;

/** ¿Tiene bytes que no son texto? (un .crt en DER, un .pfx, un .zip). */
function looksBinary(text: string): boolean {
  // eslint-disable-next-line no-control-regex
  // U+FFFD: lo que deja el navegador al leer como texto bytes que no son UTF-8.
  return /[\u0000-\u0008\u000E-\u001F\u007F-\u009F]/.test(text) || text.includes(String.fromCharCode(0xfffd));
}

/** Qué contiene el texto leído de un archivo. Mira el primer bloque PEM. */
export function pemKind(text: string | null | undefined): PemKind {
  const t = String(text ?? "").trim();
  if (!t) return "empty";
  if (looksBinary(t)) return "binary";
  const m = BLOCK.exec(t);
  const label = m?.[1] ?? /-----BEGIN ([A-Z0-9 ]+)-----/.exec(t)?.[1];
  if (!label) return "unknown";
  if (label === "CERTIFICATE" || label === "X509 CERTIFICATE" || label === "TRUSTED CERTIFICATE") return "certificate";
  if (label === "ENCRYPTED PRIVATE KEY") return "encrypted_private_key";
  if (label === "PRIVATE KEY" || label === "RSA PRIVATE KEY" || label === "EC PRIVATE KEY") return "private_key";
  if (label === "CERTIFICATE REQUEST" || label === "NEW CERTIFICATE REQUEST") return "csr";
  if (label === "PUBLIC KEY" || label === "RSA PUBLIC KEY") return "public_key";
  return "unknown";
}

/** El bloque PEM de esa clase, sin texto alrededor (p. ej. "Bag Attributes" de openssl). */
export function extractPem(text: string, kind: "certificate" | "private_key"): string | null {
  const labels =
    kind === "certificate" ? ["CERTIFICATE", "X509 CERTIFICATE", "TRUSTED CERTIFICATE"] : ["PRIVATE KEY", "RSA PRIVATE KEY", "EC PRIVATE KEY"];
  const t = String(text ?? "").replace(/\r/g, "");
  for (const label of labels) {
    const re = new RegExp(`-----BEGIN ${label}-----[\\s\\S]*?-----END ${label}-----`);
    const m = re.exec(t);
    if (m) return m[0].trim() + "\n";
  }
  return null;
}

export type PemCheck = { ok: true; pem: string } | { ok: false; code: string; title: string; action: string };

const fail = (code: string, title: string, action: string): PemCheck => ({ ok: false, code, title, action });

/** Valida el archivo del certificado (.crt / .pem). */
export function checkCertificateFile(text: string | null | undefined): PemCheck {
  const t = String(text ?? "");
  const kind = pemKind(t);
  if (kind === "empty") return fail("vacio", "El archivo está vacío", "Elegí el certificado que descargaste de ARCA.");
  if (t.length > MAX_PEM_CHARS) return fail("muy_grande", "El archivo es demasiado grande para ser un certificado", "Elegí el .crt que descargaste de ARCA.");
  if (kind === "binary")
    return fail(
      "binario",
      "El certificado está en formato binario (DER o PFX)",
      "Convertilo a texto PEM, por ejemplo: openssl x509 -inform der -in cert.crt -out cert.pem.",
    );
  if (kind === "private_key" || kind === "encrypted_private_key")
    return fail("es_clave", "Ese archivo es una clave privada, no el certificado", "Cargalo en la zona de la clave privada.");
  if (kind === "csr")
    return fail("es_pedido", "Ese archivo es el pedido (CSR), no el certificado", "Subí el pedido a ARCA y cargá acá el certificado que te devuelve.");
  const pem = kind === "certificate" ? extractPem(t, "certificate") : null;
  if (!pem) return fail("no_pem", "Eso no parece un certificado", "Tiene que ser un archivo de texto que empiece con -----BEGIN CERTIFICATE-----.");
  return { ok: true, pem };
}

/** Valida el archivo de la clave privada (.key). */
export function checkKeyFile(text: string | null | undefined): PemCheck {
  const t = String(text ?? "");
  const kind = pemKind(t);
  if (kind === "empty") return fail("vacio", "El archivo está vacío", "Elegí la clave privada con la que generaste el pedido del certificado.");
  if (t.length > MAX_PEM_CHARS) return fail("muy_grande", "El archivo es demasiado grande para ser una clave", "Elegí el .key del certificado.");
  if (kind === "binary") return fail("binario", "La clave está en formato binario", "Exportala en texto PEM (openssl rsa -in clave.der -inform der -out clave.key).");
  if (kind === "encrypted_private_key")
    return fail(
      "con_contrasena",
      "La clave privada tiene contraseña",
      "Exportala sin contraseña (openssl rsa -in clave.key -out clave-sin-pass.key) y volvé a cargarla.",
    );
  if (kind === "certificate") return fail("es_certificado", "Ese archivo es el certificado, no la clave", "Cargalo en la zona del certificado.");
  if (kind === "csr") return fail("es_pedido", "Ese archivo es el pedido (CSR), no la clave", "La clave es el .key que se generó junto con el pedido.");
  if (kind === "public_key") return fail("es_publica", "Esa es la clave pública", "Hace falta la clave privada (empieza con -----BEGIN PRIVATE KEY-----).");
  const pem = kind === "private_key" ? extractPem(t, "private_key") : null;
  if (!pem) return fail("no_pem", "Eso no parece una clave privada", "Tiene que empezar con -----BEGIN PRIVATE KEY----- o -----BEGIN RSA PRIVATE KEY-----.");
  return { ok: true, pem };
}

/** Error del campo CUIT, o null si está bien o todavía incompleto. */
export function cuitFieldError(value: string | null | undefined): string | null {
  const d = String(value ?? "").replace(/\D/g, "");
  if (d.length === 0) return null;
  if (d.length > 11) return "La CUIT tiene 11 números.";
  if (d.length < 11) return null;
  return isValidCuit(d) ? null : "El dígito verificador no coincide. Revisá el número.";
}

export function cuitReady(value: string | null | undefined): boolean {
  return isValidCuit(String(value ?? "").replace(/\D/g, ""));
}

/** 30712345678 → 30-71234567-8 (deja tal cual lo que no tiene 11 números). */
export function formatCuit(value: string | null | undefined): string {
  const d = String(value ?? "").replace(/\D/g, "");
  return d.length === 11 ? `${d.slice(0, 2)}-${d.slice(2, 10)}-${d.slice(10)}` : String(value ?? "");
}

/** Atributos de un DN "C=AR, O=NinjaSoft, CN=ninjasoftpos, serialNumber=CUIT 30...". */
export function parseDn(dn: string | null | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  for (const part of String(dn ?? "").split(/,\s*(?=[A-Za-z][A-Za-z0-9.]*=)/)) {
    const i = part.indexOf("=");
    if (i <= 0) continue;
    out[part.slice(0, i).trim().toLowerCase()] = part.slice(i + 1).trim();
  }
  return out;
}

/** Titular legible del certificado: organización o, si no hay, el nombre (CN). */
export function certHolder(subject: string | null | undefined): { name: string | null; alias: string | null; cuit: string | null } {
  const a = parseDn(subject);
  const cuit = /CUIT\s*(\d{11})/i.exec(a.serialnumber ?? "")?.[1] ?? null;
  return { name: a.o ?? a.cn ?? null, alias: a.cn ?? null, cuit };
}

/** Emisor legible ("Computadores" = ARCA producción). */
export function certIssuerLabel(issuer: string | null | undefined): string | null {
  const a = parseDn(issuer);
  const cn = a.cn ?? null;
  if (!cn) return issuer ? String(issuer) : null;
  if (cn === "Computadores") return "ARCA (Computadores, producción)";
  if (cn === "Computadores Test") return "ARCA (Computadores Test, homologación)";
  return cn;
}

// ---------------------------------------------------------------------------
// Estado del servicio (tarjeta de Complementos)
// ---------------------------------------------------------------------------
export type CertServiceState = "missing" | "expired" | "expiring" | "active";

export const CERT_SERVICE_LABEL: Record<CertServiceState, { label: string; tone: "success" | "warning" | "danger" }> = {
  active: { label: "Activo", tone: "success" },
  missing: { label: "Falta certificado", tone: "warning" },
  expiring: { label: "Vence pronto", tone: "warning" },
  expired: { label: "Vencido", tone: "danger" },
};

export function certServiceState(
  info: { has_cert?: boolean; has_key?: boolean; not_after?: string | null } | null | undefined,
  now: Date = new Date(),
): { state: CertServiceState; expiry: CertExpiry } {
  const expiry = certExpiry(info?.not_after, now);
  if (!info?.has_cert || !info.has_key) return { state: "missing", expiry };
  if (expiry.level === "expired") return { state: "expired", expiry };
  if (expiry.level === "warn") return { state: "expiring", expiry };
  return { state: "active", expiry };
}

// ---------------------------------------------------------------------------
// Errores de la Edge al cargar el certificado, en el contexto de esta pantalla
// ---------------------------------------------------------------------------
export interface UploadProblem {
  code: string;
  title: string;
  action: string;
}

/**
 * Mensaje de cada problema que devuelve `platform_subir_par` /
 * `platform_subir_certificado`. Para los códigos genéricos usa el texto que
 * manda la Edge (`fallback`); algunos se reescriben porque acá no hay
 * "negocio" ni el pedido del asistente del dueño.
 */
export function uploadProblem(
  code: string,
  ctx: { typedCuit?: string | null; certCuit?: string | null; pair?: boolean; fallback?: { title: string; action: string } } = {},
): UploadProblem {
  switch (code) {
    case "cert_no_corresponde":
      return ctx.pair
        ? { code, title: "La clave privada no corresponde a este certificado", action: "Elegí la clave con la que se generó el pedido de este certificado." }
        : {
            code,
            title: "El certificado no corresponde al último pedido generado",
            action: "Subí a ARCA el pedido de esta pestaña y cargá el certificado que te devuelve.",
          };
    case "cert_cuit_distinto": {
      const detail =
        ctx.certCuit && ctx.typedCuit
          ? `El certificado es de la CUIT ${formatCuit(ctx.certCuit)} y cargaste ${formatCuit(ctx.typedCuit)}.`
          : "La CUIT que cargaste no es la del certificado.";
      return { code, title: "La CUIT no coincide con la del certificado", action: `${detail} Corregí la CUIT o elegí el certificado de esa empresa.` };
    }
    case "cert_vencido":
      return { code, title: "El certificado está vencido", action: "Generá uno nuevo en ARCA (pestaña Generar certificado) y cargalo." };
    case "cert_emisor_incorrecto":
      return {
        code,
        title: "El certificado no es de producción",
        action: "Tiene que emitirlo ARCA en Administración de Certificados Digitales (Computadores). Los de WSASS (Computadores Test) son de homologación.",
      };
    case "cert_invalido":
      return { code, title: "Eso no parece un certificado", action: "Elegí el .crt que descargaste de ARCA, en texto PEM." };
    case "platform_cuit_missing":
      return { code, title: "Falta la CUIT de la empresa", action: "Cargá la CUIT de la empresa titular del certificado." };
    case "csr_faltante":
      return {
        code,
        title: "No hay un pedido generado",
        action: "Primero generá el pedido en esta pestaña, o cargá el certificado con su clave en Cargar certificado.",
      };
    case "store_failed":
      return { code, title: "No se pudo guardar", action: "Probá de nuevo en un rato." };
    default:
      return {
        code,
        title: ctx.fallback?.title ?? "No se pudo validar el certificado",
        action: ctx.fallback?.action ?? "Revisá los archivos y probá de nuevo.",
      };
  }
}

/** Lista de problemas a partir de la respuesta de la Edge. */
export function uploadProblems(
  r: {
    error?: string;
    problems?: string[];
    messages?: { code: string; title: string; action: string }[];
    certificate?: { cuit?: string | null } | null;
  },
  ctx: { typedCuit?: string | null; pair?: boolean } = {},
): UploadProblem[] {
  const codes = r.problems?.length ? r.problems : [r.error ?? "cert_invalido"];
  return codes.map((code) =>
    uploadProblem(code, {
      ...ctx,
      certCuit: r.certificate?.cuit ?? null,
      fallback: r.messages?.find((m) => m.code === code),
    }),
  );
}
