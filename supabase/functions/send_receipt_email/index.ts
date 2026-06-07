// =============================================================================
// Edge Function: send_receipt_email — envía el comprobante de una venta (PNG)
// por email al cliente. Guard: miembro activo del tenant de la venta.
// SMTP del NEGOCIO (tenant_email_smtp, ver Configuración → Email). H9b PR3.
// Cuerpo HTML con branding del tenant (logo/accent/legal_name).
// =============================================================================
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.47.10";
import { SMTPClient } from "https://deno.land/x/denomailer@1.6.0/mod.ts";

const cors = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers":
    "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};
const json = (b: unknown, s = 200) =>
  new Response(JSON.stringify(b), {
    status: s,
    headers: { ...cors, "Content-Type": "application/json" },
  });
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const PNG_PREFIX = "data:image/png;base64,";
// Escapa datos provistos por el tenant (legal_name) antes de interpolar en HTML.
const escapeHtml = (s: string) =>
  s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });
  if (req.method !== "POST") return json({ error: "method_not_allowed" }, 405);
  const url = Deno.env.get("SUPABASE_URL")!;
  const serviceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
  const anonKey = Deno.env.get("SUPABASE_ANON_KEY")!;
  const userClient = createClient(url, anonKey, {
    global: { headers: { Authorization: req.headers.get("Authorization") ?? "" } },
    auth: { persistSession: false },
  });
  const {
    data: { user },
    error,
  } = await userClient.auth.getUser();
  if (error || !user) return json({ error: "unauthorized" }, 401);

  let b: { sale_id?: string; to?: string; png?: string };
  try {
    b = await req.json();
  } catch {
    return json({ error: "invalid_json" }, 400);
  }
  const saleId = String(b.sale_id ?? "").trim();
  const to = String(b.to ?? "").trim().toLowerCase();
  const png = String(b.png ?? "");
  if (!saleId) return json({ error: "missing_sale_id" }, 400);
  if (!EMAIL_RE.test(to)) return json({ error: "invalid_to" }, 400);
  if (!png.startsWith(PNG_PREFIX)) return json({ error: "invalid_png" }, 400);
  const base64 = png.slice(PNG_PREFIX.length);
  // ~2 MB de imagen (base64 agrega ~33%).
  if (base64.length > 2_800_000) return json({ error: "png_too_large" }, 413);

  const admin = createClient(url, serviceKey, { auth: { persistSession: false } });
  const { data: sale } = await admin
    .from("sales")
    .select("id, tenant_id, number")
    .eq("id", saleId)
    .maybeSingle();
  if (!sale) return json({ error: "sale_not_found" }, 404);
  const { data: member } = await admin
    .from("tenant_users")
    .select("user_id")
    .eq("tenant_id", sale.tenant_id)
    .eq("user_id", user.id)
    .eq("status", "active")
    .maybeSingle();
  if (!member) return json({ error: "forbidden" }, 403);

  const { data: cfg } = await admin
    .from("tenant_email_smtp")
    .select("*")
    .eq("tenant_id", sale.tenant_id)
    .maybeSingle();
  if (!cfg?.host || !cfg?.from_email)
    return json(
      {
        error: "tenant_smtp_not_configured",
        detail: "Configurá el email de tu negocio en Configuración → Email.",
      },
      400,
    );
  const { data: brand } = await admin
    .from("tenant_branding")
    .select("legal_name, logo_url, accent")
    .eq("tenant_id", sale.tenant_id)
    .maybeSingle();
  // Sin caracteres de control: legal_name viaja en headers SMTP (From/Subject);
  // CR/LF permitirían inyectar headers (denomailer no los filtra).
  const name = (brand?.legal_name || cfg.from_name || "NinjaSoft POS")
    // deno-lint-ignore no-control-regex
    .replace(/[\x00-\x1f\x7f]+/g, " ")
    .trim() || "NinjaSoft POS";
  const safeName = escapeHtml(name);

  // Branding del cuerpo HTML.
  const accent = /^#[0-9a-fA-F]{6}$/.test(String(brand?.accent ?? ""))
    ? String(brand!.accent)
    : "#111827";
  const logoUrl = String(brand?.logo_url ?? "").trim();
  const safeLogo = escapeHtml(logoUrl); // escapa comillas para el atributo src
  const bodyTextRaw =
    String(cfg.body_text ?? "").trim() ||
    "¡Gracias por tu compra! Te enviamos tu comprobante.";
  const safeBodyText = escapeHtml(bodyTextRaw);
  const html = `<div style="font-family:system-ui,Segoe UI,Arial,sans-serif;max-width:480px;margin:0 auto;border:1px solid #e5e7eb;border-radius:12px;overflow:hidden">
  <div style="background:${accent};padding:20px;text-align:center">
    ${logoUrl ? `<img src="${safeLogo}" alt="" style="max-height:48px">` : `<strong style="color:#fff;font-size:18px">${safeName}</strong>`}
  </div>
  <div style="padding:24px;color:#111">
    <p style="white-space:pre-wrap">${safeBodyText}</p>
    <p style="color:#6b7280;font-size:12px">Tu comprobante va adjunto a este email.</p>
  </div>
  <div style="background:#f9fafb;padding:12px;text-align:center;color:#9ca3af;font-size:11px">Enviado con NinjaSoft POS</div>
</div>`;

  const client = new SMTPClient({
    connection: {
      hostname: cfg.host,
      port: cfg.port || 587,
      tls: !!cfg.secure,
      auth: cfg.username ? { username: cfg.username, password: cfg.password } : undefined,
    },
  });
  try {
    await client.send({
      from: `${name} <${cfg.from_email}>`,
      to,
      subject: `Tu comprobante de ${name}`,
      content: bodyTextRaw,
      html,
      attachments: [
        {
          filename: `comprobante-${sale.number}.png`,
          content: base64,
          encoding: "base64",
          contentType: "image/png",
        },
      ],
    });
    await client.close();
  } catch (e) {
    try {
      await client.close();
    } catch (_) {
      /* noop */
    }
    return json(
      { error: "send_failed", detail: e instanceof Error ? e.message : String(e) },
      502,
    );
  }
  await admin
    .from("sales")
    .update({ receipt_email_to: to, receipt_emailed_at: new Date().toISOString() })
    .eq("id", saleId);
  await admin.from("audit_logs").insert({
    tenant_id: sale.tenant_id,
    actor_user_id: user.id,
    entity_type: "sale",
    entity_id: saleId,
    action: "receipt_emailed",
    after_data: { to },
  });
  return json({ ok: true });
});
