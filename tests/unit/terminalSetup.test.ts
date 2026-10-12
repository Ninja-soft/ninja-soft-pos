import { describe, expect, it } from "vitest";
import {
  SETUP_TYPES,
  defaultAcquirer,
  groupByRegister,
  idHelp,
  registerPickHint,
  setupTypeOf,
  stepProblem,
  suggestLabel,
  type WizardDraft,
} from "@/lib/payments/terminalSetup";
import type { PaymentTerminal } from "@/lib/payments/terminals";

const t = (p: Partial<PaymentTerminal>): PaymentTerminal => ({
  id: p.id ?? Math.random().toString(36).slice(2),
  store_id: "s1",
  cash_register_id: null,
  provider_key: "mercadopago_point",
  kind: "point",
  external_id: null,
  environment: null,
  label: "T",
  merchant_number: null,
  acquirer: null,
  is_default: false,
  active: true,
  last_seen_at: null,
  ...p,
});

const draft = (p: Partial<WizardDraft>): WizardDraft => ({
  type: "point",
  provider_key: "mercadopago_point",
  kind: "point",
  store_id: "s1",
  cash_register_id: null,
  external_id: "",
  simulator: false,
  label: "",
  ...p,
});

describe("terminalSetup", () => {
  it("cubre los cuatro tipos y el posnet sin integrar no necesita registro", () => {
    expect(SETUP_TYPES.map((x) => x.key)).toEqual(["point", "qr", "integrated", "manual"]);
    expect(SETUP_TYPES.find((x) => x.key === "manual")?.noRecord).toBe(true);
  });

  it("mapea el kind de una terminal al tipo del asistente", () => {
    expect(setupTypeOf("point")).toBe("point");
    expect(setupTypeOf("clover")).toBe("point");
    expect(setupTypeOf("qr_caja")).toBe("qr");
    expect(setupTypeOf("pinpad")).toBe("integrated");
    expect(setupTypeOf("posnet_integrado")).toBe("integrated");
    expect(setupTypeOf("posnet_manual")).toBe("manual");
  });

  it("ayuda de identificación: Detectar en los Point y opcional con el simulador", () => {
    expect(idHelp("mercadopago_point", "point").detect).toBe(true);
    expect(idHelp("fiserv_point", "clover").detect).toBe(true);
    expect(idHelp("mercadopago", "qr_caja").detect).toBe(false);
    expect(idHelp("payway", "posnet_integrado").required).toBe(true);
    expect(idHelp("payway", "posnet_integrado", true).required).toBe(false);
    expect(idHelp("getnet", "posnet_manual").required).toBe(false);
  });

  it("sugiere nombre con marca y caja sin repetir", () => {
    expect(suggestLabel({ provider: "mercadopago_point", kind: "point", registerName: "Caja 1" })).toBe("Point Caja 1");
    expect(
      suggestLabel({ provider: "fiserv_point", kind: "clover", registerName: "Caja 1", taken: ["Clover Caja 1"] }),
    ).toBe("Clover Caja 1 (2)");
    expect(suggestLabel({ provider: "payway", kind: "pinpad", storeName: "Centro" })).toBe("Pinpad Payway Centro");
  });

  it("propone el adquirente de la marca", () => {
    expect(defaultAcquirer("mercadopago_point")).toBe("mercadopago");
    expect(defaultAcquirer("fiserv_point")).toBe("fiserv");
    expect(defaultAcquirer("payway")).toBe("payway");
  });

  it("valida cada paso", () => {
    expect(stepProblem(0, draft({ type: null }))).toMatch(/tipo/);
    expect(stepProblem(0, draft({}))).toBeNull();
    expect(stepProblem(1, draft({ store_id: "" }))).toMatch(/sucursal/);
    expect(stepProblem(2, draft({}))).toMatch(/device id/);
    expect(stepProblem(2, draft({ external_id: "PAX A910" }))).toMatch(/Sólo letras/);
    expect(stepProblem(2, draft({ external_id: "PAX_A910__SMARTPOS1" }))).toBeNull();
    expect(
      stepProblem(2, draft({ type: "integrated", provider_key: "payway", kind: "posnet_integrado", simulator: true })),
    ).toBeNull();
    expect(stepProblem(3, draft({ label: " " }))).toMatch(/nombre/);
  });

  it("agrupa por caja con las de toda la sucursal primero y la por defecto arriba", () => {
    const regs = [
      { id: "r1", name: "Caja 1" },
      { id: "r2", name: "Caja 2" },
    ];
    const list = [
      t({ id: "a", label: "B", cash_register_id: "r1" }),
      t({ id: "b", label: "A", cash_register_id: "r1", is_default: true }),
      t({ id: "c", label: "Flot" }),
    ];
    const g = groupByRegister(list, regs);
    expect(g.map((x) => x.name)).toEqual(["Toda la sucursal", "Caja 1", "Caja 2"]);
    expect(g[1]!.terminals.map((x) => x.id)).toEqual(["b", "a"]);
    expect(g[2]!.terminals).toHaveLength(0);
  });

  it("explica cómo elige el POS en cada caja", () => {
    const empty = { registerId: "r1", name: "Caja 1", terminals: [] };
    expect(registerPickHint(empty, 1)).toMatch(/toda la sucursal/);
    expect(registerPickHint(empty, 0)).toMatch(/Sin terminal/);
    expect(registerPickHint({ ...empty, terminals: [t({})] }, 0)).toMatch(/sola/);
    const two = [t({ cash_register_id: "r1" }), t({ cash_register_id: "r1" })];
    expect(registerPickHint({ ...empty, terminals: two }, 0)).toMatch(/pregunta/);
    const mixed = [t({}), t({ provider_key: "mercadopago", kind: "qr_caja" })];
    expect(registerPickHint({ ...empty, terminals: mixed }, 0)).toMatch(/cada medio/);
  });
});
