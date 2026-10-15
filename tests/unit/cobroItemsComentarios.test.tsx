// Pestaña "Ítems" de la hoja de cobro: cantidad y precio por línea con el total
// en vivo, comentario por renglón (line_note, ADR-116) que viaja a create_sale
// y sale en el comprobante, y la fila del carrito con "Precio a definir".
import { describe, expect, it, beforeEach, vi } from "vitest";
import { act, fireEvent, render, screen } from "@testing-library/react";
import { CheckoutItemsBlock } from "@/components/pos/checkout/CheckoutItemsBlock";
import { CartLines } from "@/components/pos/screen/CartPane";
import { money as rawMoney } from "@/components/pos/ui/posStyles";
import { InvoiceDocument } from "@/components/invoices/InvoiceDocument";
import { LINE_NOTE_MAX, linePriceToDefine, normalizeLineNote } from "@/lib/pos/cartLine";
import { invoiceFromTicket } from "@/lib/invoices/fromTicket";
import { sampleServiceSale } from "@/lib/invoices/samples";
import { serviceOfItem } from "@/lib/invoices/serviceFields";
import { resolveInvoiceStyle } from "@/lib/invoices/style";
import { buildSaleItemsAndExtras } from "@/modules/pending-charges/logic";
import { cartToSaleLines } from "@/modules/pos/screen/usePosSale";
import { cartSubtotal, useCartStore, type CartLine } from "@/modules/pos/store";

// Testing Library normaliza los espacios (el precio usa espacio duro).
const money = (n: number) => rawMoney(n).replace(/\s+/g, " ");

// La hoja real lee el mismo carrito: el total que muestra es cartSubtotal.
function Harness({ onEditPrice }: { onEditPrice?: (id: string) => void }) {
  const lines = useCartStore((s) => s.lines);
  const s = useCartStore.getState();
  return (
    <>
      <output aria-label="Total">{money(cartSubtotal(lines))}</output>
      <CheckoutItemsBlock
        open
        lines={lines}
        onQty={s.setQuantity}
        onRemove={s.removeLine}
        onEditPrice={onEditPrice}
        onNote={(id, note) => s.setLineService(id, { lineNote: note })}
      />
    </>
  );
}

const total = () => screen.getByLabelText("Total").textContent;

beforeEach(() => {
  useCartStore.getState().clear();
  const add = useCartStore.getState().addProduct;
  add({ id: "p-1", name: "Direccion tecnica bromatologica", sku: null, price: 0 });
  add({ id: "p-2", name: "Análisis de agua", sku: null, price: 1500 });
});

describe("pestaña Ítems de la hoja de cobro", () => {
  it("un precio sin definir abre la pestaña y avisa", () => {
    render(<Harness onEditPrice={() => {}} />);
    expect(screen.getByRole("button", { name: /^Ítems/ })).toHaveTextContent("Falta un precio");
    expect(screen.getByRole("button", { name: "Definir el precio de Direccion tecnica bromatologica" })).toHaveTextContent(
      "Precio a definir",
    );
  });

  it("editar la cantidad recalcula el total", () => {
    render(<Harness onEditPrice={() => {}} />);
    expect(total()).toBe(money(1500));
    fireEvent.click(screen.getByRole("button", { name: "Sumar Análisis de agua" }));
    fireEvent.click(screen.getByRole("button", { name: "Sumar Análisis de agua" }));
    expect(total()).toBe(money(4500));
    expect(screen.getByLabelText("Subtotal de Análisis de agua")).toHaveTextContent(money(4500));
    fireEvent.click(screen.getByRole("button", { name: "Restar Análisis de agua" }));
    expect(total()).toBe(money(3000));
    // En 1 no baja a 0: para sacarlo está "Quitar".
    fireEvent.click(screen.getByRole("button", { name: "Restar Análisis de agua" }));
    expect(screen.getByRole("button", { name: "Restar Análisis de agua" })).toBeDisabled();
    fireEvent.click(screen.getByRole("button", { name: "Quitar Análisis de agua" }));
    expect(total()).toBe(money(0));
    // La única línea que queda no se quita desde el cobro.
    expect(screen.getByRole("button", { name: "Quitar Direccion tecnica bromatologica" })).toBeDisabled();
  });

  it("editar el precio usa el cambio de precio con motivo y recalcula el total", () => {
    const onEditPrice = vi.fn();
    render(<Harness onEditPrice={onEditPrice} />);
    fireEvent.click(screen.getByRole("button", { name: "Definir el precio de Direccion tecnica bromatologica" }));
    const id = useCartStore.getState().lines[0]!.lineId;
    expect(onEditPrice).toHaveBeenCalledWith(id);
    // Lo que confirma el diálogo de precio (ADR-056).
    act(() => useCartStore.getState().setLinePrice(id, 25000, "Honorarios de octubre"));
    expect(total()).toBe(money(26500));
    expect(screen.getByRole("button", { name: "Cambiar el precio de Direccion tecnica bromatologica" })).toHaveTextContent(
      `${money(25000)} c/u`,
    );
    expect(screen.getByRole("button", { name: /^Ítems/ })).not.toHaveTextContent("Falta un precio");
  });

  it("sin permiso para cambiar el precio, se ve pero no se toca", () => {
    render(<Harness />);
    expect(screen.queryByRole("button", { name: /precio de Análisis de agua/ })).toBeNull();
    expect(screen.getByText(`${money(1500)} c/u`)).toBeInTheDocument();
  });

  it("el comentario se guarda con contador, viaja en el payload y sale en el comprobante", () => {
    render(<Harness onEditPrice={() => {}} />);
    fireEvent.click(screen.getByRole("button", { name: "Agregar comentario a Análisis de agua" }));
    const area = screen.getByLabelText("Comentario para la factura");
    expect(area).toHaveAttribute("maxLength", String(LINE_NOTE_MAX));
    fireEvent.change(area, { target: { value: "  Muestra N° 45, tanque de reserva " } });
    expect(screen.getByText(`35/${LINE_NOTE_MAX}`)).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Guardar" }));

    const line = useCartStore.getState().lines.find((l) => l.productId === "p-2")!;
    expect(line.lineNote).toBe("Muestra N° 45, tanque de reserva");
    expect(screen.getByText("Muestra N° 45, tanque de reserva")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /^Ítems/ })).toHaveTextContent("1 con comentario");

    // Payload de create_sale: line_note en la línea (también en un producto).
    const { items } = buildSaleItemsAndExtras(cartToSaleLines(useCartStore.getState().lines), []);
    expect(items[1]).toMatchObject({ product_id: "p-2", line_note: "Muestra N° 45, tanque de reserva" });
    expect(items[0]).not.toHaveProperty("line_note");

    // Lo que guarda create_sale (sale_items.line_note) vuelve al comprobante.
    const s = sampleServiceSale(null);
    const row = { id: "i1", product_name: "Análisis de agua", quantity: 1, unit_price: 1500, subtotal: 1500, line_note: "Muestra N° 45, tanque de reserva" };
    const data = {
      ...s,
      sale: { ...s.sale, fiscal: null, service_from: null, service_to: null, payment_due: null, subtotal: 1500, total: 1500 },
      items: [{ ...row, ...serviceOfItem(row) }],
    };
    const doc = invoiceFromTicket(data);
    expect(doc.lines[0]!.detailLines).toEqual([{ bullet: false, text: "Muestra N° 45, tanque de reserva" }]);
    const style = resolveInvoiceStyle({}, null, { pro: true, unbranded: true });
    for (const format of ["a4", "80"] as const) {
      const { container, unmount } = render(<InvoiceDocument doc={doc} style={style} format={format} />);
      expect(container.textContent).toContain("Muestra N° 45, tanque de reserva");
      unmount();
    }
  });

  it("borrar el comentario lo saca del payload", () => {
    const id = useCartStore.getState().lines[1]!.lineId;
    useCartStore.getState().setLineService(id, { lineNote: "Lote 9" });
    render(<Harness onEditPrice={() => {}} />);
    fireEvent.click(screen.getByRole("button", { name: "Editar el comentario de Análisis de agua" }));
    fireEvent.click(screen.getByRole("button", { name: "Borrar" }));
    expect(useCartStore.getState().lines[1]!.lineNote).toBeNull();
    const { items } = buildSaleItemsAndExtras(cartToSaleLines(useCartStore.getState().lines), []);
    expect(items[1]).not.toHaveProperty("line_note");
  });
});

describe("reglas de la línea", () => {
  const base: CartLine = { lineId: "l", productId: "p", name: "X", sku: null, unitPrice: 0, quantity: 1, discount: 0, unit: "un" };
  it("precio a definir: producto a $0 que se cobra (no regalos, packs ni montos libres)", () => {
    expect(linePriceToDefine(base)).toBe(true);
    expect(linePriceToDefine({ ...base, unitPrice: 10 })).toBe(false);
    expect(linePriceToDefine({ ...base, giftPromoId: "promo" })).toBe(false);
    expect(linePriceToDefine({ ...base, packCreditId: "c" })).toBe(false);
    expect(linePriceToDefine({ ...base, productId: null })).toBe(false);
  });
  it("comentario: recorta espacios y el largo; vacío es sin comentario", () => {
    expect(normalizeLineNote("   ")).toBeNull();
    expect(normalizeLineNote(" hola ")).toBe("hola");
    expect(normalizeLineNote("x".repeat(300))).toHaveLength(LINE_NOTE_MAX);
  });
});

describe("fila del carrito", () => {
  const lines: CartLine[] = [
    { lineId: "a", productId: "p-1", name: "Direccion tecnica bromatologica", sku: null, unitPrice: 0, quantity: 1, discount: 0, unit: "un", lineNote: "Período octubre" },
    { lineId: "b", productId: "p-2", name: "Análisis de agua", sku: null, unitPrice: 1500, quantity: 2, discount: 0, unit: "un" },
  ];
  it("precio a definir abre el editor de precio; precio unitario, tooltip y comentario a la vista", () => {
    const onEditPrice = vi.fn();
    render(
      <CartLines
        lines={lines}
        onQty={() => {}}
        onRemove={() => {}}
        creditForLine={() => null}
        onCover={() => {}}
        onUncover={() => {}}
        onEditPrice={onEditPrice}
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: "Definir el precio de Direccion tecnica bromatologica" }));
    expect(onEditPrice).toHaveBeenCalledWith("a");
    expect(screen.getByText(`${money(1500)} c/u`)).toBeInTheDocument();
    expect(screen.getByTitle("Direccion tecnica bromatologica")).toBeInTheDocument();
    expect(screen.getByText("Período octubre")).toBeInTheDocument();
    expect(screen.getByText(money(3000))).toBeInTheDocument();
  });
});
