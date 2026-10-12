// =============================================================================
// send_password_recovery (público, verify_jwt = false)
//
// Reemplaza supabase.auth.resetPasswordForEmail (mailer propio de Supabase) por
// un email con la plantilla `password_recovery` de /internal/emails, enviado por
// la misma cadena de proveedores (Resend → SMTP → legacy).
//
// • El link usa token_hash (verifyOtp en /reset-password): funciona aunque se
//   abra en otro navegador o dispositivo (el ?code PKCE no).
// • Anti-enumeración: responde siempre { ok: true }.
// • Límite: 3 envíos por email cada 15 min (bitácora system_emails).
// • El origen del link sólo puede ser un dominio propio (evita phishing con
//   links de recuperación válidos apuntando a otro sitio).
// =============================================================================
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.47.10";
import { sendWithChain } from "../_shared/mailer.ts";

const cors = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};
const json = (b: unknown, s = 200) =>
  new Response(JSON.stringify(b), {
    status: s,
    headers: { ...cors, "Content-Type": "application/json" },
  });

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const DEFAULT_ORIGIN = "https://pos.soft.ninja";
const ALLOWED_ORIGINS = [
  /^https:\/\/pos\.soft\.ninja$/,
  /^https:\/\/ninja-soft-pos(-[a-z0-9-]+)?\.vercel\.app$/,
  /^http:\/\/localhost:\d+$/,
];
const KIND = "password_recovery";
const WINDOW_MS = 15 * 60 * 1000;
const MAX_PER_WINDOW = 3;

const FALLBACK_SUBJECT = "Restablecé tu contraseña de NinjaPos";
const FALLBACK_HTML =
  '<p>Hola {{nombre}},</p><p>Pediste restablecer tu contraseña.</p><p><a href="{{link}}">Cambiar mi contraseña</a></p><p>Si no fuiste vos, ignorá este email.</p>';

function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!,
  );
}

function render(tpl: string, vars: Record<string, string>): string {
  return tpl.replace(/\{\{\s*(\w+)\s*\}\}/g, (_, k) => vars[k] ?? "");
}

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });
  if (req.method !== "POST") return json({ error: "method_not_allowed" }, 405);

  let b: { email?: string; origin?: string };
  try {
    b = await req.json();
  } catch {
    return json({ error: "invalid_json" }, 400);
  }
  const email = String(b.email ?? "").trim().toLowerCase();
  if (!EMAIL_RE.test(email)) return json({ error: "invalid_email" }, 400);
  const origin = ALLOWED_ORIGINS.some((re) => re.test(String(b.origin ?? "")))
    ? String(b.origin)
    : DEFAULT_ORIGIN;

  try {
    const admin = createClient(
      Deno.env.get("SUPABASE_URL")!,
      Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
      { auth: { persistSession: false } },
    );

    // Límite por email.
    const since = new Date(Date.now() - WINDOW_MS).toISOString();
    const { count } = await admin
      .from("system_emails")
      .select("id", { count: "exact", head: true })
      .eq("recipient", email)
      .eq("kind", KIND)
      .gte("created_at", since);
    if ((count ?? 0) >= MAX_PER_WINDOW) return json({ ok: true });

    // Si el usuario no existe, generateLink falla: respondemos ok igual.
    const { data: link, error } = await admin.auth.admin.generateLink({
      type: "recovery",
      email,
    });
    const hashed = link?.properties?.hashed_token;
    if (error || !hashed) return json({ ok: true });

    const meta = (link.user?.user_metadata ?? {}) as Record<string, unknown>;
    const nombre = String(meta.full_name ?? meta.name ?? email.split("@")[0]);
    const url = `${origin}/reset-password?token_hash=${encodeURIComponent(hashed)}&type=recovery`;

    const { data: tpl } = await admin
      .from("system_email_templates")
      .select("subject, html")
      .eq("key", KIND)
      .maybeSingle();
    const vars = { nombre: escapeHtml(nombre), link: url, negocio: "", logo_url: "" };
    const subject = render(tpl?.subject || FALLBACK_SUBJECT, { ...vars, nombre });
    const html = render(tpl?.html || FALLBACK_HTML, vars);

    // Bitácora (cuenta para el límite aunque el envío falle).
    const { data: logRow } = await admin
      .from("system_emails")
      .insert({ tenant_id: null, recipient: email, subject, kind: KIND, status: "pending", html_content: html })
      .select("id")
      .single();

    const result = await sendWithChain(admin, { to: email, subject, html });
    if (logRow?.id) {
      await admin
        .from("system_emails")
        .update(
          result.providerUsed
            ? { status: "sent", sent_at: new Date().toISOString() }
            : { status: "failed", error_message: (result.attempts.join(" | ") || "sin proveedor").slice(0, 500) },
        )
        .eq("id", logRow.id)
        .then(() => {}, () => {});
    }
    if (!result.providerUsed) console.error("password_recovery send failed:", result.attempts.join(" | "));
    return json({ ok: true });
  } catch (e) {
    console.error("password_recovery internal:", String(e));
    return json({ ok: true });
  }
});
