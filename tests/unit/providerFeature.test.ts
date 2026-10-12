import { describe, expect, it } from "vitest";
import { PROVIDER_FEATURE, providerFeature } from "@/lib/payments/providerFeature";
import { FEATURE_INFO } from "@/lib/saas/featureInfo";

describe("providerFeature (espejo de payment_method_plan_key)", () => {
  it("cada canal Point tiene su propia feature", () => {
    expect(providerFeature("mercadopago_point")).toBe("mercadopago_point");
    expect(providerFeature("payway_point")).toBe("payway_point");
    expect(providerFeature("getnet_point")).toBe("getnet_point");
    expect(providerFeature("nave_point")).toBe("nave_point");
  });
  it("Mercado Pago QR + link usa mercado_pago", () => {
    expect(providerFeature("mercadopago")).toBe("mercado_pago");
  });
  it("medios sin gating devuelven null", () => {
    expect(providerFeature("cash")).toBeNull();
  });
  it("toda feature mapeada tiene copy en featureInfo", () => {
    for (const f of Object.values(PROVIDER_FEATURE)) expect(FEATURE_INFO[f], f).toBeDefined();
  });
});
