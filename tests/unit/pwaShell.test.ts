import { describe, expect, it } from "vitest";
import { checkOfflineSale, OFFLINE_POLICY_DEFAULTS } from "@/lib/pos/offline/policy";
import {
  addShellLine,
  buildShellSale,
  setShellQty,
  shellProductBlock,
  shellTotal,
  type ShellProduct,
} from "@/lib/pos/offline/shellCart";
import { shouldRegisterSw, swUpdateView, SW_SCOPE } from "@/lib/pwa/update";

// POS sin conexión (H65, ADR-087): carrito reducido y aviso de versión nueva.

const P: ShellProduct = { id: "p1", name: "Alfajor", price: 900, unit: "u" };
const KG: ShellProduct = { id: "p2", name: "Queso", price: 12000, unit: "kg" };

describe("carrito del POS sin conexión", () => {
  it("bloquea lo que necesita conexión", () => {
    expect(shellProductBlock(P)).toBeNull();
    expect(shellProductBlock({ ...P, has_variants: true })).toMatch(/variantes/);
    expect(shellProductBlock({ ...P, is_serialized: true })).toMatch(/serie/);
    expect(shellProductBlock({ ...P, is_active: false })).toMatch(/inactivo/);
    expect(shellProductBlock({ ...P, price: 0 })).toMatch(/precio/);
    expect(addShellLine([], { ...P, has_variants: true })).toEqual([]);
  });
  it("suma, cambia cantidades y calcula el total", () => {
    let l = addShellLine([], P);
    l = addShellLine(l, P);
    l = addShellLine(l, KG, 0.25);
    expect(l).toHaveLength(2);
    expect(shellTotal(l)).toBe(900 * 2 + 3000);
    l = setShellQty(l, "p2", 0.3333);
    expect(l.find((x) => x.productId === "p2")?.quantity).toBe(0.333);
    l = setShellQty(l, "p1", 2.6);
    expect(l.find((x) => x.productId === "p1")?.quantity).toBe(3);
    l = setShellQty(l, "p1", 0);
    expect(l.map((x) => x.productId)).toEqual(["p2"]);
  });
  it("arma el mismo payload de create_sale que la venta offline (efectivo con vuelto)", () => {
    const r = buildShellSale(addShellLine([], P), { method: "cash", received: 1000 });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.input.total).toBe(900);
    expect(r.input.change).toBe(100);
    expect(r.input.payload.items).toEqual([{ product_id: "p1", quantity: 1, unit_price: 900, discount: 0 }]);
    expect(r.input.payload.payments).toEqual([{ method: "cash", amount: 900 }]);
    expect(r.input.payload).toMatchObject({ discount_total: 0, customer_id: null, extras: [], promo_discount: 0 });
    // La regla compartida con el servidor la acepta.
    expect(
      checkOfflineSale({
        policy: OFFLINE_POLICY_DEFAULTS,
        total: r.input.total,
        countInShift: 0,
        shiftId: "s1",
        hasSession: true,
        payments: r.input.payments,
        extraKinds: r.input.extraKinds,
        anyPriceOverride: r.input.anyPriceOverride,
        hasServerOrigin: r.input.hasServerOrigin,
      }),
    ).toEqual({ ok: true });
  });
  it("valida efectivo insuficiente, carrito vacío y cupón de tarjeta", () => {
    expect(buildShellSale([], { method: "cash" })).toEqual({ ok: false, message: "El carrito está vacío" });
    expect(buildShellSale(addShellLine([], P), { method: "cash", received: 500 }).ok).toBe(false);
    expect(buildShellSale(addShellLine([], P), { method: "debit", voucher: { lote: "1", cupon: "", autorizacion: "" } }).ok).toBe(
      false,
    );
    const card = buildShellSale(addShellLine([], P), {
      method: "credit",
      voucher: { lote: " 12 ", cupon: "345", autorizacion: "" },
    });
    expect(card.ok && card.input.payload.payments[0]).toEqual({
      method: "credit",
      amount: 900,
      card_voucher: { lote: "12", cupon: "345", autorizacion: "" },
    });
    const tr = buildShellSale(addShellLine([], P), { method: "transfer", reference: " 99 " });
    expect(tr.ok && tr.input.payload.payments[0]).toEqual({ method: "transfer", amount: 900, reference: "99" });
  });
});

describe("aviso de versión nueva", () => {
  it("no aparece sin actualización", () => {
    expect(swUpdateView({ updateReady: false, busy: false })).toBeNull();
  });
  it("con cobro o carrito en curso no deja recargar", () => {
    expect(swUpdateView({ updateReady: true, busy: true })).toMatchObject({ canReload: false });
    expect(swUpdateView({ updateReady: true, busy: false })).toMatchObject({ canReload: true, title: "Hay una versión nueva" });
  });
  it("se registra sólo en producción, contexto seguro y sin el interruptor", () => {
    const base = { nodeEnv: "production", hasSw: true, secure: true, optOut: false };
    expect(shouldRegisterSw(base)).toBe(true);
    expect(shouldRegisterSw({ ...base, nodeEnv: "development" })).toBe(false);
    expect(shouldRegisterSw({ ...base, secure: false })).toBe(false);
    expect(shouldRegisterSw({ ...base, hasSw: false })).toBe(false);
    expect(shouldRegisterSw({ ...base, optOut: true })).toBe(false);
  });
  it("el alcance es sólo el POS", () => {
    expect(SW_SCOPE).toBe("/pos");
  });
});
