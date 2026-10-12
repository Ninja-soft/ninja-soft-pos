import { describe, expect, it } from "vitest";
import {
  cellState,
  clearActionForBranch,
  effectivePlans,
  overridesByStore,
  winningPlans,
  type ScopedPlanRow,
} from "@/lib/payments/planScope";

type Row = ScopedPlanRow & { surcharge_pct: number };

const N = "store-norte";
const C = "store-centro";

const row = (id: string, code: string, store: string | null, pct: number, active = true, provider = "payway"): Row => ({
  id,
  provider_key: provider,
  code,
  store_id: store,
  is_active: active,
  surcharge_pct: pct,
});

const rows: Row[] = [
  row("t3", "credito_visa_3c", null, 10),
  row("t6", "credito_visa_6c", null, 20),
  row("t12", "credito_visa_12c", null, 35),
  row("n3", "credito_visa_3c", N, 0),
  row("n6", "credito_visa_6c", N, 20, false),
  row("n18", "credito_visa_18c", N, 50),
  row("c3", "credito_visa_3c", C, 5),
  row("m3", "credito_visa_3c", null, 8, true, "mobbex"),
];

describe("planes por sucursal (ADR-057)", () => {
  it("sin sucursal: sólo los del negocio", () => {
    const ids = effectivePlans(rows, null).map((r) => r.id);
    expect(ids).toEqual(["t3", "t6", "t12", "m3"]);
  });

  it("la sucursal pisa, oculta y suma planes; las otras sucursales no cuentan", () => {
    const ids = effectivePlans(rows, N).map((r) => r.id).sort();
    expect(ids).toEqual(["m3", "n18", "n3", "t12"].sort());
    const n3 = effectivePlans(rows, N).find((r) => r.code === "credito_visa_3c" && r.provider_key === "payway");
    expect(n3?.surcharge_pct).toBe(0);
  });

  it("sin multi_sucursal los planes de sucursal no se aplican", () => {
    expect(effectivePlans(rows, N, false).map((r) => r.id)).toEqual(["t3", "t6", "t12", "m3"]);
  });

  it("la clave es medio + code: otro medio con el mismo code no se pisa", () => {
    const win = winningPlans(rows, C);
    expect(win.get("mobbex|credito_visa_3c")?.id).toBe("m3");
    expect(win.get("payway|credito_visa_3c")?.id).toBe("c3");
  });

  it("estado de la celda en el editor", () => {
    expect(cellState(rows, null, "payway", "credito_visa_3c")).toMatchObject({ origin: "tenant" });
    expect(cellState(rows, N, "payway", "credito_visa_3c").origin).toBe("store");
    expect(cellState(rows, N, "payway", "credito_visa_6c").origin).toBe("hidden");
    expect(cellState(rows, N, "payway", "credito_visa_12c").origin).toBe("tenant");
    expect(cellState(rows, N, "payway", "credito_visa_24c").origin).toBeNull();
    expect(cellState(rows, N, "payway", "credito_visa_6c").inherited?.id).toBe("t6");
  });

  it("vaciar una celda en la sucursal: oculta si el negocio la ofrece, si no borra", () => {
    expect(clearActionForBranch(cellState(rows, N, "payway", "credito_visa_12c"))).toBe("hide");
    expect(clearActionForBranch(cellState(rows, N, "payway", "credito_visa_3c"))).toBe("hide");
    expect(clearActionForBranch(cellState(rows, N, "payway", "credito_visa_18c"))).toBe("delete");
    expect(clearActionForBranch(cellState(rows, N, "payway", "credito_visa_24c"))).toBe("none");
  });

  it("cuenta las combinaciones propias por sucursal", () => {
    expect(overridesByStore(rows, "payway")).toEqual({ [N]: 3, [C]: 1 });
  });
});
