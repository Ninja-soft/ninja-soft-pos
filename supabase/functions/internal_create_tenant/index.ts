// =============================================================================
// Edge Function: internal_create_tenant  (F7 · H11c, ADR-073)
// Alta manual de un negocio desde /internal/tenants.
//   1. Valida JWT: staff NinjaSoft admin o super_admin (soporte no).
//   2. Valida el cuerpo (lógica pura en _shared/tenantAdmin.ts).
//   3. Dueño por email: si ya tiene cuenta se reusa; si no, se lo invita
//      (email de invitación de Supabase Auth con redirect a /login).
//   4. RPC internal_create_tenant (service_role): negocio, suscripción con plan
//      y trial, membresía de dueño, sucursal, caja, medios base y audit_logs en
//      una sola transacción. Si el audit no se escribe, no hay alta.
//   5. Si el dueño no tiene negocio activo en el JWT, se le setea éste.
//   6. Email de trial (best-effort, cola system_emails).
// service_role sólo vive acá (nunca en el front).
// =============================================================================
import { createClient, type SupabaseClient } from "https://esm.sh/@supabase/supabase-js@2.47.10";
import { parseCreateTenantInput } from "../_shared/tenantAdmin.ts";

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

// Errores de la RPC que son del pedido (400), no del servidor.
const CLIENT_ERRORS = [
  "invalid_name",
  "invalid_slug",
  "invalid_industry",
  "invalid_trial_days",
  "reason_too_long",
  "plan_not_found",
  "owner_not_found",
  "slug_taken",
];

function renderTemplate(tpl: string, vars: Record<string, string>): string {
  return tpl.replace(/\{\{\s*(\w+)\s*\}\}/g, (_m, k: string) =>
    k in vars ? vars[k]! : `{{${k}}}`,
  );
}

async function enqueueSystemEmail(
  admin: SupabaseClient,
  tenantId: string,
  recipient: string,
  key: string,
  vars: Record<string, string>,
): Promise<void> {
  try {
    const { data: tpl } = await admin
      .from("system_email_templates")
      .select("subject, html")
      .eq("key", key)
      .maybeSingle();
    if (!tpl?.subject || !tpl?.html) return;
    await admin.from("system_emails").insert({
      tenant_id: tenantId,
      recipient,
      subject: renderTemplate(tpl.subject as string, vars),
      kind: "system",
      status: "pending",
      html_content: renderTemplate(tpl.html as string, vars),
    });
  } catch (_) {
    /* el alta no depende del email */
  }
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

  const meta = (user.app_metadata ?? {}) as { is_internal?: boolean; internal_level?: string };
  if (!meta.is_internal) return json({ error: "forbidden" }, 403);
  if (meta.internal_level === "support") return json({ error: "forbidden_support_level" }, 403);

  let raw: unknown;
  try {
    raw = await req.json();
  } catch {
    return json({ error: "invalid_json" }, 400);
  }
  const parsed = parseCreateTenantInput(raw);
  if (!parsed.ok) return json({ error: parsed.error }, 400);
  const input = parsed.value;

  const admin = createClient(url, serviceKey, { auth: { persistSession: false } });

  // El plan se valida antes de invitar (no dejar una invitación huérfana).
  const { data: plan } = await admin
    .from("plans")
    .select("id")
    .eq("key", input.planKey)
    .eq("is_active", true)
    .is("tenant_id", null)
    .maybeSingle();
  if (!plan) return json({ error: "plan_not_found" }, 400);

  // Dueño: cuenta existente o invitación.
  let ownerId: string | null = null;
  let invited = false;
  const { data: existing } = await admin
    .from("users")
    .select("id")
    .eq("email", input.ownerEmail)
    .maybeSingle();
  if (existing) {
    ownerId = existing.id as string;
  } else {
    const redirectTo = `${Deno.env.get("PUBLIC_SITE_URL") ?? ""}/login`;
    const { data: inv, error: invErr } = await admin.auth.admin.inviteUserByEmail(
      input.ownerEmail,
      {
        redirectTo,
        data: input.ownerName ? { full_name: input.ownerName } : undefined,
      },
    );
    if (invErr || !inv?.user) {
      return json({ error: "invite_failed", detail: invErr?.message?.slice(0, 200) }, 502);
    }
    ownerId = inv.user.id;
    invited = true;
    // El espejo public.users lo crea el trigger de auth.users; el nombre se
    // completa si vino en el formulario.
    if (input.ownerName) {
      await admin.from("users").update({ full_name: input.ownerName }).eq("id", ownerId);
    }
  }

  const { data: created, error: rpcErr } = await admin.rpc("internal_create_tenant", {
    p_actor: user.id,
    p_owner_user_id: ownerId,
    p_name: input.name,
    p_slug: input.slug,
    p_industry: input.industry,
    p_plan_key: input.planKey,
    p_trial_days: input.trialDays,
    p_reason: input.reason,
    p_owner_invited: invited,
  });
  if (rpcErr) {
    const code = CLIENT_ERRORS.find((c) => rpcErr.message.includes(c));
    if (code) return json({ error: code }, 400);
    if (rpcErr.message.includes("forbidden")) return json({ error: "forbidden" }, 403);
    return json({ error: "tenant_create_failed", detail: rpcErr.message.slice(0, 200) }, 500);
  }
  const res = created as { tenant_id: string; slug: string; status: string; trial_ends_at: string | null };

  // Negocio activo en el JWT del dueño si todavía no tiene uno.
  const { data: target } = await admin.auth.admin.getUserById(ownerId!);
  const ownerMeta = (target?.user?.app_metadata ?? {}) as Record<string, unknown>;
  if (!ownerMeta.current_tenant_id) {
    await admin.auth.admin.updateUserById(ownerId!, {
      app_metadata: { ...ownerMeta, current_tenant_id: res.tenant_id },
    });
  }

  if (res.trial_ends_at) {
    await enqueueSystemEmail(admin, res.tenant_id, input.ownerEmail, "trial_started", {
      negocio: input.name,
      dias: String(input.trialDays),
      vence: new Date(res.trial_ends_at).toLocaleDateString("es-AR"),
    });
  }

  return json({
    ok: true,
    tenant_id: res.tenant_id,
    slug: res.slug,
    status: res.status,
    owner_invited: invited,
  });
});
