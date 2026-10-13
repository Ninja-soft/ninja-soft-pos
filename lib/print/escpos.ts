// Tickets en ESC/POS (F10 · H22 · ADR-101). PURO: arma los bytes que entiende
// una térmica (Epson TM, Bematech, Hasar, 3nStar, Xprinter y compatibles) y,
// al revés, interpreta esos bytes para la impresora simulada del diagnóstico.
//
// No manda nada: el envío va por los transportes de ADR-053 / ADR-063
// (Web Serial, WebUSB o el puente local). Así se prueba todo sin equipo: el
// simulador recibe los mismos bytes que recibiría la impresora real.
//
// Texto: las térmicas arrancan en la página de códigos PC437 / PC850; acá se
// usa PC850 (ESC t 2), que trae á é í ó ú ñ Ñ ü ¿ ¡. Lo que no entra se
// reemplaza por su versión sin acento o por "?".

export type Align = "left" | "center" | "right";

export type TicketLine =
  | {
      kind: "text";
      text: string;
      align?: Align;
      bold?: boolean;
      double?: boolean;
    }
  /** Texto a la izquierda y a la derecha en la misma línea (ítem e importe). */
  | { kind: "pair"; left: string; right: string; bold?: boolean }
  | { kind: "rule"; char?: string }
  | { kind: "feed"; lines?: number };

export type PaperWidth = 58 | 80;

export interface EscposOptions {
  paper: PaperWidth;
  /** Corte al final: total, parcial o sin corte (impresoras sin cuchilla). */
  cut: "full" | "partial" | "none";
  /** Líneas en blanco antes del corte (la cuchilla está más arriba que el cabezal). */
  feedBeforeCut: number;
  /** Densidad de impresión 1 (clara) a 8 (oscura); null = la de la impresora. */
  density: number | null;
  /** Pulso del cajón al final (ESC p). */
  drawer: { pin: 2 | 5; onMs: number; offMs: number } | null;
}

export const DEFAULT_ESCPOS: EscposOptions = {
  paper: 80,
  cut: "partial",
  feedBeforeCut: 4,
  density: null,
  drawer: null,
};

/** Columnas de texto en fuente A (12x24): 32 en 58 mm, 48 en 80 mm. */
export function columnsFor(paper: PaperWidth): number {
  return paper === 58 ? 32 : 48;
}

// ── Comandos ─────────────────────────────────────────────────────────────────

const ESC = 0x1b;
const GS = 0x1d;
const LF = 0x0a;

export const CMD = {
  init: [ESC, 0x40],
  codePage850: [ESC, 0x74, 2],
  align: (a: Align) => [ESC, 0x61, a === "center" ? 1 : a === "right" ? 2 : 0],
  bold: (on: boolean) => [ESC, 0x45, on ? 1 : 0],
  /** Doble alto y ancho (GS ! 0x11) o normal. */
  size: (double: boolean) => [GS, 0x21, double ? 0x11 : 0],
  feed: (n: number) => [ESC, 0x64, Math.max(0, Math.min(255, Math.trunc(n)))],
  /** GS V 0 = corte total, GS V 1 = parcial. */
  cut: (kind: "full" | "partial") => [GS, 0x56, kind === "full" ? 0 : 1],
  /**
   * Densidad (Epson: GS ( K 2 0 49 n, n = 0xFA..0x06). Mapeamos 1..8 a
   * -6..+6 en complemento a dos de un byte. Las que no lo entienden lo ignoran.
   */
  density: (level: number) => {
    const l = Math.max(1, Math.min(8, Math.round(level)));
    const steps = [-6, -4, -2, -1, 0, 2, 4, 6][l - 1]!;
    return [GS, 0x28, 0x4b, 2, 0, 49, steps & 0xff];
  },
  drawer: (pin: 2 | 5, onMs: number, offMs: number) => {
    const u = (ms: number) => Math.min(255, Math.max(1, Math.round(ms / 2)));
    return [ESC, 0x70, pin === 5 ? 1 : 0, u(onMs), u(offMs)];
  },
} as const;

// PC850: sólo lo que aparece en un ticket argentino.
const PC850: Record<string, number> = {
  á: 0xa0,
  é: 0x82,
  í: 0xa1,
  ó: 0xa2,
  ú: 0xa3,
  Á: 0xb5,
  É: 0x90,
  Í: 0xd6,
  Ó: 0xe0,
  Ú: 0xe9,
  ñ: 0xa4,
  Ñ: 0xa5,
  ü: 0x81,
  Ü: 0x9a,
  "¿": 0xa8,
  "¡": 0xad,
  "°": 0xf8,
  º: 0xa7,
  ª: 0xa6,
};
const PC850_REVERSE: Record<number, string> = Object.fromEntries(
  Object.entries(PC850).map(([ch, b]) => [b, ch]),
);

/** Texto a bytes PC850 (ASCII imprimible + acentos; el resto sin acento o "?"). */
export function encodeText(text: string): number[] {
  const out: number[] = [];
  for (const ch of text) {
    const code = ch.codePointAt(0)!;
    if (code >= 0x20 && code < 0x7f) out.push(code);
    else if (PC850[ch] !== undefined) out.push(PC850[ch]!);
    else {
      const plain = ch.normalize("NFD").replace(/\p{M}/gu, "");
      const p = plain.codePointAt(0) ?? 0;
      out.push(plain.length === 1 && p >= 0x20 && p < 0x7f ? p : 0x3f);
    }
  }
  return out;
}

/** Corta o completa con espacios para entrar en `width` columnas. */
export function fitPair(left: string, right: string, width: number): string {
  const r = right.slice(0, width);
  const room = Math.max(0, width - r.length - 1);
  const l = left.length > room ? left.slice(0, Math.max(0, room)) : left;
  return l + " ".repeat(Math.max(1, width - l.length - r.length)) + r;
}

/** Parte un texto largo en líneas de `width` (por palabras cuando se puede). */
export function wrap(text: string, width: number): string[] {
  if (width <= 0) return [text];
  const out: string[] = [];
  for (const para of text.split("\n")) {
    let line = "";
    for (const word of para.split(/\s+/).filter(Boolean)) {
      if (!line) line = word;
      else if (line.length + 1 + word.length <= width) line += " " + word;
      else {
        out.push(line);
        line = word;
      }
      while (line.length > width) {
        out.push(line.slice(0, width));
        line = line.slice(width);
      }
    }
    out.push(line);
  }
  return out;
}

/** Bytes del ticket completo (init, página de códigos, líneas, corte, cajón). */
export function encodeTicket(
  lines: TicketLine[],
  opts: Partial<EscposOptions> = {},
): Uint8Array {
  const o = { ...DEFAULT_ESCPOS, ...opts };
  const cols = columnsFor(o.paper);
  const b: number[] = [...CMD.init, ...CMD.codePage850];
  if (o.density !== null) b.push(...CMD.density(o.density));
  for (const ln of lines) {
    switch (ln.kind) {
      case "text": {
        const width = ln.double ? Math.floor(cols / 2) : cols;
        b.push(...CMD.align(ln.align ?? "left"));
        if (ln.bold) b.push(...CMD.bold(true));
        if (ln.double) b.push(...CMD.size(true));
        for (const row of wrap(ln.text, width)) b.push(...encodeText(row), LF);
        if (ln.double) b.push(...CMD.size(false));
        if (ln.bold) b.push(...CMD.bold(false));
        b.push(...CMD.align("left"));
        break;
      }
      case "pair":
        if (ln.bold) b.push(...CMD.bold(true));
        b.push(...encodeText(fitPair(ln.left, ln.right, cols)), LF);
        if (ln.bold) b.push(...CMD.bold(false));
        break;
      case "rule":
        b.push(...encodeText((ln.char ?? "-").slice(0, 1).repeat(cols)), LF);
        break;
      case "feed":
        b.push(...CMD.feed(ln.lines ?? 1));
        break;
    }
  }
  if (o.cut !== "none") b.push(...CMD.feed(o.feedBeforeCut), ...CMD.cut(o.cut));
  else if (o.feedBeforeCut > 0) b.push(...CMD.feed(o.feedBeforeCut));
  if (o.drawer)
    b.push(...CMD.drawer(o.drawer.pin, o.drawer.onMs, o.drawer.offMs));
  return new Uint8Array(b);
}

// ── Lectura (impresora simulada) ─────────────────────────────────────────────

export type EscposEvent =
  | { kind: "init" }
  | { kind: "cut"; partial: boolean }
  | { kind: "drawer"; pin: 2 | 5; onMs: number; offMs: number }
  | { kind: "density"; raw: number }
  | { kind: "unknown"; byte: number };

export interface EscposPreview {
  /** Líneas impresas tal como saldrían (sin formato). */
  lines: string[];
  events: EscposEvent[];
}

/**
 * Interpreta bytes ESC/POS como lo haría la impresora: devuelve el texto por
 * línea y los eventos (corte, pulso de cajón). Ignora alineación y tamaños,
 * que sólo cambian cómo se ve, no qué se imprime.
 */
export function decodeEscpos(bytes: Uint8Array): EscposPreview {
  const lines: string[] = [];
  const events: EscposEvent[] = [];
  let cur = "";
  const flush = () => {
    lines.push(cur);
    cur = "";
  };
  for (let i = 0; i < bytes.length; i++) {
    const c = bytes[i]!;
    if (c === LF) {
      flush();
      continue;
    }
    if (c === 0x0d) continue;
    if (c === ESC) {
      const cmd = bytes[i + 1];
      if (cmd === 0x40) {
        events.push({ kind: "init" });
        i += 1;
      } else if (cmd === 0x64) {
        if (cur) flush();
        for (let k = 0; k < (bytes[i + 2] ?? 0); k++) lines.push("");
        i += 2;
      } else if (cmd === 0x70) {
        events.push({
          kind: "drawer",
          pin: bytes[i + 2] === 1 ? 5 : 2,
          onMs: (bytes[i + 3] ?? 0) * 2,
          offMs: (bytes[i + 4] ?? 0) * 2,
        });
        i += 4;
      } else if (
        cmd === 0x61 ||
        cmd === 0x45 ||
        cmd === 0x74 ||
        cmd === 0x21 ||
        cmd === 0x2d
      ) {
        i += 2;
      } else {
        events.push({ kind: "unknown", byte: cmd ?? -1 });
        i += 1;
      }
      continue;
    }
    if (c === GS) {
      const cmd = bytes[i + 1];
      if (cmd === 0x56) {
        if (cur) flush();
        const m = bytes[i + 2] ?? 0;
        events.push({ kind: "cut", partial: m === 1 || m === 49 });
        i += 2;
      } else if (cmd === 0x21) {
        i += 2;
      } else if (cmd === 0x28 && bytes[i + 2] === 0x4b) {
        const len = (bytes[i + 3] ?? 0) + (bytes[i + 4] ?? 0) * 256;
        if (bytes[i + 5] === 49)
          events.push({ kind: "density", raw: bytes[i + 6] ?? 0 });
        i += 4 + len;
      } else {
        events.push({ kind: "unknown", byte: cmd ?? -1 });
        i += 1;
      }
      continue;
    }
    if (c >= 0x20 && c < 0x7f) cur += String.fromCharCode(c);
    else cur += PC850_REVERSE[c] ?? "?";
  }
  if (cur) flush();
  return { lines, events };
}

/** Ticket de prueba del diagnóstico (sin datos de clientes). */
export function testTicketLines(info: {
  business: string;
  register?: string | null;
  when: Date;
}): TicketLine[] {
  const d = info.when;
  const pad = (n: number) => String(n).padStart(2, "0");
  const stamp = `${pad(d.getDate())}/${pad(d.getMonth() + 1)}/${d.getFullYear()} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
  return [
    {
      kind: "text",
      text: info.business || "NinjaSoft POS",
      align: "center",
      bold: true,
      double: true,
    },
    { kind: "text", text: "Prueba de impresión", align: "center" },
    { kind: "rule" },
    { kind: "pair", left: "Caja", right: info.register || "Sin caja" },
    { kind: "pair", left: "Fecha", right: stamp },
    { kind: "rule" },
    { kind: "pair", left: "1 x Artículo de prueba", right: "$ 1.000,00" },
    { kind: "pair", left: "1 x Ñandú con acentos áéíóú", right: "$ 250,50" },
    { kind: "rule", char: "=" },
    { kind: "pair", left: "TOTAL", right: "$ 1.250,50", bold: true },
    { kind: "feed", lines: 1 },
    {
      kind: "text",
      text: "Si leés bien esta línea, los acentos y la ñ salen bien.",
      align: "center",
    },
  ];
}
