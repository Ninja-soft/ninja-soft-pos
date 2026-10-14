// Portada de Tiendita: tiendas → íconos, filtro por catálogo activo, contador
// "Más de N" y spinner del buscador.
import { describe, it, expect } from "vitest";
import {
  buildIntroShowcase,
  iconInk,
  introCountLabel,
  marqueeRows,
  roundDownNice,
  storeInitials,
  toIntroStore,
} from "@/modules/tiendita/introShowcase";
import { catalogSearchBusy } from "@/modules/tiendita/searchState";

const STORES = [
  { key: "COTO", name: "Coto", logo_url: "https://x/coto.png" },
  { key: "BNA", name: "Tienda BNA", logo_url: null },
  { key: "NUEVA", name: "Tienda Nueva", logo_url: "https://x/nueva.png" },
  { key: "SUELTA", name: "Suelta", logo_url: null },
];

describe("toIntroStore", () => {
  it("usa el ícono oficial por key (sin importar mayúsculas)", () => {
    expect(toIntroStore({ key: "coto", name: "Coto", logo_url: null }).icon).toBe(
      "/tiendas/iconos/coto.webp",
    );
    expect(toIntroStore(STORES[1]!).icon).toBe("/tiendas/iconos/bna.webp");
  });
  it("sin ícono oficial cae al logo_url y deja iniciales", () => {
    const s = toIntroStore(STORES[2]!);
    expect(s.icon).toBeNull();
    expect(s.logoUrl).toBe("https://x/nueva.png");
    expect(s.initials).toBe("NU");
  });
  it("marca la tinta de los íconos que se pierden en un tema", () => {
    expect(iconInk("BANCOR")).toBe("light");
    expect(iconInk("provincia")).toBe("light");
    expect(iconInk("MACRO")).toBe("dark");
    expect(iconInk("COTO")).toBeNull();
  });
});

describe("storeInitials", () => {
  it("ignora la palabra Tienda", () => {
    expect(storeInitials("Tienda BNA")).toBe("BN");
    expect(storeInitials("Provincia Compras")).toBe("PC");
    expect(storeInitials("Tienda")).toBe("TI");
  });
});

describe("buildIntroShowcase", () => {
  const cats = [
    { id: "a", is_active: true, product_count: 342924 },
    { id: "b", is_active: true, product_count: "28677" },
    { id: "c", is_active: false, product_count: 999999 },
  ];
  it("muestra sólo tiendas que están en algún catálogo activo", () => {
    const links = [
      { catalog_id: "a", store_key: "COTO" },
      { catalog_id: "b", store_key: "bna" },
      { catalog_id: "c", store_key: "NUEVA" },
    ];
    const r = buildIntroShowcase(STORES, links, cats);
    expect(r.stores.map((s) => s.key)).toEqual(["COTO", "BNA"]);
  });
  it("suma productos sólo de catálogos activos", () => {
    expect(buildIntroShowcase(STORES, [], cats).productCount).toBe(342924 + 28677);
  });
  it("sin relación cargada muestra todas las tiendas", () => {
    expect(buildIntroShowcase(STORES, [], cats).stores).toHaveLength(4);
  });
  it("ignora conteos inválidos", () => {
    const r = buildIntroShowcase([], [], [
      { id: "a", is_active: true, product_count: null },
      { id: "b", is_active: true, product_count: "abc" },
      { id: "c", is_active: true, product_count: -5 },
    ]);
    expect(r.productCount).toBe(0);
  });
});

describe("contador", () => {
  it("redondea hacia abajo a 2 cifras significativas", () => {
    expect(roundDownNice(371601)).toBe(370000);
    expect(roundDownNice(1234567)).toBe(1200000);
    expect(roundDownNice(9798)).toBe(9700);
    expect(roundDownNice(999)).toBe(999);
    expect(roundDownNice(0)).toBe(0);
    expect(roundDownNice(Number.NaN)).toBe(0);
  });
  it("arma 'Más de N productos de 13 tiendas'", () => {
    expect(introCountLabel(371601, 13)).toEqual({
      prefix: "Más de",
      value: 370000,
      suffix: "productos de 13 tiendas",
    });
  });
  it("si el número es exacto no dice 'Más de'", () => {
    expect(introCountLabel(370000, 1)).toEqual({ prefix: "", value: 370000, suffix: "productos de 1 tienda" });
    expect(introCountLabel(1, 0)).toEqual({ prefix: "", value: 1, suffix: "producto" });
  });
  it("sin productos no hay contador", () => {
    expect(introCountLabel(0, 13)).toBeNull();
  });
});

describe("marqueeRows", () => {
  it("cada fila arranca en otra tienda y cubre el mínimo", () => {
    const items = Array.from({ length: 13 }, (_, i) => i);
    const rows = marqueeRows(items, 4, 12);
    expect(rows).toHaveLength(4);
    expect(new Set(rows.map((r) => r[0])).size).toBe(4);
    for (const r of rows) {
      expect(r.length).toBeGreaterThanOrEqual(12);
      expect(new Set(r).size).toBe(13);
    }
  });
  it("repite listas cortas hasta el mínimo", () => {
    const rows = marqueeRows(["a", "b"], 2, 12);
    expect(rows[0]).toHaveLength(12);
  });
  it("sin tiendas no hay filas", () => {
    expect(marqueeRows([], 4)).toEqual([]);
  });
});

describe("catalogSearchBusy", () => {
  it("con el campo vacío no gira aunque se carguen los destacados", () => {
    expect(catalogSearchBusy("", "", true)).toBe(false);
    expect(catalogSearchBusy("   ", "", true)).toBe(false);
  });
  it("gira mientras se escribe (antes del debounce)", () => {
    expect(catalogSearchBusy("lech", "le", false)).toBe(true);
  });
  it("gira mientras se busca el texto enviado", () => {
    expect(catalogSearchBusy("leche", "leche", true)).toBe(true);
  });
  it("quieto cuando terminó", () => {
    expect(catalogSearchBusy("leche ", "leche", false)).toBe(false);
  });
});
