import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Product } from "@/modules/products/api";
import { decideScan, moveIndex, stockLabel, visibleResults } from "@/lib/products/productSearch";

// --- mocks -------------------------------------------------------------------
const toast = vi.fn();
vi.mock("@/components/ui/Toast", () => ({ useToast: () => ({ toast }) }));

let found: Partial<Product>[] = [];
vi.mock("@/modules/products/hooks", () => ({
  useProducts: (search: string) => ({ data: search ? found : [], isFetching: false }),
}));

const findAllByCode = vi.fn();
const listVariants = vi.fn();
vi.mock("@/modules/products/api", async (orig) => {
  const real = await orig<typeof import("@/modules/products/api")>();
  return {
    ...real,
    productsApi: { findAllByCode: (c: string) => findAllByCode(c) },
    variantsApi: { list: (id: string) => listVariants(id) },
  };
});

let storeRows: { store_id: string; product_id: string; variant_id: string | null; qty: number }[] = [];
vi.mock("@/modules/stock/hooks", () => ({
  useMultiStoreStock: () => ({ enabled: true }),
  useStockByStore: () => ({ data: storeRows }),
}));

import { ProductSearchCombobox } from "@/components/products/ProductSearchCombobox";

const prod = (over: Partial<Product>): Product =>
  ({
    id: "p1",
    name: "Coca 500",
    sku: null,
    barcode: null,
    plu: null,
    stock: 10,
    track_stock: true,
    is_kit: false,
    has_variants: false,
    image_url: null,
    ...over,
  }) as Product;

// Simula un lector HID: caracteres rápidos y Enter.
function scan(code: string) {
  for (const ch of code) fireEvent.keyDown(window, { key: ch });
  fireEvent.keyDown(window, { key: "Enter" });
}

beforeEach(() => {
  toast.mockReset();
  findAllByCode.mockReset();
  listVariants.mockReset();
  found = [];
  storeRows = [];
});

// --- puro ----------------------------------------------------------------------
describe("productSearch (puro)", () => {
  it("filtra, recorta y exige 2 caracteres", () => {
    const list = [prod({ id: "a" }), prod({ id: "b", is_kit: true }), prod({ id: "c" })];
    expect(visibleResults(list, "c")).toEqual([]);
    expect(visibleResults(list, "co", (p) => !p.is_kit).map((p) => p.id)).toEqual(["a", "c"]);
    expect(visibleResults(list, "co", undefined, 1)).toHaveLength(1);
  });

  it("stock: sin control si no trackea", () => {
    expect(stockLabel(false, 5)).toBe("sin control");
    expect(stockLabel(true, 2.5)).toBe("2.5");
    expect(stockLabel(null, null)).toBe("0");
  });

  it("flechas circulares", () => {
    expect(moveIndex(-1, 1, 3)).toBe(0);
    expect(moveIndex(-1, -1, 3)).toBe(2);
    expect(moveIndex(2, 1, 3)).toBe(0);
    expect(moveIndex(0, 1, 0)).toBe(-1);
  });

  it("escaneo: único → directo, varios → lista, filtrado → rechazo", () => {
    const a = { product: prod({ id: "a" }) };
    const k = { product: prod({ id: "k", is_kit: true }) };
    const f = (p: Product) => !p.is_kit;
    expect(decideScan([], f)).toEqual({ kind: "not_found" });
    expect(decideScan([a, k], f)).toEqual({ kind: "pick", match: a });
    expect(decideScan([k], f)).toEqual({ kind: "rejected", match: k });
    expect(decideScan([a, { product: prod({ id: "b" }) }], f)).toEqual({ kind: "list" });
  });
});

// --- componente ------------------------------------------------------------------
describe("ProductSearchCombobox", () => {
  it("muestra foto, stock de la sucursal, EAN y PLU; aplica el filtro", () => {
    found = [
      prod({ id: "a", name: "Alfajor", barcode: "7790001", plu: "000123", image_url: "https://x/a.webp" }),
      prod({ id: "k", name: "Combo kit", is_kit: true }),
      prod({ id: "s", name: "Servicio", track_stock: false }),
    ];
    storeRows = [{ store_id: "st1", product_id: "a", variant_id: null, qty: 4 }];
    render(<ProductSearchCombobox onPick={vi.fn()} storeId="st1" filter={(p) => !p.is_kit} />);
    fireEvent.change(screen.getByRole("combobox"), { target: { value: "al" } });

    const options = screen.getAllByRole("option");
    expect(options).toHaveLength(2);
    expect(options[0]).toHaveTextContent("Alfajor");
    expect(options[0]).toHaveTextContent("Stock: 4");
    expect(options[0]).toHaveTextContent("EAN 7790001");
    expect(options[0]).toHaveTextContent("PLU 000123");
    expect(options[0]!.querySelector("img")).toHaveAttribute("src", "https://x/a.webp");
    expect(options[1]).toHaveTextContent("sin control");
    expect(screen.queryByText("Combo kit")).toBeNull();
  });

  it("sin resultados", () => {
    found = [];
    render(<ProductSearchCombobox onPick={vi.fn()} emptyHint="Los kits no se compran." />);
    fireEvent.change(screen.getByRole("combobox"), { target: { value: "zz" } });
    expect(screen.getByText("Sin resultados.")).toBeInTheDocument();
    expect(screen.getByText("Los kits no se compran.")).toBeInTheDocument();
  });

  it("teclado: flechas + Enter eligen, aria-activedescendant sigue la opción, Esc cierra", () => {
    found = [prod({ id: "a", name: "Uno" }), prod({ id: "b", name: "Dos" })];
    const onPick = vi.fn();
    render(<ProductSearchCombobox onPick={onPick} />);
    const input = screen.getByRole("combobox");
    fireEvent.change(input, { target: { value: "xx" } });
    expect(input).toHaveAttribute("aria-expanded", "true");

    fireEvent.keyDown(input, { key: "ArrowDown" });
    fireEvent.keyDown(input, { key: "ArrowDown" });
    const opts = screen.getAllByRole("option");
    expect(input.getAttribute("aria-activedescendant")).toBe(opts[1]!.id);
    expect(opts[1]).toHaveAttribute("aria-selected", "true");

    fireEvent.keyDown(input, { key: "ArrowDown" }); // vuelve al primero
    fireEvent.keyDown(input, { key: "Enter" });
    expect(onPick).toHaveBeenCalledWith(expect.objectContaining({ id: "a" }), null);
    expect(input).toHaveValue("");

    fireEvent.change(input, { target: { value: "xx" } });
    expect(screen.getByRole("listbox")).toBeInTheDocument();
    fireEvent.keyDown(input, { key: "Escape" });
    expect(screen.queryByRole("listbox")).toBeNull();
  });

  it("producto con variantes: elige la variante en la lista", async () => {
    found = [prod({ id: "r", name: "Remera", has_variants: true })];
    listVariants.mockResolvedValue([
      { id: "v1", product_id: "r", option1: "M", option2: "Rojo", stock: 3, barcode: "111", sku: null },
    ]);
    const onPick = vi.fn();
    render(<ProductSearchCombobox onPick={onPick} />);
    fireEvent.change(screen.getByRole("combobox"), { target: { value: "re" } });
    fireEvent.click(screen.getByRole("option"));
    const variant = await screen.findByRole("option", { name: /M \/ Rojo/ });
    expect(variant).toHaveTextContent("EAN 111");
    fireEvent.click(variant);
    expect(onPick).toHaveBeenCalledWith(
      expect.objectContaining({ id: "r" }),
      expect.objectContaining({ id: "v1" }),
    );
  });

  it("escáner con EAN exacto agrega directo", async () => {
    const p = prod({ id: "e", name: "Agua", barcode: "7791234567890" });
    findAllByCode.mockResolvedValue([{ product: p }]);
    const onPick = vi.fn();
    render(<ProductSearchCombobox onPick={onPick} />);
    await act(async () => scan("7791234567890"));
    await waitFor(() => expect(onPick).toHaveBeenCalledWith(p, null));
    expect(findAllByCode).toHaveBeenCalledWith("7791234567890");
  });

  it("escáner con varias coincidencias muestra la lista", async () => {
    findAllByCode.mockResolvedValue([
      { product: prod({ id: "a", name: "Uno" }) },
      { product: prod({ id: "b", name: "Dos" }) },
    ]);
    found = [prod({ id: "a", name: "Uno" }), prod({ id: "b", name: "Dos" })];
    const onPick = vi.fn();
    render(<ProductSearchCombobox onPick={onPick} />);
    await act(async () => scan("7790000"));
    await waitFor(() => expect(screen.getAllByRole("option")).toHaveLength(2));
    expect(screen.getByRole("combobox")).toHaveValue("7790000");
    expect(onPick).not.toHaveBeenCalled();
  });

  it("escáner con producto filtrado avisa y no agrega", async () => {
    findAllByCode.mockResolvedValue([{ product: prod({ id: "k", name: "Combo", is_kit: true }) }]);
    const onPick = vi.fn();
    render(
      <ProductSearchCombobox
        onPick={onPick}
        filter={(p) => !p.is_kit}
        rejectMessage={(p) => `${p.name} es un kit`}
      />,
    );
    await act(async () => scan("123456"));
    await waitFor(() => expect(toast).toHaveBeenCalledWith(expect.objectContaining({ title: "Combo es un kit" })));
    expect(onPick).not.toHaveBeenCalled();
  });
});
