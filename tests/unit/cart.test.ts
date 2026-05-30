import { describe, it, expect, beforeEach } from "vitest";
import {
  useCartStore,
  cartSubtotal,
  lineSubtotal,
} from "@/modules/pos/store";

const P = { id: "p1", name: "Coca", sku: "C1", price: 100 };

describe("cart store", () => {
  beforeEach(() => {
    useCartStore.setState({ lines: [], discountTotal: 0 });
  });

  it("agrega productos y acumula cantidad al repetir", () => {
    const { addProduct } = useCartStore.getState();
    addProduct(P);
    addProduct(P);
    const lines = useCartStore.getState().lines;
    expect(lines).toHaveLength(1);
    expect(lines[0]!.quantity).toBe(2);
  });

  it("setQuantity a 0 elimina la línea", () => {
    const { addProduct, setQuantity } = useCartStore.getState();
    addProduct(P);
    setQuantity("p1", 0);
    expect(useCartStore.getState().lines).toHaveLength(0);
  });

  it("calcula subtotales con descuento", () => {
    expect(
      lineSubtotal({
        productId: "p1",
        name: "x",
        sku: null,
        unitPrice: 100,
        quantity: 3,
        discount: 50,
      }),
    ).toBe(250);
    expect(
      cartSubtotal([
        { productId: "a", name: "a", sku: null, unitPrice: 100, quantity: 1, discount: 0 },
        { productId: "b", name: "b", sku: null, unitPrice: 200, quantity: 2, discount: 100 },
      ]),
    ).toBe(400);
  });
});
