// @vitest-environment node
// ADR-145: configuración de la facturación de Mercado Libre más clara.
// Plantillas con variables (percepción, mensaje al facturar, leyenda), venta
// de ejemplo de la vista previa, sucursal y depósito por tipo de envío y el
// worker que arma la leyenda y avisa al comprador después de subir la factura
// (con un cliente falso: nunca se manda un mensaje real).
import { describe, it, expect } from "vitest";
import {
  DEFAULT_INVOICE_MESSAGE,
  DEFAULT_INVOICE_NOTES,
  DEFAULT_PERCEPTION_MESSAGE,
  TEMPLATE_VARS,
  dateAr,
  effectiveTemplate,
  exampleVars,
  invoiceMessageTexts,
  invoiceNotesText,
  logisticStoresFrom,
  moneyAr,
  renderTemplate,
  resolveLogisticStore,
  trimKeepingLink,
  unknownVars,
} from "@/supabase/functions/_shared/mercadolibre/billingConfig";
import { DEFAULT_PLAN_SETTINGS, buildInvoicePlan, perceptionMessage } from "@/supabase/functions/_shared/mercadolibre/invoicePlan";
import { perceptionTexts } from "@/supabase/functions/_shared/mercadolibre/perceptionLink";
import { wrapText } from "@/supabase/functions/_shared/mercadolibre/invoicePdf";
import { processJob, type JobDeps } from "@/supabase/functions/_shared/mercadolibre/worker";
import { MlApiError, type MlClient } from "@/supabase/functions/_shared/mercadolibre/client";
import { COUPON_MODES, SAMPLE_DEFAULT, previewPtoVta, sampleInvoiceInput } from "@/lib/mercadolibre/billing";

const S1 = "11111111-1111-4111-8111-111111111111";
const S2 = "22222222-2222-4222-8222-222222222222";
const W2 = "33333333-3333-4333-8333-333333333333";
const LINK = "https://www.mercadopago.com.ar/checkout/v1/redirect?pref_id=123456789-0a1b2c3d-4e5f-6a7b-8c9d-0e1f2a3b4c5d";

describe("plantillas", () => {
  it("reemplaza las variables conocidas y deja a la vista las que no existen", () => {
    expect(renderTemplate("Hola {comprador}, venta #{venta} {otra}", { comprador: "Ana", venta: "123" })).toBe("Hola Ana, venta #123 {otra}");
    expect(renderTemplate("Hola {comprador}, listo", { comprador: "" })).toBe("Hola, listo");
    expect(unknownVars("invoice_message", "Hola {comprador} {monto} {link}")).toEqual(["monto", "link"]);
    expect(unknownVars("perception", "Hola {nombre} {monto} {link}")).toEqual([]);
  });

  it("vacío = el ejemplo precargado; el ejemplo no nombra a nadie y usa variables", () => {
    expect(effectiveTemplate("perception", null)).toBe(DEFAULT_PERCEPTION_MESSAGE);
    expect(effectiveTemplate("invoice_message", "  ")).toBe(DEFAULT_INVOICE_MESSAGE);
    expect(effectiveTemplate("invoice_notes", "Mío {venta}")).toBe("Mío {venta}");
    for (const t of [DEFAULT_PERCEPTION_MESSAGE, DEFAULT_INVOICE_MESSAGE, DEFAULT_INVOICE_NOTES]) {
      expect(t).not.toMatch(/andesmar/i);
      expect(t).not.toContain("—");
    }
    expect(DEFAULT_PERCEPTION_MESSAGE).toContain("{comprador}");
    expect(DEFAULT_PERCEPTION_MESSAGE).toContain("{monto}");
    expect(DEFAULT_PERCEPTION_MESSAGE).toContain("{link}");
    expect(DEFAULT_PERCEPTION_MESSAGE).toContain("{jurisdiccion}");
    for (const kind of ["perception", "invoice_message", "invoice_notes"] as const) {
      expect(unknownVars(kind, effectiveTemplate(kind, null))).toEqual([]);
      expect(TEMPLATE_VARS[kind].length).toBeGreaterThan(2);
    }
  });

  it("el mensaje de la percepción de ejemplo entra en 350 caracteres con el link completo", () => {
    const t = perceptionTexts({
      template: null, buyer: "Maximiliano", amount: 123456.78, link: LINK, days: 3, packKey: "2000012345678901",
      lines: [{ jurisdiction: "902", effective_rate: 3 }, { jurisdiction: "922", effective_rate: 1.5 }],
    });
    expect(t.full.length).toBeLessThanOrEqual(350);
    expect(t.short).toBe(t.full);
    expect(t.full).toContain(LINK);
    expect(t.full).toContain("Hola Maximiliano");
    expect(t.full).toContain("Buenos Aires y Santiago del Estero");
    expect(t.full).toContain("$ 123.456,78");
    // La vista previa de la pantalla da lo mismo que el servidor con la venta de ejemplo.
    const ex = renderTemplate(DEFAULT_PERCEPTION_MESSAGE, exampleVars("perception"));
    expect(ex.length).toBeLessThanOrEqual(350);
    // Compatibilidad: {nombre} y {detalle} siguen funcionando; {venta} es el pack.
    const old = perceptionTexts({ template: "Hola {nombre} ({detalle}) #{venta}: {link}", buyer: "Ana", amount: 1, link: LINK, days: 2, packKey: "99", lines: [{ jurisdiction: "901", effective_rate: 1 }] });
    expect(old.full).toBe(`Hola Ana (CABA 1 %) #99: ${LINK}`);
  });

  it("el texto por defecto del armado (sin imports) es el mismo ejemplo", () => {
    const viaPlan = perceptionMessage(null, { nombre: "Ana", monto: 10, link: LINK, dias: 3, detalle: "CABA 1 %", jurisdiccion: "CABA", venta: "1" });
    expect(viaPlan).toBe(renderTemplate(DEFAULT_PERCEPTION_MESSAGE, { comprador: "Ana", monto: "$ 10,00", link: LINK, jurisdiccion: "CABA" }));
  });

  it("mensaje al facturar: completo y versión de 350 sin cortar el link", () => {
    const t = invoiceMessageTexts(null, { comprador: "Ana", factura: "A 00004-00000123", total: moneyAr(126875), venta: "2000012345678901", fecha: dateAr("2026-10-15") });
    expect(t.full).toBe("Hola Ana, ya está tu factura A 00004-00000123 por $ 126.875,00 de la compra #2000012345678901. La descargás desde el detalle de la compra en Mercado Libre. ¡Gracias por elegirnos!");
    const long = invoiceMessageTexts(`${"x".repeat(400)} ${LINK}`, {});
    expect(long.short.length).toBeLessThanOrEqual(350);
    expect(long.short).toContain(LINK);
    expect(trimKeepingLink("abc", 10)).toBe("abc");
  });

  it("leyenda: una línea de hasta 240 caracteres", () => {
    expect(invoiceNotesText(null, { venta: "200" })).toBe("Venta en Mercado Libre #200. Gracias por tu compra.");
    expect(invoiceNotesText("a\n\nb {venta}", { venta: "1" })).toBe("a b 1");
    expect(invoiceNotesText("y".repeat(400), {}).length).toBe(240);
  });

  it("PDF: la leyenda se parte en renglones sin perder palabras", () => {
    expect(wrapText("uno dos tres cuatro", 8, 3)).toEqual(["uno dos", "tres", "cuatro"]);
    const w = wrapText("aaa bbb ccc ddd eee", 7, 2);
    expect(w).toHaveLength(2);
    expect(w[1]!.length).toBeLessThanOrEqual(7);
  });

  it("formatos de fecha y plata", () => {
    expect(dateAr("2026-10-15T03:00:00Z")).toBe("15/10/2026");
    expect(dateAr(null)).toBe("");
    expect(moneyAr(-1234.5)).toBe("-$ 1.234,50");
  });
});

describe("sucursal y depósito por tipo de envío", () => {
  const account = { store_id: S1, warehouse_id: null };

  it("normaliza lo guardado: claves e ids válidos, Full sin depósito", () => {
    expect(
      logisticStoresFrom({ me2: { store_id: S2, warehouse_id: W2 }, full: { store_id: S2, warehouse_id: W2 }, drone: { store_id: S2 }, flex: { store_id: "x" } }),
    ).toEqual({ me2: { store_id: S2, warehouse_id: W2 }, full: { store_id: S2, warehouse_id: null } });
    expect(logisticStoresFrom(null)).toEqual({});
    expect(logisticStoresFrom([1])).toEqual({});
  });

  it("la regla del tipo, si no la por defecto, si no la de la cuenta (mismo orden que el SQL)", () => {
    const rules = logisticStoresFrom({ me2: { store_id: S2, warehouse_id: W2 }, full: { store_id: S2 } });
    expect(resolveLogisticStore(rules, "me2", account)).toEqual({ store_id: S2, warehouse_id: W2, source: "logistic", full_stock: false });
    expect(resolveLogisticStore(rules, "full", account)).toEqual({ store_id: S2, warehouse_id: null, source: "logistic", full_stock: true });
    expect(resolveLogisticStore(rules, "flex", account)).toEqual({ store_id: S1, warehouse_id: null, source: "account", full_stock: false });
    const withDefault = { ...rules, default: { store_id: S2, warehouse_id: null } };
    expect(resolveLogisticStore(withDefault, "me1", account).source).toBe("default");
    expect(resolveLogisticStore(withDefault, "full", { store_id: S1, warehouse_id: W2 }).warehouse_id).toBeNull();
  });

  it("punto de venta de la vista previa: el de la sucursal de la regla manda sobre el de la cuenta", () => {
    const stores = [{ id: S1, name: "Central", pto_vta: 1 }, { id: S2, name: "Norte", pto_vta: 7 }];
    const rules = logisticStoresFrom({ me2: { store_id: S2 } });
    expect(previewPtoVta({ logistic: "me2", rules, accountStore: account, accountPtoVta: 9, stores })).toEqual({ pto_vta: 7, store: "Norte", source: "logistic" });
    expect(previewPtoVta({ logistic: "flex", rules, accountStore: account, accountPtoVta: 9, stores })).toEqual({ pto_vta: 9, store: "Central", source: "account" });
    expect(previewPtoVta({ logistic: "flex", rules, accountStore: account, accountPtoVta: null, stores }).pto_vta).toBe(1);
  });
});

describe("venta de ejemplo de la vista previa", () => {
  const emitter = { iva_condition: "responsable_inscripto", issues_m: false };
  const rule = { jurisdiction: "902", enabled: true, rate_source: "padron" as const, rate: null, base_pct: 100, min_base: 0, min_amount: 0, conditions: ["responsable_inscripto"], base: "neto" as const, base_exempt: "total" as const, without_padron: false };

  it("cupón como renglón, envío pagado y factura A a una empresa", () => {
    const plan = buildInvoicePlan(sampleInvoiceInput(DEFAULT_PLAN_SETTINGS, emitter, SAMPLE_DEFAULT, false));
    expect(plan.receptors[plan.choice].letter).toBe("A");
    expect(plan.coupon.discount).toBe(5000);
    expect(plan.shipping.line).toBe(true);
    expect(plan.totals.invoice).toBe(125000 - 5000 + 6875);
    expect(plan.status).toBe("ready");
    expect(plan.warnings).toEqual([]);
  });

  it("se recalcula con cada regla: cupón repartido, sin envío, consumidor final", () => {
    const prorate = buildInvoicePlan(sampleInvoiceInput({ ...DEFAULT_PLAN_SETTINGS, coupon_mode: "prorate", shipping_line: false }, emitter, SAMPLE_DEFAULT, false));
    expect(prorate.coupon.discount).toBe(0);
    expect(prorate.items.reduce((a, i) => a + i.gross, 0)).toBe(120000);
    expect(prorate.shipping.line).toBe(false);
    const cf = buildInvoicePlan(sampleInvoiceInput(DEFAULT_PLAN_SETTINGS, emitter, { ...SAMPLE_DEFAULT, buyer: "cf" }, false));
    expect(cf.receptors[cf.choice].letter).toBe("B");
    const conv = buildInvoicePlan(sampleInvoiceInput(DEFAULT_PLAN_SETTINGS, emitter, { ...SAMPLE_DEFAULT, logistic: "a_convenir" }, false));
    expect(conv.shipping.line).toBe(false);
    expect(conv.warnings).toContain("shipping_a_convenir");
    expect(COUPON_MODES.map((c) => c.hint).join(" ")).not.toMatch(/andesmar/i);
  });

  it("percepción: link antes de la A con Mercado Envíos y B con Full", () => {
    const s = { ...DEFAULT_PLAN_SETTINGS, perc_enabled: true, perc_rules: [rule] };
    const me2 = buildInvoicePlan(sampleInvoiceInput(s, emitter, SAMPLE_DEFAULT, true));
    expect(me2.status).toBe("hold_perception");
    expect(me2.perception.total).toBeGreaterThan(0);
    const full = buildInvoicePlan(sampleInvoiceInput(s, emitter, { ...SAMPLE_DEFAULT, logistic: "full" }, true));
    expect(full.choice).toBe("consumidor_final");
    expect(full.perception.strategy).toBe("invoice_b");
    const notAgent = buildInvoicePlan(sampleInvoiceInput(s, emitter, SAMPLE_DEFAULT, false));
    expect(notAgent.perception.applies).toBe(false);
  });
});

describe("worker: leyenda y mensaje al subir la factura", () => {
  const base = {
    emitter: { name: "N", cuit: "30712345671", ivaCondition: "responsable_inscripto", address: null },
    doc: { letter: "A", cbteTipo: 1, label: "FACTURA", ptoVta: 7, nro: 123, fecha: "2026-10-15", cae: "76123456789012", caeVto: "2026-10-25", qrUrl: null, total: 126875, netTaxed: 0, iva: 0, otherTaxes: 0 },
    receptor: { name: "EMPRESA SA", docType: "cuit", docNumber: "30712345671", ivaCondition: "responsable_inscripto", address: null },
    items: [{ description: "X", qty: 1, unitPrice: 126875, subtotal: 126875 }],
    format: "a4" as const,
    notes: "Venta en Mercado Libre 1",
  };
  const pdfText = (b: Uint8Array) => Array.from(b, (c) => String.fromCharCode(c)).join("");

  function deps(data: Record<string, unknown>, post: (path: string, body: unknown) => Promise<unknown>) {
    const rpc: Array<{ fn: string; args: Record<string, unknown> }> = [];
    const posts: Array<{ path: string; body: unknown }> = [];
    let pdf = "";
    const client = {
      post: async (path: string, body: unknown) => {
        posts.push({ path, body });
        return post(path, body);
      },
    } as unknown as MlClient;
    const d: JobDeps = {
      rpc: async (fn, args) => {
        rpc.push({ fn, args });
        return fn === "ml_invoice_pdf_data" ? data : null;
      },
      client: () => client,
      postForm: async (_a, _p, form) => {
        pdf = pdfText(new Uint8Array(await (form.get("fiscal_document") as Blob).arrayBuffer()));
        return { ids: ["DOC1"] };
      },
    };
    return { d, rpc, posts, pdf: () => pdf };
  }
  const job = { id: "j", account_id: "a", tenant_id: "t", kind: "invoice_upload", ref: "P1", payload: { fiscal_document_id: "doc", pack_key: "P1" }, attempts: 1, max_attempts: 8 };
  const message = { template: null, seller_id: 123, buyer_id: 999, vars: { comprador: "Ana", factura: "A 00007-00000123", total: 126875, venta: "P1", fecha: "2026-10-15" } };

  it("sube con la leyenda configurada y después avisa al comprador por la guía de mensajes", async () => {
    const t = deps({ ...base, notes_config: { enabled: true, template: "Leyenda propia #{venta} ({envio})", vars: { venta: "P1", envio: "me2" } }, buyer_message: message }, async () => ({}));
    expect(await processJob(t.d, job)).toEqual({ status: "done" });
    expect(t.pdf()).toContain("Leyenda propia #P1 \\(Mercado Env");
    expect(t.posts).toHaveLength(1);
    expect(t.posts[0]!.path).toBe("/messages/action_guide/packs/P1/option");
    expect((t.posts[0]!.body as { text: string }).text).toContain("A 00007-00000123 por $ 126.875,00");
    const fns = t.rpc.map((c) => c.fn);
    expect(fns.indexOf("ml_invoice_uploaded")).toBeLessThan(fns.indexOf("ml_invoice_message_sent"));
    expect(t.rpc.find((c) => c.fn === "ml_invoice_message_sent")!.args).toEqual({ p_doc: "doc", p_ok: true });
  });

  it("leyenda apagada: el PDF sale sin leyenda; sin mensaje configurado no se manda nada", async () => {
    const t = deps({ ...base, notes_config: { enabled: false, template: null, vars: {} }, buyer_message: null }, async () => ({}));
    expect(await processJob(t.d, job)).toEqual({ status: "done" });
    expect(t.pdf()).not.toContain("Venta en Mercado Libre");
    expect(t.posts).toHaveLength(0);
    expect(t.rpc.some((c) => c.fn === "ml_invoice_message_sent")).toBe(false);
  });

  it("si la guía no deja, va por postventa; si eso también falla, la subida igual queda hecha", async () => {
    const t = deps({ ...base, buyer_message: message }, async (path) => {
      if (path.includes("action_guide")) throw new MlApiError("bad_request", "option not available", 400, false);
      return {};
    });
    expect(await processJob(t.d, job)).toEqual({ status: "done" });
    expect(t.posts.map((p) => p.path)).toEqual(["/messages/action_guide/packs/P1/option", "/messages/packs/P1/sellers/123?tag=post_sale"]);
    expect(t.pdf()).toContain("Venta en Mercado Libre 1");

    const f = deps({ ...base, buyer_message: message }, async () => {
      throw new MlApiError("forbidden", "blocked", 403, false);
    });
    expect(await processJob(f.d, job)).toEqual({ status: "done" });
    expect(f.rpc.find((c) => c.fn === "ml_invoice_uploaded")!.args).toMatchObject({ p_ok: true });
    expect(f.rpc.find((c) => c.fn === "ml_invoice_message_sent")!.args).toMatchObject({ p_ok: false, p_error: "blocked" });
  });
});
