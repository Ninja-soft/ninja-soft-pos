import { describe, it, expect } from "vitest";
import { computeDimensions } from "@/lib/utils/image";

describe("computeDimensions", () => {
  it("no agranda imágenes más chicas que el máximo", () => {
    expect(computeDimensions(400, 300, 900)).toEqual({ width: 400, height: 300 });
  });

  it("reduce manteniendo aspect ratio", () => {
    expect(computeDimensions(1800, 1200, 900)).toEqual({ width: 900, height: 600 });
  });

  it("redondea la altura", () => {
    expect(computeDimensions(1000, 333, 900)).toEqual({ width: 900, height: 300 });
  });
});
