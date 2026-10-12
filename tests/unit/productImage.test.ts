import { describe, expect, it } from "vitest";
import {
  fitWidth,
  isAllowedSourceUrl,
  isExternalImage,
  isImageContentType,
  isStoredImagePath,
  productImagePath,
} from "@/supabase/functions/_shared/productImage";

const T = "11111111-1111-1111-1111-111111111111";
const P = "22222222-2222-2222-2222-222222222222";

describe("productImage (copia de foto de Tiendita)", () => {
  it("arma el path canónico tenant/product/uuid.webp", () => {
    expect(productImagePath(T, P, "abc")).toBe(`${T}/${P}/abc.webp`);
  });

  it("distingue foto propia del bucket vs externa pendiente", () => {
    expect(isStoredImagePath(`${T}/${P}/abc.webp`)).toBe(true);
    expect(isStoredImagePath(`${T}/${P}/abc.webp`, T)).toBe(true);
    expect(isStoredImagePath(`${T}/${P}/abc.webp`, "otro")).toBe(false);
    expect(isStoredImagePath("")).toBe(false);
    expect(isStoredImagePath("suelto.webp")).toBe(false);

    expect(isExternalImage("", "https://firebasestorage.googleapis.com/x.jpg")).toBe(true);
    expect(isExternalImage(`${T}/${P}/a.webp`, "https://x.supabase.co/a.webp")).toBe(false);
    expect(isExternalImage("", "")).toBe(false);
    expect(isExternalImage("", "javascript:alert(1)")).toBe(false);
  });

  it("valida la URL de origen (anti SSRF)", () => {
    expect(isAllowedSourceUrl("https://firebasestorage.googleapis.com/v0/b/x/o/a.jpg?alt=media")).toBe(true);
    expect(isAllowedSourceUrl("http://cdn.example.com/a.jpg")).toBe(false);
    expect(isAllowedSourceUrl("https://127.0.0.1/a.jpg")).toBe(false);
    expect(isAllowedSourceUrl("https://10.0.0.5/a.jpg")).toBe(false);
    expect(isAllowedSourceUrl("https://169.254.169.254/latest")).toBe(false);
    expect(isAllowedSourceUrl("https://localhost/a.jpg")).toBe(false);
    expect(isAllowedSourceUrl("https://[::1]/a.jpg")).toBe(false);
    expect(isAllowedSourceUrl("https://user:pass@cdn.example.com/a.jpg")).toBe(false);
    expect(isAllowedSourceUrl("https://cdn.example.com:8443/a.jpg")).toBe(false);
    expect(isAllowedSourceUrl("https://intranet/a.jpg")).toBe(false);
    expect(isAllowedSourceUrl("no es url")).toBe(false);
    expect(isAllowedSourceUrl(null)).toBe(false);
  });

  it("acepta sólo content-types de imagen", () => {
    expect(isImageContentType("image/jpeg")).toBe(true);
    expect(isImageContentType("image/webp; charset=binary")).toBe(true);
    expect(isImageContentType("text/html")).toBe(false);
    expect(isImageContentType("image/svg+xml")).toBe(false);
    expect(isImageContentType(null)).toBe(false);
  });

  it("achica a 900px sin agrandar", () => {
    expect(fitWidth(1800, 1200)).toEqual({ width: 900, height: 600 });
    expect(fitWidth(400, 300)).toEqual({ width: 400, height: 300 });
  });
});
