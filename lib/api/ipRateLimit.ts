// Límite por IP del sandbox público (ADR-163). Misma regla de ventana
// deslizante que la API (lib/api-publica/rateLimit.ts), en memoria de cada
// instancia: es un freno al abuso de una página sin login, no una cuota
// contable. Con una credencial de prueba propia, además, la base aplica el
// límite por credencial de siempre.

import { SlidingWindowLimiter, type RateDecision } from "@/lib/api-publica/rateLimit";

export const SANDBOX_IP_LIMIT_PER_MIN = 60;
const MAX_TRACKED = 5_000;

export class IpRateLimiter {
  private byIp = new Map<string, SlidingWindowLimiter>();
  constructor(private readonly limit: number = SANDBOX_IP_LIMIT_PER_MIN) {}

  hit(ip: string, nowMs: number = Date.now()): RateDecision {
    let l = this.byIp.get(ip);
    if (!l) {
      // Tope de memoria: si se llena, se descarta la IP más vieja.
      if (this.byIp.size >= MAX_TRACKED) {
        const first = this.byIp.keys().next().value;
        if (first !== undefined) this.byIp.delete(first);
      }
      l = new SlidingWindowLimiter(this.limit);
      this.byIp.set(ip, l);
    }
    return l.hit(nowMs);
  }

  get size(): number {
    return this.byIp.size;
  }
}

/** IP del cliente detrás del proxy de Vercel (primer x-forwarded-for). */
export function clientIp(headers: { get(name: string): string | null }): string {
  const fwd = headers.get("x-forwarded-for");
  const first = fwd?.split(",")[0]?.trim();
  return first || headers.get("x-real-ip")?.trim() || "unknown";
}

export function rateHeaders(d: RateDecision): Record<string, string> {
  const h: Record<string, string> = {
    "RateLimit-Limit": String(d.limit),
    "RateLimit-Remaining": String(d.remaining),
    "RateLimit-Reset": String(d.reset),
  };
  if (!d.allowed) h["Retry-After"] = String(d.retryAfter ?? d.reset);
  return h;
}
