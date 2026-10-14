// ADR-123: presupuestos v2. Email del presupuesto (plantilla en espejo con la
// Edge, reglas de email), destinatarios, plantilla editable, sin vencimiento
// y emisor en el documento.
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { render } from "@testing-library/react";
import { buildQuoteEmailHtml, quoteEmailTextOn } from "@/lib/email/quoteTemplate";
import { QuoteDocument } from "@/components/quotes/QuoteDocument";
import { resolveInvoiceStyle } from "@/lib/invoices/style";
import {
  QUOTE_EMAIL_DEFAULT_MESSAGE,
  QUOTE_EMAIL_DEFAULT_SUBJECT,
  QUOTE_NO_EXPIRY_LEGEND,
  effectiveQuoteStatus,
  fillQuoteTemplate,
  parseEmails,
  quoteEmailVars,
  quoteErrorMessage,
  quoteLegends,
  quoteRecipients,
  quoteShareText,
  quoteToInvoiceDoc,
  quoteValidityText,
  type Quote,
} from "@/lib/quotes/logic";

const ROOT = resolve(__dirname, "../..");
const read = (p: string) => readFileSync(resolve(ROOT, p), "utf8").replace(/\r\n/g, "\n");

const BASE = {
  accent: "#0F766E",
  logoUrl: "",
  businessName: "Laboratorio A",
  numberLabel: "0001-00000012",
  message: "Hola <Ana>,\nTe mandamos el presupuesto.",
  totalText: "$ 36.000,00",
  validityText: "Válido hasta el 29/10/2026",
  issuedBy: "Ana Dueña",
  link: "https://pos.soft.ninja/presupuesto/abc",
  contactText: "Tel. 341 000 · ventas@lab.com",
};

const Q: Quote = {
  id: "q1",
  pto_vta: 1,
  number: 12,
  version: 1,
  status: "draft",
  customer_id: null,
  customer_name: "Frigorífico Sur SA",
  customer_doc: null,
  customer_email: "compras@sur.com",
  customer_phone: null,
  customer_address: null,
  customer_iva: null,
  issue_date: "2026-10-14",
  valid_until: null,
  terms: null,
  notes: null,
  service_from: null,
  service_to: null,
  subtotal: 36000,
  discount_total: 0,
  total: 36000,
  show_signature: false,
  public_token: null,
  sent_at: null,
  accepted_at: null,
  accepted_via: null,
  accepted_by_name: null,
  rejected_at: null,
  rejection_reason: null,
  converted_sale_id: null,
  converted_at: null,
  parent_quote_id: null,
  created_at: "2026-10-14T13:00:00Z",
  updated_at: "2026-10-14T13:00:00Z",
  customer_emails: ["compras@sur.com", "jefe@sur.com"],
  created_by_name: "Ana Dueña",
};

describe("HTML del email del presupuesto", () => {
  it("la copia de la Edge es idéntica a la de lib/", () => {
    const block = (src: string) =>
      src.slice(src.indexOf("// <quote-template>"), src.indexOf("// </quote-template>")).replace(/^export /gm, "");
    const lib = block(read("lib/email/quoteTemplate.ts"));
    const edge = block(read("supabase/functions/_shared/quoteEmailTemplate.ts"));
    expect(lib.length).toBeGreaterThan(1000);
    expect(edge).toBe(lib);
    expect(read("supabase/functions/send_quote_email/index.ts")).toContain('from "../_shared/quoteEmailTemplate.ts"');
  });

  it("documento completo, claro, sin guion largo, sin degradados ni sombras", () => {
    const html = buildQuoteEmailHtml(BASE);
    expect(html.startsWith("<!doctype html>")).toBe(true);
    expect(html).toContain('<meta name="color-scheme" content="light only">');
    expect(html).not.toContain("—");
    expect(html).not.toContain("gradient");
    expect(html).not.toContain("box-shadow");
    expect(html).not.toContain("<style");
    expect(html.toLowerCase()).not.toContain(".webp");
    for (const [, src] of html.matchAll(/<img[^>]+src="([^"]+)"/g)) expect(src!.startsWith("https://")).toBe(true);
  });

  it("número, mensaje escapado, total, validez, emisor, botón y contacto", () => {
    const html = buildQuoteEmailHtml(BASE);
    expect(html).toContain("Presupuesto N° 0001-00000012");
    expect(html).toContain("Hola &lt;Ana&gt;,\nTe mandamos");
    expect(html).not.toContain("<Ana>");
    expect(html).toContain("$ 36.000,00");
    expect(html).toContain("Válido hasta el 29/10/2026");
    expect(html).toContain("Emitido por");
    expect(html).toContain('href="https://pos.soft.ninja/presupuesto/abc"');
    expect(html).toContain("Ver y responder el presupuesto");
    expect(html).toContain("ventas@lab.com");
    expect(html).toContain("adjunto en PDF");
  });

  it("sin logo usa la inicial; link que no es https no lleva botón; acento inválido cae a neutro", () => {
    const html = buildQuoteEmailHtml({ ...BASE, accent: "red", link: "javascript:alert(1)", issuedBy: "" });
    expect(html).toContain(">L</td>");
    expect(html).not.toContain("javascript:");
    expect(html).not.toContain("Ver y responder");
    expect(html).not.toContain("Emitido por");
    expect(html).toContain("#111827");
    expect(quoteEmailTextOn("#ffffff")).toBe("#09051C");
    expect(quoteEmailTextOn("#0f766e")).toBe("#ffffff");
  });
});

describe("destinatarios y plantilla", () => {
  it("separa, normaliza y descarta repetidos e inválidos", () => {
    expect(parseEmails("A@x.com, b@y.com; a@x.com\nmalo  <c@z.ar>")).toEqual({
      valid: ["a@x.com", "b@y.com", "c@z.ar"],
      invalid: ["malo"],
    });
    expect(quoteRecipients(Q)).toEqual(["compras@sur.com", "jefe@sur.com"]);
    expect(quoteRecipients({ customer_email: "Uno@x.com" })).toEqual(["uno@x.com"]);
    expect(quoteRecipients({ customer_email: null })).toEqual([]);
  });

  it("completa asunto y mensaje con los datos del presupuesto", () => {
    const vars = quoteEmailVars(Q, "Laboratorio A");
    expect(fillQuoteTemplate(QUOTE_EMAIL_DEFAULT_SUBJECT, vars)).toBe("Presupuesto N° 0001-00000012 de Laboratorio A");
    const msg = fillQuoteTemplate(QUOTE_EMAIL_DEFAULT_MESSAGE, vars);
    expect(msg.startsWith("Hola Frigorífico Sur SA,")).toBe(true);
    expect(msg).toContain("Precio de referencia, sujeto a cambios.");
    expect(msg).toContain("Ana Dueña\nLaboratorio A");
    expect(msg).not.toMatch(/\{[a-z]+\}/);
  });

  it("sin cliente ni emisor no deja huecos", () => {
    const vars = quoteEmailVars({ ...Q, customer_name: null, created_by_name: null, valid_until: "2026-10-29" }, "Lab");
    const msg = fillQuoteTemplate(QUOTE_EMAIL_DEFAULT_MESSAGE, vars);
    expect(msg.startsWith("Hola,")).toBe(true);
    expect(msg).toContain("Válido hasta el 29/10/2026.");
    expect(msg).toContain("Saludos,\nLab");
    expect(msg).not.toContain("..");
  });

  it("errores del envío en castellano", () => {
    expect(quoteErrorMessage(new Error("quote_email_limit"))).toMatch(/tope/);
    expect(quoteErrorMessage(new Error("quote_email_invalid"))).toMatch(/emails/);
    expect(quoteErrorMessage(new Error("send_failed"))).toMatch(/Configuración/);
  });
});

describe("sin vencimiento y emisor", () => {
  it("nunca pasa a vencido", () => {
    expect(effectiveQuoteStatus("sent", null, "2030-01-01")).toBe("sent");
    expect(effectiveQuoteStatus("sent", "2026-10-01", "2026-10-14")).toBe("expired");
    expect(quoteValidityText(null)).toBe("Precio de referencia, sujeto a cambios");
  });

  it("leyendas: referencia sujeta a cambios y quién emitió", () => {
    expect(quoteLegends(Q)).toEqual([QUOTE_NO_EXPIRY_LEGEND, "Emitido por: Ana Dueña."]);
    expect(quoteShareText(Q, "Lab", null)).toContain("precio de referencia sujeto a cambios");
    const doc = quoteToInvoiceDoc(Q, [], null);
    expect(doc.qrFallbackText).toContain("precio de referencia");
    expect(doc.receiver.email).toBe("compras@sur.com, jefe@sur.com");
  });

  it("el documento lo dice (A4 y ticket)", () => {
    const style = resolveInvoiceStyle({}, { accent: "#0F766E", logo_url: null }, { pro: true, unbranded: true });
    for (const format of ["a4", "80"] as const) {
      const { container, unmount } = render(<QuoteDocument quote={Q} items={[]} brand={null} style={style} format={format} />);
      const text = container.textContent ?? "";
      expect(text).toContain("precios sujetos a cambio sin previo aviso");
      expect(text).toContain("Emitido por: Ana Dueña");
      expect(text).not.toContain("Válido hasta");
      unmount();
    }
  });
});

describe("migración y Edge", () => {
  const sql = read("supabase/migrations/20261121100000_presupuestos_v2.sql");
  it("RLS con initplan, sin escritura directa y cierre sólo para service_role", () => {
    expect(sql).toContain("create policy quote_emails_select on quote_emails\n  for select using (tenant_id = (select current_tenant_id()));");
    expect(sql).toContain("revoke insert, update, delete on quote_emails from anon, authenticated;");
    expect(sql).toContain("revoke all on function quote_email_finish(uuid, jsonb, text) from public, anon, authenticated;");
    expect(sql).toContain("grant execute on function quote_email_finish(uuid, jsonb, text) to service_role;");
    // El pedido de envío pasa por el guard con la feature del plan.
    expect(sql).toMatch(/quote_email_prepare[\s\S]*?v_tenant\s+uuid := _quote_guard\(\);/);
    expect(sql).toMatch(/quote_issuer_report[\s\S]*?tenant_has_feature_for\(v_tenant, 'presupuestos'\)/);
  });
  it("la Edge pide el envío con el JWT del usuario y nunca un mailto", () => {
    const edge = read("supabase/functions/send_quote_email/index.ts");
    expect(edge).toContain('userClient.rpc("quote_email_prepare"');
    expect(edge).toContain('admin.rpc("quote_email_finish"');
    expect(read("components/quotes/QuoteDetailModal.tsx")).not.toContain("mailto");
  });
});
