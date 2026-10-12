import { describe, expect, it } from "vitest";
import {
  BinaryBitmap,
  DecodeHintType,
  HybridBinarizer,
  QRCodeReader,
  RGBLuminanceSource,
} from "@zxing/library";
import { encodeQr, qrSvgPath } from "@/lib/qr/qrcode";

// Renderiza la matriz a luminancia (escala 4, borde 4) y la decodifica con
// zxing: si un lector real la lee, el encoder es correcto.
function decode(text: string, ecc?: "L" | "M" | "Q" | "H"): string {
  const qr = encodeQr(text, ecc);
  const scale = 4;
  const border = 4;
  const dim = (qr.size + border * 2) * scale;
  const lum = new Uint8ClampedArray(dim * dim).fill(255);
  for (let y = 0; y < qr.size; y++) {
    for (let x = 0; x < qr.size; x++) {
      if (!qr.modules[y]![x]) continue;
      for (let dy = 0; dy < scale; dy++) {
        for (let dx = 0; dx < scale; dx++) {
          lum[((y + border) * scale + dy) * dim + (x + border) * scale + dx] = 0;
        }
      }
    }
  }
  const source = new RGBLuminanceSource(lum, dim, dim);
  const bitmap = new BinaryBitmap(new HybridBinarizer(source));
  const hints = new Map();
  hints.set(DecodeHintType.PURE_BARCODE, true);
  hints.set(DecodeHintType.CHARACTER_SET, "UTF-8");
  return new QRCodeReader().decode(bitmap, hints).getText();
}

// Payload EMVCo típico de un QR de Mercado Pago (Orders API, qr_data).
const EMV =
  "00020101021243650016COM.MERCADOLIBRE02013063638f1192a-5fd1-4180-a180-8bcae3556bc35204000053030325802AR5925IZABEL AAAA DE MELO6009SAO PAULO62070503***63040B6D";

describe("encodeQr", () => {
  it("texto corto (versión 1)", () => {
    const qr = encodeQr("HOLA");
    expect(qr.size).toBe(21);
    expect(decode("HOLA")).toBe("HOLA");
  });

  it("payload EMVCo de Mercado Pago", () => {
    expect(decode(EMV)).toBe(EMV);
  });

  it("link de checkout largo", () => {
    const url = `https://www.mercadopago.com.ar/checkout/v1/redirect?pref_id=123456789-${"a".repeat(240)}`;
    expect(decode(url)).toBe(url);
  });

  it("UTF-8 (acentos y ñ)", () => {
    expect(decode("Café con ñandú · $1.500")).toBe("Café con ñandú · $1.500");
  });

  it.each(["L", "M", "Q", "H"] as const)("nivel de corrección %s", (ecc) => {
    expect(decode("https://pos.soft.ninja/pagar/3f2a3c1e", ecc)).toBe(
      "https://pos.soft.ninja/pagar/3f2a3c1e",
    );
  });

  it("muchas versiones distintas decodifican", () => {
    for (const n of [10, 40, 80, 120, 200, 400, 700, 1000]) {
      const t = "x".repeat(n);
      expect(decode(t)).toBe(t);
    }
  });

  it("texto demasiado largo lanza error", () => {
    expect(() => encodeQr("x".repeat(5000))).toThrow();
  });
});

describe("qrSvgPath", () => {
  it("un rect por módulo oscuro, desplazado por el borde", () => {
    const qr = encodeQr("A");
    const d = qrSvgPath(qr, 4);
    const dark = qr.modules.flat().filter(Boolean).length;
    expect(d.match(/M/g)?.length).toBe(dark);
    // El módulo (0,0) es parte de un patrón de búsqueda (oscuro).
    expect(d.startsWith("M4 4h1v1h-1z")).toBe(true);
  });
});
