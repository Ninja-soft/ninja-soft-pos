// Cambio de modo Prueba / Real (ADR-155). PURO: qué falta antes de probar el
// modo real, cómo quedan los puntos de venta de cada sucursal y caja frente a
// la lista de ARCA de ese ambiente, qué número proponer y el aviso de la
// contingencia CAEA.
import { CHECKLIST_LABEL } from "./labels";

export interface PosListed {
  nro: number;
  emisionTipo: string;
}

export interface StoreLike {
  id: string;
  name: string;
  afip_pos_number: number | null;
  registers?: { id: string; name: string; afip_pos_number: number | null }[];
}

export interface PosRow {
  kind: "store" | "register";
  id: string;
  /** "Sucursal Centro" o "Centro · Caja 2". */
  label: string;
  current: number | null;
  /** El número está en ARCA como Web Services. */
  ok: boolean;
  /** Número de la lista de ARCA que se propone (null = no hay cuál). */
  suggestion: number | null;
}

const isCaea = (p: PosListed) => /caea/i.test(p.emisionTipo);

/** Puntos de venta Web Services (sin los de CAEA). */
export function webServicePos(listed: PosListed[] | null | undefined): number[] {
  return [...new Set((listed ?? []).filter((p) => !isCaea(p)).map((p) => p.nro))].sort((a, b) => a - b);
}

/**
 * Sucursales (y cajas con número propio) frente a la lista de ARCA. A cada
 * una que no está se le propone un número de la lista, primero los que no usa
 * nadie (dos sucursales pueden compartir punto de venta, pero se prefiere uno
 * libre).
 */
export function reconcilePos(stores: StoreLike[], listed: PosListed[] | null | undefined): PosRow[] {
  const ws = webServicePos(listed);
  const wsSet = new Set(ws);
  const rows: PosRow[] = [];
  for (const s of stores) {
    rows.push({ kind: "store", id: s.id, label: s.name, current: s.afip_pos_number, ok: false, suggestion: null });
    for (const r of s.registers ?? []) {
      if (r.afip_pos_number == null) continue;
      rows.push({ kind: "register", id: r.id, label: `${s.name} · ${r.name}`, current: r.afip_pos_number, ok: false, suggestion: null });
    }
  }
  const used = new Set(rows.map((r) => r.current).filter((n): n is number => n != null && wsSet.has(n)));
  const free = ws.filter((n) => !used.has(n));
  let i = 0;
  for (const r of rows) {
    r.ok = r.current != null && wsSet.has(r.current);
    if (r.ok) continue;
    r.suggestion = free[i] ?? free[free.length - 1] ?? ws[0] ?? null;
    if (free[i] != null) i++;
  }
  return rows;
}

/** Ítems del checklist de producción que faltan y no se arreglan desde acá. */
export function goLivePrereqs(items: { key: string; ok: boolean; required?: boolean }[]): { key: string; label: string; help: string }[] {
  return items
    .filter((i) => !i.ok && i.required !== false)
    .filter((i) => i.key !== "conexion_produccion" && i.key !== "puntos_de_venta")
    .map((i) => ({ key: i.key, label: CHECKLIST_LABEL[i.key]?.label ?? i.key, help: CHECKLIST_LABEL[i.key]?.help ?? "" }));
}

/**
 * Aviso si la contingencia está activa y su punto de venta no figura en ARCA
 * como CAEA en el ambiente que se verificó (null = todo bien o no aplica).
 */
export function caeaPosWarning(caeaEnabled: boolean, caeaPv: number | null, listed: PosListed[] | null | undefined): string | null {
  if (!caeaEnabled || caeaPv == null || !listed) return null;
  if (listed.some((p) => p.nro === caeaPv && isCaea(p))) return null;
  return `El punto de venta de contingencia ${String(caeaPv).padStart(5, "0")} no figura en ARCA como CAEA en este modo. Mientras no esté, si ARCA no responde las facturas esperan en cola.`;
}

export const padPos = (n: number | null | undefined): string => (n == null ? "Sin número" : String(n).padStart(5, "0"));
