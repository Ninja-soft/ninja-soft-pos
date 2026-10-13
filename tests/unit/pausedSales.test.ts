import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import type { CheckoutSnapshot, LiveIntent, PaidLine } from "@/components/pos/checkout/types";
import type { CartLine } from "@/modules/pos/store";
import {
  buildPausedCart,
  classifyPayments,
  clearRule,
  defaultPausedLabel,
  discardRule,
  isCreditedPayment,
  mergePaused,
  parseLocal,
  paymentsFromCheckout,
  pausedErrorCopy,
  pausedTimeLabel,
  pausedTitle,
  priceChanges,
  readPausedCart,
  restorePlan,
  serializeLocal,
  totalChangeNotice,
  type PausedPayment,
  type PausedSale,
} from "@/modules/paused-sales/logic";

// ADR-106: pausar venta. Serialización y restauración del estado, reglas de
// descarte y de "Limpiar" según los pagos.

const INTENT = "11111111-2222-4333-8444-555555555555";

function cartLine(p: Partial<CartLine> = {}): CartLine {
  return {
    lineId: p.lineId ?? "l1",
    productId: "productId" in p ? (p.productId as string | null) : "p1",
    name: p.name ?? "Yerba 1kg",
    sku: null,
    unitPrice: p.unitPrice ?? 1000,
    quantity: p.quantity ?? 2,
    discount: p.discount ?? 0,
    unit: "un",
    ...p,
  };
}

function paid(p: Partial<PaidLine> & Pick<PaidLine, "method" | "amount">): PaidLine {
  return {
    key: p.key ?? `k-${p.method}`,
    tenderId: p.tenderId ?? p.method,
    title: p.title ?? p.method,
    logo: null,
    surcharge: 0,
    surchargeItems: [],
    locked: false,
    promoEligible: true,
    ...p,
  };
}

function snap(lines: PaidLine[], extra: Partial<CheckoutSnapshot> = {}): CheckoutSnapshot {
  return { v: 1, lines, tipPct: null, tipCustom: "", warrantyId: "", warrantyLineId: "", professionalId: "", ...extra };
}

const live: LiveIntent = {
  intentId: INTENT,
  provider: "nave",
  channel: "qr",
  amount: 500,
  surcharges: [],
  tenderId: "qr:nave",
  title: "Nave QR",
  logo: null,
  shareUrl: null,
};

describe("ADR-106 · pagos de la venta pausada", () => {
  it("normaliza las líneas de la hoja y el QR vivo para el servidor", () => {
    const pays = paymentsFromCheckout(
      snap([
        paid({ method: "cash", amount: 300 }),
        paid({ method: "debit", amount: 200, card_voucher: { lote: "1", cupon: "22", autorizacion: "A" } }),
        paid({ method: "qr", amount: 100, reference: INTENT.replace("1111", "9999"), locked: true }),
      ]),
      live,
    );
    expect(pays).toHaveLength(4);
    expect(pays.map((p) => [p.kind, p.method, p.credited])).toEqual([
      ["line", "cash", false],
      ["line", "debit", true],
      ["line", "qr", true],
      ["intent", "qr", false],
    ]);
    // El QR aprobado viaja con su intent (conciliación y no duplicar).
    expect(pays[2]!.intent_id).toBe(INTENT.replace("1111", "9999"));
    expect(pays[3]).toMatchObject({ intent_id: INTENT, provider_key: "nave", channel: "qr", status: "pending" });
    // La línea completa se guarda para restaurarla igual (sin undefined).
    expect(pays[1]!.line.card_voucher).toEqual({ lote: "1", cupon: "22", autorizacion: "A" });
  });

  it("isCreditedPayment espeja paused_payment_credited (SQL)", () => {
    expect(isCreditedPayment({ kind: "line", method: "cash", status: "confirmed" })).toBe(false);
    expect(isCreditedPayment({ kind: "line", method: "account", status: "confirmed" })).toBe(false);
    expect(isCreditedPayment({ kind: "line", method: "store_credit", status: "confirmed" })).toBe(false);
    for (const m of ["debit", "credit", "qr", "transfer"])
      expect(isCreditedPayment({ kind: "line", method: m, status: "confirmed" })).toBe(true);
    expect(isCreditedPayment({ kind: "intent", method: "qr", status: "pending" })).toBe(false);
    expect(isCreditedPayment({ kind: "intent", method: "qr", status: "approved" })).toBe(true);

    const sql = readFileSync(path.join(process.cwd(), "supabase/migrations/20261111100000_pausar_venta.sql"), "utf8");
    const fn = sql.slice(sql.indexOf("create or replace function paused_payment_credited"));
    expect(fn).toContain("p_status in ('approved', 'used')");
    expect(fn).toContain("p_method not in ('cash', 'account', 'store_credit')");
  });

  it("clasifica: acreditado, efectivo, QR esperando y lo cobrado", () => {
    const pays: PausedPayment[] = [
      ...paymentsFromCheckout(snap([paid({ method: "cash", amount: 300 })]), live),
      { kind: "intent", method: "qr", amount: 50, line: {}, status: "expired", credited: false, intent_id: "x" },
    ];
    const c = classifyPayments(pays);
    expect(c.cash).toBe(300);
    expect(c.credited).toBe(0);
    expect(c.pendingIntents).toHaveLength(1);
    expect(c.paid).toBe(300);
  });
});

describe("ADR-106 · reglas de descarte y de Limpiar", () => {
  const cash = paymentsFromCheckout(snap([paid({ method: "cash", amount: 300 })]), null);
  const card = paymentsFromCheckout(snap([paid({ method: "credit", amount: 900, card_voucher: { lote: "1", cupon: "2", autorizacion: "3" } })]), null);
  const pendingQr = paymentsFromCheckout(null, live);
  const approvedQr: PausedPayment[] = [{ ...pendingQr[0]!, status: "approved", credited: true }];

  it("sin pagos se descarta libre", () => {
    expect(discardRule([], "cashier")).toEqual({ kind: "free", pendingIntents: 0 });
    expect(discardRule(pendingQr, "cashier")).toEqual({ kind: "free", pendingIntents: 1 });
  });

  it("con efectivo pide confirmar la devolución", () => {
    expect(discardRule(cash, "cashier")).toEqual({ kind: "confirm_cash", cash: 300, pendingIntents: 0 });
  });

  it("con pagos acreditados no se descarta sin devolver: sólo dueño o encargado confirma", () => {
    expect(discardRule(card, "cashier")).toMatchObject({ kind: "needs_refund", credited: 900, canOverride: false });
    expect(discardRule(card, "manager")).toMatchObject({ kind: "needs_refund", canOverride: true });
    expect(discardRule(approvedQr, "owner")).toMatchObject({ kind: "needs_refund", credited: 500, canOverride: true });
  });

  it("Limpiar: libre sin pagos, auditado con pagos en curso, bloqueado con acreditados", () => {
    expect(clearRule([])).toEqual({ kind: "free" });
    expect(clearRule(cash)).toEqual({ kind: "audit", cash: 300, pendingIntents: 0 });
    expect(clearRule(pendingQr)).toEqual({ kind: "audit", cash: 0, pendingIntents: 1 });
    expect(clearRule(card)).toEqual({ kind: "blocked", credited: 900 });
    expect(clearRule(approvedQr)).toEqual({ kind: "blocked", credited: 500 });
    // Un QR vencido o cancelado ya no cuenta.
    expect(clearRule([{ ...pendingQr[0]!, status: "cancelled" }])).toEqual({ kind: "free" });
  });
});

describe("ADR-106 · serialización y restauración", () => {
  const input = {
    lines: [cartLine(), cartLine({ lineId: "l2", productId: null, name: "Venta rápida", unitPrice: 50, quantity: 1 })],
    discountTotal: 100,
    couponCode: " PROMO10 ",
    customer: { id: "c1", name: "Señora de rojo" },
    offeredWarrantyId: "w1",
    pricing: { listId: "list-1", termId: null },
    notes: "  ",
  };

  it("el carrito guardado es una copia (el POS sigue cambiando después)", () => {
    const cart = buildPausedCart(input);
    input.lines[0]!.quantity = 99;
    expect(cart.lines[0]!.quantity).toBe(2);
    expect(cart.couponCode).toBe("PROMO10");
    expect(cart.notes).toBeNull();
    input.lines[0]!.quantity = 2;
  });

  it("ida y vuelta por JSON (servidor) restaura exactamente el carrito", () => {
    const cart = buildPausedCart(input);
    const back = readPausedCart(JSON.parse(JSON.stringify(cart)));
    expect(back).toEqual(cart);
  });

  it("tolera datos viejos o a medias", () => {
    expect(readPausedCart(null)).toBeNull();
    expect(readPausedCart({ lines: "x" })).toBeNull();
    const r = readPausedCart({ lines: [{ lineId: "a", name: "X", unitPrice: "10", quantity: "2" }, { bad: 1 }] });
    expect(r?.lines).toHaveLength(1);
    expect(r?.lines[0]).toMatchObject({ unitPrice: 10, quantity: 2, discount: 0, unit: "un" });
    expect(r?.pricing).toEqual({ listId: null, termId: null });
  });

  it("restaura pagos: líneas, QR cobrado en la pausa (bloqueado) y avisa los vencidos", () => {
    const cart = buildPausedCart(input);
    const cashLine = paid({ method: "cash", amount: 300, key: "l7" });
    const pays: PausedPayment[] = [
      ...paymentsFromCheckout(snap([cashLine]), null),
      { ...paymentsFromCheckout(null, live)[0]!, status: "approved", credited: true },
      { ...paymentsFromCheckout(null, { ...live, intentId: "other" })[0]!, status: "expired" },
    ];
    const plan = restorePlan({ cart, checkout: snap([cashLine], { tipPct: 10, professionalId: "pro1" }), payments: pays });
    expect(plan?.checkout?.lines).toHaveLength(2);
    expect(plan?.checkout?.lines[0]).toMatchObject({ method: "cash", amount: 300, locked: false });
    expect(plan?.checkout?.lines[1]).toMatchObject({ method: "qr", amount: 500, reference: INTENT, locked: true, title: "Nave QR" });
    // Las claves no chocan con las de la hoja (l1, l2...).
    expect(plan?.checkout?.lines.every((l) => l.key.startsWith("r"))).toBe(true);
    expect(plan?.checkout).toMatchObject({ tipPct: 10, professionalId: "pro1" });
    expect(plan?.notices.join(" ")).toMatch(/se cobró mientras la venta estaba pausada/);
    expect(plan?.notices.join(" ")).toMatch(/venció/);
  });

  it("sin pagos ni extras la hoja arranca de cero", () => {
    const plan = restorePlan({ cart: buildPausedCart(input), checkout: null, payments: [] });
    expect(plan?.checkout).toBeNull();
    expect(plan?.cart.lines).toHaveLength(2);
  });

  it("detecta precios de lista que cambiaron (no toca precio manual, regalos, packs ni modificadores)", () => {
    const lines = [
      cartLine({ lineId: "a", unitPrice: 100 }),
      cartLine({ lineId: "b", unitPrice: 100, priceOverride: true }),
      cartLine({ lineId: "c", unitPrice: 0, giftPromoId: "promo" }),
      cartLine({ lineId: "d", productId: null, unitPrice: 30 }),
      cartLine({ lineId: "e", unitPrice: 100, modifiers: [{ groupId: "g", groupName: "G", options: [] }] as never }),
      cartLine({ lineId: "f", unitPrice: 100 }),
    ];
    const changes = priceChanges(lines, (_p, _v, cur) => (cur === 100 ? 120 : cur));
    expect(changes.map((c) => c.lineId)).toEqual(["a", "f"]);
    expect(changes[0]).toMatchObject({ from: 100, to: 120 });
    expect(priceChanges(lines, () => null)).toEqual([]);
  });

  it("avisa el cambio de total sólo si cambió", () => {
    expect(totalChangeNotice(1000, 1000.004)).toBeNull();
    expect(totalChangeNotice(1000, 1200)).toMatch(/cambió/);
  });
});

describe("ADR-106 · presentación y copia local", () => {
  it("nombre por defecto y hora", () => {
    expect(defaultPausedLabel("  Ana  ")).toBe("Ana");
    expect(defaultPausedLabel(null, new Date(2026, 9, 13, 9, 5))).toBe("Venta 09:05");
    const now = new Date(2026, 9, 13, 18, 0);
    expect(pausedTimeLabel(new Date(2026, 9, 13, 14, 32).toISOString(), now)).toBe("14:32");
    expect(pausedTimeLabel(new Date(2026, 9, 12, 14, 32).toISOString(), now)).toBe("12/10 14:32");
    expect(pausedTitle({ label: "Señora de rojo", customer_name: "Ana", paused_at: now.toISOString() })).toBe("Señora de rojo");
  });

  const sale = (id: string, at: string): PausedSale => ({
    id,
    tenant_id: "t",
    store_id: "s",
    register_id: null,
    cash_shift_id: null,
    created_by: "u",
    resumed_by: null,
    customer_id: null,
    customer_name: null,
    label: null,
    cart: buildPausedCart({
      lines: [cartLine()],
      discountTotal: 0,
      couponCode: null,
      customer: null,
      offeredWarrantyId: "",
      pricing: { listId: null, termId: null },
    }),
    checkout: null,
    total: 2000,
    paid_amount: 0,
    item_count: 2,
    status: "paused",
    carry_over: false,
    needs_review: false,
    source: "offline",
    paused_at: at,
    resumed_at: null,
    version: 1,
    payments: [],
  });

  it("serializa y lee la copia local (sin conexión)", () => {
    const raw = serializeLocal([sale("a", "2026-10-13T10:00:00Z")]);
    const back = parseLocal(raw);
    expect(back).toHaveLength(1);
    expect(back[0]!.localOnly).toBe(true);
    expect(parseLocal("{nope")).toEqual([]);
    expect(parseLocal(JSON.stringify({ v: 2, items: [] }))).toEqual([]);
    expect(parseLocal(null)).toEqual([]);
  });

  it("mezcla servidor y locales: por id gana el servidor; las más nuevas primero", () => {
    const server = [sale("a", "2026-10-13T10:00:00Z")];
    const local = [
      { ...sale("a", "2026-10-13T09:00:00Z"), localOnly: true },
      { ...sale("b", "2026-10-13T11:00:00Z"), localOnly: true },
    ];
    const m = mergePaused(server, local);
    expect(m.map((x) => [x.id, Boolean(x.localOnly)])).toEqual([
      ["b", true],
      ["a", false],
    ]);
  });

  it("traduce los errores del servidor", () => {
    expect(pausedErrorCopy("paused_sale_has_payments")).toMatch(/pagos cobrados/);
    expect(pausedErrorCopy("refund_requires_manager")).toMatch(/encargado/);
    expect(pausedErrorCopy("zzz")).toMatch(/No se pudo/);
  });
});
