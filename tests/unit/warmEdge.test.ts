import { describe, expect, it, vi } from "vitest";
import { edgesToWarm, QR_EDGE_BY_PROVIDER, warmEdgeFunctions } from "@/lib/pos/warmEdge";

describe("precalentado de Edge de cobro", () => {
  it("mapea cada proveedor QR a su Edge, sin repetir", () => {
    expect(edgesToWarm(["mercadopago", "modo", "modo", null, "otro"]).sort()).toEqual(
      ["modo_create_qr", "mp_create_qr", "mp_qr"].sort(),
    );
    for (const fns of Object.values(QR_EDGE_BY_PROVIDER)) expect(fns.length).toBeGreaterThan(0);
  });

  it("no repite el mismo precalentado dentro de la ventana", () => {
    process.env.NEXT_PUBLIC_SUPABASE_URL = "https://x.supabase.co";
    const spy = vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response("ok"));
    warmEdgeFunctions(["pagos360"]);
    warmEdgeFunctions(["pagos360"]);
    expect(spy).toHaveBeenCalledTimes(1);
    expect(spy.mock.calls[0]![0]).toBe("https://x.supabase.co/functions/v1/pagos360");
    expect(edgesToWarm(["pagos360"])).toEqual([]);
    spy.mockRestore();
  });
});
