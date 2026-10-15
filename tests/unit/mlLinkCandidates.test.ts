// ADR-141 (parte A): datos de la publicación para vincular (fotos, GTIN, SKU,
// variaciones) y la variante que se preelige.
import { describe, it, expect } from "vitest";
import { linkContext, splitGtins } from "@/supabase/functions/_shared/mercadolibre/items";
import { codesLine, isStrongMatch, linkMatchTone, matchVariant } from "@/lib/mercadolibre/linkMatch";
import type { MlItem } from "@/supabase/functions/_shared/mercadolibre/types";

describe("splitGtins", () => {
  it("separa varios códigos y descarta lo que no es un EAN", () => {
    expect(splitGtins("7790387000017, 7790387000024")).toEqual(["7790387000017", "7790387000024"]);
    expect(splitGtins("779-0387-000017")).toEqual(["7790387000017"]);
    expect(splitGtins("123")).toEqual([]);
    expect(splitGtins(null)).toEqual([]);
  });
});

describe("linkContext", () => {
  it("publicación simple: fotos, marca, GTIN y SKU", () => {
    const item = {
      title: "Yerba", secure_thumbnail: "https://t", pictures: [{ id: "a", secure_url: "https://a" }, { id: "b", url: "http://b" }],
      attributes: [
        { id: "BRAND", value_name: "Playadito" },
        { id: "GTIN", value_name: "7790387000017" },
        { id: "SELLER_SKU", value_name: "YP1" },
      ],
    } as unknown as MlItem;
    const c = linkContext(item);
    expect(c.pictures).toEqual(["https://a", "http://b"]);
    expect(c.brand).toBe("Playadito");
    expect(c.gtins).toEqual(["7790387000017"]);
    expect(c.skus).toEqual(["YP1"]);
    expect(c.variations).toEqual([]);
  });

  it("sin fotos usa la miniatura", () => {
    expect(linkContext({ title: "x", thumbnail: "http://t" } as unknown as MlItem).pictures).toEqual(["http://t"]);
  });

  it("clásica con variaciones: etiqueta, SKU, GTIN y foto de cada una", () => {
    const item = {
      title: "Remera",
      pictures: [{ id: "p1", secure_url: "https://p1" }, { id: "p2", secure_url: "https://p2" }],
      variations: [
        {
          id: 11, attribute_combinations: [{ id: "COLOR", value_name: "Rojo" }, { id: "SIZE", value_name: "M" }],
          attributes: [{ id: "SELLER_SKU", value_name: "R-M" }, { id: "GTIN", value_name: "7791234567890" }], picture_ids: ["p2"],
        },
        { id: 12, attribute_combinations: [{ id: "COLOR", value_name: "Azul" }], seller_custom_field: "A-1", picture_ids: [] },
      ],
    } as unknown as MlItem;
    const c = linkContext(item);
    expect(c.variations).toEqual([
      { id: "11", label: "Rojo / M", sku: "R-M", gtin: "7791234567890", picture: "https://p2" },
      { id: "12", label: "Azul", sku: "A-1", gtin: null, picture: null },
    ]);
    expect(c.skus).toEqual(["R-M", "A-1"]);
    expect(c.gtins).toEqual(["7791234567890"]);
  });
});

describe("matchVariant", () => {
  const variants = [
    { id: "v1", sku: "R-S", barcode: "7791234567883" },
    { id: "v2", sku: "r-m ", barcode: null },
  ];
  it("prefiere el código de barras y después el SKU sin importar mayúsculas", () => {
    expect(matchVariant({ id: "1", sku: "R-M", gtin: "7791234567883" }, variants)).toBe("v1");
    expect(matchVariant({ id: "1", sku: "R-M", gtin: null }, variants)).toBe("v2");
    expect(matchVariant({ id: "1", sku: "X", gtin: null }, variants)).toBeNull();
    expect(matchVariant(null, variants)).toBeNull();
  });
});

describe("textos", () => {
  it("tono y fuerza de la sugerencia", () => {
    expect(linkMatchTone("gtin")).toBe("success");
    expect(linkMatchTone("title")).toBe("info");
    expect(linkMatchTone(null)).toBe("neutral");
    expect(isStrongMatch("sku")).toBe(true);
    expect(isStrongMatch("title")).toBe(false);
  });
  it("códigos del producto", () => {
    expect(codesLine({ sku: "A1", barcode: "779" })).toBe("SKU A1 · EAN 779");
    expect(codesLine({ sku: null, barcode: null })).toBe("");
  });
});
