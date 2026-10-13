// Timeline de auditoría por negocio en el panel interno (F7 · H11c, ADR-073).
// Lógica pura: etiqueta legible, categoría, cambios antes/después, filtros y
// agrupación por día. La UI vive en components/internal/TenantAuditTimeline.

export type AuditCategory = "lifecycle" | "plan" | "access" | "config" | "operation";

export const AUDIT_CATEGORY_LABELS: Record<AuditCategory | "all", string> = {
  all: "Todo",
  lifecycle: "Ciclo de vida",
  plan: "Plan y facturación",
  access: "Accesos",
  config: "Configuración",
  operation: "Operación",
};

export interface AuditLike {
  id: string;
  entity_type: string;
  action: string;
  before_data: unknown;
  after_data: unknown;
  reason: string | null;
  created_at: string;
  actorName?: string | null;
  actorEmail?: string | null;
}

// Acciones con texto propio. El resto se arma por reglas (ver describeAuditAction).
const KNOWN: Record<string, { label: string; category: AuditCategory }> = {
  tenant_created: { label: "Alta del negocio (registro propio)", category: "lifecycle" },
  tenant_created_internal: { label: "Alta manual del negocio desde el panel interno", category: "lifecycle" },
  tenant_suspended: { label: "Negocio suspendido", category: "lifecycle" },
  tenant_reactivated: { label: "Negocio reactivado", category: "lifecycle" },
  tenant_deleted: { label: "Negocio dado de baja", category: "lifecycle" },
  status_changed: { label: "Cambio de estado de la suscripción", category: "lifecycle" },
  trial_extended: { label: "Trial extendido", category: "lifecycle" },
  trial_end_set: { label: "Fin del trial ajustado", category: "lifecycle" },
  dunning_past_due: { label: "Pago vencido (cobranza automática)", category: "lifecycle" },
  dunning_suspended: { label: "Suspendido por falta de pago", category: "lifecycle" },
  dunning_trial_expired: { label: "Trial vencido", category: "lifecycle" },
  subscription_reactivated: { label: "Suscripción reactivada", category: "lifecycle" },
  account_closure_requested: { label: "El dueño pidió la baja", category: "lifecycle" },
  access_granted: { label: "Acceso otorgado con código", category: "lifecycle" },
  plan_changed: { label: "Cambio de plan", category: "plan" },
  plan_change_requested: { label: "El dueño pidió cambio de plan", category: "plan" },
  custom_plan_created: { label: "Plan a medida creado", category: "plan" },
  custom_plan_updated: { label: "Plan a medida editado", category: "plan" },
  limit_override_set: { label: "Límite del plan ajustado", category: "plan" },
  addon_granted: { label: "Complemento regalado", category: "plan" },
  addon_revoked: { label: "Complemento quitado", category: "plan" },
  addon_set: { label: "Complemento modificado", category: "plan" },
  payment_recorded: { label: "Pago registrado", category: "plan" },
  impersonation_link_generated: { label: "Acceso como el negocio (link de un uso)", category: "access" },
  member_invited: { label: "Usuario invitado", category: "access" },
  staff_level_set: { label: "Nivel de staff cambiado", category: "access" },
  flag_changed: { label: "Feature flag cambiada", category: "config" },
  industry_changed: { label: "Rubro cambiado", category: "config" },
  industry_preset_applied: { label: "Preset de rubro aplicado", category: "config" },
};

const ENTITY_LABELS: Record<string, string> = {
  tenants: "negocio",
  subscriptions: "suscripción",
  subscription_addons: "complementos",
  billing_records: "facturación",
  tenant_discounts: "descuentos",
  tenant_users: "usuarios",
  tenant_feature_flags: "feature flags",
  products: "productos",
  sales: "ventas",
  cash_shifts: "turnos de caja",
  cash_registers: "cajas",
  stores: "sucursales",
  customers: "clientes",
  payments: "cobros",
};

const PLAN_ENTITIES = new Set([
  "subscriptions",
  "subscription",
  "plans",
  "subscription_addons",
  "billing_records",
  "billing_record",
  "billing",
  "tenant_discounts",
  "trial",
]);
const ACCESS_ENTITIES = new Set(["impersonation", "tenant_users", "users", "cashier_profiles"]);
const CONFIG_ENTITIES = new Set(["tenant_feature_flags", "tenant_branding", "pos_settings", "tenant_payment_methods"]);

function humanize(s: string): string {
  const t = s.replace(/_/g, " ").trim();
  return t ? t[0]!.toUpperCase() + t.slice(1) : s;
}

export function describeAuditAction(entityType: string, action: string): {
  label: string;
  category: AuditCategory;
} {
  const known = KNOWN[action];
  if (known) return known;

  const entity = ENTITY_LABELS[entityType] ?? entityType.replace(/_/g, " ");
  let label: string;
  if (action === "INSERT") label = `Alta en ${entity}`;
  else if (action === "UPDATE") label = `Cambio en ${entity}`;
  else if (action === "DELETE") label = `Borrado en ${entity}`;
  else label = humanize(action);

  let category: AuditCategory = "operation";
  if (entityType === "tenants" && /^(tenant_|trial_|dunning_)/.test(action)) category = "lifecycle";
  else if (/^dunning_|^trial_/.test(action)) category = "lifecycle";
  else if (ACCESS_ENTITIES.has(entityType) || /^(member_|user_|staff_|impersonation)/.test(action)) category = "access";
  else if (PLAN_ENTITIES.has(entityType) || /^(plan_|addon_|subscription_|payment_recorded)/.test(action)) category = "plan";
  else if (CONFIG_ENTITIES.has(entityType) || /(_configured|_secret_set|_secret_cleared|smtp)/.test(action)) category = "config";
  return { label, category };
}

export interface AuditChange {
  key: string;
  before: string;
  after: string;
}

function fmtValue(v: unknown): string {
  if (v === null || v === undefined || v === "") return "vacío";
  if (typeof v === "boolean") return v ? "sí" : "no";
  if (typeof v === "string" || typeof v === "number") return String(v);
  return JSON.stringify(v);
}

// Claves técnicas que no aportan en la lectura del timeline.
const HIDDEN_KEYS = new Set(["id", "tenant_id", "created_at", "updated_at"]);

/** Diferencias de primer nivel entre before_data y after_data. */
export function auditChanges(before: unknown, after: unknown): AuditChange[] {
  const b = before && typeof before === "object" && !Array.isArray(before) ? (before as Record<string, unknown>) : {};
  const a = after && typeof after === "object" && !Array.isArray(after) ? (after as Record<string, unknown>) : {};
  const keys = Array.from(new Set([...Object.keys(b), ...Object.keys(a)])).filter((k) => !HIDDEN_KEYS.has(k));
  const out: AuditChange[] = [];
  for (const key of keys) {
    const bv = fmtValue(b[key]);
    const av = fmtValue(a[key]);
    if (bv === av) continue;
    out.push({ key, before: key in b ? bv : "", after: key in a ? av : "" });
  }
  return out;
}

export interface TimelineFilters {
  category: AuditCategory | "all";
  query: string;
}

/** Filtra por categoría y por texto (etiqueta, acción, motivo o autor). */
export function filterAuditEntries<T extends AuditLike>(entries: T[], f: TimelineFilters): T[] {
  const q = f.query.trim().toLowerCase();
  return entries.filter((e) => {
    const d = describeAuditAction(e.entity_type, e.action);
    if (f.category !== "all" && d.category !== f.category) return false;
    if (!q) return true;
    return [d.label, e.action, e.entity_type, e.reason, e.actorName, e.actorEmail]
      .filter(Boolean)
      .some((v) => (v as string).toLowerCase().includes(q));
  });
}

/** Agrupa por día local (yyyy-mm-dd), en el orden recibido (más nuevo primero). */
export function groupAuditByDay<T extends AuditLike>(entries: T[]): { day: string; items: T[] }[] {
  const groups: { day: string; items: T[] }[] = [];
  for (const e of entries) {
    const d = new Date(e.created_at);
    const day = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
    const last = groups[groups.length - 1];
    if (last && last.day === day) last.items.push(e);
    else groups.push({ day, items: [e] });
  }
  return groups;
}
