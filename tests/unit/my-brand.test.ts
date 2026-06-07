import { describe, expect, it } from "vitest";
import {
  brandAccent,
  buildMyBrandBlocks,
  buildMyBrandCanvas,
  NINJA_FLAME,
} from "@/lib/tickets/myBrand";
import type { SampleBrand } from "@/lib/tickets/sample";

function brandWith(accent: string | null): SampleBrand {
  return {
    logo_url: null,
    legal_name: "Mi negocio",
    accent,
    cuit: null,
    phone: null,
    address: null,
    ticket_footer: null,
    ticket_width: null,
    ticket_title: null,
    ticket_legend: null,
    ticket_show_qr: null,
    ticket_show_logo: null,
  };
}

describe("brandAccent", () => {
  it("usa el acento del branding cuando es un hex válido", () => {
    expect(brandAccent(brandWith("#123abc"))).toBe("#123abc");
  });

  it("cae al flame de NinjaSoft cuando el branding es null", () => {
    expect(brandAccent(null)).toBe(NINJA_FLAME);
  });

  it("cae al flame cuando el acento es inválido o vacío", () => {
    expect(brandAccent(brandWith("rojo"))).toBe(NINJA_FLAME);
    expect(brandAccent(brandWith("#fff"))).toBe(NINJA_FLAME);
    expect(brandAccent(brandWith(""))).toBe(NINJA_FLAME);
    expect(brandAccent(undefined)).toBe(NINJA_FLAME);
  });
});

describe("buildMyBrandBlocks", () => {
  it("incluye logo, qr y footer", () => {
    const blocks = buildMyBrandBlocks(null);
    const types = blocks.map((b) => b.type);
    expect(types).toContain("logo");
    expect(types).toContain("qr");
    expect(types).toContain("footer");
  });

  it("ids únicos", () => {
    const blocks = buildMyBrandBlocks(null);
    const ids = blocks.map((b) => b.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it("aplica el acento al título y a los separadores", () => {
    const accent = "#abcdef";
    const blocks = buildMyBrandBlocks(brandWith(accent));
    const title = blocks.find((b) => b.type === "title");
    expect(title && "color" in title && title.color).toBe(accent);
    const seps = blocks.filter((b) => b.type === "separator");
    expect(seps.length).toBeGreaterThan(0);
    for (const s of seps) {
      expect(s.type === "separator" && s.color).toBe(accent);
    }
  });

  it("usa el flame cuando el branding no tiene acento válido", () => {
    const blocks = buildMyBrandBlocks(null);
    const title = blocks.find((b) => b.type === "title");
    expect(title && "color" in title && title.color).toBe(NINJA_FLAME);
  });
});

describe("buildMyBrandCanvas", () => {
  it("incluye elementos logo y qr movibles", () => {
    const canvas = buildMyBrandCanvas(null);
    const types = canvas.elements.map((e) => e.type);
    expect(types).toContain("logo");
    expect(types).toContain("qr");
  });

  it("ids únicos y coordenadas dentro del ancho 80mm (300px)", () => {
    const canvas = buildMyBrandCanvas(null);
    const ids = canvas.elements.map((e) => e.id);
    expect(new Set(ids).size).toBe(ids.length);
    for (const el of canvas.elements) {
      expect(el.x).toBeGreaterThanOrEqual(0);
      expect(el.x + el.w).toBeLessThanOrEqual(300);
    }
  });

  it("aplica el acento a separadores", () => {
    const accent = "#0a0b0c";
    const canvas = buildMyBrandCanvas(brandWith(accent));
    const seps = canvas.elements.filter((e) => e.type === "separator");
    expect(seps.length).toBeGreaterThan(0);
    for (const s of seps) expect(s.color).toBe(accent);
  });
});
