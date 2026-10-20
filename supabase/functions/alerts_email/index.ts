// =============================================================================
// Edge Function: alerts_email (F24 · H162, ADR-176): resumen por mail de las
// alertas programadas.
//
// Cron (pg_cron + pg_net cada 15 minutos, job `alerts-email`): header
// X-Cron-Secret == platform_secrets('internal_cron').token. Toma los eventos
// con el mail pendiente (alert_email_pending: ya trae los destinatarios, los
// emails de los miembros activos de la audiencia de cada regla), los agrupa
// por negocio y destinatarios y manda UN resumen por grupo con el email DEL
// NEGOCIO (tenant_email_smtp: SMTP, Resend o el complemento de NinjaSoft, vía
// sendTenantEmail). Sin email configurado, el evento queda 'skipped' con el
// motivo (no reintenta en loop). Cada envío queda en system_emails
// (kind alerts_digest) y el evento se marca con alert_email_mark.
//
// Deploy: verify_jwt=true (el cron manda el anon key como Bearer para pasar el
// gateway; la autenticación real es el X-Cron-Secret).
// =============================================================================
import { createClient, type SupabaseClient } from "https://esm.sh/@supabase/supabase-js@2.47.10";
import { sendTenantEmail, tenantProviderReady, type TenantEmailCfg } from "../_shared/tenantMailer.ts";

const cors = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type, x-cron-secret",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};
const json = (b: unknown, s = 200) =>
  new Response(JSON.stringify(b), { status: s, headers: { ...cors, "Content-Type": "application/json" } });

// Tope de mails por invocación (evita timeouts; el resto sale en la próxima).
const MAX_SENDS = 60;
const ITEMS_PER_EVENT = 15;
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const APP_URL = "https://pos.soft.ninja";
const NINJA_LOGO_URL = "https://pos.soft.ninja/brand/ninjasoft-wordmark.webp";
const NINJA_LOGO_DARK_URL =
  "https://res.cloudinary.com/dl6yhrcx0/image/upload/f_png,h_120/Ninja_POS_Light_glckmm";

addEventListener("unhandledrejection", (e) => {
  console.error("unhandledrejection:", (e as PromiseRejectionEvent).reason);
  (e as PromiseRejectionEvent).preventDefault();
});

const escapeHtml = (s: string) =>
  s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

const ars = (n: number) =>
  new Intl.NumberFormat("es-AR", { style: "currency", currency: "ARS", maximumFractionDigits: 0 }).format(
    Number(n) || 0,
  );

interface AlertItem {
  key: string;
  title: string;
  detail?: string;
  amount?: number | null;
  new?: boolean;
}

interface PendingEvent {
  event_id: string;
  tenant_id: string;
  rule_id: string;
  kind: string;
  ran_at: string;
  hits: number;
  new_hits: number;
  items: AlertItem[];
  only_new: boolean;
  label: string | null;
  severity: string | null;
  store_name: string | null;
  recipients: string[];
}

interface Brand {
  name: string;
  accent: string;
  logoHtml: string;
}

async function brandFor(admin: SupabaseClient, tenantId: string, cfg: TenantEmailCfg | null): Promise<Brand> {
  const { data: b } = await admin
    .from("tenant_branding")
    .select("legal_name, logo_url, accent")
    .eq("tenant_id", tenantId)
    .maybeSingle();
  const name =
    // deno-lint-ignore no-control-regex
    String(b?.legal_name || cfg?.from_name || "Tu negocio").replace(/[\x00-\x1f\x7f]+/g, " ").trim() || "Tu negocio";
  const accent = /^#[0-9a-fA-F]{6}$/.test(String(b?.accent ?? "")) ? String(b!.accent) : "#111827";
  const logo = String(b?.logo_url ?? "").trim();
  const logoHtml = logo
    ? `<img src="${escapeHtml(logo)}" alt="${escapeHtml(name)}" style="max-height:48px;display:inline-block">`
    : `<img src="${NINJA_LOGO_URL}" alt="NinjaSoft" style="max-height:32px;display:inline-block">`;
  return { name, accent, logoHtml };
}

function wrap(brand: Brand, inner: string): string {
  return `<div style="font-family:system-ui,Segoe UI,Arial,sans-serif;max-width:560px;margin:0 auto;border:1px solid #e5e7eb;border-radius:12px;overflow:hidden">
  <div style="background:${brand.accent};padding:20px;text-align:center">
    ${brand.logoHtml}
    <div style="color:#ffffff;font-size:16px;font-weight:bold;margin-top:8px">${escapeHtml(brand.name)}</div>
  </div>
  <div style="padding:24px;color:#111827;line-height:1.55;font-size:15px">${inner}</div>
  <div style="background:#09051C;padding:18px 12px;text-align:center">
    <img src="${NINJA_LOGO_DARK_URL}" alt="NinjaPos" style="max-height:20px;display:inline-block" />
    <div style="color:#9ca3af;font-size:11px;margin-top:8px">Enviado con NinjaPos</div>
  </div>
</div>`;
}

/** Los casos a contar: con "sólo casos nuevos", los nuevos; si no, todos. */
function shownItems(ev: PendingEvent): AlertItem[] {
  const items = Array.isArray(ev.items) ? ev.items : [];
  return ev.only_new ? items.filter((i) => i.new !== false) : items;
}

function digest(brand: Brand, events: PendingEvent[]): { subject: string; html: string; text: string } {
  const total = events.reduce((a, e) => a + (e.only_new ? e.new_hits : e.hits), 0);
  const blocks = events
    .map((ev) => {
      const items = shownItems(ev);
      const n = ev.only_new ? ev.new_hits : ev.hits;
      const label = escapeHtml(ev.label ?? ev.kind) + (ev.store_name ? ` (${escapeHtml(ev.store_name)})` : "");
      const rows = items
        .slice(0, ITEMS_PER_EVENT)
        .map(
          (i) => `<tr>
        <td style="padding:6px 8px;border-bottom:1px solid #f1f5f9">${escapeHtml(String(i.title ?? ""))}${
            i.detail ? `<div style="color:#6b7280;font-size:12px">${escapeHtml(String(i.detail))}</div>` : ""
          }</td>
        <td style="padding:6px 8px;border-bottom:1px solid #f1f5f9;text-align:right;white-space:nowrap">${
          i.amount != null ? ars(Number(i.amount)) : ""
        }</td></tr>`,
        )
        .join("");
      const more = n > Math.min(items.length, ITEMS_PER_EVENT) ? n - Math.min(items.length, ITEMS_PER_EVENT) : 0;
      return `<h3 style="margin:20px 0 6px;font-size:15px">${label}: ${n}</h3>
      <table style="width:100%;border-collapse:collapse;font-size:14px">${rows}</table>
      ${more > 0 ? `<p style="margin:6px 0 0;color:#6b7280;font-size:13px">Y ${more} más.</p>` : ""}
      <p style="margin:6px 0 0;font-size:13px"><a href="${APP_URL}/alertas?evento=${ev.event_id}" style="color:#2563eb">Ver en NinjaPos</a></p>`;
    })
    .join("");
  const inner = `<p style="margin:0 0 4px;font-weight:600">Resumen de alertas</p>
  <p style="margin:0 0 8px;color:#6b7280;font-size:13px">${total} caso${total === 1 ? "" : "s"} para revisar.</p>
  ${blocks}
  <p style="margin:20px 0 0;color:#6b7280;font-size:12px">Las alertas se configuran en NinjaPos › Configuración › Alertas.</p>`;
  const subject = `Alertas: ${total} caso${total === 1 ? "" : "s"} para revisar · ${brand.name}`;
  const text = events
    .map((ev) => {
      const items = shownItems(ev).slice(0, ITEMS_PER_EVENT);
      return `${ev.label ?? ev.kind}${ev.store_name ? ` (${ev.store_name})` : ""}: ${
        ev.only_new ? ev.new_hits : ev.hits
      }\n${items.map((i) => `- ${i.title}${i.detail ? ` (${i.detail})` : ""}`).join("\n")}`;
    })
    .join("\n\n");
  return { subject, html: wrap(brand, inner), text };
}

async function logEmail(
  admin: SupabaseClient,
  row: { tenant_id: string; recipient: string; subject: string; status: string; error?: string },
) {
  try {
    await admin.from("system_emails").insert({
      tenant_id: row.tenant_id,
      recipient: row.recipient,
      subject: row.subject,
      kind: "alerts_digest",
      status: row.status,
      error_message: row.error ?? null,
      sent_at: row.status === "sent" ? new Date().toISOString() : null,
    });
  } catch (_) {
    /* best-effort */
  }
}

async function mark(admin: SupabaseClient, ids: string[], status: "sent" | "failed" | "skipped", error?: string) {
  const { error: e } = await admin.rpc("alert_email_mark", { p_ids: ids, p_status: status, p_error: error ?? null });
  if (e) console.error("alert_email_mark:", e.message);
}

async function runCron(admin: SupabaseClient) {
  const { data, error } = await admin.rpc("alert_email_pending", { p_limit: 200 });
  if (error) return json({ error: "pending_failed", detail: error.message }, 500);
  const events = (data ?? []) as PendingEvent[];

  // Un grupo por negocio y conjunto de destinatarios.
  const groups = new Map<string, { tenantId: string; recipients: string[]; events: PendingEvent[] }>();
  for (const ev of events) {
    const recipients = [...new Set((ev.recipients ?? []).map((r) => String(r).trim().toLowerCase()))]
      .filter((r) => EMAIL_RE.test(r))
      .sort();
    const key = `${ev.tenant_id}|${recipients.join(",")}`;
    const g = groups.get(key) ?? { tenantId: ev.tenant_id, recipients, events: [] };
    g.events.push(ev);
    groups.set(key, g);
  }

  let sent = 0;
  let failed = 0;
  let skipped = 0;
  let budget = MAX_SENDS;
  const cfgCache = new Map<string, TenantEmailCfg | null>();
  for (const g of groups.values()) {
    const ids = g.events.map((e) => e.event_id);
    if (g.recipients.length === 0) {
      await mark(admin, ids, "skipped", "no_recipients");
      skipped += ids.length;
      continue;
    }
    if (budget < g.recipients.length) break; // queda pendiente para la próxima corrida
    if (!cfgCache.has(g.tenantId)) {
      const { data: cfg } = await admin.from("tenant_email_smtp").select("*").eq("tenant_id", g.tenantId).maybeSingle();
      cfgCache.set(g.tenantId, (cfg ?? null) as TenantEmailCfg | null);
    }
    const cfg = cfgCache.get(g.tenantId) ?? null;
    if (!cfg || !tenantProviderReady(cfg)) {
      await mark(admin, ids, "skipped", "tenant_email_not_configured");
      skipped += ids.length;
      continue;
    }
    const brand = await brandFor(admin, g.tenantId, cfg);
    const mail = digest(brand, g.events);
    let okCount = 0;
    let lastErr = "";
    for (const to of g.recipients) {
      budget--;
      try {
        await sendTenantEmail(admin, g.tenantId, cfg, { to, subject: mail.subject, html: mail.html, text: mail.text });
        okCount++;
        await logEmail(admin, { tenant_id: g.tenantId, recipient: to, subject: mail.subject, status: "sent" });
      } catch (e) {
        lastErr = e instanceof Error ? e.message : String(e);
        await logEmail(admin, { tenant_id: g.tenantId, recipient: to, subject: mail.subject, status: "failed", error: lastErr });
      }
    }
    if (okCount > 0) {
      await mark(admin, ids, "sent", okCount < g.recipients.length ? `parcial: ${lastErr}`.slice(0, 500) : undefined);
      sent += ids.length;
    } else {
      await mark(admin, ids, "failed", lastErr.slice(0, 500));
      failed += ids.length;
    }
  }
  return json({ ok: true, events: events.length, sent, failed, skipped });
}

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });
  if (req.method !== "POST") return json({ error: "method_not_allowed" }, 405);
  try {
    const url = Deno.env.get("SUPABASE_URL")!;
    const serviceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
    const admin = createClient(url, serviceKey, { auth: { persistSession: false } });

    const cronSecret = req.headers.get("X-Cron-Secret") ?? "";
    if (!cronSecret) return json({ error: "forbidden" }, 403);
    const { data: sec } = await admin.from("platform_secrets").select("secrets").eq("key", "internal_cron").maybeSingle();
    const token = (sec?.secrets as { token?: string } | null)?.token ?? "";
    if (!token || cronSecret !== token) return json({ error: "forbidden" }, 403);
    return await runCron(admin);
  } catch (e) {
    return json({ error: "internal", detail: String(e) }, 500);
  }
});
