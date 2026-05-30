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
