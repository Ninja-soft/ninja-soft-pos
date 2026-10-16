// =============================================================================
// Edge Function: routing (ADR-164 · F22 · H146, L3 de ADR-149).
//
// Ruteo por calles con OpenRouteService, OPCIONAL: sólo si el secret
// ORS_API_KEY está cargado. Sin la clave (o si ORS falla, se queda sin cupo
// o tarda) responde provider "none" y el panel usa la heurística local
// (agrupado por localidad y capacidad, vecino más cercano y 2-opt), que
// siempre está.
//   { action: "status" }                         → { ors: boolean }
//   { action: "optimize", origin, stops, vehicles, serviceS, returnToOrigin }
//                                                → reparto entre camiones (VROOM)
//   { action: "directions", points, kind? }      → recorrido por calles de una hoja
//
// JWT del usuario (verify_jwt = true). Miembro activo con reparto_propio y
// logistics.route.manage (routing_guard). Cupo por negocio en geo_usage
// (route_optimize, route_directions) y turno global de ORS en geo_providers
// ('ors', 40 por minuto; se apaga sin desplegar). Lógica pura en
// ../_shared/routing/core.ts.
// =============================================================================
import { createClient, type SupabaseClient } from "https://esm.sh/@supabase/supabase-js@2.47.10";
import {
  buildDirectionsBody,
  buildOptimizationBody,
  optimizeInputFromBody,
  orsProfile,
  ORS_BASE,
  ORS_MAX_WAYPOINTS,
  parseDirections,
  parseOptimization,
  ROUTING_LIMITS,
  validPoint,
  type LatLngTuple,
} from "../_shared/routing/core.ts";

const cors = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type, x-ninja-scope",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};
const json = (b: unknown, s = 200) =>
  new Response(JSON.stringify(b), { status: s, headers: { ...cors, "Content-Type": "application/json" } });

const ORS_KEY = Deno.env.get("ORS_API_KEY") ?? "";
const ATTRIBUTION = "© openrouteservice.org by HeiGIT | © OpenStreetMap contributors";

type Kind = "optimize" | "directions";

/** Cupo del negocio y turno de ORS. null = se puede llamar. */
async function take(admin: SupabaseClient, tenant: string, kind: Kind): Promise<string | null> {
  const lim = ROUTING_LIMITS[kind];
  const { data: quota } = await admin.rpc("geo_rate_take", {
    p_tenant: tenant,
    p_kind: kind === "optimize" ? "route_optimize" : "route_directions",
    p_per_minute: lim.perMinute,
    p_per_day: lim.perDay,
  });
  if (quota !== "ok") return "rate_limited";
  for (let i = 0; i < 3; i++) {
    const { data: turn } = await admin.rpc("geo_provider_take", { p_key: "ors" });
    if (turn === "ok") return null;
    if (turn === "disabled") return "disabled";
    await new Promise((r) => setTimeout(r, 1700));
  }
  return "busy";
}

async function postOrs(path: string, body: unknown, timeoutMs: number): Promise<unknown | null> {
  try {
    const r = await fetch(`${ORS_BASE}${path}`, {
      method: "POST",
      headers: { Authorization: ORS_KEY, "Content-Type": "application/json", Accept: "application/json, application/geo+json" },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (!r.ok) {
      console.error(JSON.stringify({ fn: "routing", step: "ors", path, status: r.status, body: (await r.text()).slice(0, 200) }));
      return null;
    }
    return await r.json();
  } catch (e) {
    console.error(JSON.stringify({ fn: "routing", step: "ors", path, error: String(e).slice(0, 120) }));
    return null;
  }
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });
  if (req.method !== "POST") return json({ error: "method_not_allowed" }, 405);

  const url = Deno.env.get("SUPABASE_URL")!;
  const admin = createClient(url, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!, { auth: { persistSession: false } });
  const userClient = createClient(url, Deno.env.get("SUPABASE_ANON_KEY")!, {
    global: { headers: { Authorization: req.headers.get("Authorization") ?? "" } },
    auth: { persistSession: false },
  });
  const {
    data: { user },
    error: authErr,
  } = await userClient.auth.getUser();
  if (authErr || !user) return json({ error: "unauthorized" }, 401);

  const tenantId = (user.app_metadata as { current_tenant_id?: string } | null)?.current_tenant_id;
  if (!tenantId) return json({ ok: false, error: "no_tenant" }, 400);
  const { data: guard, error: guardErr } = await admin.rpc("routing_guard", { p_tenant: tenantId, p_user: user.id });
  if (guardErr) return json({ ok: false, error: "guard_failed" }, 500);
  if (guard) return json({ ok: false, error: guard }, 403);

  let body: Record<string, unknown> = {};
  try {
    body = (await req.json()) as Record<string, unknown>;
  } catch {
    body = {};
  }
  const action = String(body.action ?? "");

  if (action === "status") return json({ ok: true, ors: Boolean(ORS_KEY) });

  // Sin clave: el panel usa la heurística local.
  if (!ORS_KEY) return json({ ok: true, provider: "none", reason: "no_key" });

  // --- Reparto entre camiones (VROOM) -------------------------------------------
  if (action === "optimize") {
    const input = optimizeInputFromBody(body);
    if (!input) return json({ ok: false, error: "invalid_request" }, 400);
    const blocked = await take(admin, tenantId, "optimize");
    if (blocked) return json({ ok: true, provider: "none", reason: blocked });
    const { body: orsBody, jobIds, vehicleIds } = buildOptimizationBody(input);
    const raw = await postOrs("/optimization", orsBody, 9000);
    const parsed = raw === null ? null : parseOptimization(raw, jobIds, vehicleIds);
    if (!parsed) return json({ ok: true, provider: "none", reason: "provider_error" });
    return json({ ok: true, provider: "ors", ...parsed, attribution: ATTRIBUTION });
  }

  // --- Recorrido por calles de una hoja -----------------------------------------
  if (action === "directions") {
    const pts = Array.isArray(body.points) ? (body.points as unknown[]) : [];
    const points = pts
      .filter((p): p is [number, number] => Array.isArray(p) && validPoint(p[0], p[1]))
      .map((p) => [p[0], p[1]] as LatLngTuple);
    if (points.length < 2 || points.length > ORS_MAX_WAYPOINTS || points.length !== pts.length) {
      return json({ ok: false, error: "invalid_request" }, 400);
    }
    const blocked = await take(admin, tenantId, "directions");
    if (blocked) return json({ ok: true, provider: "none", reason: blocked });
    const profile = orsProfile(typeof body.kind === "string" ? body.kind : null);
    const raw = await postOrs(`/v2/directions/${profile}/geojson`, buildDirectionsBody(points), 8000);
    const parsed = raw === null ? null : parseDirections(raw);
    if (!parsed) return json({ ok: true, provider: "none", reason: "provider_error" });
    return json({ ok: true, provider: "ors", ...parsed, attribution: ATTRIBUTION });
  }

  return json({ ok: false, error: "unknown_action" }, 400);
});
