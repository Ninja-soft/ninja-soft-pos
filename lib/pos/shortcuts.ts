// Atajos de teclado del POS (TX-3 · ADR-100). PURO: el catálogo que muestra
// la ayuda "?" y la función que decide qué atajo dispara una tecla.
//
// Reglas para no chocar con el navegador ni con el lector de códigos:
//   * Sólo teclas de función que Chrome, Edge y Firefox no usan solas: F2, F4,
//     F8 y F9. F1 (ayuda), F3 (buscar), F5 (recargar), F6 (barra), F7 (cursor),
//     F10 (menú), F11 (pantalla completa) y F12 (herramientas) quedan libres.
//     F12 sigue cobrando por costumbre de otros POS, pero en algunos equipos
//     el navegador lo toma primero: el atajo documentado es F9.
//   * Nada con Ctrl / Cmd / Alt: son del navegador y del sistema.
//   * "?" abre la ayuda sólo si el foco NO está en un campo de texto (si no,
//     escribir "?" en una búsqueda la abriría).
//   * Un lector USB tipea dígitos y Enter: ningún atajo usa esas teclas.

export type PosShortcutAction =
  | "search"
  | "checkout"
  | "customer"
  | "pending"
  | "help";

export interface PosShortcut {
  action: PosShortcutAction;
  /** Teclas tal como se muestran (la primera es la principal). */
  keys: string[];
  label: string;
  /** Explicación corta para la ayuda. */
  hint?: string;
}

export const POS_SHORTCUTS: PosShortcut[] = [
  {
    action: "search",
    keys: ["F2"],
    label: "Buscar producto",
    hint: "Lleva el cursor a la búsqueda y selecciona el texto.",
  },
  { action: "customer", keys: ["F4"], label: "Elegir cliente" },
  {
    action: "pending",
    keys: ["F8"],
    label: "Ver cobros en espera",
    hint: "Si tu plan los incluye.",
  },
  {
    action: "checkout",
    keys: ["F9", "F12"],
    label: "Cobrar",
    hint: "F12 también cobra si el navegador no lo usa.",
  },
  {
    action: "help",
    keys: ["?"],
    label: "Ver esta ayuda",
    hint: "Fuera de un campo de texto.",
  },
];

/** Atajos que no se capturan: los maneja el navegador o un diálogo. */
export const POS_PASSIVE_SHORTCUTS: { keys: string[]; label: string }[] = [
  { keys: ["Esc"], label: "Cerrar el diálogo o la hoja abierta" },
  { keys: ["Enter"], label: "Agregar el producto buscado o confirmar" },
  { keys: ["Tab", "Shift + Tab"], label: "Moverse entre botones y campos" },
];

const F_KEYS: Record<string, PosShortcutAction> = {
  F2: "search",
  F4: "customer",
  F8: "pending",
  F9: "checkout",
  F12: "checkout",
};

export interface KeyLike {
  key: string;
  ctrlKey?: boolean;
  metaKey?: boolean;
  altKey?: boolean;
  repeat?: boolean;
}

export interface TargetLike {
  tagName?: string;
  isContentEditable?: boolean;
  type?: string;
}

/** ¿El foco está en un lugar donde se escribe texto? */
export function isTypingTarget(t: TargetLike | null | undefined): boolean {
  if (!t) return false;
  if (t.isContentEditable) return true;
  const tag = (t.tagName ?? "").toUpperCase();
  if (tag === "TEXTAREA" || tag === "SELECT") return true;
  if (tag !== "INPUT") return false;
  const type = (t.type ?? "text").toLowerCase();
  return ![
    "button",
    "checkbox",
    "radio",
    "submit",
    "reset",
    "range",
    "color",
    "file",
  ].includes(type);
}

/**
 * Qué atajo corresponde a la tecla (o null). Las teclas de función andan
 * aunque el foco esté en la búsqueda; "?" sólo fuera de un campo de texto.
 * Las repeticiones por tecla sostenida no disparan de nuevo.
 */
export function matchPosShortcut(
  e: KeyLike,
  target?: TargetLike | null,
): PosShortcutAction | null {
  if (e.ctrlKey || e.metaKey || e.altKey || e.repeat) return null;
  const f = F_KEYS[e.key];
  if (f) return f;
  if (e.key === "?" && !isTypingTarget(target)) return "help";
  return null;
}
