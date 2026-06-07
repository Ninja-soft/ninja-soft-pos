// =============================================================================
// Edge Function: set_tenant_smtp — guarda la config SMTP del NEGOCIO (tenant).
// SOLO owner/manager activo del tenant. service_role solo acá:
// tenant_email_smtp tiene RLS deny a todos.
// Si password viene vacío, NO se sobrescribe (se conserva el guardado).
// { test: true, test_to } → tras guardar, envía un email de prueba. H9b PR3.
// =============================================================================
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.47.10";
import { SMTPClient } from "https://deno.land/x/denomailer@1.6.0/mod.ts";

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
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

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

  const tenantId = (user.app_metadata as { current_tenant_id?: string } | null)
    ?.current_tenant_id;
  if (!tenantId) return json({ error: "no_tenant" }, 400);

  let b: Record<string, unknown>;
  try {
    b = await req.json();
  } catch {
    return json({ error: "invalid_json" }, 400);
  }

  const admin = createClient(url, serviceKey, { auth: { persistSession: false } });

  // Guard: owner/manager activo del tenant.
  const { data: mem } = await admin
    .from("tenant_users")
    .select("role")
    .eq("tenant_id", tenantId)
    .eq("user_id", user.id)
    .eq("status", "active")
    .maybeSingle();
  if (!mem || !["owner", "manager"].includes(mem.role as string)) {
    return json({ error: "forbidden" }, 403);
  }

  const port = Number(b.port);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    return json({ error: "invalid_port" }, 400);
  }
  const fromEmail = String(b.from_email ?? "").trim().toLowerCase();
  if (fromEmail && !EMAIL_RE.test(fromEmail)) {
    return json({ error: "invalid_from_email" }, 400);
  }

  const patch: Record<string, unknown> = {
    tenant_id: tenantId,
    host: String(b.host ?? "").trim(),
    port,
    secure: !!b.secure,
    username: String(b.username ?? "").trim(),
    from_name: String(b.from_name ?? "").trim().slice(0, 80),
    from_email: fromEmail,
    body_text: String(b.body_text ?? "").trim().slice(0, 2000),
    updated_at: new Date().toISOString(),
  };

  // password vacío/ausente → conservar el guardado (no se sobrescribe).
  const pwd = typeof b.password === "string" ? b.password : "";
  const row = pwd ? { ...patch, password: pwd } : patch;

  const { error: upErr } = await admin
    .from("tenant_email_smtp")
    .upsert(row, { onConflict: "tenant_id" });
  if (upErr) return json({ error: "save_failed", detail: upErr.message }, 500);

  await admin.from("audit_logs").insert({
    tenant_id: tenantId,
    actor_user_id: user.id,
    entity_type: "tenant",
    entity_id: tenantId,
    action: "tenant_smtp_updated",
    after_data: { host: patch.host, from_email: patch.from_email },
  });

  // Test opcional: tras guardar, envía un email de prueba con la config GUARDADA
  // (incluyendo el password retenido si no se reenvió). La config queda guardada
  // pase o no pase el test.
  if (b.test === true) {
    const { data: cfg } = await admin
      .from("tenant_email_smtp")
      .select("*")
      .eq("tenant_id", tenantId)
      .maybeSingle();
    if (!cfg?.host || !cfg?.from_email) {
      return json({ error: "test_failed", detail: "incomplete_config" });
    }
    const testTo = String(b.test_to ?? cfg.from_email).trim().toLowerCase();
    if (!EMAIL_RE.test(testTo)) {
      return json({ error: "test_failed", detail: "invalid_test_to" });
    }
    // Sin caracteres de control: from_name viaja en headers SMTP.
    const fromName = (cfg.from_name || "NinjaSoft POS")
      // deno-lint-ignore no-control-regex
      .replace(/[\x00-\x1f\x7f]+/g, " ")
      .trim() || "NinjaSoft POS";
    const client = new SMTPClient({
      connection: {
        hostname: cfg.host,
        port: cfg.port || 587,
        tls: !!cfg.secure,
        auth: cfg.username
          ? { username: cfg.username, password: cfg.password }
          : undefined,
      },
    });
    try {
      await client.send({
        from: `${fromName} <${cfg.from_email}>`,
        to: testTo,
        subject: "Prueba de email del negocio",
        content:
          "Este es un email de prueba de NinjaSoft POS. Si lo recibís, tu configuración SMTP funciona.",
      });
      await client.close();
    } catch (e) {
      try {
        await client.close();
      } catch (_) {
        /* noop */
      }
      return json({
        error: "test_failed",
        detail: e instanceof Error ? e.message : String(e),
      });
    }
    return json({ ok: true, tested: true });
  }

  return json({ ok: true });
});
