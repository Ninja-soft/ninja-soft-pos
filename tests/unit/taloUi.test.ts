// Talo (ADR-175): textos y reglas de la pantalla del POS y de las
// devoluciones, más su cableado en catálogo, tenders, logos y webhooks.
import { describe, expect, it } from "vitest";
import {
  formatCvu,
  refundsByIntent,
  taloOverpaidNote,
  taloRefundErrorCopy,
  taloRefundLabel,
  taloRefundOptions,
  taloWaitingNote,
  type TaloRefundIntent,
} from "@/lib/payments/talo";
import { BRAND_BY_KEY, IMPLEMENTED, SANDBOX_PROVIDERS, PROVIDER_CHANNEL_FALLBACK } from "@/lib/payments/catalog";
import { providerFeature } from "@/lib/payments/providerFeature";
import { paymentIcon, paymentWordmark } from "@/lib/payments/logos";
import { QR_SELF_MANAGED, TENDER_BY_ID } from "@/lib/pos/tenders";
import { QR_EDGE_BY_PROVIDER } from "@/lib/pos/warmEdge";
import { WEBHOOK_FUNCTIONS } from "@/lib/hooks";
import { FEATURE_INFO } from "@/lib/saas/featureInfo";
import { maxTtlMinutes } from "@/modules/pending-charges/logic";

const intent = (over: Partial<TaloRefundIntent> = {}): TaloRefundIntent => ({
  provider_key: "talo",
  status: "approved",
  amount: 1500,
  saleNumber: null,
  saleStatus: null,
  paidAmount: 1500,
  ...over,
});
const refund = (kind: string, status: string, created_at = "2026-10-20T10:00:00Z") => ({
  intent_id: "i1",
  kind,
  status,
  amount: 100,
  created_at,
});

describe("pantalla del POS", () => {
  it("formatCvu agrupa de a 4", () => {
    expect(formatCvu("0000630500000060195375")).toBe("0000 6305 0000 0060 1953 75");
    expect(formatCvu("abc")).toBe("abc");
  });

  it("UNDERPAID avisa cuánto falta; otros estados no", () => {
    const n = taloWaitingNote({ state: "UNDERPAID", paid: 1000, missing: 500 });
    expect(n?.title).toMatch(/Faltan/);
    expect(n?.text).toMatch(/mismo CVU/);
    expect(taloWaitingNote({ state: "PENDING" })).toBeNull();
    expect(taloWaitingNote(null)).toBeNull();
  });

  it("OVERPAID avisa la diferencia", () => {
    expect(taloOverpaidNote(200)?.title).toMatch(/de más/);
    expect(taloOverpaidNote(0)).toBeNull();
    expect(taloOverpaidNote(undefined)).toBeNull();
  });

  it("los textos nuevos no usan raya (U+2014)", () => {
    const texts = [
      taloWaitingNote({ state: "UNDERPAID", paid: 1, missing: 1 })?.text,
      taloOverpaidNote(1)?.text,
      taloRefundErrorCopy("sale_active"),
      taloRefundErrorCopy(null),
      FEATURE_INFO.talo?.desc,
    ];
    for (const t of texts) expect(t ?? "").not.toContain("\u2014");
  });
});

describe("devoluciones", () => {
  it("total: aprobado sin venta vigente; diferencia: aprobado con plata de más", () => {
    expect(taloRefundOptions(intent(), [])).toEqual({ full: true, excess: null });
    expect(taloRefundOptions(intent({ saleNumber: 7, saleStatus: "completed" }), [])).toEqual({ full: false, excess: null });
    expect(taloRefundOptions(intent({ saleNumber: 7, saleStatus: "voided" }), []).full).toBe(true);
    expect(taloRefundOptions(intent({ saleNumber: 7, saleStatus: "completed", paidAmount: 1700 }), [])).toEqual({
      full: false,
      excess: 200,
    });
  });

  it("cobro cerrado al que igual llegó plata: se puede devolver", () => {
    expect(taloRefundOptions(intent({ status: "cancelled", paidAmount: 800 }), []).full).toBe(true);
    expect(taloRefundOptions(intent({ status: "cancelled", paidAmount: null }), []).full).toBe(false);
  });

  it("con una devolución en curso o ya hecha no se ofrece otra igual", () => {
    expect(taloRefundOptions(intent(), [refund("full", "initiated")])).toEqual({ full: false, excess: null });
    expect(taloRefundOptions(intent({ paidAmount: 1700 }), [refund("excess", "refunded")]).excess).toBeNull();
    expect(taloRefundOptions(intent(), [refund("full", "refunded")]).full).toBe(false);
    expect(taloRefundOptions(intent(), [refund("full", "failed")]).full).toBe(true);
    expect(taloRefundOptions(intent({ provider_key: "ualabis" }), [])).toEqual({ full: false, excess: null });
  });

  it("agrupa por cobro, la más nueva primero, y etiqueta", () => {
    const m = refundsByIntent([refund("full", "failed", "2026-10-01"), refund("excess", "refunded", "2026-10-02")]);
    expect(m.get("i1")?.[0]?.kind).toBe("excess");
    expect(taloRefundLabel({ kind: "excess", status: "refunded" }).label).toBe("Diferencia devuelta");
    expect(taloRefundLabel({ kind: "full", status: "initiated" }).tone).toBe("info");
    expect(taloRefundErrorCopy("retry_502")).toMatch(/no respondió/);
  });
});

describe("cableado", () => {
  it("catálogo, feature, logos, tender, webhook y vencimiento", () => {
    expect(BRAND_BY_KEY.talo?.channels).toEqual(["talo"]);
    expect(IMPLEMENTED.has("talo")).toBe(true);
    expect(SANDBOX_PROVIDERS.has("talo")).toBe(true);
    expect(PROVIDER_CHANNEL_FALLBACK.talo).toEqual({ brand: "talo", channel: "qr_link" });
    expect(providerFeature("talo")).toBe("talo");
    expect(FEATURE_INFO.talo?.minPlan).toBe("Pro");
    expect(paymentIcon("talo")).toBe("/images/payments/talo-icon.webp");
    expect(paymentWordmark("talo", { on: "dark" })).toBe("/images/payments/talo-wordmark-on-dark.webp");
    const t = TENDER_BY_ID["talo:link"];
    expect(t).toMatchObject({ group: "transfer", method: "qr", qrProvider: "talo", featureKey: "talo" });
    expect(QR_SELF_MANAGED.has("talo")).toBe(true);
    expect(QR_EDGE_BY_PROVIDER.talo).toEqual(["talo"]);
    expect(WEBHOOK_FUNCTIONS.talo).toBe("talo_webhook");
    expect(maxTtlMinutes("talo")).toBe(4320);
  });
});
