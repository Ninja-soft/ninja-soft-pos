import { describe, expect, it } from "vitest";
import { webhookTarget, HOOKS_HOST } from "@/lib/hooks";

const SB = "https://abc.supabase.co";

describe("webhookTarget", () => {
  it("hooks.soft.ninja/<proveedor> va a la Edge Function", () => {
    expect(webhookTarget(HOOKS_HOST, "/getnet", "", SB)).toBe(
      `${SB}/functions/v1/getnet_webhook`,
    );
  });

  it("Mercado Libre usa /ml (mercadolibre es Mercado Pago)", () => {
    expect(webhookTarget(HOOKS_HOST, "/ml", "", SB)).toBe(`${SB}/functions/v1/ml_webhook`);
  });

  it("conserva la query", () => {
    expect(webhookTarget(HOOKS_HOST, "/mercadopago", "?topic=payment&id=1", SB)).toBe(
      `${SB}/functions/v1/mp_webhook?topic=payment&id=1`,
    );
  });

  it("pos.soft.ninja/hooks/<proveedor> también", () => {
    expect(webhookTarget("pos.soft.ninja", "/hooks/payway", "", SB)).toBe(
      `${SB}/functions/v1/payway_webhook`,
    );
  });

  it("ignora puerto y mayúsculas del host", () => {
    expect(webhookTarget("HOOKS.soft.ninja:443", "/nave/", "", SB)).toBe(
      `${SB}/functions/v1/nave_webhook`,
    );
  });

  it("proveedor desconocido en el host de hooks → 404", () => {
    expect(webhookTarget(HOOKS_HOST, "/login", "", SB)).toBe("not_found");
  });

  it("rutas normales de la app no se tocan", () => {
    expect(webhookTarget("pos.soft.ninja", "/ventas", "", SB)).toBeNull();
    expect(webhookTarget("pos.soft.ninja", "/hooks/inexistente", "", SB)).toBeNull();
  });
});
