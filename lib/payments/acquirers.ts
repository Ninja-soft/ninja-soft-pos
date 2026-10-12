// Adquirentes del posnet offline ("Tarjeta en posnet", ADR-042 y ADR-054).
//
// El cajero cobra en una terminal NO integrada y registra el cupón. Primero
// elige de qué adquirente es la terminal (Getnet, Payway, Point de Mercado
// Pago, Fiserv/Clover, Nave u Otra): con eso se resuelve el n° de comercio,
// se filtran los planes de cuotas y la conciliación agrupa por adquirente.
// Se guarda en payments.card_voucher.adquirente con la clave de abajo.
//
// Puro y testeable: sin React ni Supabase.

import { paymentIcon } from "@/lib/payments/logos";
import { resolveMerchantNumber, type ProviderMerchantNumbers } from "@/lib/payments/merchantNumbers";

export type AcquirerKey = "getnet" | "payway" | "mercadopago" | "fiserv" | "nave" | "other";

export interface AcquirerDef {
  key: AcquirerKey;
  label: string;
  /** Nombre corto para las placas del POS. */
  short: string;
  /** provider_key de tenant_payment_methods de la marca (terminal primero). */
  providers: string[];
  /** Clave de logo (lib/payments/logos) o null. */
  logoKey: string | null;
}

export const ACQUIRERS: AcquirerDef[] = [
  { key: "getnet", label: "Getnet", short: "Getnet", providers: ["getnet_point", "getnet"], logoKey: "getnet" },
  { key: "payway", label: "Payway", short: "Payway", providers: ["payway_point", "payway"], logoKey: "payway" },
  {
    key: "mercadopago",
    label: "Mercado Pago Point",
    short: "MP Point",
    providers: ["mercadopago_point", "mercadopago"],
    logoKey: "mercadopago",
  },
  { key: "fiserv", label: "Fiserv / Clover", short: "Clover", providers: ["fiserv", "fiserv_point"], logoKey: "fiserv_point" },
  { key: "nave", label: "Nave", short: "Nave", providers: ["nave_point", "nave"], logoKey: "nave" },
  { key: "other", label: "Otra", short: "Otra", providers: [], logoKey: null },
];

export const ACQUIRER_KEYS = ACQUIRERS.map((a) => a.key);

const BY_KEY = new Map(ACQUIRERS.map((a) => [a.key, a]));

export function isAcquirerKey(v: unknown): v is AcquirerKey {
  return typeof v === "string" && BY_KEY.has(v as AcquirerKey);
}

export function acquirerByKey(key: string | null | undefined): AcquirerDef | null {
  return key ? (BY_KEY.get(key as AcquirerKey) ?? null) : null;
}

export function acquirerLabel(key: string | null | undefined): string {
  return acquirerByKey(key)?.label ?? (key ? String(key) : "");
}

export function acquirerLogo(key: string | null | undefined): string | null {
  const a = acquirerByKey(key);
  return a?.logoKey ? paymentIcon(a.logoKey) : null;
}

/** Adquirente de un provider_key (payway_point → payway). null si no es de ninguno. */
export function acquirerOfProvider(providerKey: string | null | undefined): AcquirerKey | null {
  if (!providerKey) return null;
  return ACQUIRERS.find((a) => a.providers.includes(providerKey))?.key ?? null;
}

export interface ProviderStatus {
  provider_key: string;
  enabled: boolean;
}

/**
 * Adquirentes a ofrecer en el POS, en el orden del catálogo y con "Otra" al
 * final:
 *   1. Si la configuración del cupón trae una lista (`configured`), esa.
 *   2. Si no, los de las marcas que el negocio tiene habilitadas (cualquier
 *      canal: Payway QR + link prendido cuenta como "tengo Payway").
 *   3. Si no sale ninguno, todos (nunca se bloquea el cobro).
 */
export function availableAcquirers(
  providers: ProviderStatus[] | null | undefined,
  configured?: string[] | null,
): AcquirerDef[] {
  const named = ACQUIRERS.filter((a) => a.key !== "other");
  let picked: AcquirerDef[];
  const list = (configured ?? []).filter(isAcquirerKey);
  if (list.length > 0) {
    picked = named.filter((a) => list.includes(a.key));
  } else {
    const on = new Set((providers ?? []).filter((p) => p.enabled).map((p) => p.provider_key));
    picked = named.filter((a) => a.providers.some((k) => on.has(k)));
    if (picked.length === 0) picked = named;
  }
  // "Otra" va siempre, salvo que la lista configurada la deje afuera a
  // propósito (y haya al menos otro).
  const withOther = list.length > 0 && !list.includes("other") && picked.length > 0;
  return withOther ? picked : [...picked, BY_KEY.get("other")!];
}

/**
 * Adquirente a preseleccionar: el último usado en la caja si sigue
 * disponible; si hay uno solo, ese. null = el cajero elige.
 */
export function initialAcquirer(available: AcquirerDef[], remembered: string | null | undefined): AcquirerKey | null {
  if (remembered && available.some((a) => a.key === remembered)) return remembered as AcquirerKey;
  if (available.length === 1) return available[0]!.key;
  return null;
}

/** Clave de localStorage del último adquirente por caja (o por equipo, sin caja). */
export function rememberKey(registerId: string | null | undefined): string {
  return `ninja.posnet.acquirer.${registerId || "device"}`;
}

/**
 * N° de comercio para el cupón: el que el negocio cargó en un medio del
 * adquirente elegido (terminal primero, después QR + link). Para "Otra" o
 * sin adquirente, la resolución de siempre (plan elegido o único cargado).
 */
export function acquirerMerchantNumber(
  providers: ProviderMerchantNumbers[],
  brand: string | null,
  acquirer: string | null | undefined,
  planProvider: string | null,
): string | null {
  if (!brand) return null;
  const a = acquirerByKey(acquirer);
  if (!a || a.key === "other") return resolveMerchantNumber(providers, brand, planProvider);
  // Sólo los medios del adquirente: nunca el n° de comercio de otro.
  const own = providers.filter((p) => a.providers.includes(p.provider_key));
  const first = a.providers.find((k) => own.find((p) => p.provider_key === k)?.merchant_numbers?.[brand]) ?? null;
  return resolveMerchantNumber(own, brand, first);
}

/**
 * Planes de cuotas para el adquirente: los suyos (provider_key de su marca) y
 * los genéricos (de ningún adquirente). Si el adquirente no tiene planes
 * propios, todos (el negocio cargó sus cuotas en otro medio y las usa para
 * cualquier posnet, como hasta ahora).
 */
export function plansForAcquirer<P extends { provider_key?: string | null }>(
  plans: P[],
  acquirer: string | null | undefined,
): P[] {
  const a = acquirerByKey(acquirer);
  if (!a || a.key === "other") return plans;
  const own = plans.filter((p) => p.provider_key && a.providers.includes(p.provider_key));
  if (own.length === 0) return plans;
  return plans.filter((p) => !p.provider_key || own.includes(p) || acquirerOfProvider(p.provider_key) === null);
}
