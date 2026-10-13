import { beforeEach, describe, expect, it, vi } from "vitest";

// F17 · H94 (ADR-080): la producción viaja con la sucursal elegida, igual que
// la merma. Sin sucursal (una sola o sin stock por sucursal) la RPC recibe la
// firma de siempre.
const rpc = vi.fn();
vi.mock("@/lib/supabase/client", () => ({
  createClient: () => ({ rpc }),
}));

import { productsApi } from "@/modules/products/api";

describe("producción por sucursal", () => {
  beforeEach(() => {
    rpc.mockReset();
    rpc.mockResolvedValue({ data: 25, error: null });
  });

  it("manda p_store_id cuando se eligió sucursal", async () => {
    const out = await productsApi.registerProduction("p1", { qty: 5, notes: "tanda" }, "norte");
    expect(out).toBe(25);
    expect(rpc).toHaveBeenCalledWith("register_production", {
      p_product_id: "p1",
      p_qty: 5,
      p_notes: "tanda",
      p_store_id: "norte",
    });
  });

  it("sin sucursal no manda el parámetro (compatible con la base vieja)", async () => {
    await productsApi.registerProduction("p1", { qty: "2" as unknown as number });
    const args = rpc.mock.calls[0]![1] as Record<string, unknown>;
    expect(args).not.toHaveProperty("p_store_id");
    expect(args.p_qty).toBe(2);
  });

  it("propaga el error del servidor (sucursal sin acceso)", async () => {
    rpc.mockResolvedValue({ data: null, error: { message: "forbidden" } });
    await expect(productsApi.registerProduction("p1", { qty: 1 }, "centro")).rejects.toMatchObject({
      message: "forbidden",
    });
  });
});
