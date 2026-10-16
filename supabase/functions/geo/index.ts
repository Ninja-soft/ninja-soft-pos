// =============================================================================
// Edge Function: geo (ADR-157 · F22 · H144, L1 de ADR-149).
//
// Direcciones argentinas con servicios gratuitos, siempre por acá (el
// navegador nunca llama a los proveedores):
//   { action: "suggest", q, near? }    → Photon: sugerencias mientras se tipea
//   { action: "normalize", address }   → Georef AR: calle oficial, localidad,
//                                        partido, provincia con su letra y
//                                        coordenadas (interpola la altura)
//   { action: "reverse", lat, lng }    → Nominatim: dirección del pin marcado
//                                        (NUNCA para autocompletar: lo prohíbe
//                                        su política)
//
// JWT del usuario (verify_jwt = true). Cualquier miembro activo del negocio
// actual con la feature direcciones_geo (geo_guard). Caché compartida en
// geocode_cache (180 días, la exige Nominatim), cupo por negocio en
// geo_usage (sólo los pedidos que llegan al proveedor), interruptor por
// proveedor y turno global de 1 pedido por segundo para Nominatim en
// geo_providers (se apagan sin desplegar). User-Agent propio con contacto
// (GEO_CONTACT_EMAIL). Lógica pura en ../_shared/geo/core.ts.
//
// Respuestas: { ok: true, ... , attribution } o { ok: false, error } con
// error en forbidden, feature_not_in_plan, invalid_request, rate_limited,
// busy, disabled, provider_error.
// =============================================================================
import { createClient, type SupabaseClient } from "https://esm.sh/@supabase/supabase-js@2.47.10";
import {
  cacheInput,
  cleanQuery,
  GEO_ATTRIBUTION,
  GEO_LIMITS,
  georefUrl,
  isFreshCache,
  mergeGeoref,
  nominatimReverseUrl,
  parseNominatimReverse,
  parsePhoton,
  photonUrl,
  typedHouseNumber,
  validLatLng,
  type GeoAddress,
} from "../_shared/geo/core.ts";

const cors = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type, x-ninja-scope",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};
const json = (b: unknown, s = 200) =>
  new Response(JSON.stringify(b), { status: s, headers: { ...cors, "Content-Type": "application/json" } });

const CONTACT = Deno.env.get("GEO_CONTACT_EMAIL") ?? "soporte@soft.ninja";
const USER_AGENT = `NinjaSoftPOS/1.0 (${CONTACT})`;
const GEOREF_TOKEN = Deno.env.get("GEOREF_TOKEN") ?? "";

type Kind = "suggest" | "normalize" | "reverse";
type Provider = "photon" | "georef" | "nominatim";

async function sha256(s: string): Promise<string> {
  const buf = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(s));
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

async function cacheGet(admin: SupabaseClient, key: string): Promise<unknown | null> {
  const { data } = await admin.from("geocode_cache").select("result, created_at").eq("key", key).maybeSingle();
  const row = data as { result: unknown; created_at: string } | null;
  return row && isFreshCache(row.created_at, new Date()) ? row.result : null;
}

async function cachePut(admin: SupabaseClient, key: string, action: Kind, provider: Provider, result: unknown) {
  await admin
    .from("geocode_cache")
    .upsert({ key, action, provider, result, created_at: new Date().toISOString() }, { onConflict: "key" });
}

/** Cupo del negocio y turno del proveedor. null = se puede llamar. */
async function take(admin: SupabaseClient, tenant: string, kind: Kind, provider: Provider): Promise<string | null> {
  const lim = GEO_LIMITS[kind];
  const { data: quota } = await admin.rpc("geo_rate_take", {
    p_tenant: tenant,
    p_kind: kind,
    p_per_minute: lim.perMinute,
    p_per_day: lim.perDay,
  });
  if (quota !== "ok") return "rate_limited";
  for (let i = 0; i < 2; i++) {
    const { data: turn } = await admin.rpc("geo_provider_take", { p_key: provider });
    if (turn === "ok") return null;
    if (turn === "disabled") return "disabled";
    // Nominatim: otro pedido usó el segundo; esperamos uno y reintentamos.
    await new Promise((r) => setTimeout(r, 1150));
  }
  return "busy";
}

async function getJson(url: string, timeoutMs: number, headers: Record<string, string> = {}): Promise<unknown | null> {
  try {
    const r = await fetch(url, {
      headers: { "User-Agent": USER_AGENT, Accept: "application/json", ...headers },
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (!r.ok) {
      console.error(JSON.stringify({ fn: "geo", step: "provider", status: r.status, host: new URL(url).host }));
      return null;
    }
    return await r.json();
  } catch (e) {
    console.error(JSON.stringify({ fn: "geo", step: "provider", host: new URL(url).host, error: String(e).slice(0, 120) }));
    return null;
  }
}

function addressFromBody(v: unknown): GeoAddress | null {
  if (!v || typeof v !== "object") return null;
  const a = v as Record<string, unknown>;
  const s = (k: string, max: number) => {
    const t = typeof a[k] === "string" || typeof a[k] === "number" ? String(a[k]).trim().slice(0, max) : "";
    return t || null;
  };
  const street = s("street", 120);
  if (!street) return null;
  const ll = validLatLng(a.lat, a.lng);
  return {
    street,
    number: s("number", 20),
    locality: s("locality", 120),
    partido: s("partido", 120),
    province: s("province", 60),
    province_code: s("province_code", 1),
    postal_code: s("postal_code", 10),
    lat: ll?.lat ?? null,
    lng: ll?.lng ?? null,
    geo_source: "photon",
    geo_quality: ll ? "calle" : "sin_geo",
  };
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
  const { data: guard, error: guardErr } = await admin.rpc("geo_guard", { p_tenant: tenantId, p_user: user.id });
  if (guardErr) return json({ ok: false, error: "guard_failed" }, 500);
  if (guard === "forbidden") return json({ ok: false, error: "forbidden" }, 403);
  if (guard === "feature_not_in_plan") return json({ ok: false, error: "feature_not_in_plan" }, 403);

  let body: Record<string, unknown> = {};
  try {
    body = (await req.json()) as Record<string, unknown>;
  } catch {
    body = {};
  }
  const action = String(body.action ?? "");

  // --- Autocompletar (Photon) ---------------------------------------------------
  if (action === "suggest") {
    const q = cleanQuery(body.q);
    if (!q) return json({ ok: true, suggestions: [], attribution: GEO_ATTRIBUTION });
    const near = body.near && typeof body.near === "object"
      ? validLatLng((body.near as { lat?: unknown }).lat, (body.near as { lng?: unknown }).lng)
      : null;
    const key = await sha256(cacheInput("suggest", { q, near }));
    const hit = await cacheGet(admin, key);
    if (hit) return json({ ok: true, cached: true, suggestions: hit, attribution: GEO_ATTRIBUTION });
    const blocked = await take(admin, tenantId, "suggest", "photon");
    if (blocked === "disabled") return json({ ok: true, suggestions: [], disabled: true, attribution: GEO_ATTRIBUTION });
    if (blocked) return json({ ok: false, error: blocked }, blocked === "rate_limited" ? 429 : 503);
    const raw = await getJson(photonUrl(q, near), 6000);
    if (raw === null) return json({ ok: false, error: "provider_error" }, 502);
    const suggestions = parsePhoton(raw, typedHouseNumber(q));
    await cachePut(admin, key, "suggest", "photon", suggestions);
    return json({ ok: true, cached: false, suggestions, attribution: GEO_ATTRIBUTION });
  }

  // --- Normalizar (Georef) ------------------------------------------------------
  if (action === "normalize") {
    const base = addressFromBody(body.address);
    if (!base) return json({ ok: false, error: "invalid_request" }, 400);
    if (!base.number) return json({ ok: true, address: base, normalized: false, attribution: GEO_ATTRIBUTION });
    const key = await sha256(cacheInput("normalize", { address: base }));
    const hit = (await cacheGet(admin, key)) as GeoAddress | { miss: true } | null;
    if (hit) {
      const merged = "miss" in hit ? null : { ...base, ...hit };
      return json({ ok: true, cached: true, address: merged ?? base, normalized: Boolean(merged), attribution: GEO_ATTRIBUTION });
    }
    const blocked = await take(admin, tenantId, "normalize", "georef");
    if (blocked) return json({ ok: true, address: base, normalized: false, reason: blocked, attribution: GEO_ATTRIBUTION });
    const headers: Record<string, string> = GEOREF_TOKEN ? { Authorization: `Bearer ${GEOREF_TOKEN}` } : {};
    let merged: GeoAddress | null = null;
    for (const withLocality of [true, false]) {
      const u = georefUrl(base, withLocality);
      if (!u) break;
      const raw = await getJson(u, 6000, headers);
      if (raw === null) return json({ ok: true, address: base, normalized: false, reason: "provider_error", attribution: GEO_ATTRIBUTION });
      merged = mergeGeoref(raw, base);
      if (merged || !base.locality) break;
    }
    await cachePut(admin, key, "normalize", "georef", merged ?? { miss: true });
    return json({ ok: true, cached: false, address: merged ?? base, normalized: Boolean(merged), attribution: GEO_ATTRIBUTION });
  }

  // --- Pin en el mapa (Nominatim inversa) ---------------------------------------
  if (action === "reverse") {
    const pin = validLatLng(body.lat, body.lng);
    if (!pin) return json({ ok: false, error: "invalid_request" }, 400);
    const key = await sha256(cacheInput("reverse", pin));
    const hit = (await cacheGet(admin, key)) as GeoAddress | { miss: true } | null;
    if (hit) {
      return json({ ok: true, cached: true, address: "miss" in hit ? null : { ...hit, lat: pin.lat, lng: pin.lng }, attribution: GEO_ATTRIBUTION });
    }
    const blocked = await take(admin, tenantId, "reverse", "nominatim");
    if (blocked) return json({ ok: false, error: blocked }, blocked === "rate_limited" ? 429 : 503);
    const raw = await getJson(nominatimReverseUrl(pin.lat, pin.lng), 8000, { "Accept-Language": "es" });
    if (raw === null) return json({ ok: false, error: "provider_error" }, 502);
    const address = parseNominatimReverse(raw, pin);
    await cachePut(admin, key, "reverse", "nominatim", address ?? { miss: true });
    return json({ ok: true, cached: false, address, attribution: GEO_ATTRIBUTION });
  }

  return json({ ok: false, error: "unknown_action" }, 400);
});
