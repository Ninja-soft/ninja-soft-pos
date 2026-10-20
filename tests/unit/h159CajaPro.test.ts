// F24 · H159 (ADR-172): arqueo por billete y medio, apertura sugerida, tope
// de descuento propio, ticket de cambio y acción de PIN para el carrito.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  DENOMINATIONS,
  billsTotal,
  buildCount,
  countDetailBills,
  countDetailRows,
  countHasData,
  countableMethods,
  openingNeedsConfirm,
  toAmount,
  toQty,
} from "@/lib/cash/arqueo";
import { effectiveDiscountCap, parseDiscountCap } from "@/lib/permissions/discountCap";
import { exchangeDeadline, exchangeItems } from "@/lib/sales/exchangeTicket";
import { ACTION_INFO, DEFAULT_POLICY, PIN_ACTIONS, pinRequired } from "@/lib/security/pinPolicy";

const MIGRATION = readFileSync(join(process.cwd(), "supabase/migrations/20270110100000_h159_caja_pro.sql"), "utf8");

describe("Arqueo por billete", () => {
  it("suma billetes y monedas", () => {
    expect(billsTotal({ "20000": 2, "1000": 3, "10": 4 }, 15.5)).toBe(43055.5);
    expect(billsTotal({}, 0)).toBe(0);
  });

  it("las denominaciones son las del servidor", () => {
    for (const d of DENOMINATIONS) expect(MIGRATION).toContain(String(d));
    expect(MIGRATION).toMatch(/not in \(20000, 10000, 2000, 1000, 500, 200, 100, 50, 20, 10, 5, 2, 1\)/);
  });

  it("parsea cantidades y montos", () => {
    expect(toQty("12")).toBe(12);
    expect(toQty("-3")).toBe(3);
    expect(toQty("")).toBe(0);
    expect(toAmount("1.234,50")).toBe(1234.5);
    expect(toAmount("")).toBeNull();
    expect(toAmount("abc")).toBeNull();
  });

  it("arma el conteo sin ceros ni medios que no se cuentan", () => {
    const c = buildCount({ "1000": 2, "500": 0 }, 0, { debit: 1500, qr: null, account: 100, cash: 5 });
    expect(c).toEqual({ bills: { "1000": 2 }, coins: 0, methods: { debit: 1500 } });
    expect(countHasData(c)).toBe(true);
    expect(countHasData(buildCount({}, 0, { qr: null }))).toBe(false);
  });

  it("medios a contar: sin efectivo, cuenta corriente ni saldo a favor", () => {
    const m = countableMethods({ cash: 100, debit: 300, account: 50, transfer: 0, qr: 200 });
    expect(m.map((x) => x.method)).toEqual(["debit", "qr"]);
    expect(m[0]!.label).toBe("Débito");
  });

  it("lee el arqueo del Z, efectivo primero", () => {
    const detail = {
      bills: { "1000": 3, "20000": 1 },
      coins: 12,
      methods: {
        qr: { expected: 200, counted: 180, diff: -20 },
        cash: { expected: 23000, counted: 23012, diff: 12 },
        debit: { expected: 500, counted: null, diff: null },
      },
    };
    expect(countDetailRows(detail).map((r) => r.method)).toEqual(["cash", "debit", "qr"]);
    expect(countDetailRows(detail)[2]).toMatchObject({ counted: 180, diff: -20 });
    expect(countDetailBills(detail)).toEqual([
      { denom: 20000, qty: 1, subtotal: 20000 },
      { denom: 1000, qty: 3, subtotal: 3000 },
    ]);
    expect(countDetailRows(null)).toEqual([]);
  });
});

describe("Apertura con el fondo anterior", () => {
  it("pide confirmar abrir en $0 si quedó plata", () => {
    expect(openingNeedsConfirm(0, 5000)).toBe(true);
    expect(openingNeedsConfirm(5000, 5000)).toBe(false);
    expect(openingNeedsConfirm(0, 0)).toBe(false);
    expect(openingNeedsConfirm(0, null)).toBe(false);
  });
});

describe("Tope de descuento propio", () => {
  it("parsea y toma el menor", () => {
    expect(parseDiscountCap("")).toEqual({ ok: true, value: null });
    expect(parseDiscountCap("7,5")).toEqual({ ok: true, value: 7.5 });
    expect(parseDiscountCap("120")).toEqual({ ok: false });
    expect(effectiveDiscountCap(20, 5)).toBe(5);
    expect(effectiveDiscountCap(10, null)).toBe(10);
    expect(effectiveDiscountCap(undefined, undefined)).toBe(100);
  });
});

describe("Ticket de cambio", () => {
  it("sin lo devuelto ni garantías, agrupado", () => {
    expect(
      exchangeItems([
        { product_name: "Remera", quantity: 2, returned_qty: 1 },
        { product_name: "Remera", quantity: 1 },
        { product_name: "Garantía", quantity: 1, warranty_for_item_id: "x" },
        { product_name: "Gorra", quantity: 1, returned_qty: 1 },
      ]),
    ).toEqual([{ name: "Remera", quantity: 2 }]);
  });

  it("vence N días después del día argentino de la venta", () => {
    // 23:30 del 31/1 en Argentina es 1/2 en UTC: cuenta desde el 31/1.
    expect(exchangeDeadline("2026-02-01T02:30:00Z", 30)).toBe("02/03/2026");
    expect(exchangeDeadline("2026-10-20T15:00:00Z", 0)).toBe("20/10/2026");
  });
});

describe("PIN para sacar del carrito", () => {
  it("acción nueva, apagada por defecto y en la política del servidor", () => {
    expect(PIN_ACTIONS).toContain("cart_remove");
    expect(DEFAULT_POLICY.cart_remove).toEqual({ enabled: false, threshold: 0 });
    expect(ACTION_INFO.cart_remove.unit).toBe("money");
    expect(MIGRATION).toMatch(/'cart_remove',\s+jsonb_build_object\('enabled', false, 'threshold', 0\)/);
    expect(pinRequired(DEFAULT_POLICY, "cart_remove", 10000)).toBe(false);
    expect(pinRequired({ ...DEFAULT_POLICY, cart_remove: { enabled: true, threshold: 1000 } }, "cart_remove", 1500)).toBe(true);
  });
});
