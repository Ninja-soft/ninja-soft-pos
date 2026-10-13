// =============================================================================
// Edge Function: internal_impersonate  (H11c)
// Genera un magic link de acceso para el dueño de un tenant. Solo admin y
// super_admin pueden usarlo (support: denegado). El link se abre en incógnito
// para no cerrar la sesión del staff. Auditado.
// ADR-073: motivo obligatorio (5 a 500 caracteres) y el audit_logs se escribe
// ANTES de devolver el link: si no se puede auditar, no hay link.
// ADR-084: duración elegida (5 a 240 minutos, default 30) y sesión registrada
// en impersonation_sessions. Ya no devuelve el action_link de Supabase: el
// panel arma /auth/impersonate#th=<token_hash>&n=<nonce>, que inicia sesión,
// ata la sesión de Auth al registro y muestra el banner con la cuenta
// regresiva. Al vencer (o al terminar) se borra la sesión de Auth.
// =============================================================================
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.47.10";
import { isValidReason } from "../_shared/tenantAdmin.ts";
import {
  impersonationExpiresAt,
  parseImpersonationMinutes,
} from "../_shared/impersonation.ts";

function randomHex(bytes: number): string {
  const a = new Uint8Array(bytes);
  crypto.getRandomValues(a);
  return Array.from(a, (b) => b.toString(16).padStart(2, "0")).join("");
}
async function sha256Hex(text: string): Promise<string> {
  const buf = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  return Array.from(new Uint8Array(buf), (b) => b.toString(16).padStart(2, "0")).join("");
}

const cors = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers":
    "authorization, x-client-info, apikey, content-type, x-ninja-scope",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};
function json(b: unknown, s = 200) {
  return new Response(JSON.stringify(b), {
    status: s,
    headers: { ...cors, "Content-Type": "application/json" },
  });
}

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });
  if (req.method !== "POST") return json({ error: "method_not_allowed" }, 405);

  const url = Deno.env.get("SUPABASE_URL")!;
  const serviceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
  const anonKey = Deno.env.get("SUPABASE_ANON_KEY")!;
  const authHeader = req.headers.get("Authorization") ?? "";

  const userClient = createClient(url, anonKey, {
    global: { headers: { Authorization: authHeader } },
    auth: { persistSession: false },
  });

  const {
    data: { user },
    error: uErr,
  } = await userClient.auth.getUser();
  if (uErr || !user) return json({ error: "unauthorized" }, 401);

  const meta = (user.app_metadata ?? {}) as {
    is_internal?: boolean;
    internal_level?: string;
  };
  if (!meta.is_internal) return json({ error: "forbidden" }, 403);
  if (meta.internal_level === "support")
    return json({ error: "forbidden_support_level" }, 403);

  let body: { tenant_id?: string; reason?: string; duration_minutes?: unknown };
  try {
    body = await req.json();
  } catch {
    return json({ error: "invalid_json" }, 400);
  }
  if (!body.tenant_id) return json({ error: "missing_tenant_id" }, 400);
  if (!isValidReason(body.reason)) return json({ error: "reason_required" }, 400);
  const reason = body.reason!.trim();
  const minutes = parseImpersonationMinutes(body.duration_minutes);
  if (minutes === null) return json({ error: "invalid_duration" }, 400);

  const admin = createClient(url, serviceKey, { auth: { persistSession: false } });

  // Buscar el owner activo del tenant; fallback a cualquier miembro activo.
  // ADR-083: current_tenant_id() exige membresía activa; un link a un miembro
  // dado de baja abriría un panel vacío.
  type TuRow = {
    user_id: string;
    users: { email: string } | null;
  };
  const { data: ownerRow } = await admin
    .from("tenant_users")
    .select("user_id, users(email)")
    .eq("tenant_id", body.tenant_id)
    .eq("role", "owner")
    .eq("status", "active")
    .order("joined_at", { ascending: true, nullsFirst: false })
    .limit(1)
    .maybeSingle();

  let ownerEmail: string | null = (ownerRow as unknown as TuRow | null)?.users?.email ?? null;

  if (!ownerEmail) {
    const { data: anyRow } = await admin
      .from("tenant_users")
      .select("user_id, users(email)")
      .eq("tenant_id", body.tenant_id)
      .eq("status", "active")
      .limit(1)
      .maybeSingle();
    ownerEmail = (anyRow as unknown as TuRow | null)?.users?.email ?? null;
  }
  if (!ownerEmail) return json({ error: "tenant_owner_not_found" }, 404);

  // Generar magic link con service_role.
  const { data: linkData, error: linkErr } =
    await admin.auth.admin.generateLink({
      type: "magiclink",
      email: ownerEmail,
    });
  if (linkErr)
    return json({ error: "link_generation_failed", detail: linkErr.message }, 500);

  const hashed = linkData?.properties?.hashed_token;
  const targetId = linkData?.user?.id;
  if (!hashed || !targetId) return json({ error: "link_generation_failed" }, 500);

  // Registro de la sesión ANTES de devolver nada: sin registro no hay acceso.
  const nonce = randomHex(32);
  const expiresAt = impersonationExpiresAt(new Date(), minutes);
  const { data: sess, error: sessErr } = await admin
    .from("impersonation_sessions")
    .insert({
      tenant_id: body.tenant_id,
      staff_user_id: user.id,
      target_user_id: targetId,
      reason,
      duration_minutes: minutes,
      nonce_hash: await sha256Hex(nonce),
      expires_at: expiresAt.toISOString(),
    })
    .select("id")
    .single();
  if (sessErr || !sess) return json({ error: "session_failed" }, 500);

  const { error: auditErr } = await admin.from("audit_logs").insert({
    tenant_id: body.tenant_id,
    actor_user_id: user.id,
    entity_type: "impersonation",
    entity_id: sess.id,
    action: "impersonation_link_generated",
    after_data: {
      owner_email: ownerEmail,
      actor_email: user.email,
      duration_minutes: minutes,
      expires_at: expiresAt.toISOString(),
    },
    reason,
  });
  if (auditErr) {
    // Sin auditoría no hay acceso: se cierra el registro recién creado.
    await admin
      .from("impersonation_sessions")
      .update({ ended_at: new Date().toISOString(), end_reason: "revoked" })
      .eq("id", sess.id);
    return json({ error: "audit_failed" }, 500);
  }

  return json({
    ok: true,
    session_id: sess.id,
    token_hash: hashed,
    nonce,
    expires_at: expiresAt.toISOString(),
    duration_minutes: minutes,
    owner_email: ownerEmail,
  });
});
