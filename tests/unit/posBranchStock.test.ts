import { describe, it, expect } from "vitest";
import {
  branchQty,
  branchQtyMap,
  branchShortfalls,
  branchStockCheck,
  otherBranchesStock,
  otherBranchesText,
  type BranchStockRow,
} from "@/lib/stock/posBranchStock";
import { ticketLocation, ticketLocationText } from "@/lib/tickets/location";
import { personAllowedIn, professionalsForStore, staffForStore } from "@/modules/branches/staffScope";
import type { StaffAssignment } from "@/modules/branches/logic";

const C = "centro";
const N = "norte";
const S = "shopping";

const rows: BranchStockRow[] = [
  { store_id: C, product_id: "p1", variant_id: null, qty: 2 },
  { store_id: N, product_id: "p1", variant_id: null, qty: 5 },
  { store_id: S, product_id: "p1", variant_id: null, qty: 0 },
  { store_id: C, product_id: "p2", variant_id: "v1", qty: 1 },
  { store_id: C, product_id: "p2", variant_id: "v2", qty: 3 },
  { store_id: N, product_id: "p2", variant_id: "v1", qty: -1 },
];

describe("stock de la sucursal del POS", () => {
  it("suma variantes por producto y filtra por variante", () => {
    expect(branchQty(rows, C, "p2")).toBe(4);
    expect(branchQty(rows, C, "p2", "v1")).toBe(1);
    expect(branchQty(rows, C, "p9")).toBe(0);
    expect(branchQtyMap(rows, C).get("p1")).toBe(2);
    expect(branchQtyMap(rows, N).get("p2")).toBe(-1);
  });

  it("lista las otras sucursales con saldo, de mayor a menor", () => {
    const names = new Map([
      [C, "Centro"],
      [N, "Norte"],
      [S, "Shopping"],
    ]);
    const others = otherBranchesStock(rows, "p1", C, names);
    expect(others.map((o) => o.name)).toEqual(["Norte"]);
    expect(otherBranchesText(others)).toBe("Norte: 5");
    expect(otherBranchesText(otherBranchesStock(rows, "p1", N, names))).toBe("Centro: 2");
  });

  it("controla contra la sucursal, no contra el total", () => {
    expect(branchStockCheck({ have: 2, inCart: 1, adding: 1, allowNegative: false })).toBe("ok");
    expect(branchStockCheck({ have: 2, inCart: 2, adding: 1, allowNegative: true })).toBe("warn");
    expect(branchStockCheck({ have: 2, inCart: 2, adding: 1, allowNegative: false })).toBe("block");
  });

  it("detecta faltantes del carrito sumando líneas y sólo en productos con stock", () => {
    const short = branchShortfalls(
      [
        { productId: "p1", quantity: 2 },
        { productId: "p1", quantity: 1 },
        { productId: "p2", variantId: "v2", quantity: 3 },
        { productId: "p3", quantity: 10 },
        { productId: null, quantity: 1 },
      ],
      rows,
      C,
      new Set(["p1", "p2"]),
    );
    expect(short).toEqual([{ productId: "p1", variantId: null, need: 3, have: 2 }]);
  });
});

describe("sucursal y caja en el ticket", () => {
  const branches = [
    { id: C, name: "Centro", deleted_at: null, registers: [{ id: "r1", name: "Caja 1" }] },
    { id: N, name: "Sucursal Norte", deleted_at: null, registers: [{ id: "r2", name: "Caja 2" }] },
  ];
  it("con una sola sucursal no muestra nada", () => {
    expect(ticketLocation([branches[0]!], C, "r1")).toBeNull();
    expect(ticketLocationText(null)).toBeNull();
  });
  it("con varias arma 'Sucursal X · Caja'", () => {
    expect(ticketLocationText(ticketLocation(branches, C, "r1"))).toBe("Sucursal Centro · Caja 1");
    expect(ticketLocationText(ticketLocation(branches, N, null))).toBe("Sucursal Norte");
    expect(ticketLocation(branches, null, null)).toBeNull();
  });
});

describe("personal habilitado en la sucursal del POS", () => {
  const stores = [
    { id: C, is_default: true, deleted_at: null, created_at: "2026-01-01" },
    { id: N, is_default: false, deleted_at: null, created_at: "2026-02-01" },
  ];
  const a = (over: Partial<StaffAssignment>): StaffAssignment => ({
    id: Math.random().toString(36),
    store_id: N,
    user_id: null,
    cashier_profile_id: null,
    kind: "home",
    role: null,
    valid_from: "2026-01-01",
    valid_until: null,
    reason: null,
    transfer_id: "t",
    superseded_by: null,
    deleted_at: null,
    cancel_reason: null,
    created_at: "2026-01-01",
    ...over,
  });
  const today = "2026-10-15";

  it("perfil sin cuenta sin asignaciones: sólo la principal", () => {
    const p = { userId: null, profileId: "pf1", role: null };
    expect(personAllowedIn(p, C, stores, [], today)).toBe(true);
    expect(personAllowedIn(p, N, stores, [], today)).toBe(false);
  });

  it("cobertura exclusiva manda sobre la base", () => {
    const list = [
      a({ cashier_profile_id: "pf1", store_id: C, kind: "home" }),
      a({ cashier_profile_id: "pf1", store_id: N, kind: "cover", valid_until: "2026-10-31" }),
    ];
    const people = [
      { userId: null, profileId: "pf1", role: null },
      { userId: "u1", profileId: null, role: "manager" as const },
    ];
    expect(staffForStore(people, C, stores, list, today).map((p) => p.userId ?? p.profileId)).toEqual(["u1"]);
    expect(staffForStore(people, N, stores, list, today)).toHaveLength(2);
    expect(staffForStore(people, null, stores, list, today)).toHaveLength(2);
  });

  it("vendedores: sin usuario se muestran siempre; con usuario siguen su alcance", () => {
    const pros = [
      { id: "x", user_id: null },
      { id: "y", user_id: "u2" },
    ];
    const roles = new Map([["u2", "cashier" as const]]);
    expect(professionalsForStore(pros, N, roles, stores, [], today).map((p) => p.id)).toEqual(["x"]);
    const list = [a({ user_id: "u2", store_id: N, kind: "extra" })];
    expect(professionalsForStore(pros, N, roles, stores, list, today).map((p) => p.id)).toEqual(["x", "y"]);
  });
});
