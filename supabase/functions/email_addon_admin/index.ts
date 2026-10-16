// =============================================================================
// Edge Function: email_addon_admin: configuración de la plataforma del
// complemento "Email con dominio NinjaSoft" (ADR-156). Panel interno ›
// Complementos.
//
// Quién: staff con nivel admin o super_admin desde /internal (JWT del usuario
// + header x-ninja-scope: internal). La autorización la decide la base:
// internal_email_addon_get() exige platform_staff_billing_role() admin o
// super_admin (internal_scope(), nunca is_internal() suelto).
//
// Acciones (body.action):
//   · status          estado: configuración, escalones, si hay una key de
//                     Resend del sistema para reutilizar (sin valores).
//   · save_key        { api_key } prueba la key contra GET /domains de Resend
//                     y recién ahí la guarda en platform_secrets
//                     'email_addon' (sólo service_role). Nunca se devuelve.
//   · use_system_key  reutiliza la key del proveedor Resend activo de los
//                     emails del sistema (send_email), probándola igual.
//   · check_domain    { domain, create? } busca el dominio en Resend (y lo da
//                     de alta si create), pide verificar y guarda el estado y
//                     los registros DNS que hay que cargar.
//   · send_test       { to } email de prueba desde el dominio verificado.
// Todo queda en audit_logs (sin valores secretos).
// Deploy: verify_jwt = true.
// =============================================================================
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.47.10";
import {
  findDomain,
  isPlausibleResendKey,
  isValidDomain,
  keyHint,
  parseResendDomain,
} from "../_shared/billing/emailAddon.ts";
import { platformResendKey, resendSend } from "../_shared/ninjaEmail.ts";

const cors = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type, x-ninja-scope",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};
const json = (b: unknown, s = 200) =>
  new Response(JSON.stringify(b), { status: s, headers: { ...cors, "Content-Type": "application/json" } });
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const RESEND = "https://api.resend.com";

type Raw = Record<string, unknown>;

async function resend(key: string, path: string, init: RequestInit = {}): Promise<{ status: number; body: unknown }> {
  const res = await fetch(`${RESEND}${path}`, {
    ...init,
    headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json", ...(init.headers ?? {}) },
    signal: AbortSignal.timeout(20000),
  });
  let body: unknown = null;
  try {
    body = await res.json();
  } catch {
    body = null;
  }
  return { status: res.status, body };
}

/** Prueba una key: GET /domains. Una key "sólo envío" no puede listar dominios. */
async function testKey(key: string): Promise<{ ok: true; domains: unknown } | { ok: false; error: string; detail?: string }> {
  try {
    const r = await resend(key, "/domains");
    if (r.status === 200) return { ok: true, domains: r.body };
    const msg = String((r.body as Raw | null)?.message ?? "");
    if (r.status === 401 && /restricted/i.test(msg)) return { ok: false, error: "restricted_key", detail: msg };
    if (r.status === 401 || r.status === 403) return { ok: false, error: "invalid_key", detail: msg };
    return { ok: false, error: "resend_error", detail: `${r.status} ${msg}`.trim() };
  } catch (e) {
    return { ok: false, error: "resend_unreachable", detail: String(e).slice(0, 200) };
  }
}

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });
  if (req.method !== "POST") return json({ error: "method_not_allowed" }, 405);

  try {
    const url = Deno.env.get("SUPABASE_URL")!;
    const serviceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
    const anonKey = Deno.env.get("SUPABASE_ANON_KEY")!;

    const userClient = createClient(url, anonKey, {
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

    // Autorización en la base (nivel admin/super_admin con scope interno).
    const { data: state, error: stErr } = await userClient.rpc("internal_email_addon_get");
    if (stErr) return json({ error: "forbidden" }, 403);

    let b: Raw;
    try {
      b = (await req.json()) as Raw;
    } catch {
      b = {};
    }
    const action = String(b.action ?? "status");
    const admin = createClient(url, serviceKey, { auth: { persistSession: false } });

    const audit = (act: string, after: Raw) =>
      admin.from("audit_logs").insert({
        tenant_id: null,
        actor_user_id: user.id,
        entity_type: "email_addon_settings",
        entity_id: null,
        action: act,
        after_data: after,
      });

    const { data: sysProv } = await admin
      .from("email_providers")
      .select("api_key")
      .eq("kind", "resend")
      .eq("is_active", true)
      .order("slot", { ascending: true })
      .limit(1)
      .maybeSingle();
    const systemKey = String((sysProv as { api_key?: string } | null)?.api_key ?? "");

    if (action === "status") {
      return json({ ok: true, state, system_key_available: Boolean(systemKey) });
    }

    if (action === "save_key" || action === "use_system_key") {
      const key = action === "save_key" ? String(b.api_key ?? "").trim() : systemKey;
      if (!key) return json({ error: action === "save_key" ? "missing_key" : "no_system_key" }, 400);
      if (action === "save_key" && !isPlausibleResendKey(key)) return json({ error: "invalid_key_format" }, 400);
      const t = await testKey(key);
      if (!t.ok) {
        await audit("email_addon_key_rejected", { source: action === "save_key" ? "own" : "system", error: t.error });
        return json({ error: t.error, detail: t.detail }, 400);
      }
      const secrets = action === "save_key" ? { api_key: key } : { use_system_key: true };
      const { error: upErr } = await admin
        .from("platform_secrets")
        .upsert({ key: "email_addon", secrets }, { onConflict: "key" });
      if (upErr) return json({ error: "save_failed", detail: upErr.message }, 500);
      await admin.rpc("email_addon_set_provider_state", {
        p: { key_source: action === "save_key" ? "own" : "system", key_hint: keyHint(key) },
        p_actor: user.id,
      });
      await audit("email_addon_key_saved", { source: action === "save_key" ? "own" : "system", hint: keyHint(key) });
      const { data: fresh } = await userClient.rpc("internal_email_addon_get");
      return json({ ok: true, state: fresh, system_key_available: Boolean(systemKey) });
    }

    if (action === "check_domain") {
      const currentDomain = String((((state as Raw | null)?.settings ?? {}) as Raw).domain ?? "");
      const domain = String(b.domain ?? currentDomain).trim().toLowerCase();
      if (!isValidDomain(domain)) return json({ error: "invalid_domain" }, 400);
      const key = await platformResendKey(admin);
      if (!key) return json({ error: "no_key" }, 400);

      const list = await resend(key, "/domains");
      if (list.status !== 200) return json({ error: "resend_error", detail: String((list.body as Raw | null)?.message ?? list.status) }, 502);
      let found = findDomain(list.body, domain);
      let created = false;
      if (!found && b.create === true) {
        const c = await resend(key, "/domains", { method: "POST", body: JSON.stringify({ name: domain }) });
        if (c.status !== 200 && c.status !== 201) {
          return json({ error: "resend_error", detail: String((c.body as Raw | null)?.message ?? c.status) }, 502);
        }
        const d = parseResendDomain(c.body);
        if (d) {
          found = { id: d.id, status: d.status };
          created = true;
        }
      }
      if (!found) {
        await admin.rpc("email_addon_set_provider_state", {
          p: { domain, domain_id: "", domain_status: "not_found", dns_records: [] },
          p_actor: user.id,
        });
        const { data: fresh } = await userClient.rpc("internal_email_addon_get");
        return json({ ok: true, found: false, state: fresh, system_key_available: Boolean(systemKey) });
      }
      // Pedir la verificación si todavía no está verificado (idempotente en Resend).
      if (found.status !== "verified") {
        await resend(key, `/domains/${found.id}/verify`, { method: "POST" });
      }
      const g = await resend(key, `/domains/${found.id}`);
      const d = parseResendDomain(g.body);
      if (!d) return json({ error: "resend_error", detail: "domain_unreadable" }, 502);
      await admin.rpc("email_addon_set_provider_state", {
        p: { domain, domain_id: d.id, domain_status: d.status, domain_region: d.region ?? "", dns_records: d.records },
        p_actor: user.id,
      });
      await audit("email_addon_domain_checked", { domain, status: d.status, created });
      const { data: fresh } = await userClient.rpc("internal_email_addon_get");
      return json({ ok: true, found: true, created, domain: d, state: fresh, system_key_available: Boolean(systemKey) });
    }

    if (action === "send_test") {
      const to = String(b.to ?? "").trim().toLowerCase();
      if (!EMAIL_RE.test(to)) return json({ error: "invalid_to" }, 400);
      const settings = ((state as Raw | null)?.settings ?? {}) as Raw;
      if (settings.domain_status !== "verified") return json({ error: "domain_not_verified" }, 400);
      const key = await platformResendKey(admin);
      if (!key) return json({ error: "no_key" }, 400);
      const local = settings.sender_mode === "fixed" ? String(settings.fixed_local ?? "notificaciones") : "prueba";
      const from = `NinjaSoft <${local}@${String(settings.domain)}>`;
      try {
        const id = await resendSend(key, from, {
          to,
          subject: "Prueba del email con dominio NinjaSoft",
          html: `<p style="font-family:Arial,sans-serif;font-size:14px">Si recibís este email, los negocios ya pueden enviar desde @${String(settings.domain)}.</p>`,
          text: `Si recibís este email, los negocios ya pueden enviar desde @${String(settings.domain)}.`,
        });
        await audit("email_addon_test_sent", { to, from: `${local}@${String(settings.domain)}`, resend_id: id });
        return json({ ok: true, id });
      } catch (e) {
        return json({ error: "send_failed", detail: e instanceof Error ? e.message : String(e) }, 502);
      }
    }

    return json({ error: "unknown_action" }, 400);
  } catch (e) {
    return json({ error: "internal", detail: String(e).slice(0, 300) }, 500);
  }
});
