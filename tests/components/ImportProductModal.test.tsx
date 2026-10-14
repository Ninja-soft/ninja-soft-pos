// ADR-118: el diálogo previo al import muestra si el producto del catálogo
// tiene EAN y medidas. Sin EAN: aviso, el código de la tienda como SKU y un
// campo para cargar el EAN antes de importar (va como código de barras).
import { describe, it, expect, vi, beforeEach } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";

const mutateAsync = vi.fn();
const toast = vi.fn();

vi.mock("@/modules/products/hooks", () => ({ useCategories: () => ({ data: [], isLoading: false }) }));
vi.mock("@/modules/tiendita/hooks", () => ({ useImportCatalogProduct: () => ({ mutateAsync }) }));
vi.mock("@/components/catalog/MarketReferencePanel", () => ({ MarketReferencePanel: () => null }));
vi.mock("@/components/ui/Toast", () => ({ useToast: () => ({ toast }) }));
vi.mock("@/components/products/CategoryPathEditor", () => ({ CategoryPathEditor: () => null }));
vi.mock("@/components/products/AttributesEditor", () => ({ AttributesEditor: () => null }));
vi.mock("@/modules/products/images", () => ({ uploadProductImage: vi.fn() }));
vi.mock("@/lib/supabase/client", () => ({ createClient: () => ({}) }));

import { ImportProductModal } from "@/components/tiendita/ImportProductModal";
import type { CatalogSearchResult } from "@/modules/tiendita/storefront";

const base: CatalogSearchResult = {
  catalogProductId: 10,
  storeKey: "MEGATONE",
  ean: null,
  codigoTienda: "M-4455",
  medidas: null,
  titulo: "Heladera No Frost Gafa 300 L",
  precio: 900000,
  precioLista: null,
  marca: "Gafa",
  categoriaPath: "Electro > Heladeras",
  fotoUrl: null,
  disponible: true,
  descripcion: null,
  atributos: null,
};

function open(product: CatalogSearchResult) {
  return render(
    <ImportProductModal open onOpenChange={() => {}} catalogId="c1" product={product} onImported={() => {}} />,
  );
}

describe("ImportProductModal: EAN y medidas", () => {
  beforeEach(() => {
    mutateAsync.mockReset();
    mutateAsync.mockResolvedValue({ productId: "p1", existing: false, imagePending: false });
    toast.mockReset();
  });

  it("sin EAN: aviso, código de la tienda como SKU y campo para cargar el EAN", async () => {
    open(base);
    const aviso = await screen.findByTestId("import-sin-ean");
    expect(aviso.textContent).toContain("Sin EAN");
    expect(aviso.textContent).toContain("M-4455");
    expect(aviso.textContent).toContain("podés agregar el código de barras después");
    expect((screen.getByLabelText("SKU (código de la tienda)") as HTMLInputElement).value).toBe("M-4455");
    expect(screen.getByTestId("import-sin-medidas").textContent).toContain("Sin medidas");

    fireEvent.change(screen.getByLabelText("Código de barras (EAN), si lo tenés"), { target: { value: "7790070012050" } });
    fireEvent.click(screen.getByRole("button", { name: /Importar producto/ }));
    await waitFor(() => expect(mutateAsync).toHaveBeenCalledTimes(1));
    const { overrides } = mutateAsync.mock.calls[0]![0];
    expect(overrides.barcode).toBe("7790070012050");
    expect(overrides.sku).toBe("M-4455");
  });

  it("sin EAN y sin cargarlo: se importa sin código de barras", async () => {
    open(base);
    await screen.findByTestId("import-sin-ean");
    fireEvent.click(screen.getByRole("button", { name: /Importar producto/ }));
    await waitFor(() => expect(mutateAsync).toHaveBeenCalledTimes(1));
    expect(mutateAsync.mock.calls[0]![0].overrides.barcode).toBeNull();
  });

  it("EAN mal tipeado: avisa pero no bloquea", async () => {
    open(base);
    await screen.findByTestId("import-sin-ean");
    fireEvent.change(screen.getByLabelText("Código de barras (EAN), si lo tenés"), { target: { value: "7790070012051" } });
    expect(screen.getByText(/No parece un EAN válido/)).toBeTruthy();
  });

  it("con EAN y medidas: muestra el EAN y cuáles medidas trae", async () => {
    open({
      ...base,
      ean: "7790070012050",
      codigoTienda: null,
      medidas: { peso_kg: 0.92, contenido: { valor: 900, unidad: "ml" }, alto_cm: 28, ancho_cm: 8, profundidad_cm: 8, unidades_pack: 6 },
    });
    const ean = await screen.findByTestId("import-ean");
    expect(ean.textContent).toContain("Con EAN");
    expect(ean.textContent).toContain("7790070012050");
    expect(screen.queryByTestId("import-sin-ean")).toBeNull();
    const med = screen.getByTestId("import-medidas").textContent ?? "";
    expect(med).toContain("Peso: 920 g");
    expect(med).toContain("Volumen: 900 ml");
    expect(med).toContain("Dimensiones: 28 × 8 × 8 cm");
    expect(med).toContain("Unidades por pack: 6");
    expect((screen.getByLabelText("SKU") as HTMLInputElement).value).toBe("");
  });

  it("SKU ocupado: mensaje claro", async () => {
    mutateAsync.mockRejectedValue(new Error("sku_taken"));
    open(base);
    await screen.findByTestId("import-sin-ean");
    fireEvent.click(screen.getByRole("button", { name: /Importar producto/ }));
    await waitFor(() => expect(toast).toHaveBeenCalled());
    expect(toast.mock.calls[0]![0].description).toContain("Ese SKU ya lo usa otro de tus productos");
  });
});
