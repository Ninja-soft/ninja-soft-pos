import { describe, expect, it } from "vitest";
import { BLOCK_STARTER_TEMPLATES } from "@/lib/tickets/blockTemplates";
import { CANVAS_STARTER_TEMPLATES } from "@/lib/tickets/canvasTemplates";
import { CANVAS_WIDTH } from "@/lib/tickets/blocks";

const KINDS = ["sale", "promo", "gift"];
const PAPERS = ["58", "80", "a4"];
const HEX = /^#[0-9a-fA-F]{6}$/;

describe("BLOCK_STARTER_TEMPLATES", () => {
  it("tiene 5 entradas con claves únicas", () => {
    expect(BLOCK_STARTER_TEMPLATES).toHaveLength(5);
    const keys = BLOCK_STARTER_TEMPLATES.map((t) => t.key);
    expect(new Set(keys).size).toBe(5);
  });

  it("expone las claves rediseñadas (clasico/moderno/elegante/promo/gift)", () => {
    const keys = BLOCK_STARTER_TEMPLATES.map((t) => t.key).sort();
    expect(keys).toEqual(["clasico", "elegante", "gift", "moderno", "promo"]);
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
});

describe("CANVAS_STARTER_TEMPLATES", () => {
  it("tiene 5 entradas con claves únicas", () => {
    expect(CANVAS_STARTER_TEMPLATES).toHaveLength(5);
    const keys = CANVAS_STARTER_TEMPLATES.map((t) => t.key);
    expect(new Set(keys).size).toBe(5);
  });

  it("expone las claves rediseñadas", () => {
    const keys = CANVAS_STARTER_TEMPLATES.map((t) => t.key).sort();
    expect(keys).toEqual(["cartel-a4", "clasico", "gift-card", "moderno-dark", "promo-flyer"]);
  });

  it("todo color/bg presente en elementos es un hex válido", () => {
    for (const t of CANVAS_STARTER_TEMPLATES) {
      for (const el of t.canvas.elements) {
        if (el.color) expect(el.color, `${t.key}/${el.type} color`).toMatch(HEX);
        if (el.bg) expect(el.bg, `${t.key}/${el.type} bg`).toMatch(HEX);
      }
    }
  });

  it("kind y paper válidos en cada entrada", () => {
    for (const t of CANVAS_STARTER_TEMPLATES) {
      expect(KINDS).toContain(t.kind);
      expect(PAPERS).toContain(t.paper);
    }
  });

  it("a lo sumo un elemento items por modelo", () => {
    for (const t of CANVAS_STARTER_TEMPLATES) {
      const items = t.canvas.elements.filter((e) => e.type === "items");
      expect(items.length, `${t.key} tiene más de un items`).toBeLessThanOrEqual(1);
    }
  });

  it("coordenadas v2 en px: x>=0, w>=10, y>=0 y dentro del ancho del papel", () => {
    for (const t of CANVAS_STARTER_TEMPLATES) {
      const width = CANVAS_WIDTH[t.paper];
      for (const el of t.canvas.elements) {
        expect(el.x, `${t.key}/${el.type} x`).toBeGreaterThanOrEqual(0);
        expect(el.y, `${t.key}/${el.type} y`).toBeGreaterThanOrEqual(0);
        expect(el.w, `${t.key}/${el.type} w`).toBeGreaterThanOrEqual(10);
        // No se sale del lienzo por la derecha.
        expect(el.x + el.w, `${t.key}/${el.type} x+w`).toBeLessThanOrEqual(width);
      }
    }
  });
});
