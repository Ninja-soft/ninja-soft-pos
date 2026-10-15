// ADR-141: armado de la factura de una venta de Mercado Libre (cupones,
// envío, receptor y "contraparte", percepciones por jurisdicción con sus
// reglas), link de pago de la percepción, PDF A4 o ticket y el worker
// (contexto del servidor, plan en la ingesta, reemplazo de la factura subida).
import { describe, it, expect } from "vitest";
import {
  DEFAULT_PLAN_SETTINGS,
  buildInvoicePlan,
  cuitKind,
  cuitValid,
  dniFromCuit,
  jurisdictionOf,
  logisticKind,
  pickPadronEntry,
  planSettingsFrom,
  suggestLetter,
  trimKeepingUrl,
  type PercRule,
  type PlanInput,
  type PlanSettings,
} from "@/supabase/functions/_shared/mercadolibre/invoicePlan";
import { perceptionDetail, perceptionPreference, perceptionTexts } from "@/supabase/functions/_shared/mercadolibre/perceptionLink";
import { buildInvoicePdf } from "@/supabase/functions/_shared/mercadolibre/invoicePdf";
import { ingestOrder, planInputFromPack, processJob, type BillingContext, type JobDeps } from "@/supabase/functions/_shared/mercadolibre/worker";
import { MlApiError, type MlClient } from "@/supabase/functions/_shared/mercadolibre/client";
import { canEmit, effectiveLetter, letterChoices } from "@/lib/mercadolibre/billing";

const cuit = (base10: string) => {
  const w = [5, 4, 3, 2, 7, 6, 5, 4, 3, 2];
  const s = w.reduce((a, x, i) => a + x * Number(base10[i]), 0);
  let v = 11 - (s % 11);
  if (v === 11) v = 0;
  if (v === 10) v = 9;
  return base10 + v;
};
const RI = cuit("3071234567");
const PERSON = cuit("2030123456");
const COMPANY = cuit("3370000001");
const TODAY = "2026-10-15";

const pay = (tx: number, coupon = 0, ship = 0, status = "approved") => ({
  id: String(tx), status, transaction_amount: tx, coupon_amount: coupon, shipping_cost: ship,
});
const line = (title: string, qty: number, unit: number, iva_rate: number | null = 21, item = "MLA100001") => ({
  ml_order_id: "1", ml_item_id: item, ml_variation_id: null, title, seller_sku: null, quantity: qty, unit_price: unit, iva_rate,
});
const settings = (over: Partial<PlanSettings> = {}): PlanSettings => ({ ...DEFAULT_PLAN_SETTINGS, ...over });
const arba = (over: Partial<PercRule> = {}): PercRule => ({
  jurisdiction: "902", enabled: true, rate_source: "padron", rate: null, base_pct: 100, min_base: 3500, min_amount: 0,
  conditions: ["responsable_inscripto", "monotributo", "exento"], base: "neto", base_exempt: "total", without_padron: false, ...over,
});

function input(over: Partial<PlanInput> = {}): PlanInput {
  return {
    orders: [{ ml_order_id: "1", status: "paid", total_amount: 20000, lines: [line("Remera", 2, 10000)], payments: [pay(20000)] }],
    shipment: { mode: "me2", logistic_type: "drop_off", cost: 0, state: "Buenos Aires" },
    billing: { docType: "cuit", docNumber: RI, name: "Juan Comprador", ivaCondition: "responsable_inscripto", address: "Calle 1", state: "Buenos Aires" },
    padron: null,
    iibb: [],
    iibb_loaded: [],
    emitter: { iva_condition: "responsable_inscripto", issues_m: false, cf_id_threshold: 10_000_000, can_perceive: true },
    settings: settings(),
    today: TODAY,
    ...over,
  };
}

describe("utilidades fiscales", () => {
  it("CUIT, tipo de persona y DNI dentro del CUIL", () => {
    expect(cuitValid(RI)).toBe(true);
    expect(cuitValid("30712345670")).toBe(cuitValid("30712345670"));
    expect(cuitValid("123")).toBe(false);
    expect(cuitKind(PERSON)).toBe("person");
    expect(cuitKind(COMPANY)).toBe("company");
    expect(dniFromCuit(PERSON)).toBe("30123456");
    expect(dniFromCuit(RI)).toBeNull();
  });
  it("provincia de ML o de ARCA a jurisdicción", () => {
    expect(jurisdictionOf("Capital Federal")).toBe("901");
    expect(jurisdictionOf("Ciudad Autónoma de Buenos Aires")).toBe("901");
    expect(jurisdictionOf("Buenos Aires")).toBe("902");
    expect(jurisdictionOf("CÓRDOBA")).toBe("904");
    expect(jurisdictionOf("Tierra del Fuego, Antártida e Islas del Atlántico Sur")).toBe("923");
    expect(jurisdictionOf("Marte")).toBeNull();
  });
  it("tipo de envío", () => {
    expect(logisticKind("me2", "fulfillment")).toBe("full");
    expect(logisticKind("me2", "self_service")).toBe("flex");
    expect(logisticKind("me2", "drop_off")).toBe("me2");
    expect(logisticKind("not_specified", null)).toBe("a_convenir");
    expect(logisticKind("custom", null)).toBe("custom");
    expect(logisticKind(null, null)).toBe("none");
  });
  it("letra sugerida (espejo de cbte_letter_infer)", () => {
    const e = { iva_condition: "responsable_inscripto", issues_m: false, cf_id_threshold: null, can_perceive: false };
    expect(suggestLetter(e, "responsable_inscripto")).toBe("A");
    expect(suggestLetter(e, "monotributo")).toBe("A");
    expect(suggestLetter(e, "exento")).toBe("B");
    expect(suggestLetter({ ...e, issues_m: true }, "responsable_inscripto")).toBe("M");
    expect(suggestLetter({ ...e, iva_condition: "monotributo" }, "responsable_inscripto")).toBe("C");
    expect(suggestLetter({ ...e, iva_condition: null }, "consumidor_final")).toBeNull();
  });
});

describe("cupones (contraparte) y envío", () => {
  it("cupón como renglón de descuento y envío pagado por el comprador", () => {
    const p = buildInvoicePlan(input({
      orders: [{ ml_order_id: "1", status: "paid", total_amount: 20000, lines: [line("Remera", 2, 10000)], payments: [pay(20000, 2000, 3000)] }],
      shipment: { mode: "me2", logistic_type: "drop_off", cost: 3000, state: "Buenos Aires" },
    }));
    expect(p.coupon).toEqual({ total: 2000, mode: "discount_line", discount: 2000 });
    expect(p.shipping).toMatchObject({ kind: "buyer_paid", amount: 3000, line: true, label: "Envío" });
    expect(p.totals).toEqual({ items_gross: 20000, discount: 2000, shipping: 3000, invoice: 21000, collected: 21000, diff: 0 });
    expect(p.items[0]).toMatchObject({ unit_price: 10000, gross: 20000 });
    expect(p.status).toBe("ready");
  });

  it("cupón repartido en los precios: el último renglón absorbe el redondeo", () => {
    const p = buildInvoicePlan(input({
      settings: settings({ coupon_mode: "prorate" }),
      orders: [{ ml_order_id: "1", status: "paid", total_amount: 3000, lines: [line("A", 3, 333.33), line("B", 1, 2000.01)], payments: [pay(3000, 100)] }],
    }));
    const sum = p.items.reduce((s, i) => s + i.gross, 0);
    expect(Math.round(sum * 100) / 100).toBe(2900);
    expect(p.items[0]!.unit_price).toBeLessThan(333.33);
    expect(p.items[0]!.list_unit_price).toBe(333.33);
    expect(p.totals.discount).toBe(0);
    expect(p.totals.invoice).toBe(2900);
    expect(p.status).toBe("ready");
  });

  it("cupón sin descontar: avisa y no lo toma como diferencia de cobro", () => {
    const p = buildInvoicePlan(input({
      settings: settings({ coupon_mode: "none" }),
      orders: [{ ml_order_id: "1", status: "paid", total_amount: 20000, lines: [line("Remera", 2, 10000)], payments: [pay(20000, 2000)] }],
    }));
    expect(p.totals.invoice).toBe(20000);
    expect(p.warnings).toContain("coupon_not_deducted");
    expect(p.warnings).not.toContain("paid_mismatch");
  });

  it("envío gratis, a convenir, Full y envío incluido en el pago", () => {
    expect(buildInvoicePlan(input()).shipping.kind).toBe("free");
    const conv = buildInvoicePlan(input({ shipment: { mode: "not_specified", logistic_type: null, cost: 5000, state: null } }));
    expect(conv.shipping).toMatchObject({ kind: "a_convenir", line: false, amount: 0 });
    expect(conv.warnings).toContain("shipping_a_convenir");
    expect(buildInvoicePlan(input({ shipment: { mode: "me2", logistic_type: "fulfillment", cost: 0, state: "Salta" } })).logistic).toBe("full");
    // El pago incluye el envío aunque shipping_cost venga en 0.
    const emb = buildInvoicePlan(input({
      orders: [{ ml_order_id: "1", status: "paid", total_amount: 20000, lines: [line("Remera", 2, 10000)], payments: [pay(23000)] }],
      shipment: { mode: "me1", logistic_type: null, cost: 3000, state: null },
    }));
    expect(emb.shipping).toMatchObject({ kind: "buyer_paid", amount: 3000, line: true });
    expect(emb.totals.invoice).toBe(23000);
  });

  it("sin renglón de envío por regla: lo cobrado sin el envío tiene que cerrar", () => {
    const p = buildInvoicePlan(input({
      settings: settings({ shipping_line: false }),
      orders: [{ ml_order_id: "1", status: "paid", total_amount: 20000, lines: [line("Remera", 2, 10000)], payments: [pay(20000, 0, 3000)] }],
      shipment: { mode: "me2", logistic_type: "drop_off", cost: 3000, state: null },
    }));
    expect(p.totals.invoice).toBe(20000);
    expect(p.warnings).not.toContain("paid_mismatch");
  });

  it("lo cobrado no cierra: a revisar", () => {
    const p = buildInvoicePlan(input({
      orders: [{ ml_order_id: "1", status: "paid", total_amount: 20000, lines: [line("Remera", 2, 10000)], payments: [pay(18000)] }],
    }));
    expect(p.totals.diff).toBe(2000);
    expect(p.warnings).toContain("paid_mismatch");
    expect(p.status).toBe("needs_review");
  });

  it("carrito con una orden cancelada: sólo se factura lo vigente", () => {
    const p = buildInvoicePlan(input({
      orders: [
        { ml_order_id: "1", status: "paid", total_amount: 1000, lines: [line("A", 1, 1000)], payments: [pay(1000)] },
        { ml_order_id: "2", status: "cancelled", total_amount: 500, lines: [{ ...line("B", 1, 500), ml_order_id: "2" }], payments: [pay(500, 0, 0, "refunded")] },
      ],
    }));
    expect(p.items).toHaveLength(1);
    expect(p.totals.invoice).toBe(1000);
    expect(p.status).toBe("ready");
  });
});

describe("receptor: datos del comprador o consumidor final", () => {
  it("CUIT de empresa RI con el padrón de ARCA: factura A con la razón social", () => {
    const p = buildInvoicePlan(input({ padron: { iva_condition: "responsable_inscripto", razon_social: "EMPRESA SA", domicilio: "Av. 1", provincia: "CABA" } }));
    expect(p.receptors.billing).toMatchObject({ name: "EMPRESA SA", doc_type: "cuit", doc_number: RI, iva_condition: "responsable_inscripto", source: "padron", letter: "A", address: "Av. 1" });
    expect(p.receptors.consumidor_final).toMatchObject({ iva_condition: "consumidor_final", letter: "B", source: "cf_generic" });
    expect(p.choice).toBe("billing");
  });

  it("el padrón manda sobre lo que cargó el comprador; sin padrón, la regla de ML", () => {
    const withP = buildInvoicePlan(input({ padron: { iva_condition: "exento", razon_social: "FUNDACION" } }));
    expect(withP.receptors.billing).toMatchObject({ iva_condition: "exento", letter: "B", doc_type: "cuit" });
    const noUse = buildInvoicePlan(input({ settings: settings({ use_padron: false }), padron: { iva_condition: "exento" } }));
    expect(noUse.receptors.billing.iva_condition).toBe("responsable_inscripto");
  });

  it("monotributista: A (matriz de ARCA)", () => {
    const p = buildInvoicePlan(input({ billing: { docType: "cuit", docNumber: RI, name: "Mono", ivaCondition: "monotributo", address: null } }));
    expect(p.receptors.billing.letter).toBe("A");
  });

  it("DNI y CUIL de persona como consumidor final", () => {
    const dni = buildInvoicePlan(input({ billing: { docType: "dni", docNumber: "30.111.222", name: "Ana", ivaCondition: "consumidor_final", address: null } }));
    expect(dni.receptors.billing).toMatchObject({ doc_type: "dni", doc_number: "30111222", letter: "B", source: "cf" });
    const cuil = buildInvoicePlan(input({ billing: { docType: "cuil", docNumber: PERSON, name: "Ana", ivaCondition: "consumidor_final", address: null } }));
    expect(cuil.receptors.billing).toMatchObject({ doc_type: "dni", doc_number: "30123456", letter: "B" });
    expect(cuil.receptors.consumidor_final).toMatchObject({ doc_type: "dni", doc_number: "30123456" });
  });

  it("empresa como consumidor final: sin identificar bajo el tope, a revisar si lo supera", () => {
    const bill = { docType: "cuit" as const, docNumber: COMPANY, name: "SA", ivaCondition: "consumidor_final", address: null };
    const under = buildInvoicePlan(input({ billing: bill }));
    expect(under.receptors.billing).toMatchObject({ source: "cf_generic", doc_number: null, needs_id: false });
    const over = buildInvoicePlan(input({ billing: bill, emitter: { iva_condition: "responsable_inscripto", issues_m: false, cf_id_threshold: 10000, can_perceive: false } }));
    expect(over.warnings).toContain("cf_company_cuit");
    expect(over.status).toBe("needs_review");
  });

  it("consumidor final sin documento por encima del tope de ARCA", () => {
    const p = buildInvoicePlan(input({ billing: null, emitter: { iva_condition: "responsable_inscripto", issues_m: false, cf_id_threshold: 5000, can_perceive: false } }));
    expect(p.receptors.billing.needs_id).toBe(true);
    expect(p.warnings).toContain("cf_identification_required");
    expect(p.status).toBe("needs_review");
  });

  it("CUIT inválido o documento extranjero: consumidor final con aviso", () => {
    expect(buildInvoicePlan(input({ billing: { docType: "cuit", docNumber: "30712345670", name: "X", ivaCondition: "responsable_inscripto", address: null } })).warnings)
      .toContain(cuitValid("30712345670") ? "never" : "invalid_cuit");
    expect(buildInvoicePlan(input({ billing: { docType: "other", docNumber: "AB123", name: "X", ivaCondition: "consumidor_final", address: null } })).warnings).toContain("foreign_document");
  });

  it("siempre consumidor final, emisor monotributista y emisor sin configurar", () => {
    expect(buildInvoicePlan(input({ settings: settings({ receptor_policy: "always_cf" }) })).choice).toBe("consumidor_final");
    const mono = buildInvoicePlan(input({ emitter: { iva_condition: "monotributo", issues_m: false, cf_id_threshold: null, can_perceive: false } }));
    expect(mono.receptors.billing.letter).toBe("C");
    const none = buildInvoicePlan(input({ emitter: { iva_condition: null, issues_m: false, cf_id_threshold: null, can_perceive: false } }));
    expect(none.status).toBe("needs_review");
    expect(none.warnings).toContain("emitter_not_configured");
  });
});

describe("percepciones de IIBB por jurisdicción", () => {
  const period = { valid_from: "2026-10-01", valid_to: "2026-10-31" };
  const perc = (over: Partial<PlanSettings> = {}) => settings({ perc_enabled: true, perc_rules: [arba()], ...over });

  it("ARBA con el padrón: 3 % sobre el neto con IVA ponderado (21 y 10,5)", () => {
    const p = buildInvoicePlan(input({
      settings: perc(),
      orders: [{ ml_order_id: "1", status: "paid", total_amount: 22150, lines: [line("Remera", 1, 12100), line("Libro", 1, 11050, 10.5, "MLA100002")], payments: [pay(23150)] }],
      iibb: [{ jurisdiction: "902", rate: 3, ...period }],
      iibb_loaded: ["902"],
    }));
    expect(p.perception.neto).toBe(20000);
    expect(p.perception.lines).toEqual([{ jurisdiction: "902", rate: 3, base_pct: 100, effective_rate: 3, base: 20000, amount: 600, source: "padron" }]);
    expect(p.perception.total).toBe(600);
    expect(p.perception.strategy).toBe("link");
    expect(p.status).toBe("hold_perception");
  });

  it("base mínima, Convenio Multilateral al 50 % y exento sobre el total", () => {
    const small = buildInvoicePlan(input({
      settings: perc(),
      orders: [{ ml_order_id: "1", status: "paid", total_amount: 3000, lines: [line("X", 1, 3000)], payments: [pay(3000)] }],
      iibb: [{ jurisdiction: "902", rate: 3, ...period }],
    }));
    expect(small.perception.applies).toBe(false);
    expect(small.perception.skipped).toEqual([{ jurisdiction: "902", reason: "min_base" }]);
    const cm = buildInvoicePlan(input({ settings: perc({ perc_rules: [arba({ base_pct: 50 })] }), orders: [{ ml_order_id: "1", status: "paid", total_amount: 12100, lines: [line("R", 1, 12100)], payments: [pay(12100)] }], iibb: [{ jurisdiction: "902", rate: 3, ...period }] }));
    expect(cm.perception.lines[0]).toMatchObject({ effective_rate: 1.5, amount: 150 });
    const ex = buildInvoicePlan(input({
      settings: perc(),
      padron: { iva_condition: "exento" },
      orders: [{ ml_order_id: "1", status: "paid", total_amount: 12100, lines: [line("R", 1, 12100)], payments: [pay(12100)] }],
      iibb: [{ jurisdiction: "902", rate: 3, ...period }],
    }));
    expect(ex.perception.lines[0]).toMatchObject({ base: 12100, amount: 363 });
  });

  it("acumulado suma padrones; destino sólo el de la provincia del envío", () => {
    const rules = [arba({ min_base: 0 }), arba({ jurisdiction: "921", min_base: 0 })];
    const iibb = [{ jurisdiction: "902", rate: 3, ...period }, { jurisdiction: "921", rate: 2, ...period }];
    const base = { orders: [{ ml_order_id: "1", status: "paid", total_amount: 12100, lines: [line("R", 1, 12100)], payments: [pay(12100)] }], iibb };
    const acc = buildInvoicePlan(input({ ...base, settings: perc({ perc_rules: rules }) }));
    expect(acc.perception.total).toBe(500);
    const dest = buildInvoicePlan(input({ ...base, settings: perc({ perc_rules: rules, perc_mode: "destino" }), shipment: { mode: "me2", logistic_type: "drop_off", cost: 0, state: "Santa Fe" } }));
    expect(dest.perception.lines.map((l) => l.jurisdiction)).toEqual(["921"]);
    expect(dest.perception.skipped).toContainEqual({ jurisdiction: "902", reason: "other_destination" });
  });

  it("alícuota fija (Salta) sólo con padrón o si el envío va ahí y la regla lo permite", () => {
    const salta = arba({ jurisdiction: "917", rate_source: "fixed", rate: 3.6, min_base: 1000 });
    const base = { orders: [{ ml_order_id: "1", status: "paid", total_amount: 12100, lines: [line("R", 1, 12100)], payments: [pay(12100)] }] };
    expect(buildInvoicePlan(input({ ...base, settings: perc({ perc_rules: [salta] }) })).perception.applies).toBe(false);
    const there = buildInvoicePlan(input({ ...base, settings: perc({ perc_rules: [{ ...salta, without_padron: true }] }), shipment: { mode: "me2", logistic_type: "drop_off", cost: 0, state: "Salta" } }));
    expect(there.perception.lines[0]).toMatchObject({ jurisdiction: "917", rate: 3.6, amount: 360, source: "fixed" });
  });

  it("padrón vencido: el período actual cargado dice que salió; si no está cargado, el último", () => {
    const old = [{ jurisdiction: "902", rate: 2, valid_from: "2026-09-01", valid_to: "2026-09-30" }];
    expect(pickPadronEntry(old, TODAY, true)).toBeNull();
    expect(pickPadronEntry(old, TODAY, false)?.rate).toBe(2);
    expect(pickPadronEntry([{ jurisdiction: "902", rate: 3, valid_from: "2026-10-01", valid_to: "2026-10-31" }, ...old], TODAY, true)?.rate).toBe(3);
  });

  it("estrategia por envío: Full y Flex facturan B; 'sin percibir' avisa", () => {
    const base = { orders: [{ ml_order_id: "1", status: "paid", total_amount: 12100, lines: [line("R", 1, 12100)], payments: [pay(12100)] }], iibb: [{ jurisdiction: "902", rate: 3, ...period }] };
    const full = buildInvoicePlan(input({ ...base, settings: perc(), shipment: { mode: "me2", logistic_type: "fulfillment", cost: 0, state: "Buenos Aires" } }));
    expect(full.perception.strategy).toBe("invoice_b");
    expect(full.choice).toBe("consumidor_final");
    expect(full.status).toBe("ready");
    const skip = buildInvoicePlan(input({ ...base, settings: perc({ perc_strategy: { ...DEFAULT_PLAN_SETTINGS.perc_strategy, me2: "skip" } }) }));
    expect(skip.warnings).toContain("perception_skipped");
    expect(skip.status).toBe("ready");
  });

  it("no percibe sin ser agente, a consumidor final ni sin CUIT; jurisdicción bloqueada", () => {
    const base = { orders: [{ ml_order_id: "1", status: "paid", total_amount: 12100, lines: [line("R", 1, 12100)], payments: [pay(12100)] }], iibb: [{ jurisdiction: "902", rate: 3, ...period }] };
    expect(buildInvoicePlan(input({ ...base, settings: perc(), emitter: { iva_condition: "responsable_inscripto", issues_m: false, cf_id_threshold: null, can_perceive: false } })).perception.reason).toBe("not_agent");
    expect(buildInvoicePlan(input({ ...base, settings: perc(), billing: { docType: "dni", docNumber: "30111222", name: "A", ivaCondition: "consumidor_final", address: null } })).perception.reason).toBe("no_cuit");
    const tdf = buildInvoicePlan(input({ ...base, settings: perc({ blocked_jurisdictions: ["923"] }), shipment: { mode: "me2", logistic_type: "drop_off", cost: 0, state: "Tierra del Fuego" } }));
    expect(tdf.status).toBe("blocked");
  });
});

describe("configuración guardada", () => {
  it("normaliza valores raros y completa con los de ANDESMAR", () => {
    const s = planSettingsFrom({
      coupon_mode: "x", shipping_label: "  ", perc_mode: "destino", perc_strategy: { full: "link", me2: "nada" },
      perc_rules: [{ jurisdiction: "999" }, { jurisdiction: "902", rate: "2.5", base_pct: 0 }],
    });
    expect(s.coupon_mode).toBe("discount_line");
    expect(s.shipping_label).toBe("Envío");
    expect(s.perc_mode).toBe("destino");
    expect(s.perc_strategy.full).toBe("link");
    expect(s.perc_strategy.me2).toBe("link");
    expect(s.perc_strategy.flex).toBe("invoice_b");
    expect(s.perc_rules).toHaveLength(1);
    expect(s.perc_rules[0]).toMatchObject({ jurisdiction: "902", rate: 2.5, base_pct: 100, rate_source: "padron" });
  });
});

describe("link de pago de la percepción", () => {
  it("preferencia por el monto exacto, referencia al intent y vencimiento", () => {
    const now = new Date("2026-10-15T12:00:00Z");
    const b = perceptionPreference({ amount: 600.004, packKey: "2000000099999", intentId: "int-1", notificationUrl: "https://x/mp_webhook?intent=int-1", days: 3, now });
    expect(b.items).toEqual([{ title: "Percepción IIBB · Venta Mercado Libre #2000000099999", quantity: 1, unit_price: 600, currency_id: "ARS" }]);
    expect(b.external_reference).toBe("int-1");
    expect(b.expiration_date_to).toBe("2026-10-18T12:00:00.000Z");
    expect(b.binary_mode).toBe(true);
  });

  it("mensaje con detalle por jurisdicción, sin cortar la URL en 350 caracteres", () => {
    const link = "https://www.mercadopago.com.ar/checkout/v1/redirect?pref_id=123456789-abcdefgh-ijkl-mnop-qrst-uvwxyz0123456789";
    const t = perceptionTexts({
      template: "Hola {nombre}, " + "x".repeat(400) + " {monto} {link} {detalle} {dias}",
      buyer: "Ana", amount: 1234.5, link, days: 3,
      lines: [{ jurisdiction: "902", effective_rate: 3 }, { jurisdiction: "921", effective_rate: 1.5 }],
    });
    expect(t.short.length).toBeLessThanOrEqual(350);
    expect(t.short).toContain(link);
    expect(t.full).toContain("$ 1.234,50");
    expect(t.full).toContain("Buenos Aires 3 %, Santa Fe 1,5 %");
    expect(perceptionDetail([{ jurisdiction: "901", effective_rate: 1 }])).toBe("CABA 1 %");
    expect(perceptionTexts({ template: null, buyer: "", amount: 10, link, days: 2, lines: [] }).full.startsWith("Hola, para")).toBe(true);
    expect(trimKeepingUrl("abc", 10)).toBe("abc");
  });
});

describe("PDF de la factura de ML", () => {
  const data = (format: "a4" | "ticket") => ({
    emitter: { name: "Ninja SRL", cuit: RI, ivaCondition: "responsable_inscripto", address: "Calle 1" },
    doc: { letter: "A", cbteTipo: 1, label: "FACTURA", ptoVta: 7, nro: 12, fecha: "2026-10-15", cae: "76123456789012", caeVto: "2026-10-25",
      qrUrl: "https://www.afip.gob.ar/fe/qr/?p=eyJ2ZXIiOjF9", total: 21600, netTaxed: 17355.37, iva: 3644.63, otherTaxes: 600 },
    receptor: { name: "EMPRESA SA", docType: "cuit", docNumber: RI, ivaCondition: "responsable_inscripto", address: null },
    items: [{ description: "Remera", qty: 2, unitPrice: 10000, subtotal: 20000 }, { description: "Envío", qty: 1, unitPrice: 3000, subtotal: 3000 }],
    discount: 2000,
    perceptions: [{ name: "Buenos Aires", amount: 600 }],
    format,
  });
  const text = (b: Uint8Array) => Array.from(b, (c) => String.fromCharCode(c)).join("");

  it("ticket de 80 mm con descuento, percepción y QR", () => {
    const pdf = buildInvoicePdf(data("ticket"));
    const s = text(pdf);
    expect(s.startsWith("%PDF-1.4")).toBe(true);
    expect(s).toContain("/MediaBox [0 0 226.77");
    expect(s).toContain("Descuento cup");
    expect(s).toContain("Percepciones \\(Buenos Aires\\)");
    expect(pdf.length).toBeLessThan(1_000_000);
  });

  it("A4 con renglón de descuento y rótulo de percepciones", () => {
    const s = text(buildInvoicePdf(data("a4")));
    expect(s).toContain("/MediaBox [0 0 595.28 841.89]");
    expect(s).toContain("Descuento cup");
    expect(s).toContain("Percepciones \\(Buenos Aires\\):");
  });
});

describe("worker", () => {
  const ctx: BillingContext = {
    enabled: true,
    settings: { coupon_mode: "discount_line" },
    emitter: { iva_condition: "responsable_inscripto", issues_m: false, cf_id_threshold: null, can_perceive: false },
    padron: null,
    iibb: [],
    iibb_loaded: [],
    line_rates: [{ ml_item_id: "MLA100001", ml_variation_id: null, rate: 10.5 }],
    today: TODAY,
  };

  it("entrada del armado con las alícuotas de los productos vinculados", () => {
    const pi = planInputFromPack({
      pack_key: "1", pack_id: null, shipment: null,
      billing: { docType: "cuit", docNumber: RI, name: "X", ivaCondition: "responsable_inscripto", taxpayerRaw: null, address: null, state: "Salta" },
      orders: [{
        ml_order_id: "1", status: "paid", status_detail: null, tags: [], date_created: "", date_closed: null, last_updated: null,
        total_amount: 100, paid_amount: 100, currency: "ARS", fraud_risk: false, cancel_detail: null, buyer: { id: "9", nickname: null },
        shipment_id: null, sale_fee_total: 0, lines: [{ ml_order_id: "1", ml_item_id: "MLA100001", ml_variation_id: null, title: "X", seller_sku: null, quantity: 1, unit_price: 100, sale_fee: 10 }],
        payments: [pay(100)], coupon_amount: 0, shipping_paid: 0,
      }],
    }, ctx);
    expect(pi.orders[0]!.lines[0]!.iva_rate).toBe(10.5);
    expect(pi.billing?.state).toBe("Salta");
    expect(pi.settings.coupon_mode).toBe("discount_line");
  });

  function fakeClient(routes: Record<string, unknown>): MlClient {
    const get = async <T,>(path: string): Promise<T> => {
      const key = Object.keys(routes).find((k) => path.startsWith(k));
      if (!key) throw new MlApiError("not_found", "nf", 404, false);
      return routes[key] as T;
    };
    return { get, request: async () => ({ status: 200, data: null, headers: {} }) as never, post: async () => null as never, put: async () => null as never } as unknown as MlClient;
  }

  it("ingesta: con la facturación pro manda el plan; sin ella, la venta como antes", async () => {
    const order = {
      id: 2000000001, status: "paid", date_created: "2026-10-15T10:00:00Z", total_amount: 20000, paid_amount: 21000,
      buyer: { id: 9, nickname: "COMPRADOR", billing_info: { id: "BI1" } },
      order_items: [{ item: { id: "MLA100001", title: "Remera", variation_id: null }, quantity: 2, unit_price: 10000, sale_fee: 1000 }],
      payments: [{ id: 1, status: "approved", transaction_amount: 20000, coupon_amount: 2000, shipping_cost: 3000 }],
      shipping: { id: 4001 },
    };
    const routes = {
      "/orders/billing-info/MLA/BI1": { buyer: { billing_info: { name: "Juan", identification: { type: "CUIT", number: RI }, taxes: { taxpayer_type: { description: "IVA Responsable Inscripto" } }, address: { state: { name: "Buenos Aires" } } } } },
      "/orders/2000000001": order,
      "/shipments/4001": { id: 4001, status: "ready_to_ship", logistic: { mode: "me2", type: "drop_off" }, lead_time: { cost: 3000 }, destination: { receiver_address: { state: { name: "Buenos Aires" } } } },
    };
    const calls: Array<{ fn: string; args: Record<string, unknown> }> = [];
    const mk = (enabled: boolean): JobDeps => ({
      rpc: async (fn, args) => {
        calls.push({ fn, args });
        if (fn === "ml_billing_context") return enabled ? ctx : { enabled: false };
        return { ok: true, decision: "create_sale" };
      },
      client: () => fakeClient(routes),
      postForm: async () => ({ ids: ["X"] }),
    });
    await ingestOrder(mk(true), "acc", "2000000001");
    const p = calls.find((c) => c.fn === "ml_ingest_pack")!.args.p as { invoice?: { totals: { invoice: number }; receptors: { billing: { letter: string } } }; orders: Array<{ coupon_amount: number; payments: unknown[] }> };
    expect(p.invoice?.totals.invoice).toBe(21000);
    expect(p.invoice?.receptors.billing.letter).toBe("A");
    expect(p.orders[0]!.coupon_amount).toBe(2000);
    expect(p.orders[0]!.payments).toHaveLength(1);
    calls.length = 0;
    await ingestOrder(mk(false), "acc", "2000000001");
    expect((calls.find((c) => c.fn === "ml_ingest_pack")!.args.p as { invoice?: unknown }).invoice).toBeUndefined();
  });

  it("volver a subir: borra el documento anterior y sube el nuevo; si ML ya tiene uno, no reintenta a ciegas", async () => {
    const pdfData = {
      emitter: { name: "N", cuit: RI, ivaCondition: "responsable_inscripto", address: null },
      doc: { letter: "B", cbteTipo: 8, label: "NOTA DE CRÉDITO", ptoVta: 7, nro: 3, fecha: "2026-10-15", cae: "76123456789012", caeVto: "2026-10-25", qrUrl: null, total: 100, netTaxed: 0, iva: 0, otherTaxes: 0 },
      receptor: { name: "CF", docType: null, docNumber: null, ivaCondition: "consumidor_final", address: null },
      items: [{ description: "X", qty: 1, unitPrice: 100, subtotal: 100 }],
      format: "ticket" as const,
    };
    const order: string[] = [];
    const rpcCalls: Array<{ fn: string; args: Record<string, unknown> }> = [];
    let names: string[] = [];
    const d: JobDeps = {
      rpc: async (fn, args) => {
        rpcCalls.push({ fn, args });
        return fn === "ml_invoice_pdf_data" ? pdfData : null;
      },
      client: () => fakeClient({}),
      postForm: async (_a, path, form) => {
        order.push(`POST ${path}`);
        names = [(form.get("fiscal_document") as File).name];
        return { ids: ["NEW"] };
      },
      deleteDoc: async (_a, path) => {
        order.push(`DELETE ${path}`);
        return null;
      },
    };
    const job = { id: "j", account_id: "a", tenant_id: "t", kind: "invoice_upload", ref: "P1", payload: { fiscal_document_id: "doc", pack_key: "P1", replace_ml_id: "OLD" }, attempts: 1, max_attempts: 8 };
    expect(await processJob(d, job)).toEqual({ status: "done" });
    expect(order).toEqual(["DELETE /packs/P1/fiscal_documents/OLD", "POST /packs/P1/fiscal_documents"]);
    expect(names[0]).toBe("nota-credito-B-00007-00000003.pdf");
    d.postForm = async () => {
      throw new MlApiError("bad_request", "fiscal document already exists for pack", 400, false);
    };
    expect(await processJob(d, { ...job, payload: { fiscal_document_id: "doc", pack_key: "P1" } })).toEqual({ status: "done", note: "already_uploaded" });
    expect(rpcCalls.filter((c) => c.fn === "ml_invoice_uploaded").pop()!.args).toMatchObject({ p_ok: false });
  });
});

describe("bandeja (UI)", () => {
  const plan = buildInvoicePlan(input({ padron: { iva_condition: "responsable_inscripto", razon_social: "EMPRESA SA" } }));
  const row = { status: "ready", document: null, plan, choice: "billing" as const, perception_mode: "charge" as const, charge: null, letter: null };

  it("letra efectiva y opciones con la matriz de ARCA", () => {
    expect(effectiveLetter(row)).toBe("A");
    expect(effectiveLetter({ ...row, choice: "consumidor_final" })).toBe("B");
    const opts = letterChoices("responsable_inscripto", plan.receptors.consumidor_final, false);
    expect(opts.find((o) => o.letter === "A")?.allowed).toBe(false);
    expect(opts.find((o) => o.letter === "B")?.allowed).toBe(true);
  });

  it("se puede emitir según el estado y la percepción", () => {
    expect(canEmit(row)).toBe(true);
    expect(canEmit({ ...row, status: "hold_perception" })).toBe(false);
    expect(canEmit({ ...row, status: "hold_perception", charge: { status: "paid" } as never })).toBe(true);
    expect(canEmit({ ...row, status: "hold_perception", choice: "consumidor_final" })).toBe(true);
    expect(canEmit({ ...row, status: "approved" })).toBe(false);
  });
});
