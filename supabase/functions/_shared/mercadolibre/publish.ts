// =============================================================================
// _shared/mercadolibre/publish.ts (fix "publicar antibalas"). PURO (cliente
// inyectado): lo usa la Edge ml_api para validar y publicar, igual desde el
// modal individual y desde la publicación rápida, y lo cubren los tests con
// respuestas reales de ML.
//
//   • loadShippingSources: users/me (¿aceptó Mercado Envíos?), preferencias
//     del vendedor, de la categoría y modos por categoría. Cada GET puede
//     fallar solo; lo de la cuenta se memoriza unos minutos (TtlCache).
//   • validateForPublish: sanea atributos, ajusta el título (largo y palabras
//     prohibidas), elige el envío, chequea el tipo de publicación, valida en
//     /items/validate y reintenta UNA vez si ML pide sacar atributos o pierde
//     el modo de envío pedido (`shipping.lost_*`). Los avisos (`type:
//     warning`) no frenan: /items/validate da 400 aunque sólo haya avisos.
//   • postItemWithFixes: POST /items con el mismo reintento único.
// =============================================================================
import type { MlClient } from "./client.ts";
import { MlApiError } from "./client.ts";
import {
  attributesToDelete,
  buildItemBodies,
  fitTitle,
  sanitizeAttributes,
  stripAttributes,
  validatePublish,
  validationCauses,
  type AttrField,
  type ItemBody,
  type PublishInput,
} from "./items.ts";
import {
  chooseShippingPlan,
  excludedModesFromCauses,
  needsMeActivation,
  resolveShipping,
  shippingBody,
  type ShippingInput,
  type ShippingMode,
  type ShippingPlan,
  type ShippingSources,
} from "./shipping.ts";

export type PublishClient = Pick<MlClient, "get" | "request" | "post">;

/** Memo con vencimiento (promesas: dos pedidos simultáneos hacen un solo GET). */
export class TtlCache {
  private map = new Map<string, { at: number; value: Promise<unknown> }>();
  private ttlMs: number;
  private now: () => number;
  private max: number;
  constructor(ttlMs: number, now: () => number = Date.now, max = 500) {
    this.ttlMs = ttlMs;
    this.now = now;
    this.max = max;
  }
  get<T>(key: string, load: () => Promise<T>): Promise<T> {
    const hit = this.map.get(key);
    if (hit && this.now() - hit.at < this.ttlMs) return hit.value as Promise<T>;
    const value = load();
    if (this.map.size >= this.max) this.map.delete(this.map.keys().next().value!);
    this.map.set(key, { at: this.now(), value });
    // Un error no se memoriza: el próximo pedido vuelve a intentar.
    value.catch(() => this.map.delete(key));
    return value;
  }
  clear(prefix?: string) {
    for (const k of [...this.map.keys()]) if (!prefix || k.startsWith(prefix)) this.map.delete(k);
  }
}

/** Minutos que se memoriza lo de la cuenta (users/me y preferencias de envío). */
export const ACCOUNT_TTL_MS = 5 * 60_000;
export const CATEGORY_TTL_MS = 30 * 60_000;

export interface PublishCaches {
  account: TtlCache;
  category: TtlCache;
}
export const newPublishCaches = (now: () => number = Date.now): PublishCaches => ({
  account: new TtlCache(ACCOUNT_TTL_MS, now),
  category: new TtlCache(CATEGORY_TTL_MS, now),
});

const settled = async <T>(p: Promise<T>): Promise<T | undefined> => {
  try {
    return await p;
  } catch {
    return undefined;
  }
};

/** Lo que hace falta para elegir el envío (sólo GETs, cada uno puede fallar). */
export async function loadShippingSources(
  client: PublishClient,
  mlUserId: number,
  categoryId: string | null,
  caches: PublishCaches,
): Promise<ShippingSources> {
  const acct = `${mlUserId}`;
  const [me, user, category, userCategory] = await Promise.all([
    settled(caches.account.get(`${acct}:me`, () => client.get<unknown>("/users/me"))),
    settled(caches.account.get(`${acct}:prefs`, () => client.get<unknown>(`/users/${mlUserId}/shipping_preferences`))),
    categoryId
      ? settled(caches.category.get(`cat:${categoryId}:ship`, () => client.get<unknown>(`/categories/${encodeURIComponent(categoryId)}/shipping_preferences`)))
      : Promise.resolve(undefined),
    // Da 404 en muchas cuentas: se memoriza también la falta (undefined).
    categoryId
      ? settled(
          caches.account.get(`${acct}:modes:${categoryId}`, () =>
            client.get<unknown>(`/users/${mlUserId}/shipping_modes`, { category_id: categoryId }).catch(() => null),
          ),
        )
      : Promise.resolve(undefined),
  ]);
  return { me, user, category, userCategory: userCategory ?? undefined };
}

/** Tipos de publicación que la cuenta puede usar en la categoría (null = no se pudo saber). */
export async function availableListingTypes(
  client: PublishClient,
  mlUserId: number,
  categoryId: string,
  caches: PublishCaches,
): Promise<Set<string> | null> {
  const r = await settled(
    caches.account.get(`${mlUserId}:lt:${categoryId}`, () =>
      client.get<{ available?: Array<{ id: string; remaining_listings?: number | null }> }>(`/users/${mlUserId}/available_listing_types`, {
        category_id: categoryId,
      }),
    ),
  );
  if (!r || !Array.isArray(r.available)) return null;
  return new Set(r.available.filter((t) => t.remaining_listings == null || t.remaining_listings > 0).map((t) => t.id));
}

/** POST /items/validate de cada cuerpo: errores (código: mensaje) y avisos. */
export async function validateBodies(client: PublishClient, bodies: ItemBody[]): Promise<{ errors: string[]; warnings: string[] }> {
  const errors: string[] = [];
  const warnings: string[] = [];
  for (const it of bodies) {
    try {
      await client.request("POST", "/items/validate", { body: it.body });
    } catch (e) {
      if (e instanceof MlApiError && (e.code === "validation_error" || e.code === "bad_request")) {
        const c = validationCauses(e.body, e.causes.length ? e.causes : [e.message]);
        errors.push(...c.errors);
        warnings.push(...c.warnings);
      } else throw e;
    }
  }
  return promoteBlockingWarnings({ errors: [...new Set(errors)], warnings: [...new Set(warnings)] });
}

/**
 * Avisos que en la práctica frenan: ML los marca como warning pero la
 * publicación queda moderada (p. ej. `moderations.seller.not_authorized` en
 * Licores, leído el 15/10/2026). Se tratan como error.
 */
const BLOCKING_WARNING = /^(moderations\.|seller\.(not_authorized|restricted|blocked)|item\.category_id\.restricted)/i;
export function promoteBlockingWarnings(r: { errors: string[]; warnings: string[] }): { errors: string[]; warnings: string[] } {
  const promote = r.warnings.filter((w) => BLOCKING_WARNING.test(w));
  if (promote.length === 0) return r;
  return { errors: [...r.errors, ...promote], warnings: r.warnings.filter((w) => !BLOCKING_WARNING.test(w)) };
}

/** Modos de envío que ML dice haber perdido, de los que se pidieron. */
export const lostRequestedModes = (causes: string[], mode: ShippingMode | undefined) =>
  excludedModesFromCauses(causes).filter((m) => m === mode);

/** Ids de atributos (ATTR_ID) mencionados en las causas, con su nombre. */
export function attributeNames(fields: AttrField[], causes: string[]): Record<string, string> {
  const out: Record<string, string> = {};
  const byId = new Map(fields.map((f) => [f.id, f.name]));
  for (const c of causes) {
    for (const m of c.matchAll(/\[([A-Z0-9_,\s]+)\]/g)) {
      for (const id of m[1]!.split(",").map((s) => s.trim())) {
        const name = byId.get(id);
        if (name) out[id] = name;
      }
    }
  }
  return out;
}

export interface PublishContext {
  client: PublishClient;
  mlUserId: number;
  caches: PublishCaches;
}

export interface ValidateOutcome {
  ok: boolean;
  errors: string[];
  warnings: string[];
  notices: string[];
  plan: ShippingPlan;
  /** Input ya ajustado (atributos, título, envío): es el que se publica. */
  input: PublishInput;
  bodies: ItemBody[];
  requested: ShippingInput;
  removed: string[];
  attributeNames: Record<string, string>;
  /** La cuenta no tiene Mercado Envíos: mostrar cómo activarlo. */
  meActivation: boolean;
  /** Tipos de publicación disponibles en la categoría (null = no se supo). */
  listingTypes: Set<string> | null;
}

export const CATALOG_NOTICE =
  "Se publica como publicación propia (no compite en el catálogo de Mercado Libre) porque tu cuenta no tiene Mercado Envíos activo. Los datos del catálogo sí se usaron para completar la ficha.";

export function listingUnavailableError(listingTypeId: string): string {
  return `pos.listing_type_unavailable: [${listingTypeId}]`;
}

/**
 * Valida para publicar con todos los arreglos automáticos. No publica.
 * `maxTitleLength` sale de la categoría (la Edge la lee); si no, del input.
 */
export async function validateForPublish(
  ctx: PublishContext,
  raw: PublishInput,
  attrs: AttrField[],
  opts: { maxTitleLength?: number | null; catalogProductId?: string | null } = {},
): Promise<ValidateOutcome> {
  const input: PublishInput = { ...raw, attributes: { ...(raw.attributes ?? {}) } };
  const notices: string[] = [];

  // 1. Atributos que no aplican (GRADING con "Nuevo", ocultos, de solo lectura).
  const clean = sanitizeAttributes(input.attributes, attrs, input.condition);
  const removed = Object.keys(input.attributes).filter((id) => !(id in clean));
  input.attributes = clean;

  // 2. Título: largo de la categoría y palabras que ML no acepta.
  const max = Math.max(10, Number(opts.maxTitleLength ?? input.maxTitleLength ?? 60) || 60);
  input.maxTitleLength = max;
  const fitted = fitTitle(input.title, max);
  if (fitted.changed && fitted.title.length >= 3) {
    notices.push(
      input.title.trim().length > max
        ? `El título tenía ${input.title.trim().length} caracteres y la categoría admite ${max}: lo acortamos a "${fitted.title}".`
        : `Sacamos del título palabras que Mercado Libre no acepta (stock, ofertas, envío, cuotas): queda "${fitted.title}".`,
    );
    input.title = fitted.title;
  }

  // 3. Envío: el mejor modo que admiten la cuenta y la categoría.
  const requested: ShippingInput = input.shipping ?? { mode: "me2", freeShipping: Boolean(input.freeShipping) };
  const sources = await loadShippingSources(ctx.client, ctx.mlUserId, input.categoryId, ctx.caches);
  let plan = chooseShippingPlan(sources);
  let ship = resolveShipping(requested, plan);
  // Sin envío elegido (publicación rápida) no hubo "pedido": sólo el porqué.
  if (ship.adjusted) notices.push(raw.shipping ? ship.adjusted : plan.reason);
  input.shipping = ship.input;
  input.freeShipping = ship.input.freeShipping;
  if (opts.catalogProductId && plan.me2Blocker && needsMeActivation(plan)) notices.push(CATALOG_NOTICE);

  // 4. Tipo de publicación disponible para la cuenta en la categoría.
  const listingTypes = await availableListingTypes(ctx.client, ctx.mlUserId, input.categoryId, ctx.caches);

  const done = (r: { errors: string[]; warnings: string[] }, bodies: ItemBody[]): ValidateOutcome => {
    const all = [...r.errors, ...r.warnings];
    return {
      ok: r.errors.length === 0,
      errors: r.errors.slice(0, 30),
      warnings: r.warnings.slice(0, 10),
      notices,
      plan,
      input,
      bodies,
      requested,
      removed: [...new Set(removed)],
      attributeNames: attributeNames(attrs, all),
      meActivation: needsMeActivation(plan),
      listingTypes,
    };
  };

  const local = validatePublish(input, attrs);
  if (listingTypes && !listingTypes.has(input.listingTypeId)) local.push(listingUnavailableError(input.listingTypeId));
  if (local.length > 0) return done({ errors: local, warnings: [] }, []);

  let bodies = buildItemBodies(input, attrs);
  let res = await validateBodies(ctx.client, bodies);

  // 5. Un reintento: ML pide sacar atributos o pierde el modo de envío pedido
  //    (como error o como aviso: si lo pierde, publicaría con otro).
  const del = attributesToDelete(res.errors);
  const lost = lostRequestedModes([...res.errors, ...res.warnings], input.shipping?.mode);
  if (del.length > 0 || lost.length > 0) {
    if (del.length > 0) {
      bodies = stripAttributes(bodies, del);
      for (const id of del) delete input.attributes[id];
      removed.push(...del);
      const names = del.map((id) => `"${attrs.find((f) => f.id === id)?.name ?? id}"`).join(", ");
      notices.push(`Sacamos ${names}: Mercado Libre no lo acepta para esta categoría y condición.`);
    }
    if (lost.length > 0) {
      plan = chooseShippingPlan({ ...sources, excluded: lost });
      ship = resolveShipping({ ...requested, mode: plan.mode }, plan);
      input.shipping = ship.input;
      input.freeShipping = ship.input.freeShipping;
      bodies = bodies.map((it) => ({ ...it, body: { ...it.body, shipping: shippingBody(ship.input) } }));
      notices.push(`Mercado Libre no aceptó ese envío. ${plan.reason}`);
    }
    res = await validateBodies(ctx.client, bodies);
  }
  return done(res, bodies);
}

export type PostResult<T> = { ok: true; item: T; notices: string[] } | { ok: false; errors: string[]; meActivation: boolean };

/**
 * POST /items con un reintento si ML pide sacar atributos o pierde el modo de
 * envío pedido. `replan` da el envío alternativo (o null si no hay).
 */
export async function postItemWithFixes<T = unknown>(
  client: PublishClient,
  body: Record<string, unknown>,
  replan: (lost: ShippingMode[]) => ShippingInput | null,
): Promise<PostResult<T>> {
  const notices: string[] = [];
  let current = body;
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const item = await client.post<T>("/items", current);
      return { ok: true, item, notices };
    } catch (e) {
      if (!(e instanceof MlApiError) || e.retryable) throw e;
      const c = validationCauses(e.body, e.causes.length ? e.causes : [e.message]);
      const errors = c.errors.length ? c.errors : [e.message];
      const mode = (current.shipping as { mode?: ShippingMode } | undefined)?.mode;
      const del = attributesToDelete(errors);
      const lost = lostRequestedModes(errors, mode);
      const alt = lost.length > 0 ? replan(lost) : null;
      if (attempt === 0 && (del.length > 0 || alt)) {
        let next = del.length > 0 ? stripAttributes([{ variantKey: null, body: current }], del)[0]!.body : current;
        if (alt) {
          next = { ...next, shipping: shippingBody(alt) };
          notices.push(`Mercado Libre no aceptó ese envío: se publicó con "${alt.mode === "custom" ? "envío con costo fijo" : "envío a convenir"}".`);
        }
        current = next;
        continue;
      }
      return { ok: false, errors: errors.slice(0, 10), meActivation: errors.some((x) => /^shipping\./i.test(x)) };
    }
  }
  return { ok: false, errors: ["No se pudo publicar."], meActivation: false };
}
