// =============================================================================
// Contingencia CAEA: quincenas y plazos (ADR-072). PURO. Espejo de
// arca_caea_tasks (SQL).
//
// Orientativo (Manual WSFEv1, métodos FECAEA*; validar con la norma vigente):
//   · Período AAAAMM y orden 1 (días 1 a 15) o 2 (16 a fin de mes).
//   · Se solicita dentro de los 5 días corridos anteriores al inicio de la
//     quincena (y se puede consultar con FECAEAConsultar).
//   · Los comprobantes emitidos con CAEA se informan con
//     FECAEARegInformativo hasta FchTopeInf (la devuelve ARCA; hoy, 8 días
//     corridos posteriores al fin de la quincena).
//   · Un punto de venta CAEA sin comprobantes en la quincena se informa con
//     FECAEASinMovimientoInformar.
//   · El punto de venta de CAEA es exclusivo (distinto de los de CAE).
// =============================================================================

export interface Quincena {
  periodo: number; // AAAAMM
  orden: 1 | 2;
  desde: string; // AAAAMMDD
  hasta: string;
}

const p2 = (n: number) => String(n).padStart(2, "0");

function lastDay(y: number, m: number): number {
  return new Date(Date.UTC(y, m, 0)).getUTCDate();
}

export function quincenaOf(ymd: string): Quincena {
  const y = +ymd.slice(0, 4);
  const m = +ymd.slice(4, 6);
  const d = +ymd.slice(6, 8);
  const orden: 1 | 2 = d <= 15 ? 1 : 2;
  return {
    periodo: y * 100 + m,
    orden,
    desde: `${y}${p2(m)}${orden === 1 ? "01" : "16"}`,
    hasta: `${y}${p2(m)}${orden === 1 ? "15" : p2(lastDay(y, m))}`,
  };
}

export function nextQuincena(q: Quincena): Quincena {
  const y = Math.floor(q.periodo / 100);
  const m = q.periodo % 100;
  if (q.orden === 1) return quincenaOf(`${y}${p2(m)}16`);
  const ny = m === 12 ? y + 1 : y;
  const nm = m === 12 ? 1 : m + 1;
  return quincenaOf(`${ny}${p2(nm)}01`);
}

function daysBetween(a: string, b: string): number {
  const da = Date.UTC(+a.slice(0, 4), +a.slice(4, 6) - 1, +a.slice(6, 8));
  const db = Date.UTC(+b.slice(0, 4), +b.slice(4, 6) - 1, +b.slice(6, 8));
  return Math.round((db - da) / 86_400_000);
}

/** Quincenas a pedir hoy: la vigente si falta y la próxima si empieza en 5 días o menos. */
export function caeaPeriodsToRequest(today: string, have: { periodo: number; orden: number }[]): Quincena[] {
  const cur = quincenaOf(today);
  const next = nextQuincena(cur);
  const has = (q: Quincena) => have.some((h) => h.periodo === q.periodo && h.orden === q.orden);
  const out: Quincena[] = [];
  if (!has(cur)) out.push(cur);
  if (daysBetween(today, next.desde) <= 5 && !has(next)) out.push(next);
  return out;
}

/** ¿Un CAEA sirve para emitir hoy? */
export function caeaUsable(c: { fch_vig_desde: string; fch_vig_hasta: string }, todayIso: string): boolean {
  return c.fch_vig_desde <= todayIso && todayIso <= c.fch_vig_hasta;
}

/** Fecha y hora de generación AAAAMMDDhhmmss en hora de Argentina. */
export function fchHsGen(d: Date): string {
  const t = new Date(d.getTime() - 3 * 3600_000);
  return (
    `${t.getUTCFullYear()}${p2(t.getUTCMonth() + 1)}${p2(t.getUTCDate())}` +
    `${p2(t.getUTCHours())}${p2(t.getUTCMinutes())}${p2(t.getUTCSeconds())}`
  );
}
