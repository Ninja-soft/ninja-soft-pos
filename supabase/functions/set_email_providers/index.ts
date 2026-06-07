// =============================================================================
// Edge Function: set_email_providers — guarda la config de un proveedor de email
// (slot 1 = principal, slot 2 = failover). Solo staff (is_internal).
// Soporta kind 'resend' (api_key) y 'smtp' (host/port/secure/user/pass).
// Si api_key / smtp_pass vienen vacíos, NO se sobrescriben (se conserva lo guardado).
// service_role solo acá: email_providers es deny-all RLS (credenciales secretas).
// =============================================================================
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.47.10";

const cors = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers":
    "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};
const json = (b: unknown, s = 200) =>
  new Response(JSON.stringify(b), {
    status: s,
    headers: { ...cors, "Content-Type": "application/json" },
  });

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });
  if (req.method !== "POST") return json({ error: "method_not_allowed" }, 405);
  const url = Deno.env.get("SUPABASE_URL")!;
  const serviceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
  const anonKey = Deno.env.get("SUPABASE_ANON_KEY")!;
  const userClient = createClient(url, anonKey, {
    global: { headers: { Authorization: req.headers.get("Authorization") ?? "" } },
    auth: { persistSession: false },
  });
  const {
    data: { user },
    error,
  } = await userClient.auth.getUser();
  if (error || !user) return json({ error: "unauthorized" }, 401);
  if (!(user.app_metadata ?? {}).is_internal) return json({ error: "forbidden" }, 403);

  let b: Record<string, unknown>;
  try {
    b = await req.json();
  } catch {
    return json({ error: "invalid_json" }, 400);
  }

  const slot = Number(b.slot);
  if (slot !== 1 && slot !== 2) return json({ error: "invalid_slot" }, 400);
  const kind = String(b.kind ?? "resend").trim();
  if (kind !== "resend" && kind !== "smtp") return json({ error: "invalid_kind" }, 400);

  // Campos comunes (siempre se actualizan).
  const patch: Record<string, unknown> = {
    slot,
    kind,
    is_active: !!b.is_active,
    from_name: String(b.from_name ?? "NinjaPos").trim().slice(0, 80) || "NinjaPos",
    from_email: String(b.from_email ?? "").trim().toLowerCase(),
  };

  if (kind === "smtp") {
    patch.smtp_host = String(b.smtp_host ?? "").trim();
    patch.smtp_port = Number(b.smtp_port) || 587;
    patch.smtp_secure = !!b.smtp_secure;
    patch.smtp_user = String(b.smtp_user ?? "").trim();
  }

  // Secretos: solo se escriben si vienen no-vacíos (vacío = conservar lo guardado).
  const apiKey = typeof b.api_key === "string" ? b.api_key.trim() : "";
  if (kind === "resend" && apiKey) patch.api_key = apiKey;
  const smtpPass = typeof b.smtp_pass === "string" ? b.smtp_pass : "";
  if (kind === "smtp" && smtpPass) patch.smtp_pass = smtpPass;

  const admin = createClient(url, serviceKey, { auth: { persistSession: false } });
  const { error: upErr } = await admin
    .from("email_providers")
    .upsert(patch, { onConflict: "slot" });
  if (upErr) return json({ error: "save_failed", detail: upErr.message }, 500);

  await admin.from("audit_logs").insert({
    tenant_id: null,
    actor_user_id: user.id,
    entity_type: "email_provider",
    entity_id: null,
    action: "email_provider_configured",
    after_data: {
      slot,
      kind,
      is_active: patch.is_active,
      from_email: patch.from_email,
    },
  });
  return json({ ok: true });
});
