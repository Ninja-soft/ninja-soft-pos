const ars = new Intl.NumberFormat("es-AR", {
  style: "currency",
  currency: "ARS",
  minimumFractionDigits: 2,
});

/** Formatea un monto en pesos argentinos. */
export function formatCurrency(value: number | null | undefined): string {
  return ars.format(value ?? 0);
}

/** Formatea una cantidad (stock) sin ceros decimales innecesarios. */
export function formatQty(value: number | null | undefined): string {
  const n = value ?? 0;
  return Number.isInteger(n) ? String(n) : n.toFixed(3).replace(/\.?0+$/, "");
}

const intFmt = new Intl.NumberFormat("es-AR", { maximumFractionDigits: 0 });

/** Formatea un entero con separador de miles es-AR (1234 → "1.234"). */
export function formatInt(value: number | null | undefined): string {
  return intFmt.format(Math.round(value ?? 0));
}

/**
 * Capitaliza un nombre: primera letra de cada palabra en mayúscula y el resto
 * en minúscula, respetando acentos (usa locale es-AR). Solo cambia la
 * capitalización; no agrega ni quita tildes. Reconoce separadores de espacio,
 * guion y apóstrofo (ej. "ana-maría", "d'angelo").
 *
 * "hola juan perez" → "Hola Juan Perez"   ·   "JUAN PÉREZ" → "Juan Pérez"
 */
export function capitalizeName(value: string | null | undefined): string {
  if (!value) return "";
  return value
    .toLocaleLowerCase("es-AR")
    .replace(/(^|[\s\-'’])(\p{L})/gu, (_m, sep: string, ch: string) =>
      sep + ch.toLocaleUpperCase("es-AR"),
    );
}

const rtf = new Intl.RelativeTimeFormat("es-AR", { numeric: "auto" });

/** "hace 5 minutos", "ayer", "hace 3 meses". null/undefined → "nunca". */
export function formatRelative(date: string | Date | null | undefined): string {
  if (!date) return "nunca";
  const then = typeof date === "string" ? new Date(date) : date;
  const secs = Math.round((then.getTime() - Date.now()) / 1000);
  const abs = Math.abs(secs);
  if (abs < 60) return rtf.format(Math.trunc(secs / 1), "second");
  if (abs < 3600) return rtf.format(Math.trunc(secs / 60), "minute");
  if (abs < 86400) return rtf.format(Math.trunc(secs / 3600), "hour");
  if (abs < 2592000) return rtf.format(Math.trunc(secs / 86400), "day");
  if (abs < 31536000) return rtf.format(Math.trunc(secs / 2592000), "month");
  return rtf.format(Math.trunc(secs / 31536000), "year");
}
