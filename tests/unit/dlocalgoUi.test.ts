// ADR-180: dLocal Go en el catálogo de medios, el registro de tenders del POS,
// los logos, los webhooks y la feature de plan (espejo de payment_method_plan_key).
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import {
  BRAND_BY_KEY,
  IMPLEMENTED,
  MANUAL_FALLBACK,
  SANDBOX_PROVIDERS,
  connectionKeyOf,
  groupProvidersByBrand,
} from "@/lib/payments/catalog";
import { paymentIcon, paymentWordmark } from "@/lib/payments/logos";
import { providerFeature } from "@/lib/payments/providerFeature";
import { QR_SELF_MANAGED, TENDER_BY_ID, resolveTenders, type ProviderStatus } from "@/lib/pos/tenders";
import { QR_EDGE_BY_PROVIDER } from "@/lib/pos/warmEdge";
import { WEBHOOK_FUNCTIONS } from "@/lib/hooks";
import { WEBHOOK_PROVIDERS } from "@/lib/internal/webhookHealth";
import { FEATURE_INFO } from "@/lib/saas/featureInfo";
import { CHANNEL_INFO, CHANNEL_SUMMARY, CONNECT_GUIDE } from "@/components/dashboard-team/payments/copy";
import { canRefundDlocal, dlocalRefundErrorCopy, dlocalRefundLabel } from "@/lib/payments/dlocalgo";

const ROOT = resolve(__dirname, "../..");
const row = (key: string, connected = true): ProviderStatus => ({ provider_key: key, enabled: true, connected });
const ids = (providers: ProviderStatus[], features?: Record<string, boolean>) =>
  resolveTenders({ providers, features, hasCustomer: false, storeCreditBalance: 0 }).map((t) => t.id);

describe("catálogo y logos", () => {
  it("marca con su canal, conexión propia y ambiente de prueba", () => {
    expect(BRAND_BY_KEY.dlocalgo?.channels).toEqual(["dlocalgo"]);
    expect(connectionKeyOf("dlocalgo")).toBe("dlocalgo");
    expect(IMPLEMENTED.has("dlocalgo")).toBe(true);
    expect(SANDBOX_PROVIDERS.has("dlocalgo")).toBe(true);
    expect(MANUAL_FALLBACK.has("dlocalgo")).toBe(false);
    const groups = groupProvidersByBrand([{ key: "dlocalgo", name: "dLocal Go", kind: "gateway", sort: 16 }]);
    expect(groups[0]?.channels.map((c) => [c.key, c.channel])).toEqual([["dlocalgo", "qr_link"]]);
  });

  it("logos oficiales (isotipo, logo y variante oscura)", () => {
    expect(paymentIcon("dlocalgo")).toBe("/images/payments/dlocalgo-icon.webp");
    expect(paymentWordmark("dlocalgo")).toBe("/images/payments/dlocalgo-wordmark.webp");
    expect(paymentWordmark("dlocalgo", { on: "dark" })).toBe("/images/payments/dlocalgo-wordmark-on-dark.webp");
  });
});

describe("POS", () => {
  it("link y QR sólo con la API conectada y la feature", () => {
    expect(TENDER_BY_ID["dlocalgo:link"]?.featureKey).toBe("dlocalgo");
    expect(QR_SELF_MANAGED.has("dlocalgo")).toBe(true);
    expect(ids([row("dlocalgo")], { dlocalgo: true })).toEqual(expect.arrayContaining(["dlocalgo:link", "dlocalgo:qr"]));
    expect(ids([row("dlocalgo", false)], { dlocalgo: true })).not.toContain("dlocalgo:link");
    expect(ids([row("dlocalgo")], { dlocalgo: false })).not.toContain("dlocalgo:link");
    expect(QR_EDGE_BY_PROVIDER.dlocalgo).toEqual(["dlocalgo"]);
  });
});

describe("plan, webhook y copy", () => {
  it("feature propia con copy y webhook público", () => {
    expect(providerFeature("dlocalgo")).toBe("dlocalgo");
    expect(FEATURE_INFO.dlocalgo?.minPlan).toBe("Pro");
    expect(WEBHOOK_FUNCTIONS.dlocalgo).toBe("dlocalgo_webhook");
    expect(WEBHOOK_PROVIDERS.some((p) => p.key === "dlocalgo" && p.fn === "dlocalgo_webhook")).toBe(true);
    expect(CHANNEL_SUMMARY.dlocalgo).toBeTruthy();
    expect(CHANNEL_INFO.dlocalgo?.pasos?.length ?? 0).toBeGreaterThan(0);
    expect(CONNECT_GUIDE.dlocalgo?.steps.length).toBe(3);
    const toml = readFileSync(resolve(ROOT, "supabase/config.toml"), "utf8");
    expect(toml).toMatch(/\[functions\.dlocalgo_webhook\]\s*\nverify_jwt = false/);
  });

  it("la migración mapea el medio y el cupón a sus features", () => {
    const sql = readFileSync(resolve(ROOT, "supabase/migrations/20270118100000_dlocal_cupones.sql"), "utf8");
    expect(sql).toMatch(/when 'dlocalgo'\s+then 'dlocalgo'/);
    expect(sql).toMatch(/when 'mp_cupon'\s+then 'cupones_efectivo'/);
    expect(sql).toMatch(/when 'dlocalgo'\s+then 1440/);
    expect(sql).toMatch(/when 'mp_cupon'\s+then 4320/);
    expect(sql).not.toMatch(/or is_internal\(\)/i);
  });
});

describe("devolución desde Cobros QR", () => {
  const base = { provider_key: "dlocalgo", status: "approved", saleNumber: null, saleStatus: null };
  it("aprobado sin venta vigente y sin otra devolución viva", () => {
    expect(canRefundDlocal(base, null)).toBe(true);
    expect(canRefundDlocal({ ...base, saleNumber: 10, saleStatus: "completed" }, null)).toBe(false);
    expect(canRefundDlocal({ ...base, saleNumber: 10, saleStatus: "voided" }, null)).toBe(true);
    expect(canRefundDlocal(base, { status: "initiated" })).toBe(false);
    expect(canRefundDlocal(base, { status: "failed" })).toBe(true);
    expect(canRefundDlocal({ ...base, status: "pending" }, null)).toBe(false);
    expect(dlocalRefundLabel("refunded").tone).toBe("success");
    expect(dlocalRefundErrorCopy("sale_active")).toContain("Anulá la venta");
    expect(dlocalRefundErrorCopy("retry_503")).toContain("no respondió");
  });
});
