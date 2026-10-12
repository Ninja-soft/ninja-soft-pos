// Plantillas de emails de cuenta corriente (account_reminder y
// account_statement) para la VISTA PREVIA de /internal/emails.
//
// ESPEJO de reminderHtml() / statementHtml() / wrap() de la Edge Function
// supabase/functions/account_reminders/index.ts (Deno no importa de lib/): si
// cambia el diseño allá, cambia acá. Estos emails los envía cada negocio con su
// propio email y su marca (header con el acento y el logo del negocio, footer
// oscuro de NinjaPos); no se editan desde internal.

const NINJA_LOGO_URL = "https://pos.soft.ninja/brand/ninjasoft-wordmark.webp";
const NINJA_LOGO_DARK_URL =
  "https://res.cloudinary.com/dl6yhrcx0/image/upload/f_png,h_120/Ninja_POS_Light_glckmm";

export interface AccountEmailBrand {
  name: string;
  accent: string;
  logoUrl?: string | null;
}

export interface AccountEmailItem {
  kind: "charge" | "interest" | "adjust_debit";
  due_date: string | null;
  open_amount: number;
  installment_no: number | null;
  installments: number | null;
}

export interface RenderedEmail {
  subject: string;
  html: string;
  text: string;
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

function logoHtml(brand: AccountEmailBrand): string {
  return brand.logoUrl
    ? `<img src="${escapeHtml(brand.logoUrl)}" alt="${escapeHtml(brand.name)}" style="max-height:48px;display:inline-block">`
    : `<img src="${NINJA_LOGO_URL}" alt="NinjaSoft" style="max-height:32px;display:inline-block">`;
}

function wrap(brand: AccountEmailBrand, inner: string): string {
  return `<div style="font-family:system-ui,Segoe UI,Arial,sans-serif;max-width:520px;margin:0 auto;border:1px solid #e5e7eb;border-radius:12px;overflow:hidden">
  <div style="background:${brand.accent};padding:20px;text-align:center">
    ${logoHtml(brand)}
    <div style="color:#ffffff;font-size:16px;font-weight:bold;margin-top:8px">${escapeHtml(brand.name)}</div>
  </div>
  <div style="padding:24px;color:#111827;line-height:1.55;font-size:15px">${inner}</div>
  <div style="background:#09051C;padding:18px 12px;text-align:center">
    <img src="${NINJA_LOGO_DARK_URL}" alt="NinjaPos" style="max-height:20px;display:inline-block" />
    <div style="color:#9ca3af;font-size:11px;margin-top:8px">Enviado con NinjaPos</div>
  </div>
</div>`;
}

function itemsTable(items: AccountEmailItem[], today: string): string {
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
export function accountReminderEmail(
  brand: AccountEmailBrand,
  c: { name: string; kind: "before" | "after"; days: number; due: string; amount: number; balance: number },
): RenderedEmail {
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
export function accountStatementEmail(
  brand: AccountEmailBrand,
  c: { name: string; balance: number; overdue: number; items: AccountEmailItem[]; today: string },
): RenderedEmail {
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

export interface AccountEmailPreview {
  key: string;
  label: string;
  description: string;
  render: () => RenderedEmail;
}

const SAMPLE_BRAND: AccountEmailBrand = { name: "Almacén Don Pepe", accent: "#f97316", logoUrl: null };

// Vista previa con datos de ejemplo (internal → Emails del sistema).
export const ACCOUNT_EMAIL_PREVIEWS: AccountEmailPreview[] = [
  {
    key: "account_reminder:before",
    label: "Recordatorio de vencimiento",
    description:
      "Cuenta corriente: aviso automático días antes del vencimiento (account_reminder). Lo envía el negocio con su email.",
    render: () =>
      accountReminderEmail(SAMPLE_BRAND, {
        name: "Juan Pérez",
        kind: "before",
        days: 3,
        due: "2026-10-14",
        amount: 25000,
        balance: 48500,
      }),
  },
  {
    key: "account_reminder:after",
    label: "Saldo vencido",
    description:
      "Cuenta corriente: aviso automático después del vencimiento (account_reminder). Lo envía el negocio con su email.",
    render: () =>
      accountReminderEmail(SAMPLE_BRAND, {
        name: "Juan Pérez",
        kind: "after",
        days: 7,
        due: "2026-10-04",
        amount: 25000,
        balance: 48500,
      }),
  },
  {
    key: "account_statement",
    label: "Estado de cuenta",
    description:
      "Cuenta corriente: estado de cuenta que el negocio envía desde la ficha del cliente (account_statement).",
    render: () =>
      accountStatementEmail(SAMPLE_BRAND, {
        name: "Juan Pérez",
        balance: 48500,
        overdue: 26250,
        today: "2026-10-11",
        items: [
          { kind: "charge", due_date: "2026-10-04", open_amount: 25000, installment_no: null, installments: null },
          { kind: "interest", due_date: "2026-10-11", open_amount: 1250, installment_no: null, installments: null },
          { kind: "charge", due_date: "2026-11-04", open_amount: 11125, installment_no: 1, installments: 2 },
          { kind: "charge", due_date: "2026-12-04", open_amount: 11125, installment_no: 2, installments: 2 },
        ],
      }),
  },
];
