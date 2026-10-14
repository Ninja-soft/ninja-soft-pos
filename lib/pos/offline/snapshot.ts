// Foto local para vender sin conexión (ADR-077): catálogo con precios, política
// offline y turno abierto, por negocio y usuario. NO guarda secretos: nada de
// tokens, credenciales de medios de pago ni costos (se sacan del producto).
// Los precios son los del último momento con conexión; el servidor los
// revalida al sincronizar y, si cambiaron, respeta el cobrado y lo audita.

import type { OfflinePolicy } from "./policy";

export const SNAPSHOT_VERSION = 1;
/** Tope de productos en la foto (el POS lista hasta 200 por búsqueda). */
export const SNAPSHOT_MAX_PRODUCTS = 5000;

/** Campos que nunca van a la foto local. */
const STRIP = ["cost", "created_by", "updated_by", "deleted_at", "tenant_id"] as const;

export interface OfflineSnapshot<P = Record<string, unknown>> {
  v: number;
  tenantId: string;
  userId: string;
  /** ISO de la foto. */
  at: string;
  products: P[];
  policy: OfflinePolicy;
  shift: { id: string; storeId: string | null } | null;
}

export function snapshotKey(tenantId: string, userId: string): string {
  return `snapshot.${tenantId}.${userId}`;
}

export function shiftCountKey(tenantId: string, userId: string, shiftId: string): string {
  return `count.${tenantId}.${userId}.${shiftId}`;
}

export function toSnapshotProduct<P extends object>(p: P): P {
  const out = { ...p } as Record<string, unknown>;
  for (const k of STRIP) delete out[k];
  return out as P;
}

export function buildSnapshot<P extends object>(i: {
  tenantId: string;
  userId: string;
  products: P[];
  policy: OfflinePolicy;
  shift: { id: string; storeId: string | null } | null;
  now?: Date;
}): OfflineSnapshot<P> {
  return {
    v: SNAPSHOT_VERSION,
    tenantId: i.tenantId,
    userId: i.userId,
    at: (i.now ?? new Date()).toISOString(),
    products: i.products.slice(0, SNAPSHOT_MAX_PRODUCTS).map(toSnapshotProduct),
    policy: i.policy,
    shift: i.shift,
  };
}

/**
 * La misma foto con el turno, la sucursal y la política actuales, sin volver a
 * bajar el catálogo. Devuelve null si no cambia nada.
 */
export function snapshotWithMeta<P>(
  s: OfflineSnapshot<P>,
  meta: { shift: { id: string; storeId: string | null } | null; policy: OfflinePolicy },
): OfflineSnapshot<P> | null {
  const cur = s.shift;
  const sameShift =
    (cur?.id ?? null) === (meta.shift?.id ?? null) && (cur?.storeId ?? null) === (meta.shift?.storeId ?? null);
  const samePolicy = JSON.stringify(s.policy) === JSON.stringify(meta.policy);
  if (sameShift && samePolicy) return null;
  return { ...s, shift: meta.shift, policy: meta.policy };
}

/** La foto es de esta sesión y de esta versión. */
export function snapshotMatches(s: OfflineSnapshot<unknown> | null | undefined, tenantId: string, userId: string) {
  return Boolean(s && s.v === SNAPSHOT_VERSION && s.tenantId === tenantId && s.userId === userId);
}

const fold = (s: unknown) =>
  typeof s === "string"
    ? s
        .normalize("NFD")
        .replace(/[̀-ͯ]/g, "")
        .toLowerCase()
    : "";

interface Searchable {
  name?: unknown;
  sku?: unknown;
  barcode?: unknown;
  plu?: unknown;
}

/** Misma búsqueda que productsApi.list (nombre, SKU, código, PLU), en local. */
export function searchSnapshot<P extends Searchable>(products: P[], q: string, limit = 200): P[] {
  const s = fold(q.trim());
  const list = s
    ? products.filter(
        (p) => fold(p.name).includes(s) || fold(p.sku).includes(s) || fold(p.barcode).includes(s) || fold(p.plu).includes(s),
      )
    : products;
  return list.slice(0, limit);
}

/** Código exacto (scanner): barcode, SKU o PLU. */
export function findByCodeInSnapshot<P extends Searchable>(products: P[], code: string): P | null {
  const c = code.trim();
  if (!c) return null;
  return products.find((p) => p.barcode === c || p.sku === c || p.plu === c) ?? null;
}
