// ADR-141 (parte A): "Vincular con un producto" muestra la foto de la
// publicación y las de los productos, los sugeridos por código de barras o SKU
// arriba, busca por nombre, SKU, código o marca, preelige la variante y
// vincula con el motivo de la sugerencia.
import { describe, it, expect, vi, beforeEach } from "vitest";
import { fireEvent, render, screen, within } from "@testing-library/react";
import type { MlItem } from "@/modules/mercadolibre/hooks";

vi.mock("@/components/ui/Toast", () => ({ useToast: () => ({ toast: vi.fn() }) }));

const linkMutate = vi.fn();
vi.mock("@/modules/mercadolibre/hooks", () => ({
  useMlMutations: () => ({ link: { mutate: linkMutate, isPending: false } }),
}));

const candidatesCalls: Array<{ search: string; ids: unknown }> = [];
const suggested = [
  {
    product_id: "p1", name: "Yerba Playadito 1 kg", sku: "YP1", barcode: "7790387000017", brand: "PLAYADITO",
    image_url: "https://img.test/yerba.jpg", has_variants: false, price: 4500, stock: 12, variant_id: null,
    variant_label: null, match: "gtin", score: 1060, words_hit: 3, linked_elsewhere: 0,
  },
  {
    product_id: "p2", name: "Yerba Playadito 500 g", sku: "YP05", barcode: null, brand: "PLAYADITO",
    image_url: null, has_variants: false, price: 2400, stock: 3, variant_id: null,
    variant_label: null, match: "title", score: 60, words_hit: 3, linked_elsewhere: 1,
  },
];
const remeras = [
  {
    product_id: "p9", name: "Remera lisa", sku: "REM", barcode: null, brand: "NINJA", image_url: "https://img.test/remera.jpg",
    has_variants: true, price: 9000, stock: 5, variant_id: "v2", variant_label: "M / Negra", match: "sku", score: 900,
    words_hit: 0, linked_elsewhere: 0,
  },
];
let ctxData: unknown = {
  pictures: ["https://img.test/ml-1.jpg", "https://img.test/ml-2.jpg"],
  brand: "Playadito",
  model: null,
  gtins: ["7790387000017"],
  skus: ["YP1"],
  variations: [],
};
vi.mock("@/modules/mercadolibre/linkHooks", () => ({
  useMlLinkContext: () => ({ data: ctxData, isLoading: false, isError: false }),
  useMlLinkCandidates: (_item: string, search: string, ids: unknown) => {
    candidatesCalls.push({ search, ids });
    const list = search.toLowerCase().includes("remera") ? remeras : search ? [] : suggested;
    return { data: { item: {}, words: [], searching: Boolean(search), candidates: list }, isFetching: false, isError: false };
  },
}));
vi.mock("@/modules/products/hooks", () => ({
  useVariants: (productId: string | null) => ({
    data: productId === "p9"
      ? [
          { id: "v1", option1: "S", option2: "Negra", sku: "REM-S", barcode: null },
          { id: "v2", option1: "M", option2: "Negra", sku: "REM-M", barcode: null },
        ]
      : [],
  }),
}));

import { LinkProductModal } from "@/components/mercadolibre/LinkProductModal";

const item = {
  id: "row-1", account_id: "acc", ml_item_id: "MLA123456", title: "Yerba Mate Playadito 1kg", thumbnail: "https://img.test/thumb.jpg",
  price: 4800, permalink: "https://articulo.mercadolibre.com.ar/MLA-123456", has_variations: false,
} as unknown as MlItem;

describe("LinkProductModal", () => {
  beforeEach(() => {
    linkMutate.mockReset();
    candidatesCalls.length = 0;
  });

  it("muestra la foto de la publicación y la de cada producto sugerido", () => {
    render(<LinkProductModal item={item} onClose={() => {}} />);
    const pub = screen.getByRole("region", { name: "Publicación de Mercado Libre" });
    expect(within(pub).getByText("Yerba Mate Playadito 1kg")).toBeTruthy();
    expect(within(pub).getByText(/Marca Playadito/)).toBeTruthy();
    expect(within(pub).getByText(/EAN 7790387000017/)).toBeTruthy();
    const imgs = Array.from(document.querySelectorAll("img")).map((i) => i.getAttribute("src"));
    expect(imgs).toContain("https://img.test/ml-1.jpg");
    expect(imgs).toContain("https://img.test/yerba.jpg");
    const list = screen.getByRole("list", { name: "Sugeridos" });
    expect(within(list).getByText("Mismo código de barras")).toBeTruthy();
    expect(within(list).getByText("Nombre parecido")).toBeTruthy();
    expect(within(list).getByText(/ya vinculado a 1/)).toBeTruthy();
  });

  it("manda el GTIN y el SKU de la publicación para sugerir", () => {
    render(<LinkProductModal item={item} onClose={() => {}} />);
    expect(candidatesCalls[0]!.ids).toEqual({ gtins: ["7790387000017"], skus: ["YP1"] });
  });

  it("vincula el sugerido por código de barras con ese motivo", () => {
    render(<LinkProductModal item={item} onClose={() => {}} />);
    fireEvent.click(screen.getByText("Yerba Playadito 1 kg"));
    fireEvent.click(screen.getByRole("button", { name: "Vincular" }));
    expect(linkMutate).toHaveBeenCalledWith(
      expect.objectContaining({ itemId: "row-1", productId: "p1", variantId: null, by: "gtin" }),
      expect.anything(),
    );
  });

  it("busca y preelige la variante que encontró el servidor", () => {
    render(<LinkProductModal item={item} onClose={() => {}} />);
    fireEvent.change(screen.getByLabelText("Buscar producto"), { target: { value: "remera" } });
    expect(screen.getByRole("list", { name: "Resultados" })).toBeTruthy();
    fireEvent.click(screen.getByText("Remera lisa"));
    const sel = screen.getByLabelText("Variante") as HTMLSelectElement;
    expect(sel.value).toBe("v2");
    fireEvent.click(screen.getByRole("button", { name: "Vincular" }));
    expect(linkMutate).toHaveBeenCalledWith(expect.objectContaining({ productId: "p9", variantId: "v2", by: "sku" }), expect.anything());
  });

  it("publicación clásica: elige la variación de una lista en vez de tipear el id", () => {
    ctxData = {
      pictures: [], brand: null, model: null, gtins: [], skus: [],
      variations: [{ id: "177001", label: "Rojo / XL", sku: "R-XL", gtin: null, picture: "https://img.test/rojo.jpg" }],
    };
    render(<LinkProductModal item={{ ...item, has_variations: true } as MlItem} onClose={() => {}} />);
    const sel = screen.getByLabelText("Variación de Mercado Libre") as HTMLSelectElement;
    fireEvent.change(sel, { target: { value: "177001" } });
    fireEvent.click(screen.getByText("Yerba Playadito 1 kg"));
    fireEvent.click(screen.getByRole("button", { name: "Vincular" }));
    expect(linkMutate).toHaveBeenCalledWith(expect.objectContaining({ variationId: "177001" }), expect.anything());
  });
});
