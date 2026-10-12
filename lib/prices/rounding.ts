// Redondeo de precios (F18 · H100, ADR-058). Lógica pura, espejo exacto de
// `_price_round` (SQL, migración 20261021100200_resolver_listas_pro).
//
// Todo se hace en CENTAVOS enteros para que el navegador y Postgres (numeric,
// exacto) den el mismo resultado: el redondeo a centavos es "mitad hacia arriba"
// sobre el valor limpio a 9 decimales (evita el ruido binario, 110.495 no se
// vuelve 110.49).
//
// Reglas:
//   · multiple: múltiplo de `step` ($10, $50, $100 o cualquiera), hacia arriba,
//     abajo o al más cercano (empate: arriba).
//   · ending: terminación psicológica. `ending` 0.99 → $X,99; 9 → $..9;
//     90 → $..90; 99 → $..99; 990 → $..990. El módulo es la potencia de 10
//     inmediatamente mayor que la terminación (1 para ,99). Nunca deja un precio
//     en cero o negativo: si "abajo" cae en <= 0, sube.

export type RoundingMode = "none" | "multiple" | "ending";
export type RoundingDirection = "up" | "down" | "nearest";

export interface RoundingRule {
  mode: RoundingMode;
  /** Múltiplo en pesos (mode = multiple). */
  step?: number | null;
  /** Terminación (mode = ending): 0.99, 9, 90, 99, 990… */
  ending?: number | null;
  direction?: RoundingDirection | null;
}

export const NO_ROUNDING: RoundingRule = { mode: "none" };

/** Pesos → centavos enteros, mitad hacia arriba (lejos del cero). */
export function toCents(n: number): number {
  if (!Number.isFinite(n)) return 0;
  const neg = n < 0;
  const s = Math.abs(n).toFixed(9);
  const [ip, fp = ""] = s.split(".");
  const frac = (fp + "000").slice(0, 3);
  let cents = Number(ip) * 100 + Number(frac.slice(0, 2));
  if (Number(frac[2]) >= 5) cents += 1;
  return neg ? -cents : cents;
}

/** Pesos → centavos enteros redondeando SIEMPRE hacia arriba (piso de precio). */
export function toCentsCeil(n: number): number {
  if (!Number.isFinite(n) || n <= 0) return toCents(n);
  const s = n.toFixed(9);
  const [ip, fp = ""] = s.split(".");
  const frac = (fp + "000000000").slice(0, 9);
  let cents = Number(ip) * 100 + Number(frac.slice(0, 2));
  if (Number(frac.slice(2)) > 0) cents += 1;
  return cents;
}

/** Centavos → pesos. */
export function fromCents(c: number): number {
  return c / 100;
}

/** Redondeo a 2 decimales con la misma regla que `round(x, 2)` de Postgres. */
export function round2(n: number): number {
  return fromCents(toCents(n));
}

function modulusFor(endingCents: number): number {
  // Potencia de 10 (en centavos) inmediatamente mayor que la terminación.
  let m = 100; // $1
  while (m <= endingCents) m *= 10;
  return m;
}

/** ¿La regla redondea algo? */
export function isRounding(rule: RoundingRule | null | undefined): rule is RoundingRule {
  if (!rule || rule.mode === "none") return false;
  if (rule.mode === "multiple") return Number(rule.step ?? 0) > 0;
  if (rule.mode === "ending") return rule.ending != null && Number(rule.ending) >= 0;
  return false;
}

/** Aplica la regla a un precio en pesos. Sin regla válida, sólo redondea a centavos. */
export function applyRounding(price: number, rule: RoundingRule | null | undefined): number {
  const p = toCents(price);
  if (!isRounding(rule)) return fromCents(p);
  const dir: RoundingDirection = rule.direction ?? "nearest";

  if (rule.mode === "multiple") {
    const step = toCents(Number(rule.step));
    if (step <= 0) return fromCents(p);
    const down = Math.floor(p / step) * step;
    const up = down === p ? p : down + step;
    let r: number;
    if (dir === "up") r = up;
    else if (dir === "down") r = down;
    else r = p - down < up - p ? down : up;
    if (r <= 0) r = up > 0 ? up : step;
    return fromCents(r);
  }

  const e = toCents(Number(rule.ending));
  const m = modulusFor(e);
  const base = Math.floor(p / m) * m + e;
  const down = base > p ? base - m : base;
  const up = base < p ? base + m : base;
  let r: number;
  if (dir === "up") r = up;
  else if (dir === "down") r = down;
  else r = p - down < up - p ? down : up;
  if (r <= 0) r = up;
  return fromCents(r);
}

/** Texto corto para la UI ("A múltiplos de $100, hacia arriba"). */
export function describeRounding(rule: RoundingRule | null | undefined): string {
  if (!isRounding(rule)) return "Sin redondeo";
  const dir =
    rule.direction === "up" ? "hacia arriba" : rule.direction === "down" ? "hacia abajo" : "al más cercano";
  if (rule.mode === "multiple") return `A múltiplos de $${rule.step}, ${dir}`;
  const e = Number(rule.ending);
  const label = e < 1 ? `,${String(Math.round(e * 100)).padStart(2, "0")}` : String(e);
  return `Terminado en ${label}, ${dir}`;
}
