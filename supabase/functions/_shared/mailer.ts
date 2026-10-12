// =============================================================================
// Envío de emails del sistema con la cadena de proveedores de /internal/emails:
// email_providers por slot (Resend / SMTP) → SMTP legacy (system_email_smtp).
// Compartido por send_email (staff) y send_password_recovery (público).
// =============================================================================
// @ts-ignore tipos de nodemailer no resuelven en Deno; el archivo está excluido del tsconfig.
import nodemailer from "npm:nodemailer@6.9.16";

// deno-lint-ignore no-explicit-any
type Admin = any;

export interface SendArgs {
  to: string;
  subject: string;
  html: string;
}

export interface ChainResult {
  providerUsed: string | null;
  attempts: string[];
  lastError: string;
  // Ni proveedores activos ni SMTP legacy configurados.
  noProvider: boolean;
}

// Carrera contra un timeout: si la promesa no resuelve a tiempo, rechaza.
function withTimeout<T>(p: Promise<T>, ms: number, label: string): Promise<T> {
  return Promise.race([
    p,
    new Promise<T>((_, rej) => setTimeout(() => rej(new Error(`${label}_timeout`)), ms)),
  ]);
}

// Sin caracteres de control en el nombre (viaja en headers); evita header injection.
function safeFromName(name: string): string {
  return (
    // deno-lint-ignore no-control-regex
    (name || "NinjaPos").replace(/[\x00-\x1f\x7f]+/g, " ").replace(/"/g, "").trim() ||
    "NinjaPos"
  );
}

async function sendViaResend(
  apiKey: string,
  fromName: string,
  fromEmail: string,
  { to, subject, html }: SendArgs,
): Promise<void> {
  const from = `${safeFromName(fromName)} <${fromEmail}>`;
  const res = await withTimeout(
    fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ from, to, subject, html }),
    }),
    20000,
    "resend",
  );
  if (!res.ok) {
    const detail = await res.text().catch(() => "");
    throw new Error(`resend_${res.status}: ${detail.slice(0, 300)}`);
  }
}

async function sendViaSmtp(
  cfg: {
    host: string;
    port: number;
    secure: boolean;
    user: string | null;
    pass: string | null;
  },
  fromName: string,
  fromEmail: string,
  { to, subject, html }: SendArgs,
): Promise<void> {
  // 465 = SSL directo (forzar tls); 587 = STARTTLS (nodemailer lo negocia solo).
  const port = cfg.port || 587;
  const secure = port === 465 ? true : !!cfg.secure;
  const transporter = nodemailer.createTransport({
    host: cfg.host,
    port,
    secure,
    auth: cfg.user ? { user: cfg.user, pass: cfg.pass ?? "" } : undefined,
    connectionTimeout: 15000,
    greetingTimeout: 10000,
    socketTimeout: 20000,
  });
  try {
    await withTimeout(
      transporter.sendMail({
        from: `"${safeFromName(fromName)}" <${fromEmail}>`,
        to,
        subject,
        text: "Este mensaje se ve mejor con un cliente que soporte HTML.",
        html,
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

interface ProviderRow {
  slot: number;
  kind: string;
  is_active: boolean;
  api_key: string | null;
  smtp_host: string | null;
  smtp_port: number | null;
  smtp_secure: boolean | null;
  smtp_user: string | null;
  smtp_pass: string | null;
  from_name: string | null;
  from_email: string | null;
}

// Prueba los proveedores en orden (slot 1 → slot 2 → SMTP legacy) hasta que uno envía.
export async function sendWithChain(admin: Admin, args: SendArgs): Promise<ChainResult> {
  const { data: providers } = await admin
    .from("email_providers")
    .select("*")
    .order("slot", { ascending: true });
  const rows = (providers ?? []) as ProviderRow[];

  // Solo proveedores activos y "completos" para su kind entran a la cadena.
  const candidates = rows.filter((p) => {
    if (!p.is_active || !p.from_email) return false;
    if (p.kind === "resend") return !!p.api_key;
    if (p.kind === "smtp") return !!p.smtp_host;
    return false;
  });

  const attempts: string[] = [];
  let lastError = "";

  for (const p of candidates) {
    const label = `${p.kind}#${p.slot}`;
    try {
      if (p.kind === "resend") {
        await sendViaResend(p.api_key!, p.from_name ?? "NinjaPos", p.from_email!, args);
      } else {
        await sendViaSmtp(
          {
            host: p.smtp_host!,
            port: p.smtp_port ?? 587,
            secure: !!p.smtp_secure,
            user: p.smtp_user,
            pass: p.smtp_pass,
          },
          p.from_name ?? "NinjaPos",
          p.from_email!,
          args,
        );
      }
      return { providerUsed: label, attempts, lastError, noProvider: false };
    } catch (e) {
      lastError = e instanceof Error ? e.message : String(e);
      attempts.push(`${label}: ${lastError}`);
    }
  }

  // Fallback: SMTP legacy (system_email_smtp) si ningún provider funcionó.
  const { data: legacy } = await admin
    .from("system_email_smtp")
    .select("*")
    .eq("id", true)
    .maybeSingle();
  if (legacy?.host && legacy?.from_email) {
    try {
      await sendViaSmtp(
        {
          host: legacy.host,
          port: legacy.port ?? 587,
          secure: !!legacy.secure,
          user: legacy.username ?? null,
          pass: legacy.password ?? null,
        },
        legacy.from_name ?? "NinjaPos",
        legacy.from_email,
        args,
      );
      return { providerUsed: "smtp#legacy", attempts, lastError, noProvider: false };
    } catch (e) {
      lastError = e instanceof Error ? e.message : String(e);
      attempts.push(`smtp#legacy: ${lastError}`);
    }
  }

  return { providerUsed: null, attempts, lastError, noProvider: candidates.length === 0 && !legacy?.host };
}
