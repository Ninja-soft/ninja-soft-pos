import { NextResponse, type NextRequest } from "next/server";
import { z } from "zod";
import { MAX_REPORT_BYTES, redact } from "@/lib/errors/clientError";
import {
  BodyTooLargeError,
  clientIp,
  createIpLimiter,
  readTextLimited,
} from "@/supabase/functions/_shared/requestGuard";

// Reporte de errores del front (ADR-098). Lo mandan los error boundaries con
// sendBeacon; queda como una línea JSON `event: "client_error"` en los logs de
// Vercel (Functions). Público y sin sesión (falla también en /login), así que:
// mismo origen, cuerpo chico, esquema cerrado y tope por IP. No guarda nada.
export const dynamic = "force-dynamic";

const limiter = createIpLimiter(20, 60_000);

const schema = z
  .object({
    boundary: z.string().max(40),
    kind: z.enum(["update", "network", "unknown"]),
    name: z.string().max(80),
    message: z.string().max(500),
    digest: z.string().max(64).nullable(),
    path: z.string().max(200),
    stack: z.string().max(2000).nullable(),
    release: z.string().max(40).nullable(),
  })
  .strict();

function sameOrigin(req: NextRequest): boolean {
  const origin = req.headers.get("origin");
  if (!origin) return true; // sendBeacon de algunos navegadores no lo manda
  try {
    return new URL(origin).host === req.headers.get("host");
  } catch {
    return false;
  }
}

export async function POST(req: NextRequest) {
  if (!sameOrigin(req)) return new NextResponse(null, { status: 403 });
  if (!limiter.hit(clientIp(req))) return new NextResponse(null, { status: 429, headers: { "Retry-After": "60" } });
  let text: string;
  try {
    text = await readTextLimited(req, MAX_REPORT_BYTES);
  } catch (e) {
    return new NextResponse(null, { status: e instanceof BodyTooLargeError ? 413 : 400 });
  }
  let parsed: z.infer<typeof schema>;
  try {
    parsed = schema.parse(JSON.parse(text));
  } catch {
    return new NextResponse(null, { status: 400 });
  }
  console.error(
    JSON.stringify({
      level: "error",
      event: "client_error",
      env: process.env.VERCEL_ENV ?? process.env.NODE_ENV ?? "unknown",
      ua: (req.headers.get("user-agent") ?? "").slice(0, 200),
      ...parsed,
      // El cliente ya lo limpia; se repite acá porque el cuerpo no es confiable.
      message: redact(parsed.message),
      stack: parsed.stack ? redact(parsed.stack) : null,
    }),
  );
  return new NextResponse(null, { status: 204 });
}
