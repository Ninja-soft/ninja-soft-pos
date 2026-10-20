// =============================================================================
// Edge Function: pending_charge_share: manda por email el link de pago de un
// cobro en espera (ADR-048) con el diseño del negocio.
//
// POST { pending_charge_id, to, note? } con el JWT de un miembro activo que
// opera la sucursal del cobro. Exige la feature cobros_en_espera, que el cobro
// esté esperando pago, sin vencer y con un link https. Envía con la cadena de
// proveedores de la plataforma (_shared/mailer.ts: Resend → SMTP), registra el
// envío en system_emails (kind 'payment_link') y en la línea de tiempo del
// cobro (evento 'shared'), y guarda el email del cliente si no lo tenía.
//
// Límites anti abuso: 5 envíos por cobro y 60 por negocio por hora.
// Deploy: verify_jwt = true.
// =============================================================================
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.47.10";
import { sendWithChain } from "../_shared/mailer.ts";
import { businessDisplayName, fetchTradeName } from "../_shared/businessName.ts";

const cors = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type, x-ninja-scope",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};
const json = (b: unknown, s = 200) =>
  new Response(JSON.stringify(b), { status: s, headers: { ...cors, "Content-Type": "application/json" } });

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const MAX_PER_CHARGE = 5;
const MAX_PER_HOUR = 60;

const PROVIDER_NAME: Record<string, string> = {
  mercadopago: "Mercado Pago",
  mobbex: "Mobbex",
  modo: "MODO",
  pagos360: "Pagos360",
  payway: "Payway",
  getnet: "Getnet",
  nave: "Nave",
  gocuotas: "GO Cuotas",
  directo: "Directo",
  ualabis: "Ualá Bis",
  viumi: "Viumi",
  talo: "Talo (transferencia)",
  dlocalgo: "dLocal Go",
  mp_cupon: "Rapipago o Pago Fácil (cupón de Mercado Pago)",
};

function money(n: number): string {
  return new Intl.NumberFormat("es-AR", { style: "currency", currency: "ARS" }).format(n);
}

function expiresText(iso: string): string {
  const f = new Intl.DateTimeFormat("es-AR", {
    timeZone: "America/Argentina/Buenos_Aires",
    day: "2-digit",
    month: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  }).formatToParts(new Date(iso));
  const g = (t: string) => f.find((p) => p.type === t)?.value ?? "";
  return `El link vence el ${g("day")}/${g("month")} a las ${g("hour")}:${g("minute")}.`;
}

// <payment-link-template>
interface PaymentLinkEmailInput {
  businessName: string;
  logoUrl: string;
  accent: string;
  customerName: string;
  amountLabel: string;
  payUrl: string;
  expiresLabel: string;
  providerName: string;
  lines: { name: string; quantity: number; subtotalLabel: string }[];
  note: string;
}

const PL_FONT = "-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif";
const PL_PAGE = "#f3f2f8";
const PL_INK = "#09051C";
const PL_MUTED = "#6b7280";
const PL_SOFT = "#f7f6fb";
const PL_HAIR = "#ecebf3";
const PL_LOGO_POS =
  "https://res.cloudinary.com/dl6yhrcx0/image/upload/f_png,h_120/Ninja_POS_Dark_majzi0";
const PL_MAX_LINES = 12;

function plEscape(s: string): string {
  return String(s ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/\u2014/g, "-");
}

function plHex(v: string): string {
  return /^#[0-9a-fA-F]{6}$/.test(v) ? v.toLowerCase() : "#ff5a1f";
}

function plInk(bg: string): string {
  const n = parseInt(bg.slice(1), 16);
  const ch = [(n >> 16) & 255, (n >> 8) & 255, n & 255].map((v) => {
    const c = v / 255;
    return c <= 0.03928 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4);
  });
  const lum = 0.2126 * ch[0]! + 0.7152 * ch[1]! + 0.0722 * ch[2]!;
  return lum > 0.45 ? PL_INK : "#ffffff";
}

/** Sólo links https para el botón (nunca javascript: ni data:). */
function plSafeUrl(u: string): string {
  return /^https:\/\/[^\s"'<>]+$/i.test(u) ? u : "";
}

function buildPaymentLinkEmailHtml(i: PaymentLinkEmailInput): string {
  const accent = plHex(i.accent);
  const onAccent = plInk(accent);
  const name = plEscape(i.businessName || "Tu comercio");
  const logo = plSafeUrl(i.logoUrl);
  const url = plSafeUrl(i.payUrl);
  const hello = i.customerName ? `Hola ${plEscape(i.customerName.split(" ")[0] ?? "")},` : "Hola,";
  const brand = logo
    ? `<img src="${plEscape(logo)}" alt="${name}" height="52" style="display:block;margin:0 auto;height:52px;width:auto;max-width:220px;border:0" />`
    : `<table role="presentation" cellpadding="0" cellspacing="0" border="0" align="center"><tr>` +
      `<td width="56" height="56" align="center" valign="middle" bgcolor="${accent}" style="width:56px;height:56px;border-radius:50%;background:${accent};font-size:24px;line-height:56px;font-weight:800;color:${onAccent};text-align:center">${plEscape((i.businessName || "N").trim().charAt(0).toUpperCase())}</td>` +
      `</tr></table>`;
  const shown = i.lines.slice(0, PL_MAX_LINES);
  const more = i.lines.length - shown.length;
  const rows = shown
    .map(
      (l, idx) =>
        `<tr>` +
        `<td style="padding:10px 18px;${idx ? `border-top:1px solid ${PL_HAIR};` : ""}font-size:14px;line-height:20px;color:${PL_INK}">${plEscape(l.name)}${l.quantity !== 1 ? ` <span style="color:${PL_MUTED}">x ${plEscape(String(l.quantity))}</span>` : ""}</td>` +
        `<td align="right" style="padding:10px 18px;${idx ? `border-top:1px solid ${PL_HAIR};` : ""}font-size:14px;line-height:20px;font-weight:600;color:${PL_INK};white-space:nowrap">${plEscape(l.subtotalLabel)}</td>` +
        `</tr>`,
    )
    .join("");
  const moreRow = more > 0
    ? `<tr><td colspan="2" style="padding:10px 18px;border-top:1px solid ${PL_HAIR};font-size:13px;color:${PL_MUTED}">Y ${more} producto${more === 1 ? "" : "s"} más</td></tr>`
    : "";
  const detail = shown.length
    ? `<tr><td style="padding:0 36px 8px"><table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" bgcolor="${PL_SOFT}" style="background:${PL_SOFT};border-radius:14px">${rows}${moreRow}</table></td></tr>`
    : "";
  const button = url
    ? `<table role="presentation" cellpadding="0" cellspacing="0" border="0" align="center"><tr>` +
      `<td align="center" bgcolor="${accent}" style="border-radius:999px;background:${accent}">` +
      `<a href="${plEscape(url)}" target="_blank" style="display:inline-block;padding:16px 40px;font-family:${PL_FONT};font-size:16px;font-weight:700;line-height:20px;color:${onAccent};text-decoration:none;border-radius:999px">Pagar ahora</a>` +
      `</td></tr></table>` +
      `<p style="margin:14px 0 0;font-size:12px;line-height:1.5;color:${PL_MUTED};word-break:break-all">Si el botón no funciona, copiá este link: <a href="${plEscape(url)}" target="_blank" style="color:${PL_INK}">${plEscape(url)}</a></p>`
    : "";
  const note = i.note
    ? `<p style="margin:0 0 18px;white-space:pre-wrap;font-size:14px;line-height:1.6;color:${PL_MUTED};text-align:center">${plEscape(i.note)}</p>`
    : "";
  const via = i.providerName ? ` con ${plEscape(i.providerName)}` : "";
  return (
    `<!doctype html>` +
    `<html lang="es"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="color-scheme" content="light only"><meta name="supported-color-schemes" content="light"><title>${name}</title></head>` +
    `<body style="margin:0;padding:0;background:${PL_PAGE};-webkit-font-smoothing:antialiased">` +
    `<div style="display:none;max-height:0;overflow:hidden;opacity:0;color:transparent;mso-hide:all">Tu link de pago de ${name} por ${plEscape(i.amountLabel)}.</div>` +
    `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" bgcolor="${PL_PAGE}" style="background:${PL_PAGE}"><tr><td align="center" style="padding:28px 12px 40px">` +
    `<table role="presentation" width="560" cellpadding="0" cellspacing="0" border="0" bgcolor="#ffffff" style="max-width:560px;width:100%;font-family:${PL_FONT};background:#ffffff;border-radius:20px">` +
    `<tr><td height="6" bgcolor="${accent}" style="height:6px;line-height:6px;font-size:6px;background:${accent};border-radius:20px 20px 0 0">&nbsp;</td></tr>` +
    `<tr><td align="center" style="padding:36px 36px 8px;text-align:center">${brand}` +
    `<p style="margin:14px 0 0;font-size:15px;line-height:20px;font-weight:700;color:${PL_INK}">${name}</p></td></tr>` +
    `<tr><td align="center" style="padding:18px 36px 6px;text-align:center">` +
    `<p style="margin:0 0 8px;font-size:12px;line-height:16px;font-weight:700;letter-spacing:1.4px;text-transform:uppercase;color:${accent === "#ffffff" ? PL_INK : accent}">Link de pago</p>` +
    `<p style="margin:0 0 6px;font-size:16px;line-height:1.6;color:${PL_MUTED}">${hello} podés pagar tu compra${via} desde este link.</p>` +
    `<p style="margin:6px 0 18px;font-size:40px;line-height:1.1;font-weight:800;letter-spacing:-0.5px;color:${PL_INK}">${plEscape(i.amountLabel)}</p>` +
    `</td></tr>` +
    detail +
    `<tr><td align="center" style="padding:22px 36px 36px;text-align:center">` +
    note +
    button +
    (i.expiresLabel
      ? `<p style="margin:18px 0 0;font-size:13px;line-height:1.5;color:${PL_MUTED}">${plEscape(i.expiresLabel)}</p>`
      : "") +
    `</td></tr>` +
    `</table>` +
    `<table role="presentation" width="560" cellpadding="0" cellspacing="0" border="0" style="max-width:560px;width:100%;font-family:${PL_FONT}"><tr><td align="center" style="padding:24px 0 0;text-align:center">` +
    `<p style="margin:0 0 8px;font-size:12px;line-height:1.5;color:${PL_MUTED}">Si no hiciste esta compra, ignorá este email.</p>` +
    `<img src="${PL_LOGO_POS}" alt="NinjaPOS" height="20" style="display:block;margin:0 auto;height:20px;border:0" />` +
    `<p style="margin:6px 0 0;font-size:11px;line-height:1.5;color:#9ca3af">Enviado con NinjaPos</p>` +
    `</td></tr></table>` +
    `</td></tr></table></body></html>`
  );
}
// </payment-link-template>

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });
  if (req.method !== "POST") return json({ error: "method_not_allowed" }, 405);
  try {
    const url = Deno.env.get("SUPABASE_URL")!;
    const serviceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
    const anonKey = Deno.env.get("SUPABASE_ANON_KEY")!;

    const userClient = createClient(url, anonKey, {
      global: { headers: { Authorization: req.headers.get("Authorization") ?? "" } },
      auth: { persistSession: false },
    });
    const [{ data: { user }, error }, b] = await Promise.all([
      userClient.auth.getUser(),
      req.json().catch(() => null) as Promise<{ pending_charge_id?: string; to?: string; note?: string } | null>,
    ]);
    if (error || !user) return json({ error: "unauthorized" }, 401);
    const tenantId = (user.app_metadata as { current_tenant_id?: string } | null)?.current_tenant_id;
    if (!tenantId) return json({ error: "no_tenant" }, 400);
    if (!b) return json({ error: "invalid_json" }, 400);

    const chargeId = String(b.pending_charge_id ?? "").trim();
    const to = String(b.to ?? "").trim().toLowerCase();
    // deno-lint-ignore no-control-regex
    const note = String(b.note ?? "").replace(/[\x00-\x08\x0b-\x1f\x7f]+/g, " ").trim().slice(0, 400);
    if (!/^[0-9a-f-]{36}$/i.test(chargeId)) return json({ error: "invalid_charge" }, 400);
    if (!EMAIL_RE.test(to) || to.length > 200) return json({ error: "invalid_to" }, 400);

    const admin = createClient(url, serviceKey, { auth: { persistSession: false } });
    const hourAgo = new Date(Date.now() - 3600_000).toISOString();

    // Todo lo independiente en paralelo (una ronda a la base).
    const [memRes, chargeRes, featRes, brandRes, tenantRes, sentRes, perChargeRes] = await Promise.all([
      admin.from("tenant_users").select("role").eq("tenant_id", tenantId).eq("user_id", user.id)
        .eq("status", "active").maybeSingle(),
      admin.from("pending_charges")
        .select("id, tenant_id, store_id, status, expires_at, share_url, amount, provider_key, customer_name, customer_email, lines, shared_via, share_count")
        .eq("id", chargeId).eq("tenant_id", tenantId).is("deleted_at", null).maybeSingle(),
      admin.rpc("tenant_has_feature_for", { p_tenant: tenantId, p_key: "cobros_en_espera" }),
      admin.from("tenant_branding").select("legal_name, logo_url, accent").eq("tenant_id", tenantId).maybeSingle(),
      admin.from("tenants").select("name").eq("id", tenantId).maybeSingle(),
      admin.from("system_emails").select("id", { count: "exact", head: true })
        .eq("tenant_id", tenantId).eq("kind", "payment_link").gte("created_at", hourAgo),
      admin.from("pending_charge_events").select("id", { count: "exact", head: true })
        .eq("pending_charge_id", chargeId).eq("kind", "shared").eq("data->>via", "email"),
    ]);

    const mem = memRes.data as { role: string } | null;
    if (!mem) return json({ error: "forbidden" }, 403);
    if (featRes.data !== true) return json({ error: "feature_not_in_plan" }, 403);
    const c = chargeRes.data as {
      id: string;
      store_id: string;
      status: string;
      expires_at: string;
      share_url: string | null;
      amount: number;
      provider_key: string;
      customer_name: string | null;
      customer_email: string | null;
      lines: { name: string; quantity: number; subtotal: number }[] | null;
      shared_via: string[] | null;
      share_count: number;
    } | null;
    if (!c) return json({ error: "pending_charge_not_found" }, 404);

    const { data: allowed } = await admin.rpc("staff_allowed_store_ids", {
      p_tenant: tenantId,
      p_user: user.id,
      p_profile: null,
      p_role: mem.role,
      p_on: null,
    });
    if (!Array.isArray(allowed) || !allowed.includes(c.store_id)) {
      return json({ error: "store_not_allowed" }, 403);
    }
    if (c.status !== "waiting" || Date.parse(c.expires_at) <= Date.now()) {
      return json({ error: "not_waiting" }, 409);
    }
    const payUrl = plSafeUrl(c.share_url ?? "");
    if (!payUrl) return json({ error: "no_link" }, 409);
    if ((sentRes.count ?? 0) >= MAX_PER_HOUR) return json({ error: "rate_limited" }, 429);
    if ((perChargeRes.count ?? 0) >= MAX_PER_CHARGE) return json({ error: "rate_limited" }, 429);

    const brand = brandRes.data as { legal_name?: string | null; logo_url?: string | null; accent?: string | null } | null;
    // ADR-124: nombre de fantasía → nombre de la cuenta → razón social.
    const tradeName = await fetchTradeName(admin, tenantId);
    const businessName = businessDisplayName({
      tradeName,
      tenantName: (tenantRes.data as { name?: string } | null)?.name,
      legalName: brand?.legal_name,
    })
      // deno-lint-ignore no-control-regex
      .replace(/[\x00-\x1f\x7f]+/g, " ")
      .trim()
      .slice(0, 80);
    const amountLabel = money(Number(c.amount));
    const html = buildPaymentLinkEmailHtml({
      businessName,
      logoUrl: String(brand?.logo_url ?? ""),
      accent: String(brand?.accent ?? ""),
      customerName: c.customer_name ?? "",
      amountLabel,
      payUrl,
      expiresLabel: expiresText(c.expires_at),
      providerName: PROVIDER_NAME[c.provider_key] ?? "",
      lines: (c.lines ?? []).map((l) => ({
        name: String(l.name ?? ""),
        quantity: Number(l.quantity) || 1,
        subtotalLabel: money(Number(l.subtotal) || 0),
      })),
      note,
    });
    const subject = businessName
      ? `Tu link de pago de ${businessName} por ${amountLabel}`
      : `Tu link de pago por ${amountLabel}`;

    let logId: string | null = null;
    try {
      const { data: logRow } = await admin
        .from("system_emails")
        .insert({ tenant_id: tenantId, recipient: to, subject, kind: "payment_link", status: "pending" })
        .select("id")
        .single();
      logId = (logRow as { id: string } | null)?.id ?? null;
    } catch (_) {
      /* bitácora best-effort */
    }

    const res = await sendWithChain(admin, { to, subject, html });
    if (!res.providerUsed) {
      if (logId) {
        await admin
          .from("system_emails")
          .update({ status: "failed", error_message: (res.lastError || "no_provider").slice(0, 500) })
          .eq("id", logId);
      }
      return json({ error: res.noProvider ? "no_email_provider" : "send_failed", detail: res.lastError }, 502);
    }
    if (logId) {
      await admin.from("system_emails").update({ status: "sent", sent_at: new Date().toISOString() }).eq("id", logId);
    }

    const via = new Set(c.shared_via ?? []);
    via.add("email");
    await Promise.all([
      admin
        .from("pending_charges")
        .update({
          shared_via: [...via],
          share_count: (c.share_count ?? 0) + 1,
          ...(c.customer_email ? {} : { customer_email: to }),
        })
        .eq("id", c.id),
      admin.from("pending_charge_events").insert({
        tenant_id: tenantId,
        pending_charge_id: c.id,
        kind: "shared",
        data: { via: "email", to, provider: res.providerUsed },
        actor_user_id: user.id,
      }),
      admin.from("audit_logs").insert({
        tenant_id: tenantId,
        actor_user_id: user.id,
        entity_type: "pending_charges",
        entity_id: c.id,
        action: "pending_charge_emailed",
        after_data: { to },
      }),
    ]);
    return json({ ok: true });
  } catch (e) {
    return json({ error: "internal", detail: String(e) }, 500);
  }
});
