// =============================================================================
// _shared/requestGuard.ts (F1.5 · ADR-098)
//
// Barreras baratas para las Edge Functions PÚBLICAS (verify_jwt = false, lista
// en supabase/config.toml y scripts/deploy-check.mjs):
//
//   • readJsonLimited: lee el cuerpo con tope de bytes (por Content-Length y
//     contando lo leído, para cuerpos chunked) y lo parsea. Lanza
//     BodyTooLargeError o el SyntaxError de JSON.parse: los llamadores ya
//     envuelven `req.json()` en try/catch, así que se reemplaza 1 a 1.
//   • createIpLimiter: ventana fija por clave (IP) EN MEMORIA DEL ISOLATE. Es
//     best-effort (cada isolate cuenta por separado y se reinicia en frío): la
//     barrera real sigue siendo la propia validación de cada función (monto
//     fijado por el servidor, re-consulta al proveedor, límite por email en la
//     base). Sirve para frenar ráfagas desde una misma IP.
//
// Puro (sin Deno.*): lo usan las Edge y los tests de Vitest.
// =============================================================================

/** 64 KB: holgado para cualquier notificación de procesador o checkout. */
export const DEFAULT_MAX_BODY_BYTES = 64 * 1024;

export class BodyTooLargeError extends Error {
  constructor(readonly maxBytes: number) {
    super(`body_too_large: más de ${maxBytes} bytes`);
    this.name = "BodyTooLargeError";
  }
}

export async function readTextLimited(req: Request, maxBytes = DEFAULT_MAX_BODY_BYTES): Promise<string> {
  const declared = Number(req.headers.get("content-length") ?? "");
  if (Number.isFinite(declared) && declared > maxBytes) throw new BodyTooLargeError(maxBytes);
  if (!req.body) return "";
  const reader = req.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > maxBytes) {
      await reader.cancel().catch(() => undefined);
      throw new BodyTooLargeError(maxBytes);
    }
    chunks.push(value);
  }
  const buf = new Uint8Array(total);
  let off = 0;
  for (const c of chunks) {
    buf.set(c, off);
    off += c.byteLength;
  }
  return new TextDecoder().decode(buf);
}

// deno-lint-ignore no-explicit-any
export async function readJsonLimited<T = any>(req: Request, maxBytes = DEFAULT_MAX_BODY_BYTES): Promise<T> {
  return JSON.parse(await readTextLimited(req, maxBytes)) as T;
}

/** IP del cliente según el proxy de Supabase (primer x-forwarded-for). */
export function clientIp(req: Request): string {
  const xff = req.headers.get("x-forwarded-for") ?? "";
  const first = xff.split(",")[0]?.trim();
  return first || req.headers.get("x-real-ip")?.trim() || "unknown";
}

export interface IpLimiter {
  /** true = se permite; false = pasó el límite en la ventana actual. */
  hit(key: string, nowMs?: number): boolean;
}

export function createIpLimiter(limit: number, windowMs: number, maxKeys = 5_000): IpLimiter {
  const hits = new Map<string, { start: number; count: number }>();
  return {
    hit(key, nowMs = Date.now()) {
      const cur = hits.get(key);
      if (!cur || nowMs - cur.start >= windowMs) {
        // Tope de memoria: si se llena, se descartan las ventanas vencidas y,
        // si no alcanza, todo (best-effort, nunca crece sin límite).
        if (!cur && hits.size >= maxKeys) {
          for (const [k, v] of hits) if (nowMs - v.start >= windowMs) hits.delete(k);
          if (hits.size >= maxKeys) hits.clear();
        }
        hits.set(key, { start: nowMs, count: 1 });
        return true;
      }
      cur.count += 1;
      return cur.count <= limit;
    },
  };
}
