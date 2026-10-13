// Límite por cliente de la API pública (ADR-094): ventana deslizante
// aproximada con dos ventanas fijas de un minuto. Espejo puro de
// _api_rate_hit (20261109400200_api_publica_auth.sql), que es la barrera real.
//
//   estimado = previa * (1 - transcurrido) + actual
//
// donde `actual` ya incluye el pedido que se evalúa y `transcurrido` es la
// fracción (0..1) del minuto en curso.

export type RateDecision = {
  allowed: boolean;
  limit: number;
  remaining: number;
  /** Segundos hasta que cierra la ventana actual. */
  reset: number;
  retryAfter?: number;
};

export function slidingEstimate(prev: number, current: number, elapsedFraction: number): number {
  const f = Math.min(Math.max(elapsedFraction, 0), 1);
  return Math.max(prev, 0) * (1 - f) + Math.max(current, 0);
}

export function rateDecision(input: {
  prev: number;
  /** Hits de la ventana actual contando este pedido. */
  current: number;
  elapsedFraction: number;
  limit: number;
}): RateDecision {
  const est = slidingEstimate(input.prev, input.current, input.elapsedFraction);
  const reset = Math.max(1, Math.ceil(60 - Math.min(Math.max(input.elapsedFraction, 0), 1) * 60));
  if (est > input.limit) {
    return { allowed: false, limit: input.limit, remaining: 0, reset, retryAfter: reset };
  }
  return { allowed: true, limit: input.limit, remaining: Math.max(Math.floor(input.limit - est), 0), reset };
}

/** Ventana (inicio del minuto) de un instante, como date_trunc('minute'). */
export function windowStart(ms: number): number {
  return Math.floor(ms / 60_000) * 60_000;
}

/**
 * Simulador en memoria (tests y documentación): aplica la misma regla que la
 * base y sólo cuenta lo permitido.
 */
export class SlidingWindowLimiter {
  private hits = new Map<number, number>();
  constructor(private readonly limit: number) {}

  hit(nowMs: number): RateDecision {
    const win = windowStart(nowMs);
    const current = (this.hits.get(win) ?? 0) + 1;
    const prev = this.hits.get(win - 60_000) ?? 0;
    const d = rateDecision({ prev, current, elapsedFraction: (nowMs - win) / 60_000, limit: this.limit });
    if (d.allowed) this.hits.set(win, current);
    for (const k of this.hits.keys()) if (k < win - 60_000) this.hits.delete(k);
    return d;
  }
}
