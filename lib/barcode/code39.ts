// Generador de código de barras Code 39 — sin dependencias.
// Code 39 es alfanumérico, auto-checkeante y ampliamente legible por lectores
// USB/cámara. Devuelve segmentos (barra/espacio) para renderizar como SVG.
// Ver H24 (etiquetas) en docs/02-roadmap.md.

// Patrón de 9 elementos por carácter: '1' = ancho, '0' = angosto.
// Posiciones pares = barra, impares = espacio. Empieza y termina en barra.
const CODE39: Record<string, string> = {
  "0": "000110100", "1": "100100001", "2": "001100001", "3": "101100000",
  "4": "000110001", "5": "100110000", "6": "001110000", "7": "000100101",
  "8": "100100100", "9": "001100100", A: "100001001", B: "001001001",
  C: "101001000", D: "000011001", E: "100011000", F: "001011000",
  G: "000001101", H: "100001100", I: "001001100", J: "000011100",
  K: "100000011", L: "001000011", M: "101000010", N: "000010011",
  O: "100010010", P: "001010010", Q: "000000111", R: "100000110",
  S: "001000110", T: "000010110", U: "110000001", V: "011000001",
  W: "111000000", X: "010010001", Y: "110010000", Z: "011010000",
  "-": "010000101", ".": "110000100", " ": "011000100", $: "010101000",
  "/": "010100010", "+": "010001010", "%": "000101010", "*": "010010100",
};

export interface BarSegment {
  on: boolean; // true = barra (negro), false = espacio (blanco)
  width: number; // en módulos angostos (1 = angosto, 3 = ancho)
}

// Deja solo caracteres válidos de Code 39 (uppercase). Vacío si no queda nada.
export function sanitizeCode39(value: string): string {
  return value
    .toUpperCase()
    .split("")
    .filter((c) => c !== "*" && Object.prototype.hasOwnProperty.call(CODE39, c))
    .join("");
}

// Segmentos del código (incluye start/stop '*'). Lanza si el texto queda vacío.
export function code39Segments(text: string, wide = 3): BarSegment[] {
  const clean = sanitizeCode39(text);
  if (!clean) throw new Error("code39_empty");
  const chars = `*${clean}*`.split("");
  const segs: BarSegment[] = [];
  chars.forEach((ch, idx) => {
    const pattern = CODE39[ch]!;
    for (let i = 0; i < pattern.length; i++) {
      segs.push({ on: i % 2 === 0, width: pattern[i] === "1" ? wide : 1 });
    }
    // Espacio angosto inter-carácter (salvo después del último).
    if (idx < chars.length - 1) segs.push({ on: false, width: 1 });
  });
  return segs;
}

// Ancho total en módulos (útil para dimensionar el SVG).
export function code39Width(text: string, wide = 3): number {
  return code39Segments(text, wide).reduce((acc, s) => acc + s.width, 0);
}
