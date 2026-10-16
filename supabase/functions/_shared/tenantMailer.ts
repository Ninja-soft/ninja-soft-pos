// =============================================================================
// Envío con el email DEL NEGOCIO (tenant_email_smtp, Configuración → Email):
// Resend (API key) o SMTP (nodemailer). Mismo criterio que send_receipt_email
// y account_reminders (465 = SSL directo, timeouts, sin caracteres de control
// en el nombre). Lo usa send_quote_email (ADR-123).
// ADR-156: provider 'ninjasoft' = el complemento "Email con dominio NinjaSoft"
// (sale por la API de Resend de la plataforma con cupo mensual): usar
// sendTenantEmail, que lo resuelve con _shared/ninjaEmail.ts.
// =============================================================================
// @ts-ignore tipos de nodemailer no resuelven en Deno; el archivo está excluido del tsconfig.
import nodemailer from "npm:nodemailer@6.9.16";
import type { SendArgs } from "./mailer.ts";
import { sendViaNinja } from "./ninjaEmail.ts";

// deno-lint-ignore no-explicit-any
type Admin = any;

export const NINJA_PROVIDER = "ninjasoft";

export function isNinjaProvider(cfg: { provider?: string | null } | null | undefined): boolean {
  return String(cfg?.provider ?? "") === NINJA_PROVIDER;
}

export interface TenantEmailCfg {
  provider?: string | null;
  resend_api_key?: string | null;
  host?: string | null;
  port?: number | null;
  secure?: boolean | null;
  username?: string | null;
  password?: string | null;
  from_name?: string | null;
  from_email?: string | null;
}

function withTimeout<T>(p: Promise<T>, ms: number, label: string): Promise<T> {
  return Promise.race([
    p,
    new Promise<T>((_, rej) => setTimeout(() => rej(new Error(`${label}_timeout`)), ms)),
  ]);
}

/** Nombre seguro para headers (sin CR/LF ni comillas). */
export function safeName(name: string | null | undefined, fallback = "NinjaPos"): string {
  return (
    String(name ?? "")
      // deno-lint-ignore no-control-regex
      .replace(/[\x00-\x1f\x7f]+/g, " ")
      .replace(/"/g, "")
      .trim() || fallback
  );
}

/** ¿El negocio tiene su proveedor listo? */
export function tenantProviderReady(cfg: TenantEmailCfg | null | undefined): boolean {
  // El complemento se valida al enviar (email_addon_consume): cupo, vigencia y
  // dominio. Acá sólo se elige el camino.
  if (isNinjaProvider(cfg)) return true;
  if (!cfg?.from_email) return false;
  return String(cfg.provider ?? "smtp") === "resend" ? Boolean(cfg.resend_api_key) : Boolean(cfg.host);
}

export async function sendViaTenant(cfg: TenantEmailCfg, args: SendArgs): Promise<void> {
  const name = safeName(args.fromName || cfg.from_name);
  if (String(cfg.provider ?? "smtp") === "resend") {
    const res = await withTimeout(
      fetch("https://api.resend.com/emails", {
        method: "POST",
        headers: { Authorization: `Bearer ${cfg.resend_api_key}`, "Content-Type": "application/json" },
        body: JSON.stringify({
          from: `${name} <${cfg.from_email}>`,
          to: args.to,
          subject: args.subject,
          html: args.html,
          ...(args.text ? { text: args.text } : {}),
          ...(args.replyTo ? { reply_to: args.replyTo } : {}),
          ...(args.attachments?.length
            ? { attachments: args.attachments.map((a) => ({ filename: a.filename, content: a.content })) }
            : {}),
        }),
      }),
      25000,
      "resend",
    );
    if (!res.ok) {
      const detail = await res.text().catch(() => "");
      throw new Error(`resend_${res.status}: ${detail.slice(0, 300)}`);
    }
    return;
  }
  const port = cfg.port || 587;
  const transporter = nodemailer.createTransport({
    host: cfg.host,
    port,
    secure: port === 465 ? true : !!cfg.secure,
    auth: cfg.username ? { user: cfg.username, pass: cfg.password ?? "" } : undefined,
    connectionTimeout: 15000,
    greetingTimeout: 10000,
    socketTimeout: 20000,
  });
  try {
    await withTimeout(
      transporter.sendMail({
        from: `"${name}" <${cfg.from_email}>`,
        to: args.to,
        subject: args.subject,
        text: args.text || "Este mensaje se ve mejor con un cliente que soporte HTML.",
        html: args.html,
        ...(args.replyTo ? { replyTo: args.replyTo } : {}),
        ...(args.attachments?.length
          ? {
              attachments: args.attachments.map((a) => ({
                filename: a.filename,
                content: a.content,
                encoding: "base64",
                contentType: a.contentType ?? "application/octet-stream",
              })),
            }
          : {}),
      }),
      25000,
      "smtp_send",
    );
  } finally {
    try {
      transporter.close();
    } catch (_) {
      /* noop */
    }
  }
}

/**
 * Envío con el proveedor del negocio, incluido el complemento de NinjaSoft
 * (ADR-156). Para 'ninjasoft' descuenta del cupo del mes y puede lanzar
 * NinjaEmailError (reason: quota_exceeded, addon_inactive, …).
 */
export async function sendTenantEmail(
  admin: Admin,
  tenantId: string,
  cfg: TenantEmailCfg,
  args: SendArgs,
): Promise<void> {
  if (isNinjaProvider(cfg)) {
    await sendViaNinja(admin, tenantId, args);
    return;
  }
  await sendViaTenant(cfg, args);
}
