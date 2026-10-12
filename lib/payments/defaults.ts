// Medios de pago habilitados por defecto en todo negocio.
//
// Efectivo y transferencia no necesitan cuenta ni conexión: si el negocio no
// tiene fila en tenant_payment_methods para ellos, cuentan como prendidos (en
// la configuración y en el POS). Una fila explícita siempre manda, así el
// dueño los puede apagar. El alta de negocio y la migración
// 20261012010000 siembran las filas; esto cubre a los que todavía no las tienen.

export const DEFAULT_ON_PROVIDERS = ["cash", "transfer"] as const;

const DEFAULT_ON = new Set<string>(DEFAULT_ON_PROVIDERS);

/** ¿El medio está habilitado? Sin fila, sólo los medios por defecto. */
export function isProviderEnabled(key: string, row: { enabled: boolean } | undefined): boolean {
  return row ? Boolean(row.enabled) : DEFAULT_ON.has(key);
}

/** Agrega una fila virtual (de `make`) para cada medio por defecto sin fila. */
export function withDefaultMethods<T extends { provider_key: string }>(
  rows: T[],
  make: (key: string) => T,
): T[] {
  const have = new Set(rows.map((r) => r.provider_key));
  return [...rows, ...DEFAULT_ON_PROVIDERS.filter((k) => !have.has(k)).map(make)];
}
