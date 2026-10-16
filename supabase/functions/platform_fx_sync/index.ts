// =============================================================================
// Edge Function: platform_fx_sync (ADR-135). Cotización del dólar oficial (venta)
// de ArgentinaDatos para el panel interno y la liquidación del staff (F21).
//
// Lee https://api.argentinadatos.com/v1/cotizaciones/dolares/oficial (el
// histórico completo, unos 500 KB) y, si falla, el endpoint del día
// (.../oficial/YYYY/MM/DD). Graba con platform_fx_ingest (service_role): upsert
// idempotente por día en platform_fx_rates (source 'api') y una fila en platform_fx_runs.
// La carga manual del staff (source 'manual') nunca se pisa y manda sobre la
// de la API para ese día.
//
// Desde qué fecha: platform_fx_sync_from() (2 años si todavía no hay datos de la
// API: backfill; si no, los últimos 15 días). { mode: "backfill", days } pide
// una ventana explícita (hasta 3650 días).
//
// Si la API falla: 3 intentos con espera creciente; después registra la
// corrida con status 'error' y el mensaje (el panel lo muestra como aviso) y
// responde 200 para que el cron no reintente en loop. Nunca rompe la
// liquidación: sigue usando la última cotización disponible.
//
// Entradas:
//   1. Cron (pg_cron + pg_net, platform-fx-sync, lunes a viernes cada hora de 10 a 15 ART): header
//      X-Cron-Secret == platform_secrets('internal_cron').token, body
//      { mode: "cron" }.
//   2. Staff (Actualizar ahora): JWT del usuario + header x-ninja-scope:
//      internal; exige super_admin (internal_staff_access().is_owner). Body
//      { mode: "manual" } o { mode: "backfill", days }.
//
// Deploy: verify_jwt=true (el cron manda el anon key como Bearer para pasar el
// gateway; la autenticación real es el X-Cron-Secret o el JWT del usuario).
// =============================================================================
import { createClient, type SupabaseClient } from "https://esm.sh/@supabase/supabase-js@2.47.10";
import { FX_API_BASE, FX_CASA, addDaysISO, parseFxResponse, rowsSince, type FxApiRow } from "../_shared/fx/rates.ts";

const cors = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type, x-cron-secret, x-ninja-scope",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};
const json = (b: unknown, s = 200) =>
  new Response(JSON.stringify(b), { status: s, headers: { ...cors, "Content-Type": "application/json" } });

type Raw = Record<string, unknown>;
type Trigger = "cron" | "manual" | "backfill";

const ATTEMPTS = 3;
const TIMEOUT_MS = 15_000;

function arToday(): string {
  return new Intl.DateTimeFormat("en-CA", { timeZone: "America/Argentina/Buenos_Aires" }).format(new Date());
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function getJson(url: string): Promise<unknown> {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), TIMEOUT_MS);
  try {
    const res = await fetch(url, { headers: { Accept: "application/json" }, signal: ctrl.signal });
    if (!res.ok) throw new Error(`ArgentinaDatos respondió ${res.status}`);
    return await res.json();
  } finally {
    clearTimeout(t);
  }
}

/** Histórico con reintentos; si no anda, el día de hoy por el endpoint puntual. */
async function fetchRates(from: string): Promise<{ rows: FxApiRow[]; attempts: number; note: string | null }> {
  let lastErr = "";
  for (let i = 1; i <= ATTEMPTS; i++) {
    try {
      const rows = rowsSince(parseFxResponse(await getJson(`${FX_API_BASE}/${FX_CASA}`)), from);
      return { rows, attempts: i, note: null };
    } catch (e) {
      lastErr = String((e as Error)?.message ?? e);
      if (i < ATTEMPTS) await sleep(1_000 * 2 ** (i - 1));
    }
  }
  try {
    const [y, m, d] = arToday().split("-");
    const rows = parseFxResponse(await getJson(`${FX_API_BASE}/${FX_CASA}/${y}/${m}/${d}`));
    if (rows.length > 0) {
      return { rows, attempts: ATTEMPTS + 1, note: `El histórico no respondió (${lastErr}): se trajo sólo la cotización de hoy.` };
    }
  } catch (e) {
    lastErr = `${lastErr}; del día: ${String((e as Error)?.message ?? e)}`;
  }
  throw Object.assign(new Error(lastErr || "sin respuesta"), { attempts: ATTEMPTS + 1 });
}

async function run(admin: SupabaseClient, trigger: Trigger, days: number | null, actor: string | null) {
  let from: string;
  if (days !== null) {
    from = addDaysISO(arToday(), -days);
  } else {
    const { data, error } = await admin.rpc("platform_fx_sync_from", { p_casa: FX_CASA });
    if (error || !data) return json({ status: "error", message: `No se pudo leer desde qué fecha pedir: ${error?.message ?? "sin datos"}` }, 500);
    from = String(data);
  }

  const ingest = async (status: "ok" | "error", rows: FxApiRow[], attempts: number, message: string) => {
    const { data, error } = await admin.rpc("platform_fx_ingest", {
      p_trigger: trigger,
      p_status: status,
      p_rows: rows.map((r) => ({ date: r.date, compra: r.compra, venta: r.venta })),
      p_attempts: attempts,
      p_message: message,
      p_actor: actor,
      p_casa: FX_CASA,
    });
    if (error) throw new Error(error.message);
    return (data ?? {}) as Raw;
  };

  try {
    const { rows, attempts, note } = await fetchRates(from);
    if (rows.length === 0) {
      const message = `ArgentinaDatos no devolvió cotizaciones del oficial desde el ${from}.`;
      await ingest("error", [], attempts, message);
      return json({ status: "error", message, from });
    }
    const last = rows[rows.length - 1]!;
    const message = note ?? `${rows.length} días desde el ${from}; última: ${last.date} venta $ ${last.venta}.`;
    const saved = await ingest("ok", rows, attempts, message);
    return json({ status: "ok", message, from, received: rows.length, upserted: saved.upserted ?? 0, latest_date: saved.latest_date ?? null });
  } catch (e) {
    const attempts = Number((e as { attempts?: number }).attempts ?? ATTEMPTS);
    const message = `No se pudo traer la cotización de ArgentinaDatos: ${String((e as Error)?.message ?? e)}. Se sigue usando la última disponible.`;
    try {
      await ingest("error", [], attempts, message);
    } catch {
      // Sin poder registrar el aviso igual respondemos: la próxima corrida reintenta.
    }
    return json({ status: "error", message, from });
  }
}

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });
  if (req.method !== "POST") return json({ error: "method_not_allowed" }, 405);
  try {
    const url = Deno.env.get("SUPABASE_URL")!;
    const admin = createClient(url, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!, { auth: { persistSession: false } });

    let body: Raw = {};
    try {
      body = (await req.json()) as Raw;
    } catch {
      body = {};
    }

    const cronSecret = req.headers.get("X-Cron-Secret") ?? "";
    if (cronSecret) {
      const { data: sec } = await admin.from("platform_secrets").select("secrets").eq("key", "internal_cron").maybeSingle();
      const token = String(((sec?.secrets ?? {}) as Raw).token ?? "");
      if (!token || cronSecret !== token) return json({ error: "forbidden" }, 403);
      return await run(admin, "cron", null, null);
    }

    const userClient = createClient(url, Deno.env.get("SUPABASE_ANON_KEY")!, {
      global: {
        headers: {
          Authorization: req.headers.get("Authorization") ?? "",
          ...(req.headers.get("x-ninja-scope") === "internal" ? { "x-ninja-scope": "internal" } : {}),
        },
      },
      auth: { persistSession: false },
    });
    const {
      data: { user },
      error: authErr,
    } = await userClient.auth.getUser();
    if (authErr || !user) return json({ error: "unauthorized" }, 401);
    const { data: access, error: accErr } = await userClient.rpc("internal_staff_access");
    if (accErr || (access as Raw | null)?.is_owner !== true) return json({ error: "forbidden" }, 403);

    if (body.mode === "backfill") {
      const days = Math.min(Math.max(Math.round(Number(body.days) || 730), 1), 3650);
      return await run(admin, "backfill", days, user.id);
    }
    return await run(admin, "manual", null, user.id);
  } catch (e) {
    return json({ error: "internal", detail: String(e) }, 500);
  }
});
