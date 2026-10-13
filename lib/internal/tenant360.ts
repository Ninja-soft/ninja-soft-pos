// =============================================================================
// Ficha 360 del negocio (F7 · H11c, ADR-084): normaliza el jsonb de la RPC
// internal_tenant_360 a un objeto tipado y tolerante a campos faltantes.
// =============================================================================

export interface Tenant360Module {
  key: string;
  label: string;
  grupo: string;
  isBasic: boolean;
  enabled: boolean;
}

export interface Tenant360Error {
  source: "webhook" | "fiscal" | "email";
  label: string;
  detail: string | null;
  at: string;
}

export interface Tenant360Activity {
  action: string;
  entityType: string;
  at: string;
  reason: string | null;
  actorEmail: string | null;
}

export interface Tenant360 {
  members: {
    total: number;
    active: number;
    suspended: number;
    inactive: number;
    owners: number;
    managers: number;
    cashiers: number;
    viewers: number;
    lastLoginAt: string | null;
  };
  stores: number;
  registers: number;
  products: number;
  sales: {
    todayCount: number;
    todayTotal: number;
    d7Count: number;
    d7Total: number;
    d30Count: number;
    d30Total: number;
  };
  lastSaleAt: string | null;
  modules: Tenant360Module[];
  flagOverrides: number;
  activity: Tenant360Activity[];
  errors: Tenant360Error[];
  webhookErrors7d: number;
  fiscalPending: number;
  openImpersonations: number;
}

type Obj = Record<string, unknown>;
const obj = (v: unknown): Obj => (v && typeof v === "object" && !Array.isArray(v) ? (v as Obj) : {});
const num = (v: unknown): number => {
  const n = typeof v === "string" ? Number(v) : typeof v === "number" ? v : 0;
  return Number.isFinite(n) ? n : 0;
};
const str = (v: unknown): string | null => (typeof v === "string" && v ? v : null);
const arr = (v: unknown): unknown[] => (Array.isArray(v) ? v : []);

export function parseTenant360(raw: unknown): Tenant360 {
  const r = obj(raw);
  const m = obj(r.members);
  const s = obj(r.sales);
  return {
    members: {
      total: num(m.total),
      active: num(m.active),
      suspended: num(m.suspended),
      inactive: num(m.inactive),
      owners: num(m.owners),
      managers: num(m.managers),
      cashiers: num(m.cashiers),
      viewers: num(m.viewers),
      lastLoginAt: str(m.last_login_at),
    },
    stores: num(r.stores),
    registers: num(r.registers),
    products: num(r.products),
    sales: {
      todayCount: num(s.today_count),
      todayTotal: num(s.today_total),
      d7Count: num(s.d7_count),
      d7Total: num(s.d7_total),
      d30Count: num(s.d30_count),
      d30Total: num(s.d30_total),
    },
    lastSaleAt: str(r.last_sale_at),
    modules: arr(r.modules).map((x) => {
      const o = obj(x);
      return {
        key: String(o.key ?? ""),
        label: String(o.label ?? o.key ?? ""),
        grupo: String(o.grupo ?? "general"),
        isBasic: o.is_basic === true,
        enabled: o.enabled === true,
      };
    }),
    flagOverrides: num(r.flag_overrides),
    activity: arr(r.activity).map((x) => {
      const o = obj(x);
      return {
        action: String(o.action ?? ""),
        entityType: String(o.entity_type ?? ""),
        at: String(o.created_at ?? ""),
        reason: str(o.reason),
        actorEmail: str(o.actor_email),
      };
    }),
    errors: arr(r.errors)
      .map((x) => {
        const o = obj(x);
        const src = o.source === "webhook" || o.source === "fiscal" ? o.source : "email";
        return {
          source: src as Tenant360Error["source"],
          label: String(o.label ?? ""),
          detail: str(o.detail),
          at: String(o.at ?? ""),
        };
      })
      .sort((a, b) => b.at.localeCompare(a.at)),
    webhookErrors7d: num(r.webhook_errors_7d),
    fiscalPending: num(r.fiscal_pending),
    openImpersonations: num(r.open_impersonations),
  };
}

export const ERROR_SOURCE_LABELS: Record<Tenant360Error["source"], string> = {
  webhook: "Cobro",
  fiscal: "Fiscal",
  email: "Email",
};

// Módulos agrupados para mostrar: activos primero dentro de cada grupo.
export function groupModules(mods: Tenant360Module[]): { grupo: string; items: Tenant360Module[] }[] {
  const by = new Map<string, Tenant360Module[]>();
  for (const m of mods) {
    const list = by.get(m.grupo) ?? [];
    list.push(m);
    by.set(m.grupo, list);
  }
  return [...by.entries()].map(([grupo, items]) => ({
    grupo,
    items: [...items].sort((a, b) => Number(b.enabled) - Number(a.enabled) || a.label.localeCompare(b.label)),
  }));
}
