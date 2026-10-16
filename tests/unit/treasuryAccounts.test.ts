import { describe, expect, it } from "vitest";
import {
  canLinkTransfers,
  groupPositions,
  isMissingSchema,
  isSystemKind,
  movementOrigin,
  movementOriginHref,
  providerLabel,
  treasuryErrorMessage,
} from "@/lib/treasury/accounts";

const mov = (over: Partial<Parameters<typeof movementOrigin>[0]>) => ({
  id: "m1",
  type: "deposit",
  reference_type: null,
  reference_id: null,
  cheque_id: null,
  counterpart_id: null,
  sale_id: null,
  ...over,
});

describe("cuentas de dinero (H150)", () => {
  it("las cajas del POS y lo a acreditar son del sistema; bancos y billeteras reciben transferencias", () => {
    expect(isSystemKind("pos_cash")).toBe(true);
    expect(isSystemKind("receivable")).toBe(true);
    expect(isSystemKind("bank")).toBe(false);
    expect(canLinkTransfers("bank")).toBe(true);
    expect(canLinkTransfers("wallet")).toBe(true);
    expect(canLinkTransfers("cash")).toBe(false);
  });

  it("agrupa la posición en orden y suma sólo lo activo en pesos", () => {
    const groups = groupPositions([
      { account_id: "a", kind: "bank", name: "Galicia", currency: "ARS", is_active: true, balance: 100 },
      { account_id: "b", kind: "bank", name: "BBVA USD", currency: "USD", is_active: true, balance: 50 },
      { account_id: "c", kind: "bank", name: "Viejo", currency: "ARS", is_active: false, balance: 999 },
      { account_id: "d", kind: "pos_cash", name: "Caja 1", currency: "ARS", is_active: true, balance: 30.1 },
      { account_id: "e", kind: "receivable", name: "A acreditar Payway", currency: "ARS", is_active: true, balance: 70 },
    ]);
    expect(groups.map((g) => g.kind)).toEqual(["pos_cash", "cash", "bank", "wallet", "receivable"]);
    const bank = groups.find((g) => g.kind === "bank")!;
    expect(bank.totalArs).toBe(100);
    expect(bank.rows.map((r) => r.account_id)).toEqual(["b", "a", "c"]);
    expect(groups.find((g) => g.kind === "pos_cash")!.totalArs).toBe(30.1);
  });

  it("nombres de procesadores", () => {
    expect(providerLabel("mercadopago")).toBe("Mercado Pago");
    expect(providerLabel("prisma")).toBe("Payway");
    expect(providerLabel(null)).toBe("Sin procesador");
    expect(providerLabel("xyz")).toBe("Xyz");
  });
});

describe("origen de los movimientos (H155)", () => {
  it("cobro por transferencia de una venta lleva a la venta", () => {
    const m = mov({ type: "sale_collection", reference_type: "payment", reference_id: "p1", sale_id: "s1" });
    expect(movementOrigin(m)).toBe("venta");
    expect(movementOriginHref(m)).toBe("/ventas?venta=s1");
    expect(movementOrigin(mov({ type: "sale_collection_void", sale_id: "s1" }))).toBe("venta");
  });

  it("orden de pago, cheque, entre cuentas y manual", () => {
    expect(movementOrigin(mov({ type: "supplier_payment", reference_type: "supplier_payment" }))).toBe("orden_pago");
    expect(movementOriginHref(mov({ type: "supplier_payment_void" }))).toBe("/compras/facturas");
    expect(movementOrigin(mov({ type: "cheque_deposit", cheque_id: "c1" }))).toBe("cheque");
    expect(movementOriginHref(mov({ type: "cheque_rejected" }))).toBe("/tesoreria/cheques");
    expect(movementOrigin(mov({ type: "transfer_out" }))).toBe("transferencia");
    expect(movementOrigin(mov({ type: "withdrawal" }))).toBe("manual");
    expect(movementOriginHref(mov({ type: "withdrawal" }))).toBeNull();
  });
});

describe("errores de Tesorería", () => {
  it("traduce los errores nuevos del servidor", () => {
    expect(treasuryErrorMessage(new Error("treasury_opening_locked"))).toMatch(/ya tiene movimientos/);
    expect(treasuryErrorMessage({ message: "receipt_vat_invalid" })).toMatch(/IVA/);
    expect(treasuryErrorMessage(new Error("treasury_system_account"))).toMatch(/sistema/);
    expect(treasuryErrorMessage(new Error("movement_not_manual"))).toMatch(/documento/);
  });

  it("detecta una base sin la migración", () => {
    expect(isMissingSchema({ code: "PGRST202", message: "x" })).toBe(true);
    expect(isMissingSchema({ code: "42703", message: "column treasury_accounts.provider_key does not exist" })).toBe(true);
    expect(isMissingSchema(new Error("Could not find the function public.treasury_position"))).toBe(true);
    expect(isMissingSchema(new Error("forbidden"))).toBe(false);
  });
});
