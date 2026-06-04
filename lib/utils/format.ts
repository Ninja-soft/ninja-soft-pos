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
