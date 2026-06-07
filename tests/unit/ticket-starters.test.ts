import { describe, expect, it } from "vitest";
import { BLOCK_STARTER_TEMPLATES } from "@/lib/tickets/blockTemplates";
import { FISCAL_TRANSPARENCY_TEXT } from "@/lib/tickets/legal";

const KINDS = ["sale", "promo", "gift"];
const PAPERS = ["58", "80", "a4"];
const HEX = /^#[0-9a-fA-F]{6}$/;

describe("BLOCK_STARTER_TEMPLATES", () => {
  it("tiene 8 entradas con claves únicas", () => {
    expect(BLOCK_STARTER_TEMPLATES).toHaveLength(8);
    const keys = BLOCK_STARTER_TEMPLATES.map((t) => t.key);
    expect(new Set(keys).size).toBe(8);
  });

  it("expone las claves esperadas (5 base + 3 modelos nuevos)", () => {
    const keys = BLOCK_STARTER_TEMPLATES.map((t) => t.key).sort();
    expect(keys).toEqual([
      "a4-ejecutivo",
      "a4-minimal",
      "clasico",
      "elegante",
      "gift",
      "moderno",
      "promo",
      "termico-denso",
    ]);
  });

  it("kind y paper válidos en cada entrada", () => {
    for (const t of BLOCK_STARTER_TEMPLATES) {
      expect(KINDS).toContain(t.kind);
      expect(PAPERS).toContain(t.paper);
    }
  });

  it("cada modelo tiene al menos 3 bloques con ids únicos", () => {
    for (const t of BLOCK_STARTER_TEMPLATES) {
      expect(t.blocks.length, t.key).toBeGreaterThanOrEqual(3);
      const ids = t.blocks.map((b) => b.id);
      expect(new Set(ids).size, `${t.key} tiene ids duplicados`).toBe(ids.length);
    }
  });

  it("todo color/bg/separador presente es un hex válido", () => {
    for (const t of BLOCK_STARTER_TEMPLATES) {
      for (const b of t.blocks) {
        if ("color" in b && b.color) expect(b.color, `${t.key}/${b.type} color`).toMatch(HEX);
        if ("bg" in b && b.bg) expect(b.bg, `${t.key}/${b.type} bg`).toMatch(HEX);
      }
    }
  });

  it("al menos un modelo aporta identidad visual (color/bg)", () => {
    const withColor = BLOCK_STARTER_TEMPLATES.filter((t) =>
      t.blocks.some((b) => ("color" in b && b.color) || ("bg" in b && b.bg)),
    );
    expect(withColor.length).toBeGreaterThanOrEqual(4);
  });

  it("todos los modelos de venta incluyen la leyenda fiscal (Ley 27.743)", () => {
    const sales = BLOCK_STARTER_TEMPLATES.filter((t) => t.kind === "sale");
    expect(sales.length).toBeGreaterThanOrEqual(5);
    for (const t of sales) {
      const hasFiscal = t.blocks.some(
        (b) => b.type === "text" && b.text === FISCAL_TRANSPARENCY_TEXT,
      );
      expect(hasFiscal, `${t.key} debe incluir la leyenda fiscal`).toBe(true);
    }
  });

  it("la leyenda fiscal menciona la Ley 27.743", () => {
    expect(FISCAL_TRANSPARENCY_TEXT).toContain("27.743");
  });
});
