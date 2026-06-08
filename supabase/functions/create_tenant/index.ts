// =============================================================================
// Edge Function: create_tenant
// Onboarding de un tenant nuevo. Ver docs/08-multi-tenant.md §8.
//   1. Valida usuario autenticado (JWT).
//   2. Crea tenant (trial 14d) + subscription (plan start) + tenant_users(owner).
//   3. Setea app_metadata.current_tenant_id en el usuario (service_role).
//   4. Audita la creación.
//   5. Encola los emails de alta (account_registered + trial_started) en
//      system_emails usando las plantillas de system_email_templates. El envío
//      real lo hace process_pending_emails (cron cada 5 min, por Resend/failover).
// El frontend debe refrescar la sesión para que el JWT tome el nuevo tenant.
// =============================================================================
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.47.10";

const cors = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers":
    "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...cors, "Content-Type": "application/json" },
  });
}

// Render de {{var}} (mismo contrato que lib/email/templates.ts::renderTemplate):
// reemplaza {{ var }} / {{var}} por su valor; si falta, deja el placeholder.
function renderTemplate(tpl: string, vars: Record<string, string>): string {
  return tpl.replace(/\{\{\s*(\w+)\s*\}\}/g, (_m, k: string) =>
    k in vars ? vars[k]! : `{{${k}}}`,
  );
}

// Encola un email del sistema resolviendo subject+html de system_email_templates.
// Best-effort: nunca rompe el alta del tenant (cualquier error se traga).
async function enqueueSystemEmail(
  admin: ReturnType<typeof createClient>,
  tenantId: string,
  recipient: string,
  key: string,
  vars: Record<string, string>,
): Promise<void> {
  try {
    if (!recipient) return;
    const { data: tpl } = await admin
      .from("system_email_templates")
      .select("subject, html")
      .eq("key", key)
      .maybeSingle();
    if (!tpl?.subject || !tpl?.html) return; // sin plantilla: no encolamos
    await admin.from("system_emails").insert({
      tenant_id: tenantId,
      recipient,
      subject: renderTemplate(tpl.subject as string, vars),
      kind: "system",
      status: "pending",
      html_content: renderTemplate(tpl.html as string, vars),
    });
  } catch (_) {
    /* noop: el alta no depende del email */
  }
}

function slugify(name: string): string {
  return (
    name
      .toLowerCase()
      .normalize("NFD")
      .replace(/[̀-ͯ]/g, "")
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 40) || "negocio"
  );
}

// Rubros soportados (deben coincidir con lib/verticals/config.ts en el front).
const INDUSTRIES = [
  "kiosco",
  "textil",
  "retail",
  "restaurante",
  "heladeria",
  "cafeteria",
  "panaderia",
  "peluqueria",
  "estetica",
  "servicios",
  "pyme",
  "otro",
];

const IVA_CONDITIONS = [
  "monotributo",
  "responsable_inscripto",
  "exento",
  "consumidor_final",
];

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
    error: userErr,
  } = await userClient.auth.getUser();
  if (userErr || !user) return json({ error: "unauthorized" }, 401);

  let body: {
    name?: string;
    industry?: string;
    cuit?: string;
    legal_name?: string;
    iva_condition?: string;
  };
  try {
    body = await req.json();
  } catch {
    return json({ error: "invalid_json" }, 400);
  }

  const name = (body.name ?? "").trim();
  const industry = INDUSTRIES.includes(body.industry ?? "")
    ? body.industry!
    : "otro";
  if (name.length < 2 || name.length > 120) {
    return json({ error: "invalid_name" }, 400);
  }

  // Datos fiscales (opcionales). Se persisten en tenant_branding tras crear el
  // tenant. Validamos acá para no escribir basura con service_role.
  const cuitRaw = (body.cuit ?? "").replace(/\D/g, "");
  const cuit = cuitRaw.length === 11 ? cuitRaw : null;
  if (cuitRaw.length > 0 && cuit === null) {
    return json({ error: "invalid_cuit" }, 400);
  }
  const legalName = (body.legal_name ?? "").trim().slice(0, 200) || null;
  const ivaCondition = IVA_CONDITIONS.includes(body.iva_condition ?? "")
    ? body.iva_condition!
    : null;
  const hasFiscal = cuit !== null || legalName !== null || ivaCondition !== null;

  const admin = createClient(url, serviceKey, {
    auth: { persistSession: false },
  });

  // Slug unico.
  let slug = slugify(name);
  for (let i = 0; i < 5; i++) {
    const { data: existing } = await admin
      .from("tenants")
      .select("id")
      .eq("slug", slug)
      .maybeSingle();
    if (!existing) break;
    slug = `${slugify(name)}-${1000 + i * 1111}`;
  }

  const trialEnds = new Date(
    Date.now() + 14 * 24 * 60 * 60 * 1000,
  ).toISOString();

  // 1. Tenant.
  const { data: tenant, error: tErr } = await admin
    .from("tenants")
    .insert({ name, slug, industry, status: "trial", trial_ends_at: trialEnds })
    .select("id, slug")
    .single();
  if (tErr || !tenant) {
    return json({ error: "tenant_create_failed", detail: tErr?.message }, 500);
  }

  // 2. Subscription (plan start).
  const { data: plan } = await admin
    .from("plans")
    .select("id")
    .eq("key", "start")
    .single();
  if (plan) {
    await admin.from("subscriptions").insert({
      tenant_id: tenant.id,
      plan_id: plan.id,
      status: "trial",
      billing_cycle: "monthly",
      current_period_start: new Date().toISOString(),
      current_period_end: trialEnds,
    });
  }

  // 3. Membership owner.
  await admin.from("tenant_users").insert({
    tenant_id: tenant.id,
    user_id: user.id,
    role: "owner",
    status: "active",
    joined_at: new Date().toISOString(),
  });

  // 3b. Sucursal + caja por defecto (docs/08 §8).
  const { data: store } = await admin
    .from("stores")
    .insert({ tenant_id: tenant.id, name: "Sucursal principal", is_default: true })
    .select("id")
    .single();
  if (store) {
    await admin.from("cash_registers").insert({
      tenant_id: tenant.id,
      store_id: store.id,
      name: "Caja 1",
    });
  }

  // 3c. Datos fiscales opcionales → tenant_branding (con service_role, así no
  // dependemos de que el JWT ya tenga current_tenant_id para pasar la RLS).
  if (hasFiscal) {
    await admin.from("tenant_branding").upsert(
      {
        tenant_id: tenant.id,
        cuit,
        legal_name: legalName,
        iva_condition: ivaCondition,
      },
      { onConflict: "tenant_id" },
    );
  }

  // 4. JWT: tenant activo.
  await admin.auth.admin.updateUserById(user.id, {
    app_metadata: {
      ...(user.app_metadata ?? {}),
      current_tenant_id: tenant.id,
    },
  });

  // 5. Auditoria.
  await admin.from("audit_logs").insert({
    tenant_id: tenant.id,
    actor_user_id: user.id,
    entity_type: "tenants",
    entity_id: tenant.id,
    action: "tenant_created",
    after_data: { name, slug: tenant.slug, industry },
  });

  // 6. Emails de alta (account_registered + trial_started). Best-effort: si
  // fallan, el alta igual responde OK. Los envía process_pending_emails (cron).
  const ownerName =
    (typeof user.user_metadata?.full_name === "string" &&
      user.user_metadata.full_name.trim()) ||
    (typeof user.user_metadata?.name === "string" &&
      user.user_metadata.name.trim()) ||
    (user.email ? user.email.split("@")[0] : "") ||
    "";
  const recipient = (user.email ?? "").trim().toLowerCase();
  const venceLabel = new Date(trialEnds).toLocaleDateString("es-AR");
  await enqueueSystemEmail(admin, tenant.id, recipient, "account_registered", {
    negocio: name,
    nombre: ownerName,
  });
  await enqueueSystemEmail(admin, tenant.id, recipient, "trial_started", {
    negocio: name,
    dias: "14",
    vence: venceLabel,
  });

  return json({ tenant_id: tenant.id, slug: tenant.slug });
});
