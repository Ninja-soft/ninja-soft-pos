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
    const lineId = useCartStore.getState().lines[0]!.lineId;
    setQuantity(lineId, 0);
    expect(useCartStore.getState().lines).toHaveLength(0);
  });

  it("agrega un ítem de monto libre (sin producto)", () => {
    const { addFreeAmount } = useCartStore.getState();
    addFreeAmount({ name: "", amount: 500 });
    const lines = useCartStore.getState().lines;
    expect(lines).toHaveLength(1);
    expect(lines[0]!.productId).toBeNull();
    expect(lines[0]!.name).toBe("Venta rápida");
    expect(lines[0]!.unitPrice).toBe(500);
  });

  it("calcula subtotales con descuento", () => {
    expect(
      lineSubtotal({
        lineId: "l1",
        productId: "p1",
        name: "x",
        sku: null,
        unitPrice: 100,
        quantity: 3,
        discount: 50,
        unit: "un",
      }),
    ).toBe(250);
    expect(
      cartSubtotal([
        { lineId: "l1", productId: "a", name: "a", sku: null, unitPrice: 100, quantity: 1, discount: 0, unit: "un" },
        { lineId: "l2", productId: "b", name: "b", sku: null, unitPrice: 200, quantity: 2, discount: 100, unit: "un" },
      ]),
    ).toBe(400);
  });

  it("agrega por peso (kg) y acumula peso", () => {
    const { addWeighed } = useCartStore.getState();
    const prod = { id: "k1", name: "Jamón", sku: null, price: 1000 };
    addWeighed(prod, 0.25);
    addWeighed(prod, 0.1);
    const lines = useCartStore.getState().lines;
    expect(lines).toHaveLength(1);
    expect(lines[0]!.unit).toBe("kg");
    expect(lines[0]!.quantity).toBeCloseTo(0.35);
    expect(lineSubtotal(lines[0]!)).toBeCloseTo(350);
  });
});
