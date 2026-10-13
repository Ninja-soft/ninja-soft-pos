// Protocolos de balanza (F10 · H24, ADR-063). PURO.
//
// Las balanzas de mostrador con salida serie mandan el peso como texto ASCII:
//   • continuo: la balanza manda una trama cada N ms sin que se le pida;
//   • a pedido (poll): la PC manda un comando (ENQ, "P", "W"...) y la balanza
//     contesta con una trama.
// Cada trama termina en CR, LF o ETX y puede venir entre STX y ETX.
//
// Los presets de Systel, Kretz y Moretti son puntos de partida con el formato
// más común de cada marca (fuentes públicas y manuales de usuario, NO
// especificaciones oficiales): por eso todo es editable (modo, comando y
// expresión regular) y la pantalla "Probar balanza" muestra la trama cruda
// para ajustarlo. Estado: `unverified` hasta probarlos con el equipo.

export type ScaleProtocol = "systel" | "kretz" | "moretti" | "generic";
export type ScaleMode = "continuous" | "poll";
export type ScaleUnit = "kg" | "g";

export interface ScaleProtocolConfig {
  protocol: ScaleProtocol;
  mode: ScaleMode;
  /** Comando de pedido con escapes (\x05, \r, \n). Sólo modo poll. */
  pollCommand: string;
  /** Cada cuánto se pide el peso (modo poll). */
  pollMs: number;
  /**
   * Expresión regular sobre la trama limpia: el primer grupo es el número.
   * Vacía = la del preset.
   */
  regex: string;
  /** Unidad del número de la trama. */
  unit: ScaleUnit;
}

export interface ProtocolPreset {
  label: string;
  mode: ScaleMode;
  pollCommand: string;
  regex: string;
  unit: ScaleUnit;
  baud: number;
  /** Validado contra un equipo real. */
  verified: boolean;
  hint: string;
}

export const SCALE_PROTOCOLS: Record<ScaleProtocol, ProtocolPreset> = {
  systel: {
    label: "Systel (Cuora, Croma)",
    mode: "poll",
    pollCommand: "\\x05",
    regex: "(\\d{5,6})",
    unit: "g",
    baud: 9600,
    verified: false,
    hint: "Pide el peso con ENQ y la balanza contesta el peso en gramos. Activá la salida a PC en la balanza.",
  },
  kretz: {
    label: "Kretz (Report, Novel)",
    mode: "continuous",
    pollCommand: "",
    regex: "([-+]?\\d+[.,]\\d{3})",
    unit: "kg",
    baud: 9600,
    verified: false,
    hint: "Transmisión continua del peso en kg con 3 decimales. Configurá la balanza en modo PC.",
  },
  moretti: {
    label: "Moretti",
    mode: "poll",
    pollCommand: "P",
    regex: "([-+]?\\d+[.,]\\d{3})",
    unit: "kg",
    baud: 9600,
    verified: false,
    hint: "Pide el peso con P y contesta en kg con 3 decimales.",
  },
  generic: {
    label: "Genérico (ASCII)",
    mode: "continuous",
    pollCommand: "",
    regex: "([-+]?\\d+(?:[.,]\\d+)?)\\s*(?:kg|KG)?",
    unit: "kg",
    baud: 9600,
    verified: true,
    hint: "Cualquier balanza que mande el peso como texto. Ajustá la expresión con la trama que ves en la prueba.",
  },
};

/** Configuración del preset (lo que no se personalizó). */
export function protocolDefaults(p: ScaleProtocol): ScaleProtocolConfig {
  const s = SCALE_PROTOCOLS[p];
  return { protocol: p, mode: s.mode, pollCommand: s.pollCommand, pollMs: 300, regex: "", unit: s.unit };
}

/** "\x05", "\r", "\n", "\t" → bytes. */
export function decodeCommand(cmd: string): Uint8Array {
  const out: number[] = [];
  for (let i = 0; i < cmd.length; i++) {
    const c = cmd[i]!;
    if (c === "\\" && i + 1 < cmd.length) {
      const n = cmd[i + 1]!;
      if (n === "x" && /^[0-9a-fA-F]{2}$/.test(cmd.slice(i + 2, i + 4))) {
        out.push(parseInt(cmd.slice(i + 2, i + 4), 16));
        i += 3;
        continue;
      }
      if (n === "r") {
        out.push(13);
        i += 1;
        continue;
      }
      if (n === "n") {
        out.push(10);
        i += 1;
        continue;
      }
      if (n === "t") {
        out.push(9);
        i += 1;
        continue;
      }
      if (n === "\\") {
        out.push(92);
        i += 1;
        continue;
      }
    }
    out.push(c.charCodeAt(0) & 0xff);
  }
  return new Uint8Array(out);
}

/** Bytes → texto (latin1) visible para la trama cruda del diagnóstico. */
export function visibleFrame(s: string): string {
  return s.replace(/[\x00-\x1f\x7f]/g, (c) => {
    const n = c.charCodeAt(0);
    if (n === 2) return "<STX>";
    if (n === 3) return "<ETX>";
    if (n === 13) return "<CR>";
    if (n === 10) return "<LF>";
    return `<${n.toString(16).padStart(2, "0")}>`;
  });
}

/**
 * Junta los bytes que llegan en tramas: corta en CR, LF y ETX. Un STX
 * descarta lo anterior (arranca una trama). Tope de 256 caracteres por trama
 * (basura en la línea no crece sin límite).
 */
export class FrameSplitter {
  private buf = "";

  push(chunk: Uint8Array): string[] {
    const frames: string[] = [];
    for (const b of chunk) {
      if (b === 0x02) {
        this.buf = "";
        continue;
      }
      if (b === 0x0d || b === 0x0a || b === 0x03) {
        if (this.buf.trim()) frames.push(this.buf);
        this.buf = "";
        continue;
      }
      this.buf += String.fromCharCode(b);
      if (this.buf.length > 256) this.buf = this.buf.slice(-256);
    }
    return frames;
  }

  reset() {
    this.buf = "";
  }
}

export interface FrameReading {
  /** Peso bruto en kg (negativo si la balanza lo informa). */
  weightKg: number;
  /** Estable según la propia balanza; null = no lo informa. */
  stableFlag: boolean | null;
}

export type FrameResult = FrameReading | { error: "overload" | "no_match" | "bad_regex" };

const regexCache = new Map<string, RegExp | null>();

function compile(src: string): RegExp | null {
  if (regexCache.has(src)) return regexCache.get(src)!;
  let re: RegExp | null;
  try {
    re = new RegExp(src);
  } catch {
    re = null;
  }
  regexCache.set(src, re);
  return re;
}

/** ¿La expresión regular compila y tiene un grupo? (para la pantalla de configuración) */
export function regexProblem(src: string): string | null {
  if (!src.trim()) return null;
  if (src.length > 200) return "La expresión es demasiado larga.";
  const re = compile(src);
  if (!re) return "La expresión regular no es válida.";
  if (!/\((?!\?)/.test(src)) return "La expresión necesita un grupo entre paréntesis con el número.";
  return null;
}

/**
 * Interpreta una trama. Marcas de estabilidad comunes: "ST" estable, "US" o
 * "M" en movimiento; "OL" / "OVER" sobrecarga.
 */
export function parseFrame(frame: string, cfg: ScaleProtocolConfig): FrameResult {
  const text = frame.replace(/[\x00-\x1f\x7f]/g, " ").trim();
  if (/\b(OL|OVER|OVERLOAD)\b/i.test(text)) return { error: "overload" };
  const src = cfg.regex.trim() || SCALE_PROTOCOLS[cfg.protocol].regex;
  const re = compile(src);
  if (!re) return { error: "bad_regex" };
  const m = re.exec(text);
  const num = m?.[1];
  if (!num) return { error: "no_match" };
  const n = Number(num.replace(",", "."));
  if (!Number.isFinite(n)) return { error: "no_match" };
  // Signo separado del número ("-  0.350").
  const negative = n >= 0 && /-\s*$/.test(text.slice(0, m!.index + m![0].indexOf(num)));
  const kg = (cfg.unit === "g" ? n / 1000 : n) * (negative ? -1 : 1);
  let stableFlag: boolean | null = null;
  if (/\b(US|M|MOTION)\b/i.test(text)) stableFlag = false;
  else if (/\bST\b/i.test(text)) stableFlag = true;
  return { weightKg: Math.round(kg * 1000) / 1000, stableFlag };
}
