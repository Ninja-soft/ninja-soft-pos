// =============================================================================
// _shared/mercadolibre/shipping.ts (H87 · ADR-104 · fix del modo de envío). PURO.
//
// Antes de armar `shipping` de POST /items hay que saber qué modos admite el
// vendedor y la categoría. Mandar me2 a una categoría que no lo admite hace
// que ML responda `shipping.lost_me2_by_catalog` y, si además el vendedor no
// tiene me1, `shipping.lost_me1_by_user`.
//
//   • modesFrom: lee los modos de cualquiera de las respuestas de ML
//       GET /users/{id}/shipping_preferences       { modes: [...], logistics: [{ mode }] }
//       GET /categories/{id}/shipping_preferences  { logistics: [{ mode, types }] }
//       GET /users/{id}/shipping_modes?category_id { [{ mode }, ...] }
//   • chooseShippingPlan: elige el mejor modo válido. me2 si vendedor y
//     categoría lo admiten; si no, `not_specified` (a convenir) o `custom`
//     (costos propios). me1 nunca (el POS no lo maneja y casi ningún vendedor
//     lo tiene). Envío gratis sólo con me2.
//   • resolveShipping: ajusta lo que pidió el usuario a lo que se puede.
//   • excludedModesFromCauses: modos que ML rechazó en /items/validate, para
//     reintentar una vez con otro.
// =============================================================================

export type ShippingMode = "me2" | "custom" | "not_specified";

export interface ShippingCost {
  description: string;
  cost: number;
}

export interface ShippingInput {
  mode: ShippingMode;
  freeShipping?: boolean;
  localPickUp?: boolean;
  /** Sólo modo custom: hasta 10 costos fijos. */
  costs?: ShippingCost[];
}

export interface ShippingPlan {
  /** Modo recomendado. */
  mode: ShippingMode;
  /** Modos que se pueden ofrecer, en orden de preferencia. */
  allowed: ShippingMode[];
  freeShippingAllowed: boolean;
  /** Por qué se eligió ese modo (texto para el usuario). */
  reason: string;
  /** false si no se pudo consultar nada y el modo es una suposición. */
  known: boolean;
}

const ORDER: ShippingMode[] = ["me2", "not_specified", "custom"];

/** Modos que aparecen en una respuesta de ML (null si la respuesta no dice nada). */
export function modesFrom(raw: unknown): Set<string> | null {
  if (raw == null) return null;
  const out = new Set<string>();
  let recognized = false;
  const take = (v: unknown) => {
    if (typeof v === "string" && v.trim()) out.add(v.trim().toLowerCase());
    else if (v && typeof v === "object" && typeof (v as { mode?: unknown }).mode === "string") {
      out.add(String((v as { mode: string }).mode).toLowerCase());
    }
  };
  if (Array.isArray(raw)) {
    recognized = true;
    raw.forEach(take);
  } else if (typeof raw === "object") {
    const o = raw as { modes?: unknown; logistics?: unknown; shipping_modes?: unknown };
    for (const list of [o.modes, o.logistics, o.shipping_modes]) {
      if (Array.isArray(list)) {
        recognized = true;
        list.forEach(take);
      }
    }
  }
  return recognized ? out : null;
}

export interface ShippingSources {
  /** GET /users/{id}/shipping_preferences */
  user?: unknown;
  /** GET /categories/{id}/shipping_preferences (sólo lista logísticas de Mercado Envíos). */
  category?: unknown;
  /** GET /users/{id}/shipping_modes?category_id= (vendedor + categoría, la más precisa). */
  userCategory?: unknown;
  /** Modos que ML ya rechazó para esta publicación (ver excludedModesFromCauses). */
  excluded?: Iterable<ShippingMode>;
}

export const SHIPPING_REASONS = {
  me2: "Tu cuenta y la categoría admiten Mercado Envíos.",
  noMe2Category: "Esta categoría no admite Mercado Envíos: el envío lo acordás vos.",
  noMe2User: "Tu cuenta no tiene Mercado Envíos activo: el envío lo acordás vos.",
  noMe2Rejected: "Mercado Libre no aceptó Mercado Envíos para esta publicación: el envío lo acordás vos.",
  unknown: "No pudimos consultar los envíos de tu cuenta: se usa Mercado Envíos y, si Mercado Libre no lo acepta, se pasa solo a envío a convenir.",
} as const;

export function chooseShippingPlan(src: ShippingSources): ShippingPlan {
  const uc = modesFrom(src.userCategory);
  const userCat = uc && uc.size > 0 ? uc : null;
  const user = modesFrom(src.user);
  const userKnown = user && user.size > 0 ? user : null;
  const category = modesFrom(src.category);
  const excluded = new Set(src.excluded ?? []);

  const ok = (m: ShippingMode): boolean => {
    if (excluded.has(m)) return false;
    if (userCat) return userCat.has(m);
    if (m === "me2") return (userKnown ? userKnown.has("me2") : true) && (category ? category.has("me2") : true);
    // La categoría sólo lista Mercado Envíos: custom y a convenir dependen del vendedor.
    return userKnown ? userKnown.has(m) : true;
  };
  let allowed = ORDER.filter(ok);
  // Sin ningún modo válido (respuesta rara): a convenir es lo que menos falla.
  if (allowed.length === 0) allowed = ["not_specified"];
  const mode = allowed[0]!;
  const known = Boolean(userCat || userKnown || category);

  let reason: string;
  if (mode === "me2") reason = known ? SHIPPING_REASONS.me2 : SHIPPING_REASONS.unknown;
  else if (excluded.has("me2")) reason = SHIPPING_REASONS.noMe2Rejected;
  else if (userKnown && !userKnown.has("me2")) reason = SHIPPING_REASONS.noMe2User;
  else reason = SHIPPING_REASONS.noMe2Category;

  return { mode, allowed, freeShippingAllowed: allowed.includes("me2"), reason, known };
}

const validCosts = (costs: ShippingCost[] | undefined) =>
  (costs ?? []).filter((c) => c && String(c.description ?? "").trim() && Number.isFinite(Number(c.cost)) && Number(c.cost) >= 0);

/**
 * Ajusta el envío pedido a los modos válidos. `adjusted` explica el cambio
 * (null si no hubo). Envío gratis sólo con me2; custom sin costos pasa a
 * "a convenir" si se puede.
 */
export function resolveShipping(
  requested: ShippingInput | null | undefined,
  plan: ShippingPlan,
): { input: ShippingInput; adjusted: string | null } {
  const want: ShippingInput = requested ?? { mode: plan.mode };
  let mode: ShippingMode = plan.allowed.includes(want.mode) ? want.mode : plan.mode;
  if (mode === "custom" && validCosts(want.costs).length === 0 && plan.allowed.includes("not_specified")) mode = "not_specified";
  const freeShipping = mode === "me2" && Boolean(want.freeShipping);
  const input: ShippingInput = { mode, freeShipping, localPickUp: Boolean(want.localPickUp) };
  if (mode === "custom") input.costs = validCosts(want.costs).slice(0, 10);

  let adjusted: string | null = null;
  if (mode !== want.mode) adjusted = `Envío: se usa "${SHIPPING_MODE_LABELS[mode]}" en lugar de "${SHIPPING_MODE_LABELS[want.mode]}". ${plan.reason}`;
  else if (want.freeShipping && !freeShipping) adjusted = "El envío gratis sólo se puede ofrecer con Mercado Envíos: se sacó.";
  return { input, adjusted };
}

export const SHIPPING_MODE_LABELS: Record<ShippingMode, string> = {
  me2: "Mercado Envíos",
  custom: "Envío con costo fijo",
  not_specified: "Envío a convenir",
};

/** `shipping` de POST /items. */
export function shippingBody(input: ShippingInput): Record<string, unknown> {
  const local_pick_up = Boolean(input.localPickUp);
  if (input.mode === "me2") return { mode: "me2", local_pick_up, free_shipping: Boolean(input.freeShipping) };
  if (input.mode === "custom") {
    return {
      mode: "custom",
      local_pick_up,
      free_shipping: false,
      costs: validCosts(input.costs)
        .slice(0, 10)
        .map((c) => ({ description: String(c.description).trim().slice(0, 60), cost: Math.round(Number(c.cost) * 100) / 100 })),
    };
  }
  return { mode: "not_specified", local_pick_up, free_shipping: false };
}

export function validateShipping(input: ShippingInput | null | undefined): string[] {
  if (!input || input.mode !== "custom") return [];
  const costs = input.costs ?? [];
  if (validCosts(costs).length === 0) return ["Cargá al menos un costo de envío (descripción y monto) o elegí envío a convenir."];
  if (costs.length > 10) return ["Se pueden cargar hasta 10 costos de envío."];
  if (validCosts(costs).length !== costs.length) return ["Cada costo de envío necesita una descripción y un monto mayor o igual a cero."];
  return [];
}

/** Modos que ML rechazó en /items/validate (`shipping.lost_me2_by_catalog`, etc.). */
export function excludedModesFromCauses(causes: string[]): ShippingMode[] {
  const out = new Set<ShippingMode>();
  for (const c of causes ?? []) {
    const m = /shipping\.lost_(me2|custom|not_specified)/i.exec(c);
    if (m) out.add(m[1]!.toLowerCase() as ShippingMode);
  }
  return [...out];
}
