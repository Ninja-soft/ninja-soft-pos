// =============================================================================
// Edge Function: send_receipt_email — envía el comprobante de una venta (PNG)
// por email al cliente. Guard: miembro activo del tenant de la venta.
// SMTP del sistema (system_email_smtp, ver /internal/emails). H9b.
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
    .from("system_email_smtp")
    .select("*")
    .eq("id", true)
    .maybeSingle();
  if (!cfg?.host || !cfg?.from_email)
    return json(
      { error: "smtp_not_configured", detail: "Configura el SMTP en /internal/emails." },
      400,
    );
  const { data: brand } = await admin
    .from("tenant_branding")
    .select("legal_name")
    .eq("tenant_id", sale.tenant_id)
    .maybeSingle();
  const name = brand?.legal_name || "NinjaSoft POS";
  const safeName = escapeHtml(name);

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
      content: "Adjuntamos tu comprobante de compra. ¡Gracias!",
      html: `<p>Adjuntamos tu comprobante de compra de <b>${safeName}</b>. ¡Gracias!</p>`,
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
