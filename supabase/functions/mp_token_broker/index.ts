// =============================================================================
// Edge Function: mp_token_broker (ADR-166) — servidor a servidor, verify_jwt =
// false (se autentica con su propia clave, no con un JWT de Supabase).
//
// Devuelve el access token VIGENTE de Mercado Pago del negocio dueño de la
// clave, para que otro sistema del mismo negocio cobre o consulte con la misma
// cuenta sin tener nunca el refresh token: NinjaPos sigue siendo el único que
// renueva (si está por vencer, lo renueva antes de responder, igual que el
// POS), así que el otro sistema nunca rompe la conexión de acá.
//
//   GET|POST /functions/v1/mp_token_broker
//   Header:  x-api-key: nsmp_<clave>
//   200 → { access_token, public_key, mp_user_id, expires_at, env: "prod" }
//   401 invalid_key · 403 ip_not_allowed · 404 not_connected
//
// * Una clave = un negocio (mp_token_broker_keys.tenant_id). Sólo se guarda el
//   SHA-256; revocable (revoked_at); allowed_ips opcional.
// * Siempre la credencial de producción a nivel negocio (no la de sucursal ni
//   la de prueba).
// * Cada entrega escribe audit_logs (mp_token_broker_read) con la IP.
// =============================================================================
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.47.10";
import { tenantMpCredential } from "../_shared/mpAuth.ts";
import { loadProviderSecret } from "../_shared/paymentSecrets.ts";

const KEY_RE = /^nsmp_[A-Za-z0-9_-]{40,64}$/;

const json = (b: unknown, s = 200) =>
  new Response(JSON.stringify(b), {
    status: s,
    headers: {
      "Content-Type": "application/json",
      "Cache-Control": "no-store",
      Pragma: "no-cache",
    },
  });

async function sha256Hex(s: string): Promise<string> {
  const d = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(s));
  return [...new Uint8Array(d)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

function clientIp(req: Request): string | null {
  const xff = req.headers.get("x-forwarded-for");
  const first = xff?.split(",")[0]?.trim();
  return first || req.headers.get("cf-connecting-ip") || req.headers.get("x-real-ip") || null;
}

Deno.serve(async (req: Request) => {
  if (req.method !== "GET" && req.method !== "POST") return json({ error: "method_not_allowed" }, 405);

  const key = (req.headers.get("x-api-key") ?? "").trim();
  if (!KEY_RE.test(key)) return json({ error: "invalid_key" }, 401);

  const admin = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!, {
    auth: { persistSession: false },
  });

  const { data: row } = await admin
    .from("mp_token_broker_keys")
    .select("id, tenant_id, allowed_ips")
    .eq("key_hash", await sha256Hex(key))
    .is("revoked_at", null)
    .is("deleted_at", null)
    .maybeSingle();
  if (!row) return json({ error: "invalid_key" }, 401);

  const ip = clientIp(req);
  const allowed = (row.allowed_ips ?? []) as string[];
  if (allowed.length > 0 && (!ip || !allowed.includes(ip))) {
    await admin.from("audit_logs").insert({
      tenant_id: row.tenant_id,
      entity_type: "mp_token_broker_keys",
      entity_id: row.id,
      action: "mp_token_broker_denied_ip",
      after_data: { ip },
    });
    return json({ error: "ip_not_allowed" }, 403);
  }

  // Producción, credencial del negocio (scopeStoreId null), con refresh si
  // está por vencer: la misma función que usan los cobros del POS.
  const cred = await tenantMpCredential(admin, row.tenant_id, "prod", { scopeStoreId: null });
  if (!cred) return json({ error: "not_connected" }, 404);

  const loaded = await loadProviderSecret(admin, row.tenant_id, "mercadopago", { scopeStoreId: null });
  const sec = (loaded?.secrets ?? {}) as { public_key?: string; mp_user_id?: string | number; expires_at?: string | null };

  await Promise.all([
    admin.from("mp_token_broker_keys").update({ last_used_at: new Date().toISOString() }).eq("id", row.id),
    admin.from("audit_logs").insert({
      tenant_id: row.tenant_id,
      entity_type: "mp_token_broker_keys",
      entity_id: row.id,
      action: "mp_token_broker_read",
      after_data: { ip, expires_at: sec.expires_at ?? null },
    }),
  ]);

  return json({
    access_token: cred.token,
    public_key: sec.public_key ?? null,
    mp_user_id: sec.mp_user_id != null ? String(sec.mp_user_id) : null,
    expires_at: sec.expires_at ?? null,
    env: "prod",
  });
});
