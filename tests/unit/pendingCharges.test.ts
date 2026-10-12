import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import {
  buildSaleItemsAndExtras,
  buildShareMessage,
  chargeActions,
  clampTtlMinutes,
  closeShiftDecision,
  defaultTtlMinutes,
  displayLines,
  effectiveStatus,
  expiresLabel,
  extendOptions,
  isShareableLink,
  mailtoUrl,
  maxTtlMinutes,
  nextStatus,
  normalizeArPhone,
  parkBlock,
  pendingChargeErrorCopy,
  PROVIDER_MAX_TTL_MINUTES,
  restorableCart,
  smsUrl,
  whatsappUrl,
  type PendingChargeStatus,
} from "@/modules/pending-charges/logic";
import { buildPaymentLinkEmailHtml, plEscape, plSafeUrl } from "@/lib/email/paymentLinkTemplate";
import { cartToSaleLines } from "@/modules/pos/screen/usePosSale";
import type { CartLine } from "@/modules/pos/store";

const ROOT = resolve(__dirname, "../..");
const read = (p: string) => readFileSync(resolve(ROOT, p), "utf8").replace(/\r\n/g, "\n");
const EM_DASH = "\u2014";
const NOW = new Date("2026-10-14T15:00:00Z");

describe("máquina de estados", () => {
  it("transiciones válidas", () => {
    expect(nextStatus("waiting", "approve")).toBe("paid");
    expect(nextStatus("waiting", "complete")).toBe("completed");
    expect(nextStatus("paid", "complete")).toBe("completed");
    expect(nextStatus("paid", "complete_failed")).toBe("paid");
    expect(nextStatus("waiting", "cancel")).toBe("cancelled");
    expect(nextStatus("waiting", "expire")).toBe("expired");
    expect(nextStatus("expired", "regenerate")).toBe("waiting");
    expect(nextStatus("cancelled", "late_payment")).toBe("paid");
    expect(nextStatus("expired", "late_payment")).toBe("paid");
  });

  it("estados finales no se mueven (idempotencia de la venta)", () => {
    for (const t of ["approve", "complete", "cancel", "expire", "regenerate", "late_payment"] as const) {
      expect(nextStatus("completed", t)).toBeNull();
    }
    expect(nextStatus("paid", "cancel")).toBeNull();
    expect(nextStatus("cancelled", "regenerate")).toBeNull();
  });

  it("un cobro vencido por hora se ve vencido aunque el cron no corrió", () => {
    expect(effectiveStatus({ status: "waiting", expires_at: "2026-10-14T14:59:00Z" }, NOW)).toBe("expired");
    expect(effectiveStatus({ status: "waiting", expires_at: "2026-10-14T16:00:00Z" }, NOW)).toBe("waiting");
    expect(effectiveStatus({ status: "paid", expires_at: "2026-10-14T14:00:00Z" }, NOW)).toBe("paid");
  });

  it("acciones por estado", () => {
    const base = { share_url: "https://pay/x", needs_review: false, sale_id: null, expires_at: "2026-10-14T16:00:00Z" };
    const w = chargeActions({ ...base, status: "waiting" }, NOW);
    expect(w).toMatchObject({ cancel: true, edit: true, extend: true, reshare: true, retry: false, print: false, regenerate: false });
    const e = chargeActions({ ...base, status: "waiting", expires_at: "2026-10-14T14:00:00Z" }, NOW);
    expect(e).toMatchObject({ regenerate: true, extend: false, reshare: false, cancel: true });
    const p = chargeActions({ ...base, status: "paid" }, NOW);
    expect(p).toMatchObject({ retry: true, cancel: false, edit: false });
    const c = chargeActions({ ...base, status: "completed", sale_id: "s1" }, NOW);
    expect(c).toMatchObject({ print: true, openSale: true, cancel: false });
  });
});

describe("vencimiento por proveedor", () => {
  it("acota al tope del proveedor", () => {
    expect(clampTtlMinutes("getnet", 1440)).toBe(30);
    expect(clampTtlMinutes("modo", 1)).toBe(5);
    expect(clampTtlMinutes("mercadopago", 99999)).toBe(10080);
    expect(defaultTtlMinutes("mercadopago")).toBe(1440);
    expect(defaultTtlMinutes("nave")).toBe(60);
    expect(maxTtlMinutes("desconocido")).toBe(1440);
    expect(extendOptions("getnet").map((o) => o.minutes)).toEqual([30]);
  });

  it("los topes coinciden con pending_charge_max_ttl() de la migración", () => {
    const sql = read("supabase/migrations/20261014100000_cobros_en_espera.sql");
    const fn = sql.slice(sql.indexOf("create or replace function pending_charge_max_ttl"));
    for (const [k, v] of Object.entries(PROVIDER_MAX_TTL_MINUTES)) {
      expect(fn, k).toMatch(new RegExp(`when '${k}'\\s+then ${v}\\b`));
    }
  });

  it("etiqueta de vencimiento", () => {
    expect(expiresLabel("2026-10-14T15:20:00Z", NOW)).toBe("Vence en 20 min");
    expect(expiresLabel("2026-10-14T17:05:00Z", NOW)).toBe("Vence en 2 h 5 min");
    expect(expiresLabel("2026-10-14T14:00:00Z", NOW)).toBe("Venció");
  });
});

describe("cierre de caja", () => {
  const rows = [
    { status: "waiting" as PendingChargeStatus, cash_shift_id: "s1", amount: 100 },
    { status: "paid" as PendingChargeStatus, cash_shift_id: "s1", amount: 50.5 },
    { status: "completed" as PendingChargeStatus, cash_shift_id: "s1", amount: 999 },
    { status: "waiting" as PendingChargeStatus, cash_shift_id: "s2", amount: 70 },
    { status: "waiting" as PendingChargeStatus, cash_shift_id: null, amount: 10 },
  ];
  it("sólo cuentan los abiertos del turno que se cierra", () => {
    expect(closeShiftDecision(rows, "s1")).toEqual({ needsDecision: true, waiting: 1, paid: 1, amount: 150.5 });
    expect(closeShiftDecision(rows, "s3").needsDecision).toBe(false);
  });

  it("close_cash_shift exige la decisión del lado del servidor", () => {
    const sql = read("supabase/migrations/20261014100000_cobros_en_espera.sql");
    expect(sql).toContain("p_pending_action text default null");
    expect(sql).toContain("raise exception 'pending_charges_decision_required'");
    expect(sql).toContain("drop function if exists close_cash_shift(uuid, numeric, text);");
  });
});

describe("dejar en espera", () => {
  const ok = {
    paidLines: 0,
    electronicAmount: 1000,
    remaining: 1000,
    hasTableOrDelivery: false,
    hasAppointment: false,
    hasShift: true,
    featureAllowed: true,
  };
  it("sólo con un único medio que cubre el total", () => {
    expect(parkBlock(ok)).toBeNull();
    expect(parkBlock({ ...ok, paidLines: 1 })).toBe("split_payment");
    expect(parkBlock({ ...ok, electronicAmount: 500 })).toBe("partial_amount");
    expect(parkBlock({ ...ok, hasTableOrDelivery: true })).toBe("table_or_delivery");
    expect(parkBlock({ ...ok, hasAppointment: true })).toBe("appointment");
    expect(parkBlock({ ...ok, hasShift: false })).toBe("no_shift");
    expect(parkBlock({ ...ok, featureAllowed: false })).toBe("feature_off");
  });
});

describe("snapshot de la venta", () => {
  const cart: CartLine[] = [
    { lineId: "a", productId: "p1", name: "Remera", sku: null, unitPrice: 500, quantity: 2, discount: 50, unit: "un", variantId: "v1" },
    { lineId: "b", productId: null, name: "Venta rápida", sku: null, unitPrice: 300, quantity: 1, discount: 0, unit: "un" },
    { lineId: "c", productId: "p2", name: "Corte", sku: null, unitPrice: 800, quantity: 1, discount: 0, unit: "un", packCreditId: "cr1" },
    { lineId: "d", productId: null, name: "Pack 5", sku: null, unitPrice: 4000, quantity: 1, discount: 0, unit: "un", packId: "pk1" },
  ];
  it("mismo mapeo que la venta inmediata", () => {
    const { items, extras } = buildSaleItemsAndExtras(cartToSaleLines(cart), [
      { kind: "surcharge", name: "Recargo MODO", amount: 120 },
      { kind: "tip", amount: 100, method: "cash" },
      { kind: "professional", id: "pro1" },
      { kind: "warranty", name: "Garantía", amount: 0 },
    ]);
    expect(items[0]).toEqual({ product_id: "p1", variant_id: "v1", quantity: 2, unit_price: 500, discount: 50 });
    expect(items[1]).toEqual({ product_id: null, name: "Venta rápida", quantity: 1, unit_price: 300, discount: 0 });
    expect(items[2]).toMatchObject({ product_id: "p2", unit_price: 0, discount: 0 });
    expect(items.at(-1)).toEqual({ product_id: null, name: "Recargo MODO", quantity: 1, unit_price: 120, discount: 0 });
    expect(items).toHaveLength(5);
    expect(extras).toEqual([
      { kind: "surcharge", amount: 120 },
      { kind: "tip", amount: 100, method: "cash" },
      { kind: "professional", id: "pro1" },
      { kind: "pack_session", id: "cr1" },
      { kind: "pack", id: "pk1" },
    ]);
  });

  it("líneas para mostrar", () => {
    const lines = displayLines(cartToSaleLines(cart).slice(0, 1), [{ kind: "surcharge", name: "Recargo", amount: 10 }]);
    expect(lines).toEqual([
      { name: "Remera", quantity: 2, unit_price: 500, discount: 50, subtotal: 950, variant: null, unit: null },
      { name: "Recargo", quantity: 1, unit_price: 10, discount: 0, subtotal: 10 },
    ]);
  });

  it("carrito restaurable para editar en el POS", () => {
    expect(restorableCart(null)).toBeNull();
    expect(restorableCart({ lines: "x" })).toBeNull();
    expect(
      restorableCart({ lines: [{ lineId: "a" }], discountTotal: "15", customer: { id: "c1", name: "Ana" }, couponCode: "HOLA" }),
    ).toEqual({ lines: [{ lineId: "a" }], discountTotal: 15, customer: { id: "c1", name: "Ana" }, couponCode: "HOLA" });
  });
});

describe("compartir", () => {
  it("teléfono argentino a wa.me", () => {
    expect(normalizeArPhone("341 15 555-1234")).toBe("5493415551234");
    expect(normalizeArPhone("+54 9 11 5555-1234")).toBe("5491155551234");
    expect(normalizeArPhone("011 5555 1234")).toBe("5491155551234");
    expect(normalizeArPhone("123")).toBeNull();
    expect(normalizeArPhone(null)).toBeNull();
  });

  it("texto y links", () => {
    const text = buildShareMessage({ businessName: "Kiosco Ana", customerName: "Juan Pérez", amountLabel: "$ 1.500,00", url: "https://pay/x" });
    expect(text).toBe("Hola Juan! Te paso el link para pagar $ 1.500,00 de Kiosco Ana: https://pay/x");
    expect(text).not.toContain(EM_DASH);
    expect(whatsappUrl("3415551234", "hola")).toBe("https://wa.me/5493415551234?text=hola");
    expect(whatsappUrl(null, "a b")).toBe("https://wa.me/?text=a%20b");
    expect(smsUrl("+54 341 555", "x")).toBe("sms:+54341555?&body=x");
    expect(mailtoUrl("a@b.com", "S", "B")).toBe("mailto:a%40b.com?subject=S&body=B");
    expect(isShareableLink("https://x")).toBe(true);
    expect(isShareableLink("00020101021243650016COM.MERCADOLIBRE")).toBe(false);
  });

  it("errores con copy en castellano", () => {
    expect(pendingChargeErrorCopy("ERROR: amount_mismatch")).toMatch(/monto/);
    expect(pendingChargeErrorCopy("pending_charges_decision_required")).toMatch(/elegí qué hacer/);
    expect(pendingChargeErrorCopy("xyz")).toBe("No se pudo completar la acción.");
  });
});

describe("email del link de pago", () => {
  const input = {
    businessName: "Kiosco <Ana>",
    logoUrl: "https://res.cloudinary.com/demo/image/upload/f_png/logo",
    accent: "#2563eb",
    customerName: "Juan Pérez",
    amountLabel: "$ 1.500,00",
    payUrl: "https://pay.example.com/x?a=1&b=2",
    expiresLabel: "El link vence el 15/10 a las 18:30.",
    providerName: "Mercado Pago",
    lines: Array.from({ length: 14 }, (_, i) => ({ name: `Item ${i}`, quantity: 1, subtotalLabel: "$ 10,00" })),
    note: "Gracias \u2014 te esperamos",
  };

  it("respeta las reglas de email y escapa", () => {
    const html = buildPaymentLinkEmailHtml(input);
    expect(html.startsWith("<!doctype html>")).toBe(true);
    expect(html).toContain('<meta name="color-scheme" content="light only">');
    expect(html).not.toContain("<style");
    expect(html).not.toContain(EM_DASH);
    expect(html).not.toContain("Kiosco <Ana>");
    expect(html).toContain("Kiosco &lt;Ana&gt;");
    expect(html).toContain("Y 2 productos más");
    expect(html).toContain("Pagar ahora");
    for (const m of html.matchAll(/<img[^>]+src="([^"]+)"/g)) {
      expect(m[1]!.startsWith("https://")).toBe(true);
      expect(m[1]!.includes("f_png") || m[1]!.endsWith(".png")).toBe(true);
    }
  });

  it("nunca pone un link que no sea https", () => {
    expect(plSafeUrl("javascript:alert(1)")).toBe("");
    expect(plSafeUrl("http://x")).toBe("");
    const html = buildPaymentLinkEmailHtml({ ...input, payUrl: "javascript:alert(1)", logoUrl: "" });
    expect(html).not.toContain("javascript:");
    expect(html).not.toContain("Pagar ahora");
    expect(plEscape('"<x>')).toBe("&quot;&lt;x&gt;");
  });

  it("la Edge pending_charge_share tiene el mismo bloque que lib/", () => {
    const block = (src: string) =>
      src
        .slice(src.indexOf("// <payment-link-template>"), src.indexOf("// </payment-link-template>"))
        .replace(/^export /gm, "");
    const lib = block(read("lib/email/paymentLinkTemplate.ts"));
    const fn = block(read("supabase/functions/pending_charge_share/index.ts"));
    expect(lib.length).toBeGreaterThan(1000);
    expect(fn).toBe(lib);
  });
});

describe("sin guion largo", () => {
  it("en los archivos nuevos", () => {
    for (const f of [
      "supabase/migrations/20261014100000_cobros_en_espera.sql",
      "modules/pending-charges/logic.ts",
      "components/pending-charges/PendingChargeDetail.tsx",
      "components/pending-charges/PendingChargesPanel.tsx",
      "components/pending-charges/SharePanel.tsx",
      "supabase/functions/pending_charge_share/index.ts",
      "supabase/functions/pending_charges_sync/index.ts",
    ]) {
      expect(read(f), f).not.toContain(EM_DASH);
    }
  });
});
