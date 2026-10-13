// Visor de cliente de 2 líneas (F10 · H25 · ADR-101). PURO.
//
// Los visores "pole display" (VFD o LCD de 2 x 20 caracteres, por serie o USB
// serie) muestran nombre del ítem y precio, total y vuelto. Casi todos
// entienden el juego de comandos ESC/POS de visores (Epson DM-D y compatibles):
//   0C       limpiar pantalla
//   1F 24 x y  mover el cursor a columna x, fila y (1-based)
//   1B 40    inicializar
// Acá se arman las dos líneas y los bytes; el envío va por los transportes de
// ADR-053 (Web Serial o puente local) y el simulador de diagnóstico las
// dibuja sin equipo.

export const POLE_COLS = 20;

export type PoleState =
  | { kind: "idle"; message?: string | null }
  | { kind: "item"; name: string; qty: number; price: number; total: number }
  | { kind: "total"; total: number }
  | { kind: "change"; paid: number; change: number }
  | { kind: "thanks"; message?: string | null };

/** "$1.250,50" sin espacio (entra mejor en 20 columnas). */
export function poleMoney(n: number): string {
  const v = Math.round((Number.isFinite(n) ? n : 0) * 100) / 100;
  const s = Math.abs(v).toLocaleString("es-AR", {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  });
  return `${v < 0 ? "-" : ""}$${s}`;
}

function plain(text: string): string {
  // Los visores traen PC437 a lo sumo: sin acentos para no ver basura.
  return text
    .normalize("NFD")
    .replace(/\p{M}/gu, "")
    .replace(/[^\x20-\x7e]/g, "?");
}

function fitLeftRight(left: string, right: string, cols = POLE_COLS): string {
  const r = plain(right).slice(0, cols);
  const room = Math.max(0, cols - r.length - (r ? 1 : 0));
  const l = plain(left).slice(0, room);
  return (l + " ".repeat(Math.max(0, cols - l.length - r.length)) + r).slice(
    0,
    cols,
  );
}

function center(text: string, cols = POLE_COLS): string {
  const t = plain(text).slice(0, cols);
  const left = Math.floor((cols - t.length) / 2);
  return (" ".repeat(left) + t).padEnd(cols, " ");
}

/** Las dos líneas exactas (20 caracteres cada una). */
export function poleLines(state: PoleState, business = ""): [string, string] {
  switch (state.kind) {
    case "item": {
      const qty =
        state.qty === 1
          ? ""
          : `${Number(state.qty.toFixed(3)).toLocaleString("es-AR")} x `;
      return [
        fitLeftRight(state.name, ""),
        fitLeftRight(qty ? qty.trim() : "", poleMoney(state.price * state.qty)),
      ];
    }
    case "total":
      return [
        fitLeftRight("TOTAL", ""),
        fitLeftRight("", poleMoney(state.total)),
      ];
    case "change":
      return [
        fitLeftRight("PAGO", poleMoney(state.paid)),
        fitLeftRight("VUELTO", poleMoney(state.change)),
      ];
    case "thanks":
      return [
        center(state.message || "Gracias por su compra"),
        center(business),
      ];
    case "idle":
    default:
      return [center(business || "Bienvenido"), center(state.message || "")];
  }
}

/** Bytes para el visor: limpiar, línea 1, cursor a la fila 2, línea 2. */
export function encodePole(lines: [string, string]): Uint8Array {
  const text = (s: string) =>
    Array.from(
      s.padEnd(POLE_COLS, " ").slice(0, POLE_COLS),
      (c) => c.charCodeAt(0) & 0x7f,
    );
  return new Uint8Array([
    0x1b,
    0x40,
    0x0c,
    ...text(lines[0]),
    0x1f,
    0x24,
    1,
    2,
    ...text(lines[1]),
  ]);
}

/** Lee los bytes de encodePole (simulador). */
export function decodePole(bytes: Uint8Array): [string, string] {
  const rows: [string[], string[]] = [[], []];
  let row = 0;
  for (let i = 0; i < bytes.length; i++) {
    const c = bytes[i]!;
    if (c === 0x1b && bytes[i + 1] === 0x40) {
      i += 1;
      continue;
    }
    if (c === 0x0c) {
      rows[0] = [];
      rows[1] = [];
      row = 0;
      continue;
    }
    if (c === 0x1f && bytes[i + 1] === 0x24) {
      row = (bytes[i + 3] ?? 1) >= 2 ? 1 : 0;
      i += 3;
      continue;
    }
    if (c >= 0x20 && c < 0x7f && rows[row as 0 | 1].length < POLE_COLS)
      rows[row as 0 | 1].push(String.fromCharCode(c));
  }
  return [
    rows[0].join("").padEnd(POLE_COLS, " "),
    rows[1].join("").padEnd(POLE_COLS, " "),
  ];
}
