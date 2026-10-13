import { NextResponse, type NextRequest } from "next/server";
import { baseReport, deepChecks } from "@/lib/health";

// Healthcheck (roadmap H0, F1.5 · ADR-098). Público y sin sesión (el
// middleware lo deja pasar). Sin secretos ni datos de negocio.
//   GET /api/health          → liveness: el server responde, env y commit.
//   GET /api/health?deep=1   → además Supabase Auth y la base (anon key);
//                              503 si alguno falla. Para el monitor de uptime.
export const dynamic = "force-dynamic";

const NO_STORE = { "Cache-Control": "no-store" };
// El chequeo profundo es público: se reutiliza 10 s por instancia para que un
// barrido de requests no se multiplique contra Supabase.
const DEEP_TTL_MS = 10_000;
let lastDeep: { at: number; checks: Awaited<ReturnType<typeof deepChecks>> } | null = null;

export async function GET(req: NextRequest) {
  const report = baseReport(process.env);
  if (req.nextUrl.searchParams.get("deep") !== "1") return NextResponse.json(report, { headers: NO_STORE });
  if (!lastDeep || Date.now() - lastDeep.at > DEEP_TTL_MS) {
    lastDeep = {
      at: Date.now(),
      checks: await deepChecks({
        fetchFn: fetch,
        supabaseUrl: process.env.NEXT_PUBLIC_SUPABASE_URL,
        anonKey: process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY,
      }),
    };
  }
  const checks = lastDeep.checks;
  const ok = Object.values(checks).every((c) => c.ok);
  return NextResponse.json(
    { ...report, status: ok ? "ok" : "degraded", checks },
    { status: ok ? 200 : 503, headers: NO_STORE },
  );
}
