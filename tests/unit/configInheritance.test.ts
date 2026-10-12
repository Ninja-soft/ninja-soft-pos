import { describe, expect, it } from "vitest";
import {
  applicableLayers,
  copyPreview,
  effectiveProviderRows,
  fieldType,
  inheritState,
  resolveEffective,
  type ConfigOverride,
  type ResolveTarget,
} from "@/lib/config/inheritance";

const G = "g1";
const S = "s1";
const S2 = "s2";
const R = "r1";

const full: ResolveTarget = { groupId: G, storeId: S, registerId: R, multiStore: true, multiRegister: true };

function o(scope: ConfigOverride["scope"], id: string, domain: ConfigOverride["domain"], key: string, patch: Record<string, unknown>): ConfigOverride {
  return { scope, scope_id: id, domain, domain_key: key, patch };
}

describe("whitelist por dominio y alcance", () => {
  it("la caja sólo puede pisar enabled en medios", () => {
    expect(fieldType("payment_method", "register", "enabled")).toBe("bool");
    expect(fieldType("payment_method", "register", "surcharge_pct")).toBeNull();
    expect(fieldType("payment_method", "store", "merchant_numbers")).toBe("map_text");
  });
  it("redondeo no se pisa por caja; cierre ciego sí", () => {
    expect(fieldType("pos_settings", "register", "rounding_multiple")).toBeNull();
    expect(fieldType("pos_settings", "register", "blind_close")).toBe("bool");
    expect(fieldType("pos_settings", "store", "sku_prefix")).toBeNull();
  });
  it("ticket no tiene nivel caja", () => {
    expect(fieldType("ticket", "register", "address")).toBeNull();
    expect(fieldType("ticket", "store_group", "address")).toBe("text");
  });
});

describe("resolveEffective", () => {
  const base = { rounding_multiple: 0, blind_close: false, max_discount: { cashier: 10, manager: 50 } };

  it("sin overrides devuelve el negocio con origen tenant", () => {
    const r = resolveEffective("pos_settings", "", base, [], full);
    expect(r.value).toEqual(base);
    expect(r.sources.rounding_multiple).toBe("tenant");
  });

  it("orden negocio ← grupo ← sucursal ← caja; gana el último", () => {
    const ovs = [
      o("register", R, "pos_settings", "", { blind_close: true }),
      o("store", S, "pos_settings", "", { rounding_multiple: 10, blind_close: false }),
      o("store_group", G, "pos_settings", "", { rounding_multiple: 5 }),
    ];
    const r = resolveEffective("pos_settings", "", base, ovs, full);
    expect(r.value.rounding_multiple).toBe(10);
    expect(r.sources.rounding_multiple).toBe(`store:${S}`);
    expect(r.value.blind_close).toBe(true);
    expect(r.sources.blind_close).toBe(`register:${R}`);
  });

  it("los mapas se mezclan por clave", () => {
    const ovs = [o("store", S, "pos_settings", "", { max_discount: { cashier: 0 } })];
    const r = resolveEffective("pos_settings", "", base, ovs, full);
    expect(r.value.max_discount).toEqual({ cashier: 0, manager: 50 });
  });

  it("sin multi_sucursal no aplican grupo ni sucursal; sin multi_caja, la caja", () => {
    const ovs = [
      o("store", S, "pos_settings", "", { rounding_multiple: 10 }),
      o("register", R, "pos_settings", "", { blind_close: true }),
    ];
    const r = resolveEffective("pos_settings", "", base, ovs, { ...full, multiStore: false, multiRegister: false });
    expect(r.value).toEqual(base);
  });

  it("ignora campos fuera de la whitelist del alcance y overrides de otras sucursales", () => {
    const ovs = [
      o("register", R, "pos_settings", "", { rounding_multiple: 99 }),
      o("store", S2, "pos_settings", "", { rounding_multiple: 50 }),
      { ...o("store", S, "pos_settings", "", { rounding_multiple: 7 }), deleted_at: "2026-01-01" },
    ];
    expect(resolveEffective("pos_settings", "", base, ovs, full).value.rounding_multiple).toBe(0);
    expect(applicableLayers(ovs, "pos_settings", "", full)).toHaveLength(1);
  });
});

describe("medios de pago por sucursal", () => {
  const rows = [
    { provider_key: "cash", enabled: true, connected: false, surcharge_pct: 0, merchant_numbers: {}, plan_mode: null },
    {
      provider_key: "payway",
      enabled: true,
      connected: true,
      surcharge_pct: 10,
      merchant_numbers: { visa: "111", master: "222" },
      plan_mode: "plans",
    },
  ];

  it("Visa 10% en el negocio y 0% en Norte con su n° de comercio", () => {
    const ovs = [o("store", S, "payment_method", "payway", { surcharge_pct: 0, merchant_numbers: { visa: "999", master: "" } })];
    const out = effectiveProviderRows(rows, ovs, full);
    const pw = out.find((r) => r.provider_key === "payway")!;
    expect(pw.surcharge_pct).toBe(0);
    expect(pw.merchant_numbers).toEqual({ visa: "999" });
    expect(pw.connected).toBe(true);
    const other = effectiveProviderRows(rows, ovs, { ...full, storeId: S2, registerId: null });
    expect(other.find((r) => r.provider_key === "payway")!.surcharge_pct).toBe(10);
  });

  it("una caja sin efectivo apaga sólo esa caja", () => {
    const ovs = [o("register", R, "payment_method", "cash", { enabled: false })];
    expect(effectiveProviderRows(rows, ovs, full).find((r) => r.provider_key === "cash")!.enabled).toBe(false);
    expect(
      effectiveProviderRows(rows, ovs, { ...full, registerId: "r2" }).find((r) => r.provider_key === "cash")!.enabled,
    ).toBe(true);
  });

  it("la sucursal puede prender un medio que el negocio no tiene (fila virtual)", () => {
    const ovs = [o("store", S, "payment_method", "nave", { enabled: true })];
    const out = effectiveProviderRows(rows, ovs, full);
    expect(out.find((r) => r.provider_key === "nave")?.enabled).toBe(true);
    expect(effectiveProviderRows(rows, ovs, { ...full, storeId: S2 }).some((r) => r.provider_key === "nave")).toBe(false);
  });
});

describe("estado heredado / personalizado y copia", () => {
  const ovs = [
    o("store", S, "payment_method", "payway", { surcharge_pct: 0 }),
    o("store", S2, "payment_method", "payway", { enabled: false }),
    o("store", S2, "pos_settings", "", { rounding_multiple: 10 }),
  ];
  it("inheritState", () => {
    expect(inheritState(ovs, "store", S, "payment_method", "payway", "surcharge_pct")).toBe("custom");
    expect(inheritState(ovs, "store", S, "payment_method", "payway", "enabled")).toBe("inherited");
  });
  it("copiar S → S2 en modo reemplazo pisa y vuelve a heredar lo que el origen no pisa", () => {
    const ch = copyPreview(ovs, { scope: "store", id: S }, { scope: "store", id: S2 });
    expect(ch).toContainEqual(expect.objectContaining({ field: "surcharge_pct", kind: "set", to: 0 }));
    expect(ch).toContainEqual(expect.objectContaining({ field: "enabled", kind: "clear" }));
    expect(ch).toContainEqual(expect.objectContaining({ field: "rounding_multiple", kind: "clear" }));
  });
  it("modo merge no borra lo propio del destino", () => {
    const ch = copyPreview(ovs, { scope: "store", id: S }, { scope: "store", id: S2 }, "merge");
    expect(ch.every((c) => c.kind === "set")).toBe(true);
  });
  it("de sucursal a caja se saltean los campos que la caja no admite", () => {
    const ch = copyPreview(ovs, { scope: "store", id: S }, { scope: "register", id: R });
    expect(ch).toHaveLength(0);
  });
});
