// F13 · H47 — Helpers de horario para los menús por franja (daypart).
//
// Las ventanas de un menú guardan día de semana (0=domingo..6=sábado, igual que
// extract(dow) en Postgres) y un rango en MINUTOS del día (0..1440) en hora local
// de Argentina. La UI trabaja con "HH:MM" (<input type="time">). Estos helpers
// son puros (sin DOM, sin red) para poder testearlos.

// Etiquetas de día, índice = weekday (0=domingo). Orden de Postgres dow.
export const WEEKDAYS = [
  "Domingo",
  "Lunes",
  "Martes",
  "Miércoles",
  "Jueves",
  "Viernes",
  "Sábado",
] as const;

export const WEEKDAYS_SHORT = ["Dom", "Lun", "Mar", "Mié", "Jue", "Vie", "Sáb"] as const;

// "HH:MM" → minutos del día (0..1440). Devuelve null si el formato es inválido.
export function timeToMin(hhmm: string): number | null {
  const m = /^(\d{1,2}):(\d{2})$/.exec(hhmm.trim());
  if (!m) return null;
  const h = Number(m[1]);
  const min = Number(m[2]);
  if (h < 0 || h > 24 || min < 0 || min > 59) return null;
  const total = h * 60 + min;
  if (total > 1440) return null;
  return total;
}

// Minutos del día (0..1440) → "HH:MM" (24h, con cero a la izquierda). Acota al
// rango válido. 1440 = "24:00" (fin del día).
export function minToTime(min: number): string {
  const clamped = Math.max(0, Math.min(1440, Math.trunc(min)));
  const h = Math.floor(clamped / 60);
  const m = clamped % 60;
  return `${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}`;
}

// Etiqueta legible de una ventana: "Lun · 12:00–15:30".
export function formatWindow(weekday: number, startMin: number, endMin: number): string {
  const day = WEEKDAYS_SHORT[weekday] ?? "?";
  return `${day} · ${minToTime(startMin)}–${minToTime(endMin)}`;
}

// ¿La ventana es válida para guardar? end debe ser mayor que start y ambos en
// rango. (No se admiten ventanas que cruzan medianoche en esta versión.)
export function isValidWindow(weekday: number, startMin: number, endMin: number): boolean {
  if (!Number.isInteger(weekday) || weekday < 0 || weekday > 6) return false;
  if (startMin < 0 || startMin > 1439) return false;
  if (endMin < 1 || endMin > 1440) return false;
  return endMin > startMin;
}
