import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { EditorPage } from "@/lib/prices/editor";

// ADR-151: editor rápido de precios (planilla, teclado, masiva, vista previa).
const toast = vi.fn();
vi.mock("@/components/ui/Toast", () => ({ useToast: () => ({ toast }) }));
vi.mock("@/modules/saas/gating", () => ({ useFeature: () => true }));
vi.mock("@/modules/tenants/hooks", () => ({ useMyTenant: () => ({ data: { role: "owner", canManage: true } }) }));
vi.mock("@/modules/products/hooks", () => ({
  useCategories: () => ({ data: [] }),
  useBrands: () => ({ data: [] }),
}));
vi.mock("@/modules/purchases/hooks", () => ({ useSuppliers: () => ({ data: [] }) }));
vi.mock("@/modules/prices/proHooks", () => ({ usePriceSettings: () => ({ data: { pro: false, require_approval: false } }) }));
vi.mock("@/modules/prices/proApi", () => ({ priceProApi: { snapshot: vi.fn().mockResolvedValue(null) } }));

const PAGE: EditorPage = {
  total: 2,
  limit: 50,
  offset: 0,
  min_margin_pct: 20,
  lists_enabled: true,
  lists: [{ id: "L", name: "Mayorista", channel: "mayorista", kind: "fixed", currency: null, adjustment_pct: -10, prices_include_tax: true, editable: true }],
  rows: [
    {
      id: "p1", name: "Alfajor", sku: "ALF", barcode: null, image_url: null, category_id: null, brand_id: null,
      is_service: false, is_active: true, has_variants: false, price_mode: "fixed", open_price_min: null, open_price_max: null,
      price: 121, min_price: null, cost: 50, final_cost: 50, cost_currency: "ARS", cost_usd: null, cost_extras: [], iva_pct: 21,
      items: {}, list_prices: { L: 108.9 },
    },
    {
      id: "p2", name: "Turrón", sku: "TUR", barcode: null, image_url: null, category_id: null, brand_id: null,
      is_service: false, is_active: true, has_variants: false, price_mode: "open", open_price_min: null, open_price_max: null,
      price: 200, min_price: null, cost: null, final_cost: null, cost_currency: "ARS", cost_usd: null, cost_extras: [], iva_pct: 21,
      items: { L: 150 }, list_prices: { L: 150 },
    },
  ],
};

const save = vi.fn();
vi.mock("@/modules/prices/editorApi", () => ({
  usePriceEditorRows: () => ({ data: PAGE, isLoading: false, isError: false, isFetching: false, error: null }),
  usePriceEditorSave: () => ({ mutateAsync: save, isPending: false }),
}));

import { QuickPriceEditor } from "@/components/prices/QuickPriceEditor";

function renderEditor() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}>
      <QuickPriceEditor />
    </QueryClientProvider>,
  );
}

const cell = (label: string) => screen.getByLabelText(label) as HTMLInputElement;

function edit(label: string, value: string, key = "Enter", opts: Partial<KeyboardEventInit> = {}) {
  const el = cell(label);
  act(() => el.focus());
  fireEvent.focus(el);
  fireEvent.change(el, { target: { value } });
  fireEvent.keyDown(el, { key, ...opts });
}

beforeEach(() => {
  toast.mockReset();
  save.mockReset();
});

describe("QuickPriceEditor (ADR-151)", () => {
  it("planilla: filas, lista, precio libre y calculado de la lista", () => {
    renderEditor();
    expect(screen.getByText("Alfajor")).toBeInTheDocument();
    expect(screen.getByText("Turrón")).toBeInTheDocument();
    expect(screen.getByRole("columnheader", { name: /Mayorista/ })).toBeInTheDocument();
    expect(screen.getByText("Libre")).toBeInTheDocument();
    expect(cell("Mayorista de Alfajor").value).toBe("108,9");
    expect(cell("Mayorista de Alfajor").className).toMatch(/italic/);
    expect(cell("Margen de Alfajor").value).toBe("50");
  });

  it("Enter guarda y baja de fila, Tab avanza de columna, la celda queda marcada y Ctrl+Z deshace", () => {
    renderEditor();
    edit("Precio de venta de Alfajor", "130");
    expect(document.activeElement).toBe(cell("Precio de venta de Turrón"));
    expect(cell("Precio de venta de Alfajor").value).toBe("130");
    expect(cell("Precio de venta de Alfajor").dataset.modified).toBe("true");
    expect(screen.getByRole("button", { name: /Revisar y guardar \(1\)/ })).toBeEnabled();

    edit("Costo de Alfajor", "50", "Tab");
    expect(document.activeElement).toBe(cell("Precio de venta de Alfajor"));

    fireEvent.keyDown(cell("Precio de venta de Alfajor"), { key: "z", ctrlKey: true });
    expect(cell("Precio de venta de Alfajor").value).toBe("121");
    expect(cell("Precio de venta de Alfajor").dataset.modified).toBeUndefined();
  });

  it("Escape revierte lo tipeado en la celda", () => {
    renderEditor();
    const el = cell("Precio de venta de Alfajor");
    act(() => el.focus());
    fireEvent.focus(el);
    fireEvent.change(el, { target: { value: "999" } });
    fireEvent.keyDown(el, { key: "Escape" });
    expect(el.value).toBe("121");
    fireEvent.blur(el);
    expect(el.dataset.modified).toBeUndefined();
  });

  it("edición masiva: +10 % a las filas elegidas", () => {
    renderEditor();
    fireEvent.click(screen.getByRole("checkbox", { name: "Elegir todos los de la página" }));
    fireEvent.click(screen.getByRole("button", { name: /Edición masiva/ }));
    fireEvent.change(screen.getByLabelText("Valor a aplicar"), { target: { value: "10" } });
    fireEvent.click(screen.getByRole("button", { name: "Aplicar" }));
    expect(cell("Precio de venta de Alfajor").value).toBe("133,1");
    expect(cell("Precio de venta de Turrón").value).toBe("220");
    expect(toast).toHaveBeenCalledWith(expect.objectContaining({ title: "2 productos cambiados" }));
  });

  it("vista previa con resumen y alerta, y guardar manda los cambios", async () => {
    save.mockResolvedValue({ id: "b1", status: "applied", count: 2 });
    renderEditor();
    edit("Precio de venta de Alfajor", "55");
    edit("Mayorista de Turrón", "160");
    fireEvent.click(screen.getByRole("button", { name: /Revisar y guardar \(2\)/ }));
    expect(screen.getByTestId("preview-summary")).toHaveTextContent("2 cambios en 2 productos");
    expect(screen.getByText(/1 debajo del costo/)).toBeInTheDocument();
    expect(screen.getAllByText("Debajo del costo").length).toBeGreaterThan(0);
    fireEvent.change(screen.getByPlaceholderText(/aumento del proveedor/), { target: { value: "Octubre" } });
    fireEvent.click(screen.getByRole("button", { name: "Guardar precios" }));
    await waitFor(() =>
      expect(save).toHaveBeenCalledWith({
        changes: [
          { product_id: "p1", price: 55 },
          { product_id: "p2", lists: { L: 160 } },
        ],
        reason: "Octubre",
      }),
    );
    await waitFor(() => expect(toast).toHaveBeenCalledWith(expect.objectContaining({ title: "Precios aplicados" })));
    expect(screen.getByRole("button", { name: /Revisar y guardar \(0\)/ })).toBeDisabled();
  });
});
