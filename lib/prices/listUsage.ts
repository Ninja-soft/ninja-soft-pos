// Listas de precios: dónde se usa cada una y cómo se elige (ADR-151, auditoría
// de listas). PURO.
//
// Una lista sólo cambia lo que se cobra si algo la elige. El servidor
// (_resolve_unit_price) y el POS (resolveUnitPrice) eligen en este orden:
//   1. la lista que el cajero eligió en el carrito (sólo las "elegibles en el POS"),
//   2. la del cliente, 3. la de su grupo, 4. la de la sucursal, 5. la del grupo
//      de sucursales (asignaciones),
//   6. la lista del canal Mostrador.
// La primera activa y vigente gana; si ninguna aplica, se cobra el precio de
// venta del producto. El catálogo público usa la del canal Catálogo y Mercado
// Libre la que elegiste en la cuenta de ML. Los canales Mayorista y
// Personalizada no se aplican solos: hay que asignarlos o hacerlos elegibles.

import type { PricingWorld, ProductCostsLike, ProPriceItem } from "./resolve";

export interface ListUsageInput {
  id: string;
  channel: string;
  is_active?: boolean | null;
  pos_selectable?: boolean | null;
  valid_to?: string | null;
}

export interface AssignmentLike {
  price_list_id: string;
  scope: "customer" | "customer_group" | "store" | "store_group" | string;
}

export interface ListUsage {
  /** Algo la elige (canal, POS o asignación). */
  used: boolean;
  /** Dónde, en palabras ("POS por defecto", "2 grupos de clientes"). */
  where: string[];
  /** Aviso para mostrar en la lista, o null. */
  warning: string | null;
}

const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;

export function listUsage(list: ListUsageInput, assignments: AssignmentLike[], now: Date = new Date()): ListUsage {
  const where: string[] = [];
  if (list.channel === "mostrador") where.push("POS por defecto");
  if (list.channel === "catalogo") where.push("Catálogo público");
  if (list.pos_selectable) where.push("Elegible en el POS");
  const mine = assignments.filter((a) => a.price_list_id === list.id);
  const count = (s: string) => mine.filter((a) => a.scope === s).length;
  if (count("customer")) where.push(plural(count("customer"), "cliente", "clientes"));
  if (count("customer_group")) where.push(plural(count("customer_group"), "grupo de clientes", "grupos de clientes"));
  if (count("store")) where.push(plural(count("store"), "sucursal", "sucursales"));
  if (count("store_group")) where.push(plural(count("store_group"), "grupo de sucursales", "grupos de sucursales"));
  const used = where.length > 0;
  let warning: string | null = null;
  if (list.is_active === false) warning = "Está apagada: no se usa en ningún lado.";
  else if (list.valid_to && new Date(list.valid_to).getTime() <= now.getTime()) warning = "Ya venció: no se usa.";
  else if (!used)
    warning =
      "Todavía no se usa: asignala a un grupo de clientes o a una sucursal, o marcala elegible en el POS.";
  return { used, where, warning };
}

/** Qué hace cada canal, para la ayuda del formulario. */
export function channelHelp(channel: string): string {
  switch (channel) {
    case "mostrador":
      return "Es la lista que usa el POS cuando no hay otra para el cliente o la sucursal.";
    case "catalogo":
      return "Es la lista de los precios del catálogo público.";
    case "mayorista":
      return "Es sólo un nombre: para que se use, asignala a un grupo de clientes o marcala elegible en el POS.";
    default:
      return "Para que se use, asignala a clientes, grupos o sucursales, o marcala elegible en el POS.";
  }
}

export const RESOLUTION_ORDER: string[] = [
  "La que el cajero elige en el carrito (sólo las elegibles en el POS).",
  "La del cliente, después la de su grupo.",
  "La de la sucursal, después la de su grupo de sucursales.",
  "La del canal Mostrador.",
  "Si ninguna aplica, el precio de venta del producto.",
];

/** Costos del producto como los usa el resolver (listas sobre costo y pisos). */
export function productCostsLike(p: Record<string, unknown>): ProductCostsLike {
  const n = (v: unknown) => (v == null || v === "" ? null : Number(v));
  return {
    cost: n(p.cost),
    last_cost: n(p.last_cost),
    avg_cost: n(p.avg_cost),
    replacement_cost: n(p.replacement_cost),
    min_price: n(p.min_price),
    final_cost: n(p.final_cost),
  };
}

/**
 * Foto de precios con los precios fijos de UNA lista (los que se están
 * editando) y los costos de los productos que se muestran, para calcular el
 * precio de esa lista con el mismo resolver del POS. Sin asignaciones: la
 * lista se pasa explícita.
 */
export function worldWithList(
  world: PricingWorld,
  listId: string,
  items: { product_id: string; variant_id: string | null; price: number }[],
  costs: Record<string, ProductCostsLike> = {},
): PricingWorld {
  const mine: ProPriceItem[] = items.map((i) => ({
    price_list_id: listId,
    product_id: i.product_id,
    variant_id: i.variant_id,
    price: Number(i.price),
  }));
  return {
    ...world,
    assigned: [],
    items: [...world.items.filter((i) => i.price_list_id !== listId), ...mine],
    costs: { ...costs, ...world.costs },
  };
}
