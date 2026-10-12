import { describe, expect, it } from "vitest";
import {
  acquirerMerchantNumber,
  acquirerOfProvider,
  availableAcquirers,
  initialAcquirer,
  plansForAcquirer,
  rememberKey,
} from "@/lib/payments/acquirers";
import {
  ACQUIRER_PRESETS,
  LEGACY_RULES,
  applyPreset,
  cardVoucherErrorTitle,
  clearAcquirerField,
  effectiveRules,
  fieldRule,
  nextField,
  parseRules,
  rulesShapeError,
  sanitizeValue,
  setFieldRule,
  shouldAutoAdvance,
  valueError,
  voucherErrors,
  askedFields,
} from "@/lib/payments/voucherRules";
import { afterBrand, afterKind, backStep, ctaNext, initialStep } from "@/lib/pos/posnetWizard";
import { CARD_BRANDS, OTHER_CARD_BRAND } from "@/lib/pos/cardBrands";
import {
  DEFAULT_FILTERS,
  NO_ACQUIRER,
  acquirerOptions,
  filterCardRows,
  normalizeCardPayments,
} from "@/lib/reports/cardReconciliation";

const keys = (l: { key: string }[]) => l.map((a) => a.key);

describe("adquirentes del posnet offline", () => {
  it("ofrece los de las marcas habilitadas (cualquier canal) y Otra al final", () => {
    const list = availableAcquirers([
      { provider_key: "payway", enabled: true },
      { provider_key: "getnet_point", enabled: true },
      { provider_key: "nave", enabled: false },
      { provider_key: "cash", enabled: true },
    ]);
    expect(keys(list)).toEqual(["getnet", "payway", "other"]);
  });

  it("sin marcas habilitadas ofrece todas (nunca bloquea el cobro)", () => {
    expect(keys(availableAcquirers([{ provider_key: "cash", enabled: true }]))).toEqual([
      "getnet",
      "payway",
      "mercadopago",
      "fiserv",
      "nave",
      "other",
    ]);
  });

  it("la lista configurada manda; sin 'other' en la lista, no se suma", () => {
    expect(keys(availableAcquirers([], ["fiserv", "payway"]))).toEqual(["payway", "fiserv"]);
    expect(keys(availableAcquirers([], ["fiserv", "other"]))).toEqual(["fiserv", "other"]);
    // Claves desconocidas se ignoran.
    expect(keys(availableAcquirers([{ provider_key: "nave_point", enabled: true }], ["visa"]))).toEqual(["nave", "other"]);
  });

  it("preselecciona el último de la caja si sigue disponible, o el único", () => {
    const list = availableAcquirers([], ["payway", "getnet"]);
    expect(initialAcquirer(list, "getnet")).toBe("getnet");
    expect(initialAcquirer(list, "nave")).toBeNull();
    expect(initialAcquirer(availableAcquirers([], ["fiserv"]), null)).toBe("fiserv");
    expect(rememberKey("r1")).not.toBe(rememberKey(null));
  });

  it("provider_key → adquirente", () => {
    expect(acquirerOfProvider("payway_point")).toBe("payway");
    expect(acquirerOfProvider("fiserv")).toBe("fiserv");
    expect(acquirerOfProvider("mobbex")).toBeNull();
  });

  it("n° de comercio: el del adquirente elegido, nunca el de otro", () => {
    const providers = [
      { provider_key: "payway", merchant_numbers: { visa: "PW1" } },
      { provider_key: "getnet_point", merchant_numbers: { visa: "GN1", master: "GN2" } },
    ];
    expect(acquirerMerchantNumber(providers, "visa", "payway", null)).toBe("PW1");
    expect(acquirerMerchantNumber(providers, "visa", "getnet", "payway")).toBe("GN1");
    expect(acquirerMerchantNumber(providers, "master", "payway", null)).toBeNull();
    // Otra: la resolución de siempre (plan elegido o único cargado).
    expect(acquirerMerchantNumber(providers, "master", "other", null)).toBe("GN2");
    expect(acquirerMerchantNumber(providers, "visa", "other", "payway")).toBe("PW1");
    expect(acquirerMerchantNumber(providers, "visa", null, null)).toBeNull();
  });

  it("planes: los del adquirente + genéricos; sin planes propios, todos", () => {
    const plans = [
      { id: "a", provider_key: "payway" },
      { id: "b", provider_key: "mercadopago" },
      { id: "c", provider_key: "mobbex" },
    ];
    expect(plansForAcquirer(plans, "payway").map((p) => p.id)).toEqual(["a", "c"]);
    expect(plansForAcquirer(plans, "getnet").map((p) => p.id)).toEqual(["a", "b", "c"]);
    expect(plansForAcquirer(plans, "other").map((p) => p.id)).toEqual(["a", "b", "c"]);
  });
});

describe("reglas del cupón", () => {
  it("sin configurar: lo de siempre (lote, cupón y autorización opcionales, últimos 4 de 4 dígitos)", () => {
    const eff = effectiveRules({}, false, null);
    expect(askedFields(eff)).toEqual(["lote", "cupon", "autorizacion", "ultimos4"]);
    expect(eff.lote.required).toBe(false);
    expect(eff.ultimos4).toEqual(LEGACY_RULES.ultimos4);
    expect(voucherErrors(eff, {})).toEqual({});
    expect(voucherErrors(eff, { ultimos4: "12" })).toEqual({ ultimos4: "length" });
  });

  it("require_card_voucher hace obligatorios cupón, lote y autorización", () => {
    const rules = { fields: { lote: { ask: false } } };
    const eff = effectiveRules(rules, true, null);
    expect(eff.lote).toMatchObject({ ask: true, required: true });
    expect(voucherErrors(eff, { cupon: "1", autorizacion: "A" })).toEqual({ lote: "required" });
  });

  it("excepción por adquirente pisa dato por dato a la general", () => {
    const rules = parseRules({
      fields: { autorizacion: { required: true, type: "alnum", min: 6, max: 6 } },
      by_acquirer: { payway: { lote: { required: true, type: "numeric", min: 3, max: 3 } } },
    });
    expect(fieldRule(rules, false, "payway", "lote")).toMatchObject({ required: true, type: "numeric", min: 3, max: 3 });
    expect(fieldRule(rules, false, "getnet", "lote")).toEqual(LEGACY_RULES.lote);
    expect(fieldRule(rules, false, "payway", "autorizacion")).toMatchObject({ required: true, min: 6 });
    const eff = effectiveRules(rules, false, "payway");
    expect(voucherErrors(eff, { lote: "12", autorizacion: "AB12CD" })).toEqual({ lote: "length" });
    expect(voucherErrors(eff, { lote: "123", autorizacion: "AB12C" })).toEqual({ autorizacion: "length" });
    expect(voucherErrors(eff, { lote: "123", autorizacion: "AB12CD" })).toEqual({});
  });

  it("no pedido = no obligatorio ni validado", () => {
    const r = fieldRule({ fields: { comercio: { ask: false, required: true } } }, false, null, "comercio");
    expect(r.required).toBe(false);
    expect(valueError(r, "")).toBeNull();
  });

  it("valida formato y largo; vacío opcional pasa", () => {
    const num = { ask: true, required: true, type: "numeric" as const, min: 3, max: 3 };
    expect(valueError(num, "")).toBe("required");
    expect(valueError(num, "12a")).toBe("format");
    expect(valueError(num, "1234")).toBe("length");
    expect(valueError(num, "123")).toBeNull();
    expect(valueError({ ...num, required: false }, " ")).toBeNull();
    expect(valueError({ ...num, type: "alnum" }, "A-1")).toBe("format");
  });

  it("limpia lo tipeado según el tipo y el máximo", () => {
    expect(sanitizeValue({ ...LEGACY_RULES.lote, type: "numeric", max: 3 }, "1a2-34")).toBe("123");
    expect(sanitizeValue({ ...LEGACY_RULES.autorizacion, max: 6 }, "ab-12 cd9")).toBe("AB12CD");
  });

  it("forma: espejo de card_voucher_rules_error", () => {
    expect(rulesShapeError({})).toBeNull();
    expect(rulesShapeError({ acquirers: ["payway"], fields: { lote: { min: 3, max: 3 } } })).toBeNull();
    expect(rulesShapeError({ x: 1 })).toBe("invalid_key");
    expect(rulesShapeError({ acquirers: ["visa"] })).toBe("invalid_acquirer");
    expect(rulesShapeError({ fields: { lote: { min: 5, max: 3 } } })).toBe("out_of_range");
    expect(rulesShapeError({ fields: { lote: { max: 21 } } })).toBe("out_of_range");
    expect(rulesShapeError({ fields: { pin: {} } })).toBe("invalid_key");
    expect(rulesShapeError({ by_acquirer: { visa: {} } })).toBe("invalid_acquirer");
    expect(rulesShapeError({ fields: { lote: { type: "hex" } } })).toBe("invalid_type");
    for (const preset of Object.values(ACQUIRER_PRESETS)) expect(rulesShapeError({ fields: preset })).toBeNull();
  });

  it("edición: guarda sólo lo que difiere y vuelve a la general", () => {
    let r = setFieldRule({}, null, "lote", { ...LEGACY_RULES.lote, required: true });
    expect(r).toEqual({ fields: { lote: { required: true } } });
    r = setFieldRule(r, "payway", "lote", { ...LEGACY_RULES.lote, required: true, type: "numeric", min: 3, max: 3 });
    expect(r.by_acquirer?.payway?.lote).toEqual({ type: "numeric", min: 3, max: 3 });
    expect(clearAcquirerField(r, "payway", "lote")).toEqual({ fields: { lote: { required: true } } });
    expect(setFieldRule({}, null, "lote", LEGACY_RULES.lote)).toEqual({});
    const withPreset = applyPreset({}, "getnet");
    expect(fieldRule(withPreset, false, "getnet", "autorizacion")).toMatchObject({ type: "alnum", min: 6, max: 6 });
    expect(rulesShapeError(withPreset)).toBeNull();
  });

  it("mensaje del error del servidor", () => {
    expect(cardVoucherErrorTitle("card_voucher_required: lote")).toBe("Falta cargar n° de lote del cupón");
    expect(cardVoucherErrorTitle("card_voucher_invalid: autorizacion")).toMatch(/formato/);
    expect(cardVoucherErrorTitle("card_voucher_invalid: adquirente")).toMatch(/terminal/);
  });
});

describe("carga rápida del cupón", () => {
  const exact = { ask: true, required: true, type: "numeric" as const, min: 3, max: 3 };
  it("salta al completar el largo exacto o el máximo", () => {
    expect(shouldAutoAdvance(exact, "12")).toBe(false);
    expect(shouldAutoAdvance(exact, "123")).toBe(true);
    expect(shouldAutoAdvance({ ...exact, min: 1, max: 6 }, "123")).toBe(false);
    expect(shouldAutoAdvance({ ...exact, min: 1, max: 6 }, "123456")).toBe(true);
  });
  it("siguiente dato pedido (null en el último)", () => {
    expect(nextField(["lote", "cupon", "ultimos4"], "lote")).toBe("cupon");
    expect(nextField(["lote", "cupon", "ultimos4"], "ultimos4")).toBeNull();
  });
});

describe("pasos del asistente", () => {
  const visa = CARD_BRANDS.find((b) => b.key === "visa")!;
  const maestro = CARD_BRANDS.find((b) => b.key === "maestro")!;
  const amex = CARD_BRANDS.find((b) => b.key === "amex")!;
  const none = { debit: 0, credit: 0 };
  const credit3 = { debit: 0, credit: 3 };

  it("con adquirente preseleccionado arranca en la entidad", () => {
    expect(initialStep("payway")).toBe(2);
    expect(initialStep(null)).toBe(1);
  });

  it("entidad: un solo tipo sin cuotas va directo al cupón", () => {
    expect(afterBrand(maestro, "credit", none)).toEqual({ kind: "debit", step: 4 });
    expect(afterBrand(amex, "debit", none)).toEqual({ kind: "credit", step: 4 });
    expect(afterBrand(amex, "debit", credit3)).toEqual({ kind: "credit", step: 3 });
    expect(afterBrand(visa, "debit", none)).toEqual({ kind: "debit", step: 3 });
    expect(afterBrand(OTHER_CARD_BRAND, "credit", none).kind).toBe("credit");
  });

  it("tipo: sin cuotas para elegir pasa al cupón", () => {
    expect(afterKind("debit", credit3)).toBe(4);
    expect(afterKind("credit", credit3)).toBe(3);
  });

  it("atrás vuelve al último paso con elección", () => {
    expect(backStep(4, maestro, "debit", none)).toBe(2);
    expect(backStep(4, visa, "debit", none)).toBe(3);
    expect(backStep(3, visa, "debit", none)).toBe(2);
    expect(backStep(2, visa, "debit", none)).toBe(1);
  });

  it("botón principal en pasos intermedios", () => {
    const base = { acquirer: null, brand: null, kind: "debit" as const, choosableByKind: none };
    expect(ctaNext(1, base)).toBeNull();
    expect(ctaNext(1, { ...base, acquirer: "payway" })).toBe(2);
    expect(ctaNext(2, { ...base, brand: maestro })).toBe(4);
    expect(ctaNext(3, base)).toBe(4);
  });
});

describe("conciliación por adquirente", () => {
  const raw = (id: string, adquirente?: string) => ({
    id,
    method: "credit",
    amount: 100,
    reference: null,
    created_at: "2026-10-12T15:00:00Z",
    reconciled_at: null,
    card_voucher: { lote: "001", marca: "Visa", ...(adquirente ? { adquirente } : {}) },
    sales: { number: 1 },
  });
  const rows = normalizeCardPayments([raw("a", "payway"), raw("b", "Getnet"), raw("c")]);

  it("normaliza y filtra por adquirente", () => {
    expect(rows.map((r) => r.adquirente)).toEqual(["payway", "getnet", ""]);
    expect(filterCardRows(rows, { ...DEFAULT_FILTERS, acquirer: "payway" }).map((r) => r.id)).toEqual(["a"]);
    expect(filterCardRows(rows, { ...DEFAULT_FILTERS, acquirer: NO_ACQUIRER }).map((r) => r.id)).toEqual(["c"]);
    expect(filterCardRows(rows, DEFAULT_FILTERS)).toHaveLength(3);
  });

  it("opciones del filtro con etiqueta", () => {
    expect(acquirerOptions(rows)).toEqual([
      { value: "getnet", label: "Getnet" },
      { value: "payway", label: "Payway" },
      { value: NO_ACQUIRER, label: "Sin adquirente" },
    ]);
  });
});
