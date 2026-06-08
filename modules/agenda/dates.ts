// Helpers de fecha/hora para la agenda (F12 · H38). Trabajan en hora LOCAL del
// negocio (el calendario es visual; `starts_at` se guarda como timestamptz ISO).
// Sin dependencias: math de Date nativo.

// Inicio del día (00:00 local) de una fecha.
export function startOfDay(d: Date): Date {
  const x = new Date(d);
  x.setHours(0, 0, 0, 0);
  return x;
}

// Suma días (puede ser negativo).
export function addDays(d: Date, n: number): Date {
  const x = new Date(d);
  x.setDate(x.getDate() + n);
  return x;
}

// Lunes de la semana de `d` (la semana del negocio arranca el lunes).
export function startOfWeek(d: Date): Date {
  const x = startOfDay(d);
  // getDay(): 0=dom..6=sáb. Días desde el lunes.
  const since = (x.getDay() + 6) % 7;
  return addDays(x, -since);
}

// Los 7 días (lunes→domingo) de la semana de `d`.
export function weekDays(d: Date): Date[] {
  const mon = startOfWeek(d);
  return Array.from({ length: 7 }, (_, i) => addDays(mon, i));
}

// Combina una fecha (día) + hora/minuto local → Date.
export function atTime(day: Date, hour: number, minute = 0): Date {
  const x = startOfDay(day);
  x.setHours(hour, minute, 0, 0);
  return x;
}

// "YYYY-MM-DDTHH:mm" local para un <input type="datetime-local">.
export function toDatetimeLocalValue(d: Date): string {
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(
    d.getHours(),
  )}:${pad(d.getMinutes())}`;
}

// Etiqueta corta de hora local "HH:mm".
export function hhmm(d: Date | string): string {
  const x = typeof d === "string" ? new Date(d) : d;
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${pad(x.getHours())}:${pad(x.getMinutes())}`;
}

const dayFmt = new Intl.DateTimeFormat("es-AR", {
  weekday: "short",
  day: "2-digit",
  month: "short",
});
const dayLongFmt = new Intl.DateTimeFormat("es-AR", {
  weekday: "long",
  day: "2-digit",
  month: "long",
});

// "mié 11 jun" / "miércoles 11 de junio".
export function formatDayShort(d: Date): string {
  return dayFmt.format(d);
}
export function formatDayLong(d: Date): string {
  return dayLongFmt.format(d);
}

// Posición vertical (px) de un instante dentro del día, dado el rango de horas
// visible [startHour, endHour) y la altura por hora. Útil para ubicar el bloque.
export function minutesIntoDay(d: Date | string): number {
  const x = typeof d === "string" ? new Date(d) : d;
  return x.getHours() * 60 + x.getMinutes();
}
