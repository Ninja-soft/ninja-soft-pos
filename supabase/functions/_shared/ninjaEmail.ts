// =============================================================================
// Envío con el complemento "Email con dominio NinjaSoft" (ADR-156).
//
// Cada email pasa por email_addon_consume (cupo del mes, política al pasar el
// cupo, addon vigente, suscripción activa, dominio verificado) y sale por la
// API de Resend de la PLATAFORMA (platform_secrets 'email_addon': api_key
// propia, o la del proveedor Resend de los emails del sistema si se eligió
// reutilizarla). Remitente {negocio}@dominio o {fija}@dominio, con respuesta
// al email del negocio. Si el envío falla, el cupo se devuelve
// (email_addon_release).
// =============================================================================
import type { SendArgs } from "./mailer.ts";
import { ninjaEmailErrorMessage } from "./billing/emailAddon.ts";

// deno-lint-ignore no-explicit-any
type Admin = any;

export class NinjaEmailError extends Error {
  reason: string;
  constructor(reason: string) {
    super(ninjaEmailErrorMessage(reason));
    this.reason = reason;
  }
}

interface ConsumeResult {
  allowed?: boolean;
  reason?: string;
  from_email?: string;
  from_name?: string;
  reply_to?: string | null;
}

function withTimeout<T>(p: Promise<T>, ms: number, label: string): Promise<T> {
  return Promise.race([
    p,
    new Promise<T>((_, rej) => setTimeout(() => rej(new Error(`${label}_timeout`)), ms)),
  ]);
}

function safeName(name: string | null | undefined): string {
  return (
    String(name ?? "")
      // deno-lint-ignore no-control-regex
      .replace(/[\x00-\x1f\x7f]+/g, " ")
      .replace(/"/g, "")
      .trim() || "NinjaPos"
  );
}

/** API key de Resend con la que sale el complemento (null = sin configurar). */
export async function platformResendKey(admin: Admin): Promise<string | null> {
  const { data } = await admin.from("platform_secrets").select("secrets").eq("key", "email_addon").maybeSingle();
  const s = (data?.secrets ?? {}) as { api_key?: string; use_system_key?: boolean };
  if (s.api_key) return s.api_key;
  if (s.use_system_key) {
    const { data: p } = await admin
      .from("email_providers")
      .select("api_key")
      .eq("kind", "resend")
      .eq("is_active", true)
      .order("slot", { ascending: true })
      .limit(1)
      .maybeSingle();
    return (p?.api_key as string | undefined) || null;
  }
  return null;
}

/** POST /emails de Resend. Lanza `resend_{status}: detalle` si falla. */
export async function resendSend(
  apiKey: string,
  from: string,
  args: Pick<SendArgs, "to" | "subject" | "html" | "text" | "replyTo" | "attachments">,
): Promise<string | null> {
  const res = await withTimeout(
    fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        from,
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
  const body = (await res.json().catch(() => ({}))) as { id?: string };
  return body.id ?? null;
}

/**
 * Envía UN email del negocio por el dominio de NinjaSoft. Lanza
 * NinjaEmailError (con `reason`) si el complemento no permite el envío.
 */
export async function sendViaNinja(admin: Admin, tenantId: string, args: SendArgs): Promise<{ from: string }> {
  const { data, error } = await admin.rpc("email_addon_consume", { p_tenant: tenantId, p_count: 1 });
  if (error) throw new Error(`email_addon_consume_failed: ${error.message}`);
  const r = (data ?? {}) as ConsumeResult;
  if (!r.allowed || !r.from_email) throw new NinjaEmailError(r.reason ?? "addon_inactive");

  const release = async () => {
    try {
      await admin.rpc("email_addon_release", { p_tenant: tenantId, p_count: 1 });
    } catch (_) {
      /* el cupo se corrige solo el mes siguiente */
    }
  };

  const key = await platformResendKey(admin);
  if (!key) {
    await release();
    throw new NinjaEmailError("email_addon_not_configured");
  }
  const from = `${safeName(args.fromName || r.from_name)} <${r.from_email}>`;
  try {
    await resendSend(key, from, { ...args, replyTo: args.replyTo || r.reply_to || null });
  } catch (e) {
    await release();
    throw e;
  }
  return { from: r.from_email };
}
