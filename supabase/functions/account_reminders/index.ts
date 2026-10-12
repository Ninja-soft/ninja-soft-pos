// =============================================================================
// Edge Function: account_reminders — recordatorios de cobranza y estado de
// cuenta por email (Cuenta corriente v2 · cc_cobranza).
//
// DOS MODOS:
//   1. Cron (pg_cron + pg_net, diario): header X-Cron-Secret ==
//      platform_secrets('internal_cron').token. Toma los candidatos de
//      account_reminder_candidates() (sólo tenants con cuenta_corriente +
//      cc_cobranza, deduplicados por vencimiento) y envía un recordatorio por
//      cliente y vencimiento con plantilla `account_reminder`.
//   2. Manual: JWT de un miembro activo del tenant del cliente con
//      { customer_id } → envía el estado de cuenta (`account_statement`).
//      Gating: tenant_has_feature_for(cuenta_corriente).
//
// Envío con la infraestructura de email DEL NEGOCIO (tenant_email_smtp: SMTP
// con nodemailer o Resend), igual que send_receipt_email. Cada envío queda en
// system_emails (bitácora) y en account_collection_items (reminder_log con
// dedupe_key, así el cron no repite). Sin email configurado: se registra como
// 'failed' (no reintenta en loop) y se informa.
//
// Deploy: verify_jwt=true (el cron manda el anon key como Bearer para pasar el
// gateway; la autenticación real es el X-Cron-Secret o el JWT del usuario).
// =============================================================================
import { createClient, type SupabaseClient } from "https://esm.sh/@supabase/supabase-js@2.47.10";
// @ts-ignore tipos de nodemailer no resuelven en Deno; mismo patrón que send_receipt_email.
import nodemailer from "npm:nodemailer@6.9.16";

const cors = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type, x-cron-secret",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};
const json = (b: unknown, s = 200) =>
  new Response(JSON.stringify(b), { status: s, headers: { ...cors, "Content-Type": "application/json" } });

// Tope por invocación (evita timeouts del worker; el resto sale al otro día o
// en la próxima corrida porque el dedupe sólo marca lo enviado).
const MAX_SENDS = 60;
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

addEventListener("unhandledrejection", (e) => {
  console.error("unhandledrejection:", (e as PromiseRejectionEvent).reason);
  (e as PromiseRejectionEvent).preventDefault();
});
addEventListener("error", (e) => {
  console.error("uncaught error:", (e as ErrorEvent).message);
  (e as ErrorEvent).preventDefault();
});

function withTimeout<T>(p: Promise<T>, ms: number, label: string): Promise<T> {
  return Promise.race([
    p,
    new Promise<T>((_, rej) => setTimeout(() => rej(new Error(`${label}_timeout`)), ms)),
  ]);
}

const escapeHtml = (s: string) =>
  s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

const ars = (n: number) =>
  new Intl.NumberFormat("es-AR", { style: "currency", currency: "ARS" }).format(Number(n) || 0);

const fmtDate = (iso: string | null) => {
  if (!iso) return "";
  const [y, m, d] = iso.slice(0, 10).split("-");
  return `${d}/${m}/${y}`;
};

// --- Diseño (mismo lenguaje visual que los emails del POS: header con el
// acento del negocio, cuerpo blanco y footer oscuro con NinjaPos) -------------
const NINJA_LOGO_URL = "https://pos.soft.ninja/brand/ninjasoft-wordmark.webp";
const NINJA_LOGO_DARK_URL =
  "https://res.cloudinary.com/dl6yhrcx0/image/upload/f_png,h_120/Ninja_POS_Light_glckmm";

interface Brand {
  name: string;
  accent: string;
  logoHtml: string;
}

function wrap(brand: Brand, inner: string): string {
  return `<div style="font-family:system-ui,Segoe UI,Arial,sans-serif;max-width:520px;margin:0 auto;border:1px solid #e5e7eb;border-radius:12px;overflow:hidden">
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

interface OpenItem {
  id: string;
  kind: string;
  due_date: string | null;
  open_amount: number;
  installment_no: number | null;
  installments: number | null;
}

function itemsTable(items: OpenItem[], today: string): string {
  const rows = items
    .map((it) => {
      const late = it.due_date && it.due_date < today;
      const label =
        it.kind === "interest"
          ? "Punitorio"
          : it.installments
            ? `Cuota ${it.installment_no}/${it.installments}`
            : it.kind === "adjust_debit"
              ? "Ajuste"
              : "Compra";
      return `<tr>
        <td style="padding:6px 8px;border-bottom:1px solid #f1f5f9">${fmtDate(it.due_date)}</td>
        <td style="padding:6px 8px;border-bottom:1px solid #f1f5f9">${label}${late ? ' <span style="color:#b91c1c;font-weight:600">vencido</span>' : ""}</td>
        <td style="padding:6px 8px;border-bottom:1px solid #f1f5f9;text-align:right;white-space:nowrap">${ars(it.open_amount)}</td>
      </tr>`;
    })
    .join("");
  return `<table style="width:100%;border-collapse:collapse;font-size:14px;margin:12px 0">
    <thead><tr style="background:#f8fafc;color:#475569;text-align:left">
      <th style="padding:6px 8px">Vence</th><th style="padding:6px 8px">Concepto</th>
      <th style="padding:6px 8px;text-align:right">Saldo</th></tr></thead>
    <tbody>${rows}</tbody></table>`;
}

// Plantilla account_reminder.
function reminderHtml(
  brand: Brand,
  c: { name: string; kind: "before" | "after"; days: number; due: string; amount: number; balance: number },
): { subject: string; html: string; text: string } {
  const who = escapeHtml(c.name);
  const when =
    c.kind === "before"
      ? `vence el <b>${fmtDate(c.due)}</b> (en ${c.days} día${c.days === 1 ? "" : "s"})`
      : `venció el <b>${fmtDate(c.due)}</b> (hace ${c.days} día${c.days === 1 ? "" : "s"})`;
  const inner = `<p style="margin:0 0 12px">Hola ${who},</p>
  <p style="margin:0 0 12px">Te recordamos que tenés un saldo de <b>${ars(c.amount)}</b> en tu cuenta corriente que ${when}.</p>
  <p style="margin:0 0 12px">Saldo total de tu cuenta: <b>${ars(c.balance)}</b>.</p>
  <p style="margin:0;color:#6b7280;font-size:13px">Si ya lo abonaste, desestimá este mensaje. ¡Gracias!</p>`;
  const subject =
    c.kind === "before"
      ? `Recordatorio: tu saldo vence el ${fmtDate(c.due)} · ${brand.name}`
      : `Tenés un saldo vencido · ${brand.name}`;
  const text = `Hola ${c.name}, tenés un saldo de ${ars(c.amount)} que ${
    c.kind === "before" ? "vence" : "venció"
  } el ${fmtDate(c.due)}. Saldo total: ${ars(c.balance)}.`;
  return { subject, html: wrap(brand, inner), text };
}

// Plantilla account_statement.
function statementHtml(
  brand: Brand,
  c: { name: string; balance: number; overdue: number; items: OpenItem[]; today: string },
): { subject: string; html: string; text: string } {
  const inner = `<p style="margin:0 0 12px">Hola ${escapeHtml(c.name)}, este es el estado de tu cuenta corriente al ${fmtDate(c.today)}.</p>
  <div style="display:flex;gap:8px;margin:0 0 4px">
    <div style="flex:1;background:#f8fafc;border-radius:8px;padding:10px 12px">
      <div style="font-size:12px;color:#64748b">Saldo</div>
      <div style="font-size:18px;font-weight:700">${ars(c.balance)}</div>
    </div>
    <div style="flex:1;background:${c.overdue > 0 ? "#fef2f2" : "#f8fafc"};border-radius:8px;padding:10px 12px">
      <div style="font-size:12px;color:#64748b">Vencido</div>
      <div style="font-size:18px;font-weight:700;color:${c.overdue > 0 ? "#b91c1c" : "#111827"}">${ars(c.overdue)}</div>
    </div>
  </div>
  ${c.items.length > 0 ? itemsTable(c.items, c.today) : '<p style="color:#6b7280">No tenés saldos pendientes.</p>'}
  <p style="margin:12px 0 0;color:#6b7280;font-size:13px">Ante cualquier duda, respondé este email.</p>`;
  return {
    subject: `Estado de cuenta · ${brand.name}`,
    html: wrap(brand, inner),
    text: `Hola ${c.name}, tu saldo es ${ars(c.balance)} (vencido ${ars(c.overdue)}).`,
  };
}

// --- Envío con el proveedor del negocio ---------------------------------------
type TenantMailer = {
  ready: boolean;
  send: (to: string, subject: string, html: string, text: string) => Promise<void>;
  close: () => void;
};

// deno-lint-ignore no-explicit-any
function mailerFor(cfg: any, fromName: string): TenantMailer {
  const provider = String(cfg?.provider ?? "smtp");
  const resendKey = String(cfg?.resend_api_key ?? "");
  const ready =
    provider === "resend" ? !!resendKey && !!cfg?.from_email : !!cfg?.host && !!cfg?.from_email;
  const safeName = fromName.replace(/"/g, "");
  if (!ready) return { ready, send: () => Promise.reject(new Error("tenant_smtp_not_configured")), close: () => {} };

  if (provider === "resend") {
    return {
      ready,
      close: () => {},
      send: async (to, subject, html, text) => {
        const res = await withTimeout(
          fetch("https://api.resend.com/emails", {
            method: "POST",
            headers: { Authorization: `Bearer ${resendKey}`, "Content-Type": "application/json" },
            body: JSON.stringify({ from: `${safeName} <${cfg.from_email}>`, to, subject, html, text }),
          }),
          25000,
          "resend",
        );
        if (!res.ok) throw new Error(`resend_${res.status}: ${(await res.text().catch(() => "")).slice(0, 300)}`);
      },
    };
  }

  const port = cfg.port || 587;
  const transporter = nodemailer.createTransport({
    host: cfg.host,
    port,
    secure: port === 465 ? true : !!cfg.secure,
    auth: cfg.username ? { user: cfg.username, pass: cfg.password } : undefined,
    connectionTimeout: 15000,
    greetingTimeout: 10000,
    socketTimeout: 20000,
  });
  return {
    ready,
    close: () => {
      try {
        transporter.close();
      } catch (_) {
        /* noop */
      }
    },
    send: async (to, subject, html, text) => {
      await withTimeout(
        transporter.sendMail({ from: `"${safeName}" <${cfg.from_email}>`, to, subject, html, text }),
        25000,
        "smtp_send",
      );
    },
  };
}

async function brandFor(admin: SupabaseClient, tenantId: string, cfg: { from_name?: string } | null): Promise<Brand> {
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

async function logEmail(
  admin: SupabaseClient,
  row: { tenant_id: string; recipient: string; subject: string; kind: string; status: string; error?: string },
) {
  try {
    await admin.from("system_emails").insert({
      tenant_id: row.tenant_id,
      recipient: row.recipient,
      subject: row.subject,
      kind: row.kind,
      status: row.status,
      error_message: row.error ?? null,
      sent_at: row.status === "sent" ? new Date().toISOString() : null,
    });
  } catch (_) {
    /* best-effort */
  }
}

function todayAr(): string {
  const p = new Intl.DateTimeFormat("en-CA", {
    timeZone: "America/Argentina/Buenos_Aires",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(new Date());
  return p; // yyyy-mm-dd
}

interface Candidate {
  tenant_id: string;
  customer_id: string;
  customer_name: string;
  email: string;
  kind: "before" | "after";
  days: number;
  due_date: string;
  amount: number;
  balance: number;
  dedupe_key: string;
}

async function runCron(admin: SupabaseClient) {
  const { data, error } = await admin.rpc("account_reminder_candidates", {});
  if (error) return json({ error: "candidates_failed", detail: error.message }, 500);
  const cands = ((data ?? []) as Candidate[]).slice(0, MAX_SENDS);

  // Agrupado por tenant: un mailer y un branding por negocio.
  const byTenant = new Map<string, Candidate[]>();
  for (const c of cands) byTenant.set(c.tenant_id, [...(byTenant.get(c.tenant_id) ?? []), c]);

  let sent = 0;
  let failed = 0;
  for (const [tenantId, list] of byTenant) {
    const { data: cfg } = await admin.from("tenant_email_smtp").select("*").eq("tenant_id", tenantId).maybeSingle();
    const brand = await brandFor(admin, tenantId, cfg);
    const mailer = mailerFor(cfg, brand.name);
    try {
      for (const c of list) {
        const to = String(c.email).trim().toLowerCase();
        const mail = reminderHtml(brand, {
          name: c.customer_name,
          kind: c.kind,
          days: c.days,
          due: c.due_date,
          amount: Number(c.amount),
          balance: Number(c.balance),
        });
        let status = "sent";
        let err: string | undefined;
        if (!EMAIL_RE.test(to)) {
          status = "failed";
          err = "invalid_to";
        } else {
          try {
            await mailer.send(to, mail.subject, mail.html, mail.text);
          } catch (e) {
            status = "failed";
            err = e instanceof Error ? e.message : String(e);
          }
        }
        if (status === "sent") sent++;
        else failed++;
        await logEmail(admin, { tenant_id: tenantId, recipient: to, subject: mail.subject, kind: "account_reminder", status, error: err });
        // Bitácora + dedupe (también si falló: sin email configurado no se reintenta en loop).
        await admin.from("account_collection_items").insert({
          tenant_id: tenantId,
          customer_id: c.customer_id,
          type: "reminder_log",
          channel: "email",
          status,
          body: mail.subject,
          dedupe_key: c.dedupe_key,
          meta: { kind: c.kind, days: c.days, due_date: c.due_date, amount: c.amount, error: err ?? null },
        });
      }
    } finally {
      mailer.close();
    }
  }
  return json({ ok: true, candidates: cands.length, sent, failed });
}

async function runManual(admin: SupabaseClient, req: Request, url: string, anonKey: string) {
  const userClient = createClient(url, anonKey, {
    global: { headers: { Authorization: req.headers.get("Authorization") ?? "" } },
    auth: { persistSession: false },
  });
  const {
    data: { user },
    error,
  } = await userClient.auth.getUser();
  if (error || !user) return json({ error: "unauthorized" }, 401);

  let b: { customer_id?: string; to?: string };
  try {
    b = await req.json();
  } catch {
    return json({ error: "invalid_json" }, 400);
  }
  const customerId = String(b.customer_id ?? "").trim();
  if (!customerId) return json({ error: "missing_customer_id" }, 400);

  const { data: cust } = await admin
    .from("customers")
    .select("id, tenant_id, name, email")
    .eq("id", customerId)
    .maybeSingle();
  if (!cust) return json({ error: "customer_not_found" }, 404);
  const { data: member } = await admin
    .from("tenant_users")
    .select("role")
    .eq("tenant_id", cust.tenant_id)
    .eq("user_id", user.id)
    .eq("status", "active")
    .maybeSingle();
  if (!member || member.role === "viewer") return json({ error: "forbidden" }, 403);
  const { data: allowed } = await admin.rpc("tenant_has_feature_for", {
    p_tenant: cust.tenant_id,
    p_key: "cuenta_corriente",
  });
  if (!allowed) return json({ error: "feature_not_in_plan", feature: "cuenta_corriente" }, 403);

  const to = String(b.to ?? cust.email ?? "").trim().toLowerCase();
  if (!EMAIL_RE.test(to)) return json({ error: "invalid_to" }, 400);

  const today = todayAr();
  const [{ data: items }, { data: balance }] = await Promise.all([
    admin.rpc("account_open_debits", { p_tenant: cust.tenant_id, p_customer: cust.id }),
    admin.rpc("account_balance", { p_customer: cust.id }),
  ]);
  const open = ((items ?? []) as OpenItem[]).sort((a, b) =>
    String(a.due_date ?? "9999").localeCompare(String(b.due_date ?? "9999")),
  );
  const overdue = open.filter((i) => i.due_date && i.due_date < today).reduce((a, i) => a + Number(i.open_amount), 0);

  const { data: cfg } = await admin.from("tenant_email_smtp").select("*").eq("tenant_id", cust.tenant_id).maybeSingle();
  const brand = await brandFor(admin, cust.tenant_id, cfg);
  const mailer = mailerFor(cfg, brand.name);
  if (!mailer.ready) {
    return json(
      { error: "tenant_smtp_not_configured", detail: "Configurá el email de tu negocio en Configuración → Email." },
      400,
    );
  }
  const mail = statementHtml(brand, { name: cust.name, balance: Number(balance ?? 0), overdue, items: open, today });
  try {
    await mailer.send(to, mail.subject, mail.html, mail.text);
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    await logEmail(admin, { tenant_id: cust.tenant_id, recipient: to, subject: mail.subject, kind: "account_statement", status: "failed", error: msg });
    return json({ error: "send_failed", detail: msg }, 502);
  } finally {
    mailer.close();
  }
  await logEmail(admin, { tenant_id: cust.tenant_id, recipient: to, subject: mail.subject, kind: "account_statement", status: "sent" });
  await admin.from("account_collection_items").insert({
    tenant_id: cust.tenant_id,
    customer_id: cust.id,
    type: "reminder_log",
    channel: "email",
    status: "sent",
    body: mail.subject,
    created_by: user.id,
    meta: { kind: "statement", balance, overdue },
  });
  await admin.from("audit_logs").insert({
    tenant_id: cust.tenant_id,
    actor_user_id: user.id,
    entity_type: "customers",
    entity_id: cust.id,
    action: "account_statement_emailed",
    after_data: { to, balance, overdue },
  });
  return json({ ok: true, to });
}

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });
  if (req.method !== "POST") return json({ error: "method_not_allowed" }, 405);
  try {
    const url = Deno.env.get("SUPABASE_URL")!;
    const serviceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
    const anonKey = Deno.env.get("SUPABASE_ANON_KEY")!;
    const admin = createClient(url, serviceKey, { auth: { persistSession: false } });

    const cronSecret = req.headers.get("X-Cron-Secret") ?? "";
    if (cronSecret) {
      const { data: sec } = await admin
        .from("platform_secrets")
        .select("secrets")
        .eq("key", "internal_cron")
        .maybeSingle();
      const token = (sec?.secrets as { token?: string } | null)?.token ?? "";
      if (!token || cronSecret !== token) return json({ error: "forbidden" }, 403);
      return await runCron(admin);
    }
    return await runManual(admin, req, url, anonKey);
  } catch (e) {
    return json({ error: "internal", detail: String(e) }, 500);
  }
});
