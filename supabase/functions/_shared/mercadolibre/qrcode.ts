// =============================================================================
// lib/qr/qrcode.ts — generador de códigos QR sin dependencias (modo byte,
// UTF-8, versiones 1..40, niveles L/M/Q/H, elección de máscara por
// penalización). Mismo criterio que lib/barcode/code39.ts (ADR-021): el QR de
// cobro se dibuja local, sin servicios externos de imágenes (el qr_data de
// Mercado Pago es un payload EMVCo que no debe salir a terceros).
//
// Algoritmo según ISO/IEC 18004, estructura basada en el generador de
// referencia de Project Nayuki (MIT). Validado decodificando con zxing en
// tests/unit/qrcode.test.ts.
// =============================================================================

export type QrEcc = "L" | "M" | "Q" | "H";

export interface QrMatrix {
  size: number;
  /** modules[y][x] === true → módulo oscuro. */
  modules: boolean[][];
}

const ECC_INDEX: Record<QrEcc, number> = { L: 0, M: 1, Q: 2, H: 3 };
const ECC_FORMAT_BITS: Record<QrEcc, number> = { L: 1, M: 0, Q: 3, H: 2 };

// prettier-ignore
const ECC_CODEWORDS_PER_BLOCK: number[][] = [
  [-1, 7, 10, 15, 20, 26, 18, 20, 24, 30, 18, 20, 24, 26, 30, 22, 24, 28, 30, 28, 28, 28, 28, 30, 30, 26, 28, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30],
  [-1, 10, 16, 26, 18, 24, 16, 18, 22, 22, 26, 30, 22, 22, 24, 24, 28, 28, 26, 26, 26, 26, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28],
  [-1, 13, 22, 18, 26, 18, 24, 18, 22, 20, 24, 28, 26, 24, 20, 30, 24, 28, 28, 26, 30, 28, 30, 30, 30, 30, 28, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30],
  [-1, 17, 28, 22, 16, 22, 28, 26, 26, 24, 28, 24, 28, 22, 24, 24, 30, 28, 28, 26, 28, 30, 24, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30],
];
// prettier-ignore
const NUM_ERROR_CORRECTION_BLOCKS: number[][] = [
  [-1, 1, 1, 1, 1, 1, 2, 2, 2, 2, 4, 4, 4, 4, 4, 6, 6, 6, 6, 7, 8, 8, 9, 9, 10, 12, 12, 12, 13, 14, 15, 16, 17, 18, 19, 19, 20, 21, 22, 24, 25],
  [-1, 1, 1, 1, 2, 2, 4, 4, 4, 5, 5, 5, 8, 9, 9, 10, 10, 11, 13, 14, 16, 17, 17, 18, 20, 21, 23, 25, 26, 28, 29, 31, 33, 35, 37, 38, 40, 43, 45, 47, 49],
  [-1, 1, 1, 2, 2, 4, 4, 6, 6, 8, 8, 8, 10, 12, 16, 12, 17, 16, 18, 21, 20, 23, 23, 25, 27, 29, 34, 34, 35, 38, 40, 43, 45, 48, 51, 53, 56, 59, 62, 65, 68],
  [-1, 1, 1, 2, 4, 4, 4, 5, 6, 8, 8, 11, 11, 16, 16, 18, 16, 19, 21, 25, 25, 25, 34, 30, 32, 35, 37, 40, 42, 45, 48, 51, 54, 57, 60, 63, 66, 70, 74, 77, 81],
];

const tableAt = (t: number[][], ecc: QrEcc, ver: number): number =>
  t[ECC_INDEX[ecc]]![ver]!;

function numRawDataModules(ver: number): number {
  let result = (16 * ver + 128) * ver + 64;
  if (ver >= 2) {
    const numAlign = Math.floor(ver / 7) + 2;
    result -= (25 * numAlign - 10) * numAlign - 55;
    if (ver >= 7) result -= 36;
  }
  return result;
}

function numDataCodewords(ver: number, ecc: QrEcc): number {
  return (
    Math.floor(numRawDataModules(ver) / 8) -
    tableAt(ECC_CODEWORDS_PER_BLOCK, ecc, ver) * tableAt(NUM_ERROR_CORRECTION_BLOCKS, ecc, ver)
  );
}

// ── Reed-Solomon sobre GF(2^8) / 0x11D ────────────────────────────────────────
function gfMul(x: number, y: number): number {
  let z = 0;
  for (let i = 7; i >= 0; i--) {
    z = (z << 1) ^ ((z >>> 7) * 0x11d);
    z ^= ((y >>> i) & 1) * x;
  }
  return z & 0xff;
}

function rsDivisor(degree: number): number[] {
  const result = new Array<number>(degree).fill(0);
  result[degree - 1] = 1;
  let root = 1;
  for (let i = 0; i < degree; i++) {
    for (let j = 0; j < result.length; j++) {
      result[j] = gfMul(result[j]!, root);
      if (j + 1 < result.length) result[j] = result[j]! ^ result[j + 1]!;
    }
    root = gfMul(root, 0x02);
  }
  return result;
}

function rsRemainder(data: number[], divisor: number[]): number[] {
  const result = new Array<number>(divisor.length).fill(0);
  for (const b of data) {
    const factor = b ^ result.shift()!;
    result.push(0);
    divisor.forEach((coef, i) => {
      result[i] = result[i]! ^ gfMul(coef, factor);
    });
  }
  return result;
}

function addEccAndInterleave(data: number[], ver: number, ecc: QrEcc): number[] {
  const numBlocks = tableAt(NUM_ERROR_CORRECTION_BLOCKS, ecc, ver);
  const blockEccLen = tableAt(ECC_CODEWORDS_PER_BLOCK, ecc, ver);
  const rawCodewords = Math.floor(numRawDataModules(ver) / 8);
  const numShortBlocks = numBlocks - (rawCodewords % numBlocks);
  const shortBlockLen = Math.floor(rawCodewords / numBlocks);

  const blocks: number[][] = [];
  const divisor = rsDivisor(blockEccLen);
  for (let i = 0, k = 0; i < numBlocks; i++) {
    const dat = data.slice(k, k + shortBlockLen - blockEccLen + (i < numShortBlocks ? 0 : 1));
    k += dat.length;
    const eccBytes = rsRemainder(dat, divisor);
    if (i < numShortBlocks) dat.push(0);
    blocks.push(dat.concat(eccBytes));
  }

  const result: number[] = [];
  for (let i = 0; i < blocks[0]!.length; i++) {
    blocks.forEach((block, j) => {
      if (i !== shortBlockLen - blockEccLen || j >= numShortBlocks) result.push(block[i]!);
    });
  }
  return result;
}

// ── Matriz ────────────────────────────────────────────────────────────────────
class Builder {
  readonly size: number;
  readonly modules: boolean[][];
  readonly isFunction: boolean[][];

  constructor(
    readonly ver: number,
    readonly ecc: QrEcc,
  ) {
    this.size = ver * 4 + 17;
    this.modules = Array.from({ length: this.size }, () => new Array<boolean>(this.size).fill(false));
    this.isFunction = Array.from({ length: this.size }, () =>
      new Array<boolean>(this.size).fill(false),
    );
  }

  private setFunc(x: number, y: number, dark: boolean) {
    this.modules[y]![x] = dark;
    this.isFunction[y]![x] = true;
  }

  drawFunctionPatterns() {
    const s = this.size;
    for (let i = 0; i < s; i++) {
      this.setFunc(6, i, i % 2 === 0);
      this.setFunc(i, 6, i % 2 === 0);
    }
    this.drawFinder(3, 3);
    this.drawFinder(s - 4, 3);
    this.drawFinder(3, s - 4);

    const pos = this.alignmentPositions();
    const n = pos.length;
    for (let i = 0; i < n; i++) {
      for (let j = 0; j < n; j++) {
        if ((i === 0 && j === 0) || (i === 0 && j === n - 1) || (i === n - 1 && j === 0)) continue;
        this.drawAlignment(pos[i]!, pos[j]!);
      }
    }
    this.drawFormatBits(0);
    this.drawVersion();
  }

  private drawFinder(x: number, y: number) {
    for (let dy = -4; dy <= 4; dy++) {
      for (let dx = -4; dx <= 4; dx++) {
        const dist = Math.max(Math.abs(dx), Math.abs(dy));
        const xx = x + dx;
        const yy = y + dy;
        if (xx >= 0 && xx < this.size && yy >= 0 && yy < this.size) {
          this.setFunc(xx, yy, dist !== 2 && dist !== 4);
        }
      }
    }
  }

  private drawAlignment(x: number, y: number) {
    for (let dy = -2; dy <= 2; dy++) {
      for (let dx = -2; dx <= 2; dx++) {
        this.setFunc(x + dx, y + dy, Math.max(Math.abs(dx), Math.abs(dy)) !== 1);
      }
    }
  }

  private alignmentPositions(): number[] {
    if (this.ver === 1) return [];
    const numAlign = Math.floor(this.ver / 7) + 2;
    const step = Math.floor((this.ver * 8 + numAlign * 3 + 5) / (numAlign * 4 - 4)) * 2;
    const result = [6];
    for (let pos = this.size - 7; result.length < numAlign; pos -= step) result.splice(1, 0, pos);
    return result;
  }

  drawFormatBits(mask: number) {
    const data = (ECC_FORMAT_BITS[this.ecc] << 3) | mask;
    let rem = data;
    for (let i = 0; i < 10; i++) rem = (rem << 1) ^ ((rem >>> 9) * 0x537);
    const bits = ((data << 10) | rem) ^ 0x5412;
    const bit = (i: number) => ((bits >>> i) & 1) !== 0;

    for (let i = 0; i <= 5; i++) this.setFunc(8, i, bit(i));
    this.setFunc(8, 7, bit(6));
    this.setFunc(8, 8, bit(7));
    this.setFunc(7, 8, bit(8));
    for (let i = 9; i < 15; i++) this.setFunc(14 - i, 8, bit(i));

    for (let i = 0; i < 8; i++) this.setFunc(this.size - 1 - i, 8, bit(i));
    for (let i = 8; i < 15; i++) this.setFunc(8, this.size - 15 + i, bit(i));
    this.setFunc(8, this.size - 8, true);
  }

  private drawVersion() {
    if (this.ver < 7) return;
    let rem = this.ver;
    for (let i = 0; i < 12; i++) rem = (rem << 1) ^ ((rem >>> 11) * 0x1f25);
    const bits = (this.ver << 12) | rem;
    for (let i = 0; i < 18; i++) {
      const dark = ((bits >>> i) & 1) !== 0;
      const a = this.size - 11 + (i % 3);
      const b = Math.floor(i / 3);
      this.setFunc(a, b, dark);
      this.setFunc(b, a, dark);
    }
  }

  drawCodewords(data: number[]) {
    let i = 0;
    for (let right = this.size - 1; right >= 1; right -= 2) {
      if (right === 6) right = 5;
      for (let vert = 0; vert < this.size; vert++) {
        for (let j = 0; j < 2; j++) {
          const x = right - j;
          const upward = ((right + 1) & 2) === 0;
          const y = upward ? this.size - 1 - vert : vert;
          if (!this.isFunction[y]![x] && i < data.length * 8) {
            this.modules[y]![x] = ((data[i >>> 3]! >>> (7 - (i & 7))) & 1) !== 0;
            i++;
          }
        }
      }
    }
  }

  applyMask(mask: number) {
    for (let y = 0; y < this.size; y++) {
      for (let x = 0; x < this.size; x++) {
        let invert: boolean;
        switch (mask) {
          case 0: invert = (x + y) % 2 === 0; break;
          case 1: invert = y % 2 === 0; break;
          case 2: invert = x % 3 === 0; break;
          case 3: invert = (x + y) % 3 === 0; break;
          case 4: invert = (Math.floor(x / 3) + Math.floor(y / 2)) % 2 === 0; break;
          case 5: invert = ((x * y) % 2) + ((x * y) % 3) === 0; break;
          case 6: invert = (((x * y) % 2) + ((x * y) % 3)) % 2 === 0; break;
          default: invert = (((x + y) % 2) + ((x * y) % 3)) % 2 === 0; break;
        }
        if (!this.isFunction[y]![x] && invert) this.modules[y]![x] = !this.modules[y]![x];
      }
    }
  }

  penalty(): number {
    const s = this.size;
    const m = this.modules;
    let result = 0;

    const addHistory = (len: number, h: number[]) => {
      if (h[0] === 0) len += s;
      h.pop();
      h.unshift(len);
    };
    const countPatterns = (h: number[]) => {
      const n = h[1]!;
      const core = n > 0 && h[2] === n && h[3] === n * 3 && h[4] === n && h[5] === n;
      return (
        (core && h[0]! >= n * 4 && h[6]! >= n ? 1 : 0) +
        (core && h[6]! >= n * 4 && h[0]! >= n ? 1 : 0)
      );
    };
    const terminate = (color: boolean, len: number, h: number[]) => {
      if (color) {
        addHistory(len, h);
        len = 0;
      }
      addHistory(len + s, h);
      return countPatterns(h);
    };
    const scan = (get: (a: number, b: number) => boolean) => {
      for (let a = 0; a < s; a++) {
        let color = false;
        let run = 0;
        const h = [0, 0, 0, 0, 0, 0, 0];
        for (let b = 0; b < s; b++) {
          if (get(a, b) === color) {
            run++;
            if (run === 5) result += 3;
            else if (run > 5) result++;
          } else {
            addHistory(run, h);
            if (!color) result += countPatterns(h) * 40;
            color = get(a, b);
            run = 1;
          }
        }
        result += terminate(color, run, h) * 40;
      }
    };
    scan((y, x) => m[y]![x]!);
    scan((x, y) => m[y]![x]!);

    for (let y = 0; y < s - 1; y++) {
      for (let x = 0; x < s - 1; x++) {
        const c = m[y]![x];
        if (c === m[y]![x + 1] && c === m[y + 1]![x] && c === m[y + 1]![x + 1]) result += 3;
      }
    }

    let dark = 0;
    for (const row of m) for (const v of row) if (v) dark++;
    const total = s * s;
    const k = Math.ceil(Math.abs(dark * 20 - total * 10) / total) - 1;
    result += k * 10;
    return result;
  }
}

function utf8Bytes(text: string): number[] {
  return Array.from(new TextEncoder().encode(text));
}

/** Codifica `text` (UTF-8, modo byte) en la menor versión que entra. */
export function encodeQr(text: string, ecc: QrEcc = "M"): QrMatrix {
  const bytes = utf8Bytes(text);

  let ver = 1;
  let dataBits = 0;
  for (; ver <= 40; ver++) {
    const ccBits = ver <= 9 ? 8 : 16;
    dataBits = 4 + ccBits + bytes.length * 8;
    if (bytes.length < 1 << ccBits && dataBits <= numDataCodewords(ver, ecc) * 8) break;
  }
  if (ver > 40) throw new RangeError("qr_data_too_long");

  const ccBits = ver <= 9 ? 8 : 16;
  const bits: number[] = [];
  const push = (val: number, len: number) => {
    for (let i = len - 1; i >= 0; i--) bits.push((val >>> i) & 1);
  };
  push(0x4, 4);
  push(bytes.length, ccBits);
  for (const b of bytes) push(b, 8);

  const capacity = numDataCodewords(ver, ecc) * 8;
  push(0, Math.min(4, capacity - bits.length));
  push(0, (8 - (bits.length % 8)) % 8);
  for (let pad = 0xec; bits.length < capacity; pad ^= 0xec ^ 0x11) push(pad, 8);

  const data: number[] = [];
  for (let i = 0; i < bits.length; i += 8) {
    let byte = 0;
    for (let j = 0; j < 8; j++) byte = (byte << 1) | bits[i + j]!;
    data.push(byte);
  }

  const qr = new Builder(ver, ecc);
  qr.drawFunctionPatterns();
  qr.drawCodewords(addEccAndInterleave(data, ver, ecc));

  let best = 0;
  let minPenalty = Infinity;
  for (let mask = 0; mask < 8; mask++) {
    qr.applyMask(mask);
    qr.drawFormatBits(mask);
    const p = qr.penalty();
    if (p < minPenalty) {
      best = mask;
      minPenalty = p;
    }
    qr.applyMask(mask);
  }
  qr.applyMask(best);
  qr.drawFormatBits(best);

  return { size: qr.size, modules: qr.modules };
}

/**
 * Path SVG (un cuadrado de 1x1 por módulo oscuro) desplazado por `border`
 * módulos de zona silenciosa. viewBox = 0 0 (size+2*border) (size+2*border).
 */
export function qrSvgPath(qr: QrMatrix, border = 4): string {
  const parts: string[] = [];
  for (let y = 0; y < qr.size; y++) {
    for (let x = 0; x < qr.size; x++) {
      if (qr.modules[y]![x]) parts.push(`M${x + border} ${y + border}h1v1h-1z`);
    }
  }
  return parts.join("");
}

/**
 * QR como data URL de un SVG (fondo blanco, módulos negros, bordes nítidos).
 * Sirve donde hace falta un `src` de <img> (tickets, plantillas HTML,
 * exportar a PNG) sin pedir la imagen a un servicio externo. Si el texto no
 * entra en un QR devuelve "" (el llamador decide no mostrar nada).
 */
export function qrSvgDataUrl(text: string, ecc: QrEcc = "M", border = 2): string {
  let qr: QrMatrix;
  try {
    qr = encodeQr(text, ecc);
  } catch {
    return "";
  }
  const dim = qr.size + border * 2;
  const svg =
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${dim} ${dim}" shape-rendering="crispEdges">` +
    `<rect width="${dim}" height="${dim}" fill="#fff"/>` +
    `<path d="${qrSvgPath(qr, border)}" fill="#000"/></svg>`;
  return `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`;
}
