import { describe, expect, it } from "vitest";
import { upgradeCanvas } from "@/lib/tickets/canvasCompat";
import { CANVAS_WIDTH, type CanvasContent } from "@/lib/tickets/blocks";

type Canvas = CanvasContent["canvas"];

const v1: Canvas = {
  height: 300,
  elements: [
    { id: "a", type: "text", x: 50, y: 20, w: 90, text: "Hola" },
    { id: "b", type: "items", x: 0, y: 120, w: 100 },
  ],
};

const v2: Canvas = {
  height: 300,
  elements: [
    { id: "a", type: "text", x: 150, y: 20, w: 280, h: 24, text: "Hola" },
    { id: "b", type: "items", x: 0, y: 120, w: 300 },
  ],
};

describe("upgradeCanvas", () => {
  it("convierte v1 (%) a px para el ancho del papel", () => {
    const out = upgradeCanvas(v1, "80"); // width 300
    const text = out.elements.find((e) => e.id === "a")!;
    expect(text.x).toBe(Math.round((50 / 100) * CANVAS_WIDTH["80"])); // 150
    expect(text.w).toBe(Math.round((90 / 100) * CANVAS_WIDTH["80"])); // 270
    expect(text.y).toBe(20); // y se mantiene
    expect(text.h).toBeUndefined();
  });

  it("usa el ancho correcto según el papel", () => {
    const out58 = upgradeCanvas(v1, "58"); // width 220
    expect(out58.elements[0]!.x).toBe(Math.round((50 / 100) * CANVAS_WIDTH["58"])); // 110
  });

  it("deja pasar contenido v2 sin tocarlo", () => {
    const out = upgradeCanvas(v2, "80");
    expect(out).toEqual(v2);
    expect(out.elements[0]!.x).toBe(150);
    expect(out.elements[0]!.w).toBe(280);
  });

  it("es idempotente: aplicar dos veces no vuelve a escalar", () => {
    const once = upgradeCanvas(v1, "80");
    const twice = upgradeCanvas(once, "80");
    expect(twice).toEqual(once);
  });

  it("lienzo vacío se devuelve tal cual (no es v1)", () => {
    const empty: Canvas = { height: 200, elements: [] };
    expect(upgradeCanvas(empty, "80")).toEqual(empty);
  });
});
