// =============================================================================
// Complemento "Email con dominio NinjaSoft" (ADR-156): lógica pura, sin red ni
// base. La usan la Edge email_addon_admin, _shared/ninjaEmail.ts y, por
// lib/billing/emailAddon.ts, las pantallas y los tests. Corre igual en Deno y
// en Node.
//
// Espejos en SQL (migración 20261224100000_addon_email_cobro):
//   · emailLocalPart  ↔ email_addon_local_part
//   · quotaCheck      ↔ email_addon_consume (decisión de bloquear o contar)
//   · overageBlocks   ↔ email_addon_bill_overage
// =============================================================================

export type SenderMode = "business" | "fixed";
export type OveragePolicy = "block" | "warn" | "charge";

const ACCENTS_FROM = "áàäâãéèëêíìïîóòöôõúùüûñç";
const ACCENTS_TO = "aaaaaeeeeiiiiooooouuuunc";

/** Parte local del remitente a partir del slug del negocio. */
export function emailLocalPart(slug: string | null | undefined): string {
  let s = String(slug ?? "").toLowerCase();
  s = s
    .split("")
    .map((c) => {
      const i = ACCENTS_FROM.indexOf(c);
      return i >= 0 ? ACCENTS_TO[i] : c;
    })
    .join("");
  s = s.replace(/[^a-z0-9.-]+/g, "-").replace(/[-.]{2,}/g, "-");
  s = s.replace(/^[-.]+|[-.]+$/g, "").slice(0, 40);
  return s || "negocio";
}

/** Parte local fija válida (p. ej. "notificaciones"). */
export function isValidFixedLocal(local: string): boolean {
  return /^[a-z0-9]([a-z0-9._-]{0,38}[a-z0-9])?$/.test(local);
}

/** Dominio válido (minúsculas, al menos un punto). */
export function isValidDomain(domain: string): boolean {
  return /^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$/.test(domain);
}

export function senderAddress(input: {
  mode: SenderMode | string | null | undefined;
  fixedLocal?: string | null;
  domain?: string | null;
  slug?: string | null;
}): string {
  const domain = (input.domain || "soft.ninja").toLowerCase();
  const local = input.mode === "fixed" && input.fixedLocal ? input.fixedLocal : emailLocalPart(input.slug);
  return `${local}@${domain}`;
}

export interface QuotaCheck {
  allowed: boolean;
  /** Emails que pasan el cupo con este envío (0 si entra). */
  over: number;
  /** Nivel de aviso que se alcanza con este envío (null si ninguno nuevo). */
  warn: 80 | 100 | null;
}

/**
 * Qué pasa al enviar `count` emails con `sent` ya enviados en el mes. Mismo
 * criterio que email_addon_consume: con 'block' no sale nada que pase el cupo;
 * con 'warn' o 'charge' sale y se cuenta como excedente. Los avisos se dan una
 * sola vez por mes (warned80 / warned100).
 */
export function quotaCheck(input: {
  sent: number;
  quota: number;
  count?: number;
  policy: OveragePolicy | string;
  warned80?: boolean;
  warned100?: boolean;
}): QuotaCheck {
  const n = Math.max(1, Math.floor(input.count ?? 1));
  const quota = Math.max(0, Math.floor(input.quota));
  const sent = Math.max(0, Math.floor(input.sent));
  const next = sent + n;
  const over = Math.max(0, next - Math.max(sent, quota));
  if (over > 0 && input.policy === "block") {
    return { allowed: false, over, warn: input.warned100 ? null : 100 };
  }
  let warn: 80 | 100 | null = null;
  if (quota > 0 && next >= quota && !input.warned100) warn = 100;
  else if (quota > 0 && next * 100 >= quota * 80 && !input.warned80) warn = 80;
  return { allowed: true, over, warn };
}

/** Bloques de excedente a cobrar (se redondea para arriba). */
export function overageBlocks(overage: number, blockSize: number): number {
  if (!(overage > 0)) return 0;
  return Math.ceil(overage / Math.max(1, Math.floor(blockSize)));
}

/** Uso del mes para mostrar: porcentaje (tope 100) y nivel. */
export function usageLevel(sent: number, quota: number): { pct: number; level: "ok" | "warn" | "full" } {
  if (!(quota > 0)) return { pct: 0, level: "ok" };
  const pct = Math.min(100, Math.round((sent * 100) / quota));
  return { pct, level: sent >= quota ? "full" : sent * 100 >= quota * 80 ? "warn" : "ok" };
}

// ── Resend ──────────────────────────────────────────────────────────────────

export interface DnsRecord {
  record: string; // SPF | DKIM | MX | DMARC …
  name: string;
  type: string; // TXT | MX | CNAME
  value: string;
  ttl: string | null;
  priority: number | null;
  status: string; // verified | pending | not_started | failed | temporary_failure
}

export interface ResendDomain {
  id: string;
  name: string;
  status: string;
  region: string | null;
  records: DnsRecord[];
}

function str(v: unknown): string {
  return v == null ? "" : String(v);
}

/** Normaliza la respuesta de GET /domains/{id} o POST /domains de Resend. */
export function parseResendDomain(raw: unknown): ResendDomain | null {
  if (!raw || typeof raw !== "object") return null;
  const o = raw as Record<string, unknown>;
  const id = str(o.id);
  const name = str(o.name).toLowerCase();
  if (!id || !name) return null;
  const records = Array.isArray(o.records)
    ? (o.records as Record<string, unknown>[]).map((r) => ({
        record: str(r.record),
        name: str(r.name),
        type: str(r.type).toUpperCase(),
        value: str(r.value),
        ttl: r.ttl == null ? null : str(r.ttl),
        priority: r.priority == null || r.priority === "" ? null : Number(r.priority),
        status: str(r.status) || "not_started",
      }))
    : [];
  return { id, name, status: str(o.status) || "not_started", region: o.region == null ? null : str(o.region), records };
}

/** Busca el dominio en la lista de GET /domains (data: [...]). */
export function findDomain(list: unknown, domain: string): { id: string; status: string } | null {
  const data = (list as { data?: unknown } | null)?.data;
  if (!Array.isArray(data)) return null;
  const d = (data as Record<string, unknown>[]).find((x) => str(x.name).toLowerCase() === domain.toLowerCase());
  return d ? { id: str(d.id), status: str(d.status) } : null;
}

/** Nombre del registro tal como se carga en el DNS del dominio (sin el dominio). */
export function dnsHostLabel(recordName: string, domain: string): string {
  const n = recordName.replace(/\.$/, "");
  if (n === domain) return "@";
  return n.endsWith(`.${domain}`) ? n.slice(0, -(domain.length + 1)) : n;
}

export const DOMAIN_STATUS_LABEL: Record<string, string> = {
  verified: "Verificado",
  pending: "Verificando",
  not_started: "Sin verificar",
  failed: "Falló la verificación",
  temporary_failure: "Falla temporal",
};

/** Claves de Resend: empiezan con re_ y no tienen espacios. */
export function isPlausibleResendKey(key: string): boolean {
  return /^re_[A-Za-z0-9_]{8,}$/.test(key.trim());
}

/** Últimos 4 caracteres para mostrar sin exponer la key. */
export function keyHint(key: string): string {
  const k = key.trim();
  return k.length <= 4 ? "…" : `…${k.slice(-4)}`;
}

// ── Mensajes de envío ───────────────────────────────────────────────────────

export const NINJA_EMAIL_REASONS = [
  "addon_inactive",
  "subscription_inactive",
  "domain_not_verified",
  "quota_exceeded",
  "email_addon_not_configured",
] as const;

export function ninjaEmailErrorMessage(reason: string): string {
  switch (reason) {
    case "addon_inactive":
      return "El email de NinjaSoft no está activo en tu suscripción. Sumalo o elegí tu cuenta en Configuración › Email del negocio.";
    case "subscription_inactive":
      return "Tu suscripción no está activa: regularizala para seguir enviando emails con NinjaSoft.";
    case "domain_not_verified":
    case "email_addon_not_configured":
      return "El envío por NinjaSoft no está disponible en este momento. Probá más tarde o usá tu cuenta de correo.";
    case "quota_exceeded":
      return "Usaste todos los emails de este mes. Pasá a un escalón más grande en Configuración › Email del negocio.";
    default:
      return "No se pudo enviar el email.";
  }
}
