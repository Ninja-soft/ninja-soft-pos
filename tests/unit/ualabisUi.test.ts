// ADR-143: Ualá Bis en el catálogo de medios, el registro de tenders del POS,
// los logos y la feature de plan (espejo de payment_method_plan_key).
import { describe, expect, it } from "vitest";
import {
  BRAND_BY_KEY,
  IMPLEMENTED,
  MANUAL_FALLBACK,
  SANDBOX_PROVIDERS,
  connectionKeyOf,
  groupProvidersByBrand,
} from "@/lib/payments/catalog";
import { paymentIcon, paymentWordmark, logoOnDark } from "@/lib/payments/logos";
import { providerFeature } from "@/lib/payments/providerFeature";
import { QR_SELF_MANAGED, TENDER_BY_ID, resolveTenders, type ProviderStatus } from "@/lib/pos/tenders";
import { FEATURE_INFO } from "@/lib/saas/featureInfo";
import { PAYMENT_METHOD_LABELS } from "@/lib/utils/paymentMethods";
import { canRefundUala, latestRefundByIntent, ualaRefundErrorCopy, ualaRefundLabel } from "@/lib/payments/ualabis";
import { UALABIS_MIN_AMOUNT } from "@/supabase/functions/_shared/ualabis";

const row = (key: string, connected = true): ProviderStatus => ({ provider_key: key, enabled: true, connected });
const ids = (providers: ProviderStatus[], features?: Record<string, boolean>) =>
  resolveTenders({ providers, features, hasCustomer: false, storeCreditBalance: 0 }).map((t) => t.id);

describe("catálogo y logos", () => {
  it("marca con su canal, conexión propia y ambiente de prueba", () => {
    expect(BRAND_BY_KEY.ualabis?.channels).toEqual(["ualabis"]);
    expect(connectionKeyOf("ualabis")).toBe("ualabis");
    expect(IMPLEMENTED.has("ualabis")).toBe(true);
    expect(SANDBOX_PROVIDERS.has("ualabis")).toBe(true);
    expect(MANUAL_FALLBACK.has("ualabis")).toBe(true);
    const groups = groupProvidersByBrand([{ key: "ualabis", name: "Ualá Bis", kind: "gateway", sort: 13 }]);
    expect(groups[0]?.channels.map((c) => [c.key, c.channel])).toEqual([["ualabis", "qr_link"]]);
  });

  it("logos oficiales con variante para fondo oscuro", () => {
    expect(paymentIcon("ualabis")).toBe("/images/payments/ualabis-icon.webp");
    expect(paymentWordmark("ualabis")).toBe("/images/payments/ualabis-wordmark.webp");
    expect(paymentWordmark("ualabis", { on: "dark" })).toBe("/images/payments/ualabis-wordmark-on-dark.webp");
    expect(logoOnDark("/images/payments/ualabis-icon.webp")).toBe("/images/payments/ualabis-icon-on-dark.webp");
  });

  it("feature de plan, copy y etiqueta del medio manual", () => {
    expect(providerFeature("ualabis")).toBe("ualabis");
    expect(FEATURE_INFO.ualabis?.minPlan).toBe("Pro");
    expect(FEATURE_INFO.ualabis?.desc).not.toMatch(/—/);
    expect(PAYMENT_METHOD_LABELS.ualabis).toBe("Ualá Bis");
  });
});

describe("tenders del POS", () => {
  it("sin conectar: sólo el registro manual con número de operación", () => {
    const out = ids([row("cash"), row("ualabis", false)]);
    expect(out).toContain("ualabis");
    expect(out).not.toContain("ualabis:link");
    expect(TENDER_BY_ID.ualabis).toMatchObject({ method: "ualabis", requiresReference: true, flow: "direct" });
    expect(TENDER_BY_ID.ualabis?.referenceHelp).toContain("{monto}");
  });

  it("conectada: link y QR por API y el manual sigue disponible", () => {
    const out = ids([row("cash"), row("ualabis")]);
    expect(out).toEqual(expect.arrayContaining(["ualabis:link", "ualabis:qr", "ualabis"]));
    expect(TENDER_BY_ID["ualabis:link"]).toMatchObject({ method: "qr", qrProvider: "ualabis", minAmount: UALABIS_MIN_AMOUNT });
    expect(QR_SELF_MANAGED.has("ualabis")).toBe(true);
  });

  it("sin la feature en el plan no aparece ningún camino", () => {
    const out = ids([row("cash"), row("ualabis")], { ualabis: false });
    expect(out.filter((id) => id.startsWith("ualabis"))).toEqual([]);
  });
});

describe("devolución desde la conciliación", () => {
  const intent = { provider_key: "ualabis", status: "approved", saleNumber: null, saleStatus: null };

  it("sólo cobros aprobados sin venta vigente y sin devolución viva", () => {
    expect(canRefundUala(intent, null)).toBe(true);
    expect(canRefundUala({ ...intent, saleNumber: 3, saleStatus: "completed" }, null)).toBe(false);
    expect(canRefundUala({ ...intent, saleNumber: 3, saleStatus: "voided" }, null)).toBe(true);
    expect(canRefundUala({ ...intent, status: "pending" }, null)).toBe(false);
    expect(canRefundUala(intent, { status: "initiated" })).toBe(false);
    expect(canRefundUala(intent, { status: "refunded" })).toBe(false);
    expect(canRefundUala(intent, { status: "failed" })).toBe(true);
    expect(canRefundUala({ ...intent, provider_key: "modo" }, null)).toBe(false);
  });

  it("la más nueva por cobro y textos sin guion largo", () => {
    const m = latestRefundByIntent([
      { intent_id: "a", status: "failed", created_at: "2026-10-15T10:00:00Z" },
      { intent_id: "a", status: "initiated", created_at: "2026-10-15T11:00:00Z" },
    ]);
    expect(m.get("a")?.status).toBe("initiated");
    expect(ualaRefundLabel("refunded")).toEqual({ label: "Devuelto", tone: "success" });
    for (const c of ["sale_active", "forbidden", "retry_500", null]) expect(ualaRefundErrorCopy(c)).not.toMatch(/—/);
  });
});
