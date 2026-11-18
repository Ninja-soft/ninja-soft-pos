// Healthcheck (F1.5 · ADR-098). Liveness siempre; con ?deep=1 además prueba que
// Supabase responde (Auth y PostgREST con la anon key, nada privado). Pensado
// para un monitor de uptime externo y para el humo post-deploy.
import pkg from "../package.json";

// Versión de la app (OPS-53): sale de package.json en el build, no de
// npm_package_version (que sólo existe si el proceso arranca con npm/pnpm y en
// Vercel no está). La sube `pnpm release:prepare` en cada deploy.
export const APP_VERSION: string = pkg.version;

export interface HealthCheck {
  ok: boolean;
  status: number | null;
  ms: number;
  error?: string;
}

export interface HealthReport {
  status: "ok" | "degraded";
  service: string;
  version: string;
  env: string;
  commit: string | null;
  time: string;
  checks?: Record<string, HealthCheck>;
}

type FetchFn = (input: string, init?: RequestInit) => Promise<Response>;

async function probe(fetchFn: FetchFn, url: string, init: RequestInit, timeoutMs: number): Promise<HealthCheck> {
  const t0 = Date.now();
  try {
    const r = await fetchFn(url, { ...init, cache: "no-store", signal: AbortSignal.timeout(timeoutMs) });
    return { ok: r.ok, status: r.status, ms: Date.now() - t0 };
  } catch (e) {
    const name = (e as { name?: string })?.name;
    return { ok: false, status: null, ms: Date.now() - t0, error: name === "TimeoutError" ? "timeout" : "unreachable" };
  }
}

export async function deepChecks(opts: {
  fetchFn: FetchFn;
  supabaseUrl: string | undefined;
  anonKey: string | undefined;
  timeoutMs?: number;
}): Promise<{ supabase_auth: HealthCheck; supabase_db: HealthCheck }> {
  const { fetchFn, supabaseUrl, anonKey, timeoutMs = 3_000 } = opts;
  if (!supabaseUrl || !anonKey) {
    const missing: HealthCheck = { ok: false, status: null, ms: 0, error: "not_configured" };
    return { supabase_auth: missing, supabase_db: missing };
  }
  const base = supabaseUrl.replace(/\/+$/, "");
  const headers = { apikey: anonKey, Authorization: `Bearer ${anonKey}` };
  const [auth, db] = await Promise.all([
    probe(fetchFn, `${base}/auth/v1/health`, { headers }, timeoutMs),
    // Lectura anónima de una tabla pública: con RLS devuelve [] y 200 si la base
    // responde. Prueba la cadena PostgREST → Postgres sin datos de nadie.
    probe(fetchFn, `${base}/rest/v1/plans?select=key&limit=1`, { headers }, timeoutMs),
  ]);
  return { supabase_auth: auth, supabase_db: db };
}

export function baseReport(env: Record<string, string | undefined>, now = new Date(), version = APP_VERSION): HealthReport {
  return {
    status: "ok",
    service: "ninja-soft-pos",
    version,
    env: env.VERCEL_ENV ?? env.NODE_ENV ?? "unknown",
    commit: env.VERCEL_GIT_COMMIT_SHA ? env.VERCEL_GIT_COMMIT_SHA.slice(0, 7) : null,
    time: now.toISOString(),
  };
}
