// =============================================================================
// Reintentos cortos con backoff para las consultas de ARCA que hace la
// pantalla (prueba de conexión, verificación de la autorización y de los
// puntos de venta) · ADR-149. PURO: el sleep se inyecta en los tests.
//
// Sólo se reintenta lo transitorio (sin respuesta, timeout, 5xx, reloj de
// WSAA). Un error del negocio (coe.notAuthorized, certificado, CUIT) vuelve
// enseguida: reintentarlo no lo arregla. La cola fiscal tiene su propio
// backoff largo (nextAttemptAt) y no usa esto.
// =============================================================================

export const TEST_BACKOFF_MS = [800, 2_500] as const;

export type Sleep = (ms: number) => Promise<void>;
export const realSleep: Sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * Ejecuta `fn` y, mientras `isTransient(resultado)` sea verdadero, la repite
 * esperando cada valor de `delays`. Devuelve el último resultado y cuántos
 * intentos se hicieron.
 */
export async function withRetry<T>(
  fn: () => Promise<T>,
  isTransient: (r: T) => boolean,
  delays: readonly number[] = TEST_BACKOFF_MS,
  sleep: Sleep = realSleep,
): Promise<{ result: T; attempts: number }> {
  let result = await fn();
  let attempts = 1;
  for (const d of delays) {
    if (!isTransient(result)) break;
    await sleep(d);
    result = await fn();
    attempts++;
  }
  return { result, attempts };
}

/** ¿Un código de WSAA es pasajero (reloj, servidor)? */
export function isTransientWsaaCode(code: string | null | undefined): boolean {
  const c = String(code ?? "").toLowerCase();
  return c.includes("generationtime") || c.includes("expirationtime") || c.includes("server") || c.includes("unavailable");
}
