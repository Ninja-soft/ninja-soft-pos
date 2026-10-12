// Registro DATA-DRIVEN de medios de cobro del POS ("tenders"). Cada entrada es
// una forma de cobrar: medio (método de la venta) + proveedor + marca + canal.
// La hoja de cobro (CheckoutSheet) arma su grilla a partir de acá, filtrando
// por lo que el negocio habilitó, conectó y lo que su plan permite.
//
// La UI es sólo un espejo: el gating real vive en el server (trigger de
// `payments` vía payment_method_plan_key, create_sale y cada Edge de cobro).
// Sumar un proveedor nuevo = sumar una entrada acá (y su feature en
// lib/payments/providerFeature.ts), sin tocar la pantalla.

import { isProviderEnabled } from "@/lib/payments/defaults";
import { providerFeature } from "@/lib/payments/providerFeature";
import { paymentIcon } from "@/lib/payments/logos";

export type SaleMethod =
  | "cash"
  | "debit"
  | "credit"
  | "transfer"
  | "qr"
  | "other"
  | "store_credit"
  | "account"
  | "directo";

export type TenderChannel = "manual" | "qr" | "link" | "point";

// Cómo se completa el cobro:
//  - cash: efectivo con recibido y vuelto.
//  - direct: se registra tal cual (transferencia).
//  - card: tarjeta manual (débito o crédito con cuotas).
//  - terminal: terminal de la marca sin integración (se cobra en el equipo y se
//    registra como débito/crédito).
//  - qr: QrCheckoutModal (QR o link del proveedor).
//  - point: PointCheckoutModal (la terminal recibe la orden por API).
//  - store_credit / account: saldo a favor o cuenta corriente del cliente.
export type TenderFlow =
  | "cash"
  | "direct"
  | "card"
  | "terminal"
  | "qr"
  | "point"
  | "store_credit"
  | "account";

export type TenderGroupKey =
  | "cash"
  | "transfer"
  | "card"
  | "mercadopago"
  | "payway"
  | "getnet"
  | "nave"
  | "fiserv"
  | "wallets"
  | "customer";

export type QrProviderKey =
  | "mercadopago"
  | "mobbex"
  | "modo"
  | "pagos360"
  | "payway"
  | "getnet"
  | "nave"
  | "gocuotas"
  | "directo";
export type PointProviderKey = "mercadopago_point" | "nave_point" | "fiserv_point";

export interface TenderDef {
  /** Id estable "marca:canal" (se usa en pos_layout.payments). */
  id: string;
  group: TenderGroupKey;
  brand: string;
  brandLabel: string;
  channel: TenderChannel;
  /** Rótulo corto del botón dentro de su grupo ("QR", "Link", "Point"…). */
  label: string;
  /** Método de la venta. null = lo decide el cobro (débito/crédito). */
  method: SaleMethod | null;
  /** payment_providers.key que el negocio tiene que tener habilitado. */
  provider: string | null;
  /** Proveedor cuya conexión (config.connected) se exige. */
  connection: string | null;
  /** Feature de plan (espejo del server). */
  featureKey: string | null;
  logo: string | null;
  flow: TenderFlow;
  qrProvider?: QrProviderKey;
  pointProvider?: PointProviderKey;
  /** Ayuda corta debajo del rótulo. */
  hint?: string;
  /** Exige un número de operación (viaja como reference del pago). */
  requiresReference?: boolean;
  /** Monto mínimo que acepta el proveedor. */
  minAmount?: number;
  /**
   * Respaldo manual de un proveedor con API: sólo se ofrece mientras su
   * conexión (provider) NO esté conectada (Directo, ADR-041).
   */
  manualFallback?: boolean;
}

// Isotipos oficiales: misma fuente que la configuración de medios de pago
// (lib/payments/logos). Las tarjetas usan sus logos de red.
const icon = (k: string) => paymentIcon(k) ?? "";
const LOGO = {
  cash: icon("cash"),
  transfer: icon("transfer"),
  mercadopago: icon("mercadopago"),
  payway: icon("payway"),
  getnet: icon("getnet"),
  nave: icon("nave"),
  modo: icon("modo"),
  mobbex: icon("mobbex"),
  pagos360: icon("pagos360"),
  gocuotas: icon("gocuotas"),
  directo: icon("directo"),
  clover: icon("fiserv_point"),
} as const;

// Proveedores que habilitan la tarjeta manual (débito/crédito con posnet
// propio o terminal sin integrar). Espejo de los providers de débito/crédito
// que usaba PaymentModal.
export const CARD_PROVIDERS = [
  "mercadopago_point",
  "payway",
  "payway_point",
  "getnet",
  "getnet_point",
  "nave_point",
  "fiserv",
  "fiserv_point",
  "mobbex",
] as const;

function qr(
  brand: QrProviderKey,
  brandLabel: string,
  group: TenderGroupKey,
  channel: "qr" | "link",
  hint?: string,
): TenderDef {
  return {
    id: `${brand}:${channel}`,
    group,
    brand,
    brandLabel,
    channel,
    label: channel === "qr" ? "QR" : "Link",
    method: "qr",
    provider: brand,
    connection: brand,
    featureKey: providerFeature(brand),
    logo: LOGO[brand],
    flow: "qr",
    qrProvider: brand,
    hint,
  };
}

export const TENDERS: TenderDef[] = [
  {
    id: "cash",
    group: "cash",
    brand: "cash",
    brandLabel: "Efectivo",
    channel: "manual",
    label: "Efectivo",
    method: "cash",
    provider: "cash",
    connection: null,
    featureKey: null,
    logo: LOGO.cash,
    flow: "cash",
  },
  {
    id: "transfer",
    group: "transfer",
    brand: "transfer",
    brandLabel: "Transferencia",
    channel: "manual",
    label: "Transferencia",
    method: "transfer",
    provider: "transfer",
    connection: null,
    featureKey: null,
    logo: LOGO.transfer,
    flow: "direct",
  },
  {
    // Tarjeta en posnet: terminal NO integrada. Se elige la entidad, el tipo
    // (débito/crédito, con cuotas) y se cargan los datos del cupón. El pago
    // se registra como debit/credit según lo elegido (method null = lo decide
    // el cobro). Reemplaza a "card:debit" / "card:credit" (ver LEGACY_TENDER_IDS).
    id: "card",
    group: "card",
    brand: "card",
    brandLabel: "Tarjeta en posnet",
    channel: "manual",
    label: "Tarjeta en posnet",
    method: null,
    provider: null,
    connection: null,
    featureKey: null,
    logo: null,
    flow: "card",
    hint: "Terminal no integrada: cargás los datos del cupón",
  },
  qr("mercadopago", "Mercado Pago", "mercadopago", "qr", "Billeteras y tarjetas"),
  qr("mercadopago", "Mercado Pago", "mercadopago", "link", "Para mandar por mensaje"),
  {
    id: "mercadopago:point",
    group: "mercadopago",
    brand: "mercadopago",
    brandLabel: "Mercado Pago",
    channel: "point",
    label: "Point",
    method: null,
    provider: "mercadopago_point",
    connection: "mercadopago",
    featureKey: providerFeature("mercadopago_point"),
    logo: LOGO.mercadopago,
    flow: "point",
    pointProvider: "mercadopago_point",
    hint: "Lector conectado",
  },
  qr("payway", "Payway", "payway", "qr", "Checkout de la tienda"),
  qr("payway", "Payway", "payway", "link", "Para mandar por mensaje"),
  {
    id: "payway:point",
    group: "payway",
    brand: "payway",
    brandLabel: "Payway",
    channel: "point",
    label: "Point",
    method: null,
    provider: "payway_point",
    connection: null,
    featureKey: providerFeature("payway_point"),
    logo: LOGO.payway,
    flow: "terminal",
    hint: "Cobrás en la terminal",
  },
  qr("getnet", "Getnet", "getnet", "qr", "Checkout Getnet"),
  qr("getnet", "Getnet", "getnet", "link", "Para mandar por mensaje"),
  qr("nave", "Nave", "nave", "qr", "QR interoperable"),
  qr("nave", "Nave", "nave", "link", "Para mandar por mensaje"),
  {
    id: "nave:point",
    group: "nave",
    brand: "nave",
    brandLabel: "Nave",
    channel: "point",
    label: "Point",
    method: null,
    provider: "nave_point",
    connection: "nave",
    featureKey: providerFeature("nave_point"),
    logo: LOGO.nave,
    flow: "point",
    pointProvider: "nave_point",
    hint: "Terminal Nave",
  },
  {
    // Clover Point (ADR-047): terminal Clover de Fiserv por Cloud Pay Display.
    // Usa la conexión de la marca Fiserv (fila `fiserv`).
    id: "fiserv:point",
    group: "fiserv",
    brand: "fiserv",
    brandLabel: "Clover",
    channel: "point",
    label: "Point",
    method: null,
    provider: "fiserv_point",
    connection: "fiserv",
    featureKey: providerFeature("fiserv_point"),
    logo: LOGO.clover,
    flow: "point",
    pointProvider: "fiserv_point",
    hint: "Terminal Clover",
  },
  qr("modo", "MODO", "wallets", "qr", "App de los bancos"),
  qr("mobbex", "Mobbex", "wallets", "qr"),
  qr("mobbex", "Mobbex", "wallets", "link"),
  qr("pagos360", "Pagos360", "wallets", "link", "Link de pago"),
  // GO Cuotas (ADR-033): checkout Redirect como QR + link; desde $1.500.
  { ...qr("gocuotas", "GO Cuotas", "wallets", "qr", "Cuotas con débito"), minAmount: 1500 },
  { ...qr("gocuotas", "GO Cuotas", "wallets", "link", "Cuotas con débito"), minAmount: 1500 },
  // Directo (ADR-041): con la API conectada, QR + link de la orden de
  // Directo; sin conexión, respaldo manual (ADR-034): se cobra en el portal de
  // Directo y acá se registra el número de operación.
  qr("directo", "Directo", "wallets", "qr", "Crédito sin tarjeta"),
  qr("directo", "Directo", "wallets", "link", "Crédito sin tarjeta"),
  {
    id: "directo",
    group: "wallets",
    brand: "directo",
    brandLabel: "Directo",
    channel: "manual",
    label: "Crédito",
    method: "directo",
    provider: "directo",
    connection: null,
    featureKey: providerFeature("directo"),
    logo: LOGO.directo,
    flow: "direct",
    hint: "Con número de operación",
    requiresReference: true,
    manualFallback: true,
  },
  {
    id: "store_credit",
    group: "customer",
    brand: "store_credit",
    brandLabel: "Vale",
    channel: "manual",
    label: "Vale",
    method: "store_credit",
    provider: null,
    connection: null,
    featureKey: null,
    logo: null,
    flow: "store_credit",
    hint: "Saldo a favor",
  },
  {
    id: "account",
    group: "customer",
    brand: "account",
    brandLabel: "Cuenta corriente",
    channel: "manual",
    label: "Cuenta corriente",
    method: "account",
    provider: null,
    connection: null,
    featureKey: "cuenta_corriente",
    logo: null,
    flow: "account",
    hint: "Fiado",
  },
];

export const TENDER_GROUPS: { key: TenderGroupKey; label: string }[] = [
  { key: "cash", label: "Efectivo" },
  { key: "transfer", label: "Transferencia" },
  { key: "card", label: "Tarjeta en posnet" },
  { key: "mercadopago", label: "Mercado Pago" },
  { key: "payway", label: "Payway" },
  { key: "getnet", label: "Getnet" },
  { key: "nave", label: "Nave" },
  { key: "fiserv", label: "Clover" },
  { key: "wallets", label: "Billeteras y links" },
  { key: "customer", label: "Cuenta del cliente" },
];

export const TENDER_BY_ID: Record<string, TenderDef> = Object.fromEntries(
  TENDERS.map((t) => [t.id, t]),
);

// ── Disponibilidad ────────────────────────────────────────────────────────────

export interface ProviderStatus {
  provider_key: string;
  enabled: boolean;
  connected: boolean;
  surcharge_pct?: number;
}

export interface TenderContext {
  /** Todas las filas de tenant_payment_methods (habilitadas o no). */
  providers: ProviderStatus[] | undefined;
  /** gating.features. undefined = cargando → optimista (el server corta igual). */
  features: Record<string, boolean> | undefined;
  hasCustomer: boolean;
  storeCreditBalance: number;
}

export interface ResolvedTender extends TenderDef {
  /** % de recargo del medio (tenant_payment_methods.surcharge_pct). */
  surchargePct: number;
}

function featureAllowed(key: string | null, features: Record<string, boolean> | undefined) {
  if (!key) return true;
  if (!features) return true;
  return features[key] === true;
}

/** ¿El tender se puede usar con la config del negocio? (sin preferencias). */
export function tenderReady(t: TenderDef, ctx: TenderContext): boolean {
  const rows = ctx.providers ?? [];
  const byKey = new Map(rows.map((r) => [r.provider_key, r]));
  // Efectivo y transferencia sin fila cuentan como habilitados (lib/payments/defaults).
  const enabled = { has: (key: string) => isProviderEnabled(key, byKey.get(key)) };
  const connected = (key: string) => rows.some((r) => r.provider_key === key && r.connected);
  // Sin ninguna configuración: sólo los medios manuales básicos (como antes).
  const noConfig = !rows.some((r) => r.enabled);

  if (!featureAllowed(t.featureKey, ctx.features)) return false;

  switch (t.flow) {
    case "cash":
    case "direct":
      // Respaldo manual: desaparece cuando el proveedor está conectado por API.
      if (t.manualFallback && connected(t.provider ?? "")) return false;
      // Sin configuración sólo se ofrecen efectivo y transferencia.
      return (noConfig && !t.requiresReference) || enabled.has(t.provider ?? "");
    case "card":
      return (
        noConfig ||
        CARD_PROVIDERS.some(
          (p) => enabled.has(p) && featureAllowed(providerFeature(p), ctx.features),
        )
      );
    case "terminal":
      return enabled.has(t.provider ?? "");
    case "qr":
    case "point":
      return enabled.has(t.provider ?? "") && connected(t.connection ?? t.provider ?? "");
    case "store_credit":
      return ctx.hasCustomer && ctx.storeCreditBalance > 0;
    case "account":
      return ctx.hasCustomer;
  }
}

/** Tenders utilizables, en el orden del registro. */
export function resolveTenders(ctx: TenderContext): ResolvedTender[] {
  const pct = new Map(
    (ctx.providers ?? []).map((r) => [r.provider_key, Number(r.surcharge_pct) || 0]),
  );
  return TENDERS.filter((t) => tenderReady(t, ctx)).map((t) => ({
    ...t,
    // Recargo global del medio: sólo efectivo y transferencia (los QR lo
    // aplica su propio modal; las tarjetas usan planes de cuotas).
    surchargePct:
      (t.flow === "cash" || t.flow === "direct") && !t.requiresReference
        ? (pct.get(t.provider ?? "") ?? 0)
        : 0,
  }));
}

// ── Preferencias del negocio (pos_layout.payments) ───────────────────────────

export interface TenderPrefs {
  /** Orden de grupos (TenderGroupKey). Los no listados van después. */
  order?: string[];
  /** Ids de tenders ocultos. Sólo ocultan: nunca habilitan. */
  hidden?: string[];
  /** Ids de tenders fijados en el carrito (acceso de un toque). */
  pinned?: string[];
}

// Ids viejos guardados en pos_layout.payments / checkout que hoy son otro
// tender (la tarjeta manual era dos accesos: débito y crédito).
const LEGACY_TENDER_IDS: Record<string, string> = { "card:debit": "card", "card:credit": "card" };

/** Id vigente de un tender (traduce ids viejos guardados en el diseño). */
export function normalizeTenderId(id: string): string {
  return LEGACY_TENDER_IDS[id] ?? id;
}

function normalizeIds(ids: string[] | undefined): string[] {
  return Array.from(new Set((ids ?? []).map(normalizeTenderId)));
}

export interface TenderSection {
  key: TenderGroupKey;
  label: string;
  tenders: ResolvedTender[];
}

export function groupTenders(tenders: ResolvedTender[], prefs: TenderPrefs = {}): TenderSection[] {
  const hidden = new Set(normalizeIds(prefs.hidden));
  const visible = tenders.filter((t) => !hidden.has(t.id));
  const order = prefs.order ?? [];
  const rank = (k: string) => {
    const i = order.indexOf(k);
    return i === -1 ? order.length + TENDER_GROUPS.findIndex((g) => g.key === k) : i;
  };
  return TENDER_GROUPS.map((g) => ({
    key: g.key,
    label: g.label,
    tenders: visible.filter((t) => t.group === g.key),
  }))
    .filter((s) => s.tenders.length > 0)
    .sort((a, b) => rank(a.key) - rank(b.key));
}

/**
 * Tenders fijados en el carrito. Si el negocio no eligió, se fija efectivo y
 * el primer cobro electrónico disponible (máximo 3).
 */
export function pinnedTenders(tenders: ResolvedTender[], prefs: TenderPrefs = {}): ResolvedTender[] {
  const hidden = new Set(normalizeIds(prefs.hidden));
  const usable = tenders.filter((t) => !hidden.has(t.id));
  const byId = new Map(usable.map((t) => [t.id, t]));
  if (prefs.pinned && prefs.pinned.length > 0) {
    return normalizeIds(prefs.pinned)
      .map((id) => byId.get(id))
      .filter((t): t is ResolvedTender => Boolean(t))
      .slice(0, 3);
  }
  const out: ResolvedTender[] = [];
  const cash = byId.get("cash");
  if (cash) out.push(cash);
  const electronic = usable.find((t) => t.flow === "qr" || t.flow === "point");
  if (electronic) out.push(electronic);
  const card = usable.find((t) => t.flow === "card");
  if (card && out.length < 3) out.push(card);
  return out;
}

/**
 * Agrupa una lista de tenders por marca, en el orden de aparición. Las marcas
 * con más de un canal (p. ej. GO Cuotas QR + Link, Directo con API, Mobbex)
 * se muestran como una fila con canales; las de un solo canal, como tile.
 */
export function brandRuns<T extends Pick<TenderDef, "brand">>(tenders: T[]): T[][] {
  const runs = new Map<string, T[]>();
  for (const t of tenders) {
    const run = runs.get(t.brand);
    if (run) run.push(t);
    else runs.set(t.brand, [t]);
  }
  return Array.from(runs.values());
}

// ── Selector de la hoja de cobro (pos_layout.checkout) ───────────────────────

export interface CheckoutPickerPrefs {
  /** Ids de tenders fijados arriba de todo. */
  favorites?: string[];
  /** Grupos que no se muestran en el selector. */
  hiddenGroups?: string[];
}

export type CheckoutSectionKey = TenderGroupKey | "favorites";

export interface CheckoutSection {
  key: CheckoutSectionKey;
  label: string;
  tenders: ResolvedTender[];
}

/**
 * Secciones del selector de la hoja de cobro: "Favoritos" primero (en el orden
 * elegido) y después los grupos visibles, sin repetir los favoritos. Ocultar
 * grupos nunca deja la hoja vacía: si no queda nada, se ignora.
 */
export function checkoutSections(
  tenders: ResolvedTender[],
  prefs: TenderPrefs = {},
  picker: CheckoutPickerPrefs = {},
): CheckoutSection[] {
  const base = groupTenders(tenders, prefs);
  const byId = new Map(base.flatMap((s) => s.tenders).map((t) => [t.id, t]));
  const favs = normalizeIds(picker.favorites)
    .map((id) => byId.get(id))
    .filter((t): t is ResolvedTender => Boolean(t));
  const favIds = new Set(favs.map((t) => t.id));
  const hidden = new Set(picker.hiddenGroups ?? []);
  const build = (hide: boolean): CheckoutSection[] => {
    const rest = base
      .filter((s) => !hide || !hidden.has(s.key))
      .map((s) => ({ ...s, tenders: s.tenders.filter((t) => !favIds.has(t.id)) }))
      .filter((s) => s.tenders.length > 0);
    return favs.length > 0 ? [{ key: "favorites", label: "Favoritos", tenders: favs }, ...rest] : rest;
  };
  const out = build(true);
  return out.length > 0 ? out : build(false);
}
