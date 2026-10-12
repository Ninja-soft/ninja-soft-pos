// =============================================================================
// _shared/timing.ts: tiempos por etapa de las Edge de cobro (ADR-048, "QR más
// rápido"). Cada Edge marca sus etapas (auth, prechecks, intent, proveedor,
// guardado) y al responder:
//   * escribe una línea JSON en el log ({"fn":"mp_qr","total":412,"steps":{...}})
//     para medir antes y después en los logs de Supabase, y
//   * devuelve el header Server-Timing (visible en DevTools → Network → Timing).
// Sin dependencias: performance.now() existe en el runtime de Edge.
// =============================================================================

export interface EdgeTimer {
  mark(label: string): void;
  headers(): Record<string, string>;
  log(extra?: Record<string, unknown>): void;
}

export function edgeTimer(fn: string): EdgeTimer {
  const t0 = performance.now();
  let last = t0;
  const steps: [string, number][] = [];
  const total = () => Math.round(performance.now() - t0);
  return {
    mark(label: string) {
      const now = performance.now();
      steps.push([label, Math.round(now - last)]);
      last = now;
    },
    headers() {
      const parts = steps.map(([k, v]) => `${k.replace(/[^a-z0-9_]/gi, "_")};dur=${v}`);
      parts.push(`total;dur=${total()}`);
      return {
        "Server-Timing": parts.join(", "),
        "Timing-Allow-Origin": "*",
        "Access-Control-Expose-Headers": "Server-Timing",
      };
    },
    log(extra?: Record<string, unknown>) {
      console.log(JSON.stringify({ fn, total: total(), steps: Object.fromEntries(steps), ...(extra ?? {}) }));
    },
  };
}
