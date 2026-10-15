// ADR-136: tabla de Depósitos con foto, totales fijos y muchos depósitos
// (tarjetas en el celular, por depósito) y el reparto de entregas del POS.
import { describe, it, expect, vi } from "vitest";
import { fireEvent, render, screen, within } from "@testing-library/react";
import { WarehouseStockView } from "@/components/stock/warehouses/WarehouseStockView";
import { FulfillmentModal } from "@/components/pos/fulfillment/FulfillmentModal";
import type { Warehouse, WarehouseOverviewRow } from "@/lib/stock/warehouses";
import type { FulfillmentLine, FulfillmentSource } from "@/lib/stock/fulfillment";

const wh = (id: string, name: string, kind: Warehouse["kind"] = "reserva", sort = 1): Warehouse => ({
  id,
  store_id: "A",
  name,
  code: null,
  kind,
  sort,
});
const WAREHOUSES = [
  wh("p", "Salón de ventas", "principal", 0),
  wh("c", "Central", "reserva", 1),
  wh("m", "Merma", "merma", 2),
  wh("d1", "Depósito 1", "otro", 3),
  wh("d2", "Depósito 2", "otro", 4),
  wh("d3", "Depósito 3", "otro", 5),
];
const ROWS: WarehouseOverviewRow[] = [
  {
    product_id: "prod-1",
    variant_id: null,
    product_name: "Campera",
    variant_label: null,
    sku: "CAM-1",
    unit: "un",
    store_qty: 10,
    principal_qty: 2,
    in_transit: 0,
    min_qty: null,
    max_qty: null,
    by_warehouse: { c: 4, m: 1, d3: 3 },
  },
];

describe("WarehouseStockView", () => {
  it("muestra la foto del producto, el vendible y la sucursal fijos y el selector de depósitos visibles", () => {
    const { container } = render(
      <WarehouseStockView
        rows={ROWS}
        warehouses={WAREHOUSES}
        thumbs={{ "prod-1": "https://img.test/campera.webp" }}
        loading={false}
        canManage
        onCount={vi.fn()}
      />,
    );
    expect(container.querySelectorAll('img[src="https://img.test/campera.webp"]').length).toBeGreaterThan(0);
    expect(screen.getByRole("button", { name: /Depósitos visibles \(4 de 6\)/ })).toBeTruthy();
    const table = screen.getByRole("table");
    const heads = within(table).getAllByRole("columnheader").map((h) => h.textContent);
    // Salón + 3 depósitos por defecto, y los totales fijos.
    expect(heads).toEqual(["Producto", "Salón de ventas", "Central", "Merma(no se vende)", "Depósito 1", "En tránsito", "Vendible", "Sucursal"]);
    // Vendible = salón 2 + Central 4 + Depósito 3 (3); sin la merma.
    const cells = within(table).getAllByRole("cell").map((c) => c.textContent);
    expect(cells).toContain("9");
  });

  it("por depósito: un depósito a la vez", () => {
    render(<WarehouseStockView rows={ROWS} warehouses={WAREHOUSES} thumbs={{}} loading={false} canManage={false} onCount={vi.fn()} />);
    fireEvent.click(screen.getByRole("radio", { name: "Por depósito" }));
    fireEvent.click(screen.getByRole("radio", { name: "Depósito 3" }));
    const heads = within(screen.getByRole("table")).getAllByRole("columnheader").map((h) => h.textContent);
    expect(heads).toEqual(["Producto", "Depósito 3", "En tránsito", "Vendible", "Sucursal"]);
  });

  it("contar desde la celda de un depósito (dueño o encargado)", () => {
    const onCount = vi.fn();
    render(<WarehouseStockView rows={ROWS} warehouses={WAREHOUSES} thumbs={{}} loading={false} canManage onCount={onCount} />);
    const table = screen.getByRole("table");
    fireEvent.click(within(table).getAllByTitle("Contar")[0]!);
    expect(onCount).toHaveBeenCalledWith(expect.objectContaining({ productId: "prod-1", current: 4 }));
  });
});

describe("FulfillmentModal", () => {
  const lines: FulfillmentLine[] = [{ key: "prod-1|", productId: "prod-1", variantId: null, name: "Campera", quantity: 5, localOnly: false }];
  const sources: FulfillmentSource[] = [
    { product_id: "prod-1", variant_id: null, store_id: "A", store_name: "Centro", warehouse_id: null, warehouse_name: "Salón de ventas", kind: "principal", own_store: true, sale_priority: 0, available: 2 },
    { product_id: "prod-1", variant_id: null, store_id: "B", store_name: "Norte", warehouse_id: "wb", warehouse_name: "Depósito", kind: "reserva", own_store: false, sale_priority: 10, available: 6 },
  ];
  const stores = [
    { id: "A", name: "Centro" },
    { id: "B", name: "Norte" },
  ];

  it("sugiere el reparto, arma las entregas y devuelve el plan", () => {
    const onConfirm = vi.fn();
    render(
      <FulfillmentModal
        open
        onOpenChange={vi.fn()}
        lines={lines}
        sources={sources}
        loading={false}
        rules={{ storeId: "A", retiroEnabled: true, envioEnabled: true, retiroCrossBranch: false }}
        stores={stores}
        customerName="Ana Pérez"
        initial={null}
        onConfirm={onConfirm}
        onClear={vi.fn()}
      />,
    );
    expect(screen.getByText("5 de 5")).toBeTruthy();
    expect(screen.getByText("2 entregas")).toBeTruthy();
    // El título de la entrega (y la opción del selector).
    expect(screen.getAllByText("Retira en Norte").length).toBeGreaterThanOrEqual(2);
    fireEvent.click(screen.getByRole("button", { name: "Usar este reparto" }));
    const [, plan] = onConfirm.mock.calls[0]!;
    expect(plan.deliveries).toHaveLength(2);
    expect(plan.deliveries[1]).toMatchObject({ mode: "retiro", fulfillment_store_id: "B", pickup_name: "Ana Pérez" });
    expect(plan.deliveries[1].items[0]).toMatchObject({ qty: 3, source_store_id: "B", source_warehouse_id: "wb" });
  });

  it("no deja confirmar si el reparto no suma lo vendido", () => {
    render(
      <FulfillmentModal
        open
        onOpenChange={vi.fn()}
        lines={lines}
        sources={sources}
        loading={false}
        rules={{ storeId: "A", retiroEnabled: true, envioEnabled: true, retiroCrossBranch: false }}
        stores={stores}
        customerName={null}
        initial={null}
        onConfirm={vi.fn()}
        onClear={vi.fn()}
      />,
    );
    fireEvent.change(screen.getAllByLabelText("Cantidad")[0]!, { target: { value: "1" } });
    expect(screen.getByText("4 de 5")).toBeTruthy();
    expect((screen.getByRole("button", { name: "Usar este reparto" }) as HTMLButtonElement).disabled).toBe(true);
  });
});
