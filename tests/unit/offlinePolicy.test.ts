import { describe, expect, it } from "vitest";
import {
  OFFLINE_POLICY_DEFAULTS,
  checkOfflineSale,
  isPaymentAllowedOffline,
  isTenderAllowedOffline,
  offlinePolicyError,
  offlinePolicyToRaw,
  parseOfflinePolicy,
  type OfflineSaleCheckInput,
} from "@/lib/pos/offline/policy";
import { TENDERS, INTEGRATED_CARD_TENDER_ID, integratedCardTender } from "@/lib/pos/tenders";

const base: OfflineSaleCheckInput = {
  policy: OFFLINE_POLICY_DEFAULTS,
  total: 1000,
  countInShift: 0,
  shiftId: "s1",
  hasSession: true,
  payments: [{ method: "cash", amount: 1000 }],
  extraKinds: [],
  anyPriceOverride: false,
  hasServerOrigin: false,
};

describe("política offline", () => {
  it("defaults conservadores y parseo con claves snake_case", () => {
    expect(parseOfflinePolicy(null)).toEqual(OFFLINE_POLICY_DEFAULTS);
    expect(parseOfflinePolicy({ enabled: false, max_amount: "1000", max_sales: 5 })).toEqual({
      enabled: false,
      maxAmount: 1000,
      maxSales: 5,
      maxHours: 48,
    });
    expect(parseOfflinePolicy(offlinePolicyToRaw({ enabled: true, maxAmount: 1, maxSales: 2, maxHours: 3 }))).toEqual({
      enabled: true,
      maxAmount: 1,
      maxSales: 2,
      maxHours: 3,
    });
  });

  it("valida rangos como offline_policy_error", () => {
    expect(offlinePolicyError(OFFLINE_POLICY_DEFAULTS)).toBeNull();
    expect(offlinePolicyError({ ...OFFLINE_POLICY_DEFAULTS, maxAmount: -1 })).not.toBeNull();
    expect(offlinePolicyError({ ...OFFLINE_POLICY_DEFAULTS, maxSales: 0 })).not.toBeNull();
    expect(offlinePolicyError({ ...OFFLINE_POLICY_DEFAULTS, maxSales: 2.5 })).not.toBeNull();
    expect(offlinePolicyError({ ...OFFLINE_POLICY_DEFAULTS, maxHours: 169 })).not.toBeNull();
    expect(offlinePolicyError({ ...OFFLINE_POLICY_DEFAULTS, maxAmount: NaN })).not.toBeNull();
  });
});

describe("medios permitidos sin conexión", () => {
  it("sólo efectivo, transferencia y tarjeta en posnet", () => {
    const allowed = TENDERS.filter(isTenderAllowedOffline).map((t) => t.id);
    expect(allowed.sort()).toEqual(["card", "cash", "transfer"]);
  });

  it("nunca la terminal integrada", () => {
    const card = TENDERS.find((t) => t.id === "card")!;
    const integrated = integratedCardTender(card, {
      terminalId: "t1",
      label: "Pinpad",
      providerKey: "payway",
      requiresBrand: false,
      simulated: false,
    });
    expect(integrated.id).toBe(INTEGRATED_CARD_TENDER_ID);
    expect(isTenderAllowedOffline(integrated)).toBe(false);
  });

  it("pagos: QR, cuenta, vale, Directo y cupón de terminal quedan afuera", () => {
    expect(isPaymentAllowedOffline({ method: "cash", amount: 10 })).toBe(true);
    expect(isPaymentAllowedOffline({ method: "transfer", amount: 10 })).toBe(true);
    expect(isPaymentAllowedOffline({ method: "credit", amount: 10, card_voucher: { origen: undefined } })).toBe(true);
    for (const m of ["qr", "account", "store_credit", "directo", "other"]) {
      expect(isPaymentAllowedOffline({ method: m, amount: 10 })).toBe(false);
    }
    expect(isPaymentAllowedOffline({ method: "debit", amount: 10, card_voucher: { origen: "terminal" } })).toBe(false);
    expect(isPaymentAllowedOffline({ method: "debit", amount: 10, card_voucher: { terminal_tx: "x" } })).toBe(false);
    // Un pago en 0 no cuenta.
    expect(isPaymentAllowedOffline({ method: "qr", amount: 0 })).toBe(true);
  });
});

describe("checkOfflineSale", () => {
  it("acepta una venta común en efectivo", () => {
    expect(checkOfflineSale(base)).toEqual({ ok: true });
  });

  it.each([
    [{ policy: { ...OFFLINE_POLICY_DEFAULTS, enabled: false } }, "disabled"],
    [{ shiftId: null }, "no_shift"],
    [{ hasSession: false }, "no_session"],
    [{ total: 50000.02 }, "over_amount"],
    [{ countInShift: 20 }, "over_count"],
    [{ payments: [{ method: "qr", amount: 1000 }] }, "method"],
    [{ extraKinds: ["pack_session"] }, "extra"],
    [{ anyPriceOverride: true }, "price_override"],
    [{ hasServerOrigin: true }, "origin"],
  ] as const)("rechaza %o con %s", (over, reason) => {
    const r = checkOfflineSale({ ...base, ...(over as Partial<OfflineSaleCheckInput>) });
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.reason).toBe(reason);
      expect(r.message).not.toContain("—");
    }
  });

  it("el tope de monto es inclusivo", () => {
    expect(checkOfflineSale({ ...base, total: 50000 }).ok).toBe(true);
    expect(checkOfflineSale({ ...base, countInShift: 19 }).ok).toBe(true);
  });
});
