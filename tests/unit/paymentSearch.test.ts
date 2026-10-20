import { describe, expect, it } from "vitest";
import { brandMatches, normalizeSearch } from "@/lib/payments/search";
import type { BrandGroup } from "@/lib/payments/catalog";

const g = (key: string, name: string, channels: { key: string; channel: "qr_link" | "point" | "manual" }[]): BrandGroup => ({
  brand: { key, name, tagline: "", channels: channels.map((c) => c.key) },
  channels: channels.map((c) => ({ ...c, name, implemented: true, placeholder: false })),
});

describe("Buscador de medios de pago", () => {
  const mp = g("mercadopago", "Mercado Pago", [{ key: "mercadopago", channel: "qr_link" }, { key: "mercadopago_point", channel: "point" }]);
  const talo = g("talo", "Talo", [{ key: "talo", channel: "qr_link" }]);
  const nave = g("nave", "Nave", [{ key: "nave", channel: "qr_link" }]);

  it("por nombre, sin acentos ni mayúsculas", () => {
    expect(normalizeSearch("  Ualá  BIS ")).toBe("uala bis");
    expect(brandMatches(mp, "mercado")).toBe(true);
    expect(brandMatches(mp, "MERCADO pago")).toBe(true);
    expect(brandMatches(talo, "mercado")).toBe(false);
  });

  it("por lo que cobra o por su banco", () => {
    expect(brandMatches(talo, "transferencia")).toBe(true);
    expect(brandMatches(mp, "point")).toBe(true);
    expect(brandMatches(nave, "galicia")).toBe(true);
    expect(brandMatches(nave, "naranja x")).toBe(true);
    expect(brandMatches(mp, "rapipago")).toBe(true);
  });

  it("vacío muestra todo", () => {
    expect(brandMatches(talo, "")).toBe(true);
    expect(brandMatches(talo, "   ")).toBe(true);
  });
});
