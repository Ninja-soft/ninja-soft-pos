// Configuración heredable negocio → grupo → sucursal → caja (F17 · H92/H93,
// ADR-049). Espejo puro de la resolución SQL (`_effective_config` en
// supabase/migrations/20261015100000_config_heredable.sql): el POS resuelve
// en el cliente con las filas de config_overrides (lectura por RLS) y el
// servidor vuelve a resolver al cobrar (trigger de payments y Edges).
//
// Reglas:
//   * La sucursal sólo guarda lo que pisa (patch parcial, override por campo).
//   * Orden: negocio ← grupo ← sucursal ← caja. Gana el último que pisa.
//   * Los campos "mapa" (n° de comercio por marca, descuento máximo por rol,
//     perfiles de impresión, diseño del POS) se mezclan por clave.
//   * Sin multi_sucursal no se aplican grupo ni sucursal; sin multi_caja, la
//     caja (bajar de plan no borra los overrides, sólo los apaga).
//   * Un campo fuera de la whitelist del alcance se ignora.

export type ConfigDomain = "payment_method" | "pos_settings" | "ticket";
export type ConfigScope = "store_group" | "store" | "register";
export type FieldType = "bool" | "num" | "text" | "map_text" | "map_num" | "map_any";

export interface FieldDef {
  key: string;
  type: FieldType;
  label: string;
  /** Alcances donde se puede pisar. */
  scopes: ConfigScope[];
  hint?: string;
  /** Unidad o sufijo para números ("%", "$"). */
  unit?: string;
  /** Opciones para text con valores cerrados. */
  options?: { value: string; label: string }[];
}

const GS: ConfigScope[] = ["store_group", "store"];
const ALL: ConfigScope[] = ["store_group", "store", "register"];

export const CONFIG_FIELDS: Record<ConfigDomain, FieldDef[]> = {
  payment_method: [
    { key: "enabled", type: "bool", label: "Habilitado", scopes: ALL, hint: "Una caja sin posnet puede apagar la tarjeta." },
    { key: "surcharge_pct", type: "num", label: "Recargo", unit: "%", scopes: GS },
    {
      key: "plan_mode",
      type: "text",
      label: "Recargo de cuotas",
      scopes: GS,
      options: [
        { value: "plans", label: "Por plan de cuotas" },
        { value: "global", label: "Recargo único" },
      ],
    },
    { key: "merchant_numbers", type: "map_text", label: "N° de comercio por marca", scopes: GS },
    { key: "sort", type: "num", label: "Orden", scopes: GS },
  ],
  pos_settings: [
    { key: "rounding_multiple", type: "num", label: "Redondeo del total", unit: "$", scopes: GS },
    { key: "allow_negative_stock", type: "bool", label: "Vender sin stock", scopes: GS },
    { key: "max_discount", type: "map_num", label: "Descuento máximo por rol", unit: "%", scopes: GS },
    { key: "require_customer", type: "bool", label: "Cliente obligatorio", scopes: GS },
    { key: "require_card_voucher", type: "bool", label: "Exigir cupón de tarjeta", scopes: GS },
    { key: "offer_warranty", type: "bool", label: "Ofrecer garantía extendida", scopes: GS },
    { key: "auto_email_receipt", type: "bool", label: "Enviar comprobante por mail", scopes: GS },
    { key: "allow_free_sale", type: "bool", label: "Venta libre (monto manual)", scopes: ALL },
    { key: "max_free_sale", type: "map_num", label: "Tope de venta libre por rol", unit: "$", scopes: GS },
    { key: "blind_close", type: "bool", label: "Cierre de caja ciego", scopes: ALL },
    { key: "close_tolerance", type: "num", label: "Tolerancia de cierre", unit: "$", scopes: ALL },
    { key: "require_close_reason", type: "bool", label: "Motivo obligatorio en diferencias", scopes: ALL },
    { key: "display_show_unit_prices", type: "bool", label: "Pantalla del cliente: precios unitarios", scopes: ALL },
    { key: "display_welcome_message", type: "text", label: "Pantalla del cliente: bienvenida", scopes: ALL },
    { key: "display_thanks_message", type: "text", label: "Pantalla del cliente: agradecimiento", scopes: ALL },
    { key: "print_profiles", type: "map_any", label: "Perfiles de impresión", scopes: ALL },
    { key: "pos_layout", type: "map_any", label: "Diseño del POS", scopes: ALL },
  ],
  ticket: [
    {
      key: "use_store_contact",
      type: "bool",
      label: "Usar dirección y teléfono de la sucursal",
      scopes: GS,
      hint: "Toma los datos cargados en Sucursales y cajas: no se tipean dos veces.",
    },
    { key: "legal_name", type: "text", label: "Razón social", scopes: GS },
    { key: "cuit", type: "text", label: "CUIT", scopes: GS },
    { key: "phone", type: "text", label: "Teléfono", scopes: GS },
    { key: "address", type: "text", label: "Dirección", scopes: GS },
    { key: "ticket_title", type: "text", label: "Título del ticket", scopes: GS },
    { key: "ticket_legend", type: "text", label: "Leyenda", scopes: GS },
    { key: "ticket_footer", type: "text", label: "Pie del ticket", scopes: GS },
  ],
};

/** Tipo del campo en el alcance (null = no se puede pisar ahí). */
export function fieldType(domain: ConfigDomain, scope: ConfigScope, field: string): FieldType | null {
  const def = CONFIG_FIELDS[domain].find((f) => f.key === field);
  return def && def.scopes.includes(scope) ? def.type : null;
}

export function fieldsFor(domain: ConfigDomain, scope: ConfigScope): FieldDef[] {
  return CONFIG_FIELDS[domain].filter((f) => f.scopes.includes(scope));
}

export interface ConfigOverride {
  id?: string;
  scope: ConfigScope;
  scope_id: string;
  domain: ConfigDomain;
  domain_key: string;
  patch: Record<string, unknown>;
  deleted_at?: string | null;
}

export interface ResolveTarget {
  groupId?: string | null;
  storeId?: string | null;
  registerId?: string | null;
  /** Feature multi_sucursal (grupo y sucursal). */
  multiStore: boolean;
  /** Feature multi_caja (caja). */
  multiRegister: boolean;
}

/** "tenant" | "store_group:<id>" | "store:<id>" | "register:<id>". */
export type Source = string;

export interface Effective<T = Record<string, unknown>> {
  value: T;
  sources: Record<string, Source>;
}

const ORDER: Record<ConfigScope, number> = { store_group: 1, store: 2, register: 3 };

function isObj(v: unknown): v is Record<string, unknown> {
  return Boolean(v) && typeof v === "object" && !Array.isArray(v);
}

/** Capas que aplican al destino, en orden de herencia. */
export function applicableLayers(
  overrides: ConfigOverride[],
  domain: ConfigDomain,
  domainKey: string,
  t: ResolveTarget,
): ConfigOverride[] {
  return overrides
    .filter(
      (o) =>
        !o.deleted_at &&
        o.domain === domain &&
        (o.domain_key ?? "") === (domainKey ?? "") &&
        ((o.scope === "store_group" && t.multiStore && !!t.groupId && o.scope_id === t.groupId) ||
          (o.scope === "store" && t.multiStore && !!t.storeId && o.scope_id === t.storeId) ||
          (o.scope === "register" && t.multiRegister && !!t.registerId && o.scope_id === t.registerId)),
    )
    .sort((a, b) => ORDER[a.scope] - ORDER[b.scope]);
}

/** Valor efectivo y origen de cada campo. */
export function resolveEffective<T extends Record<string, unknown>>(
  domain: ConfigDomain,
  domainKey: string,
  base: T,
  overrides: ConfigOverride[],
  target: ResolveTarget,
): Effective<T> {
  const value: Record<string, unknown> = { ...base };
  const sources: Record<string, Source> = {};
  for (const k of Object.keys(base)) sources[k] = "tenant";
  for (const layer of applicableLayers(overrides, domain, domainKey, target)) {
    for (const [k, v] of Object.entries(layer.patch ?? {})) {
      const type = fieldType(domain, layer.scope, k);
      if (!type) continue;
      if (type.startsWith("map") && isObj(v) && isObj(value[k])) {
        value[k] = { ...(value[k] as Record<string, unknown>), ...v };
      } else {
        value[k] = v;
      }
      sources[k] = `${layer.scope}:${layer.scope_id}`;
    }
  }
  return { value: value as T, sources };
}

export type InheritState = "inherited" | "custom";

/** ¿El campo está pisado en ESTE alcance o se hereda? */
export function inheritState(
  overrides: ConfigOverride[],
  scope: ConfigScope,
  scopeId: string,
  domain: ConfigDomain,
  domainKey: string,
  field: string,
): InheritState {
  const own = overrides.find(
    (o) =>
      !o.deleted_at &&
      o.scope === scope &&
      o.scope_id === scopeId &&
      o.domain === domain &&
      (o.domain_key ?? "") === (domainKey ?? ""),
  );
  return own && Object.prototype.hasOwnProperty.call(own.patch ?? {}, field) ? "custom" : "inherited";
}

/** Override propio del alcance (o null). */
export function ownOverride(
  overrides: ConfigOverride[],
  scope: ConfigScope,
  scopeId: string,
  domain: ConfigDomain,
  domainKey: string,
): ConfigOverride | null {
  return (
    overrides.find(
      (o) =>
        !o.deleted_at &&
        o.scope === scope &&
        o.scope_id === scopeId &&
        o.domain === domain &&
        (o.domain_key ?? "") === (domainKey ?? ""),
    ) ?? null
  );
}

/** Lo que el alcance heredaría si no pisara nada (para "volver a heredar"). */
export function parentTarget(scope: ConfigScope, target: ResolveTarget): ResolveTarget {
  if (scope === "register") return { ...target, registerId: null };
  if (scope === "store") return { ...target, storeId: null, registerId: null };
  return { ...target, groupId: null, storeId: null, registerId: null };
}

// ── Medios de pago ───────────────────────────────────────────────────────────

export interface ProviderRow {
  provider_key: string;
  enabled: boolean;
  connected: boolean;
  surcharge_pct: number;
  merchant_numbers: Partial<Record<string, string>>;
  plan_mode: string | null;
}

/**
 * Filas de medios con la configuración efectiva de la sucursal / caja. Suma
 * filas virtuales para medios que el negocio no tiene pero que la sucursal
 * prende (enabled por override): la conexión (`connected`) sigue siendo la
 * del negocio. Los n° de comercio vacíos ("") se descartan (la sucursal
 * "borra" el número del negocio para esa marca).
 */
export function effectiveProviderRows(
  rows: ProviderRow[],
  overrides: ConfigOverride[],
  target: ResolveTarget,
): ProviderRow[] {
  const keys = new Set(rows.map((r) => r.provider_key));
  const extra = overrides
    .filter((o) => o.domain === "payment_method" && !o.deleted_at && !keys.has(o.domain_key))
    .map((o) => o.domain_key);
  const all: ProviderRow[] = [
    ...rows,
    ...[...new Set(extra)].map((k) => ({
      provider_key: k,
      enabled: k === "cash" || k === "transfer",
      connected: false,
      surcharge_pct: 0,
      merchant_numbers: {},
      plan_mode: null,
    })),
  ];
  const out: ProviderRow[] = [];
  for (const r of all) {
    const eff = resolveEffective(
      "payment_method",
      r.provider_key,
      {
        enabled: r.enabled,
        surcharge_pct: r.surcharge_pct,
        plan_mode: r.plan_mode,
        merchant_numbers: r.merchant_numbers ?? {},
      },
      overrides,
      target,
    ).value;
    // Fila virtual que ninguna capa tocó: no se agrega.
    if (!keys.has(r.provider_key) && eff.enabled === r.enabled) continue;
    const merchants: Partial<Record<string, string>> = {};
    for (const [brand, n] of Object.entries((eff.merchant_numbers ?? {}) as Record<string, unknown>)) {
      if (typeof n === "string" && n) merchants[brand] = n;
    }
    out.push({
      ...r,
      enabled: Boolean(eff.enabled),
      surcharge_pct: Number(eff.surcharge_pct) || 0,
      plan_mode: (eff.plan_mode as string | null) ?? null,
      merchant_numbers: merchants,
    });
  }
  return out;
}

// ── Copiar configuración ─────────────────────────────────────────────────────

export interface CopyChange {
  domain: ConfigDomain;
  domainKey: string;
  field: string;
  from: unknown;
  to: unknown;
  kind: "set" | "clear";
}

/**
 * Diferencias que produce copiar los overrides del origen al destino
 * (espejo de config_override_copy, para mostrar el diff antes de confirmar).
 */
export function copyPreview(
  overrides: ConfigOverride[],
  from: { scope: ConfigScope; id: string },
  to: { scope: ConfigScope; id: string },
  mode: "replace" | "merge" = "replace",
  domains?: ConfigDomain[],
): CopyChange[] {
  const live = overrides.filter((o) => !o.deleted_at && (!domains || domains.includes(o.domain)));
  const src = live.filter((o) => o.scope === from.scope && o.scope_id === from.id);
  const dst = live.filter((o) => o.scope === to.scope && o.scope_id === to.id);
  const key = (o: { domain: string; domain_key: string }) => `${o.domain}|${o.domain_key}`;
  const pairs = new Map<string, { domain: ConfigDomain; domainKey: string }>();
  for (const o of [...src, ...(mode === "replace" ? dst : [])]) {
    pairs.set(key(o), { domain: o.domain, domainKey: o.domain_key });
  }
  const changes: CopyChange[] = [];
  for (const { domain, domainKey } of pairs.values()) {
    const s = src.find((o) => o.domain === domain && o.domain_key === domainKey)?.patch ?? {};
    const d = dst.find((o) => o.domain === domain && o.domain_key === domainKey)?.patch ?? {};
    for (const [field, v] of Object.entries(s)) {
      if (!fieldType(domain, to.scope, field)) continue;
      if (JSON.stringify(d[field]) !== JSON.stringify(v)) {
        changes.push({ domain, domainKey, field, from: d[field], to: v, kind: "set" });
      }
    }
    if (mode === "replace") {
      for (const [field, v] of Object.entries(d)) {
        if (Object.prototype.hasOwnProperty.call(s, field) && fieldType(domain, to.scope, field)) continue;
        changes.push({ domain, domainKey, field, from: v, to: undefined, kind: "clear" });
      }
    }
  }
  return changes;
}

/** Mensaje amable para los errores de las RPC de configuración. */
export function configErrorMessage(err: unknown): string {
  const msg = err instanceof Error ? err.message : String(err ?? "");
  if (msg.includes("feature_not_in_plan: multi_caja")) return "Configurar por caja requiere un plan con varias cajas.";
  if (msg.includes("feature_not_in_plan")) return "Configurar por sucursal requiere un plan con varias sucursales.";
  if (msg.includes("payment_method_not_allowed")) return "Ese medio no está incluido en tu plan.";
  if (msg.includes("invalid_merchant_number")) return "El n° de comercio sólo admite letras y números (hasta 20).";
  if (msg.includes("out_of_range")) return "El valor está fuera de rango.";
  if (msg.includes("field_not_allowed")) return "Ese dato no se puede personalizar en este nivel.";
  if (msg.includes("forbidden")) return "No tenés permiso para configurar ese lugar.";
  if (msg.includes("scope_not_found")) return "La sucursal o caja ya no existe.";
  return "No se pudo guardar la configuración.";
}
