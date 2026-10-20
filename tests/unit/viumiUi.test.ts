// ADR-173: Viumi en el catálogo de medios, el registro de tenders del POS, los
// logos y la feature de plan (espejo de payment_method_plan_key).
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
import { VIUMI_MIN_AMOUNT } from "@/supabase/functions/_shared/viumi";

const row = (key: string, connected = true): ProviderStatus => ({ provider_key: key, enabled: true, connected });
const ids = (providers: ProviderStatus[], features?: Record<string, boolean>) =>
  resolveTenders({ providers, features, hasCustomer: false, storeCreditBalance: 0 }).map((t) => t.id);

describe("catálogo y logos", () => {
  it("marca con su canal, conexión propia y ambiente de prueba", () => {
    expect(BRAND_BY_KEY.viumi?.channels).toEqual(["viumi"]);
    expect(BRAND_BY_KEY.viumi?.credentialsUrl).toBe("https://developers.viumi.com.ar");
    expect(connectionKeyOf("viumi")).toBe("viumi");
    expect(IMPLEMENTED.has("viumi")).toBe(true);
    expect(SANDBOX_PROVIDERS.has("viumi")).toBe(true);
    // Sin registro manual: sólo con la API conectada.
    expect(MANUAL_FALLBACK.has("viumi")).toBe(false);
    const groups = groupProvidersByBrand([{ key: "viumi", name: "Viumi", kind: "gateway", sort: 14 }]);
    expect(groups[0]?.channels.map((c) => [c.key, c.channel])).toEqual([["viumi", "qr_link"]]);
  });

  it("sin logo oficial todavía: la UI usa el respaldo genérico", () => {
    expect(paymentIcon("viumi")).toBeNull();
    expect(paymentWordmark("viumi")).toBeNull();
    expect(TENDER_BY_ID["viumi:link"]?.logo).toBeNull();
  });

  it("feature de plan, copy, webhook y precalentado", () => {
    expect(providerFeature("viumi")).toBe("viumi");
    expect(FEATURE_INFO.viumi?.minPlan).toBe("Pro");
    expect(FEATURE_INFO.viumi?.needs).toContain("consultas@viumi.com.ar");
    expect(WEBHOOK_FUNCTIONS.viumi).toBe("viumi_webhook");
    expect(WEBHOOK_PROVIDERS.some((p) => p.key === "viumi" && p.fn === "viumi_webhook")).toBe(true);
    expect(QR_EDGE_BY_PROVIDER.viumi).toEqual(["viumi"]);
  });

  it("textos sin guion largo", () => {
    const texts = [
      FEATURE_INFO.viumi!.desc,
      FEATURE_INFO.viumi!.impact,
      FEATURE_INFO.viumi!.needs ?? "",
      CHANNEL_SUMMARY.viumi!,
      CHANNEL_INFO.viumi!.activa,
      ...(CHANNEL_INFO.viumi!.pasos ?? []),
      ...CONNECT_GUIDE.viumi!.steps.map((s) => s.text),
      CONNECT_GUIDE.viumi!.where,
      CONNECT_GUIDE.viumi!.note ?? "",
    ];
    const emDash = String.fromCharCode(0x2014);
    for (const t of texts) expect(t.includes(emDash), t).toBe(false);
  });
});

describe("tenders del POS", () => {
  it("sin conectar no aparece", () => {
    const out = ids([row("cash"), row("viumi", false)]);
    expect(out.filter((id) => id.startsWith("viumi"))).toEqual([]);
  });

  it("conectada: link y QR por API", () => {
    const out = ids([row("cash"), row("viumi")]);
    expect(out).toEqual(expect.arrayContaining(["viumi:link", "viumi:qr"]));
    expect(TENDER_BY_ID["viumi:link"]).toMatchObject({ method: "qr", qrProvider: "viumi", minAmount: VIUMI_MIN_AMOUNT });
    expect(TENDER_BY_ID["viumi:qr"]).toMatchObject({ method: "qr", qrProvider: "viumi", featureKey: "viumi" });
    expect(QR_SELF_MANAGED.has("viumi")).toBe(true);
  });

  it("sin la feature en el plan no aparece", () => {
    const out = ids([row("cash"), row("viumi")], { viumi: false });
    expect(out.filter((id) => id.startsWith("viumi"))).toEqual([]);
  });
});
