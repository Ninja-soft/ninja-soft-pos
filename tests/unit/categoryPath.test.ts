import { describe, expect, it } from "vitest";
import {
  formatCategoryPath,
  levelLabel,
  normalizeNodes,
  pathToCategory,
  splitCategoryPath,
  suggestCategoryNodes,
} from "@/lib/products/categoryPath";
import { normalizeAttributes } from "@/lib/products/attributes";

const cats = [
  { id: "alm", name: "Almacén", parent_id: null },
  { id: "des", name: "Desayuno", parent_id: "alm" },
  { id: "caf", name: "Café", parent_id: "des" },
  { id: "beb", name: "Bebidas", parent_id: null },
];

describe("árbol de jerarquía de categorías", () => {
  it("parte la ruta del catálogo", () => {
    expect(splitCategoryPath("Almacén > Desayuno >  Café ")).toEqual(["Almacén", "Desayuno", "Café"]);
    expect(splitCategoryPath("")).toEqual([]);
    expect(splitCategoryPath(null)).toEqual([]);
  });

  it("sugiere reusar existentes (sin acentos/mayúsculas) y crear el resto", () => {
    expect(suggestCategoryNodes(["almacen", "DESAYUNO", "Té"], cats)).toEqual([
      { id: "alm", name: "Almacén" },
      { id: "des", name: "Desayuno" },
      { id: null, name: "Té" },
    ]);
    // Si un nivel es nuevo, los de abajo también.
    expect(suggestCategoryNodes(["Limpieza", "Café"], cats)).toEqual([
      { id: null, name: "Limpieza" },
      { id: null, name: "Café" },
    ]);
  });

  it("reconstruye la ruta de una hoja existente", () => {
    expect(pathToCategory("caf", cats).map((n) => n.id)).toEqual(["alm", "des", "caf"]);
    expect(pathToCategory(null, cats)).toEqual([]);
  });

  it("normaliza: un existente que ya no cuelga del padre pasa a nuevo", () => {
    const out = normalizeNodes(
      [
        { id: "beb", name: "Bebidas" },
        { id: "caf", name: "Café" },
        { id: null, name: "  " },
      ],
      cats,
    );
    expect(out).toEqual([
      { id: "beb", name: "Bebidas" },
      { id: null, name: "Café" },
    ]);
    // Un "nuevo" con el nombre de una hermana existente la reusa.
    expect(normalizeNodes([{ id: null, name: "almacén" }], cats)).toEqual([
      { id: "alm", name: "Almacén" },
    ]);
  });

  it("etiquetas y formato", () => {
    expect(levelLabel(0)).toBe("Rubro");
    expect(levelLabel(2)).toBe("Subcategoría");
    expect(levelLabel(4)).toBe("Nivel 5");
    expect(formatCategoryPath(pathToCategory("caf", cats))).toBe("Almacén › Desayuno › Café");
  });
});

describe("atributos de producto", () => {
  it("acepta objeto, lista o texto y descarta vacíos/duplicados", () => {
    expect(normalizeAttributes({ Contenido: "500 g", Origen: "" })).toEqual([
      { key: "Contenido", value: "500 g" },
    ]);
    expect(
      normalizeAttributes([
        { key: "Color", value: "Rojo" },
        { nombre: "color", valor: "Azul" },
        { key: "", value: "x" },
      ]),
    ).toEqual([{ key: "Color", value: "Azul" }]);
    expect(normalizeAttributes("Talle: M; Material: Algodón")).toEqual([
      { key: "Talle", value: "M" },
      { key: "Material", value: "Algodón" },
    ]);
    expect(normalizeAttributes(null)).toEqual([]);
  });
});
