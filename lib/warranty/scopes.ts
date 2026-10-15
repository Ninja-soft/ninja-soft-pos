// Editor de alcance de un tipo de garantía (ADR-139). Lógica PURA del árbol
// de categorías con herencia hacia abajo: cada categoría hereda el estado de
// su padre (la raíz, el de "todos los productos") salvo que tenga uno propio.
// Tocar una categoría invierte su estado efectivo; las marcas propias que
// quedan iguales a lo heredado se limpian solas, así lo guardado es mínimo.

import type { CategoryNodeLike, ScopeEffect, WarrantyScopeLike } from "./pricing";

export interface ScopeDraft {
  /** true = todos los productos salvo exclusiones. */
  appliesToAll: boolean;
  /** Marca propia por categoría. */
  categories: Record<string, ScopeEffect>;
  /** Marca propia por producto (gana siempre). */
  products: Record<string, ScopeEffect>;
}

export interface ScopeRowInput {
  category_id?: string;
  product_id?: string;
  effect: ScopeEffect;
}

export function emptyDraft(appliesToAll = true): ScopeDraft {
  return { appliesToAll, categories: {}, products: {} };
}

export function draftFromScopes(planId: string | null, appliesToAll: boolean, scopes: WarrantyScopeLike[]): ScopeDraft {
  const d = emptyDraft(appliesToAll);
  for (const s of scopes) {
    if (s.deleted_at || (planId && s.plan_id !== planId)) continue;
    if (s.category_id) d.categories[s.category_id] = s.effect;
    else if (s.product_id) d.products[s.product_id] = s.effect;
  }
  return d;
}

export function draftToRows(d: ScopeDraft): ScopeRowInput[] {
  return [
    ...Object.entries(d.categories).map(([category_id, effect]) => ({ category_id, effect })),
    ...Object.entries(d.products).map(([product_id, effect]) => ({ product_id, effect })),
  ];
}

function liveIndex(categories: CategoryNodeLike[]) {
  const live = categories.filter((c) => !c.deleted_at);
  const byId = new Map(live.map((c) => [c.id, c]));
  const kids = new Map<string | null, CategoryNodeLike[]>();
  for (const c of live) {
    const p = c.parent_id && byId.has(c.parent_id) ? c.parent_id : null;
    const list = kids.get(p) ?? [];
    list.push(c);
    kids.set(p, list);
  }
  return { byId, kids };
}

/** Estado heredado por una categoría (el efectivo de su padre, o el general). */
export function inheritedOn(d: ScopeDraft, id: string, categories: CategoryNodeLike[]): boolean {
  const { byId } = liveIndex(categories);
  let cur = byId.get(id);
  let guard = 0;
  while (cur && cur.parent_id && guard < 20) {
    const parent = byId.get(cur.parent_id);
    if (!parent) break;
    const own = d.categories[parent.id];
    if (own) return own === "include";
    cur = parent;
    guard += 1;
  }
  return d.appliesToAll;
}

/** Estado efectivo de una categoría: su marca propia o lo heredado. */
export function categoryOn(d: ScopeDraft, id: string, categories: CategoryNodeLike[]): boolean {
  const own = d.categories[id];
  return own ? own === "include" : inheritedOn(d, id, categories);
}

/** ¿Alguna descendiente difiere de la categoría? (checkbox "indeterminado"). */
export function categoryMixed(d: ScopeDraft, id: string, categories: CategoryNodeLike[]): boolean {
  const { kids } = liveIndex(categories);
  const on = categoryOn(d, id, categories);
  const stack = [...(kids.get(id) ?? [])];
  let guard = 0;
  while (stack.length > 0 && guard < 5000) {
    guard += 1;
    const c = stack.pop()!;
    if (d.categories[c.id] && (d.categories[c.id] === "include") !== on) return true;
    stack.push(...(kids.get(c.id) ?? []));
  }
  return false;
}

/** Quita las marcas propias que repiten lo heredado (de arriba hacia abajo). */
export function normalizeDraft(d: ScopeDraft, categories: CategoryNodeLike[]): ScopeDraft {
  const { byId, kids } = liveIndex(categories);
  const next: Record<string, ScopeEffect> = {};
  const walk = (parentId: string | null, inherited: boolean, depth: number) => {
    if (depth > 20) return;
    for (const c of kids.get(parentId) ?? []) {
      const own = d.categories[c.id];
      const on = own ? own === "include" : inherited;
      if (own && on !== inherited) next[c.id] = own;
      walk(c.id, on, depth + 1);
    }
  };
  walk(null, d.appliesToAll, 0);
  // Marcas de categorías que ya no existen (o están borradas) se descartan.
  for (const id of Object.keys(next)) if (!byId.has(id)) delete next[id];
  return { ...d, categories: next };
}

/** Invierte el estado efectivo de una categoría (y limpia lo redundante). */
export function toggleCategory(d: ScopeDraft, id: string, categories: CategoryNodeLike[]): ScopeDraft {
  const on = categoryOn(d, id, categories);
  const cats = { ...d.categories };
  delete cats[id];
  const next = { ...d, categories: cats };
  if (inheritedOn(next, id, categories) === on) {
    // Lo heredado es lo de antes: hace falta una marca propia al revés.
    cats[id] = on ? "exclude" : "include";
  }
  return normalizeDraft({ ...next, categories: cats }, categories);
}

/** Cambia "todos los productos" / "sólo lo elegido" sin perder las marcas útiles. */
export function setAppliesToAll(d: ScopeDraft, all: boolean, categories: CategoryNodeLike[]): ScopeDraft {
  return normalizeDraft({ ...d, appliesToAll: all }, categories);
}

export function setProductScope(d: ScopeDraft, productId: string, effect: ScopeEffect | null): ScopeDraft {
  const products = { ...d.products };
  if (effect) products[productId] = effect;
  else delete products[productId];
  return { ...d, products };
}

export interface ScopeSummary {
  included: string[];
  excluded: string[];
  productsIncluded: number;
  productsExcluded: number;
}

/** Categorías con marca propia (ids), para los chips de la tarjeta. */
export function summarizeDraft(d: ScopeDraft): ScopeSummary {
  const included: string[] = [];
  const excluded: string[] = [];
  for (const [id, e] of Object.entries(d.categories)) (e === "include" ? included : excluded).push(id);
  const pv = Object.values(d.products);
  return {
    included,
    excluded,
    productsIncluded: pv.filter((e) => e === "include").length,
    productsExcluded: pv.filter((e) => e === "exclude").length,
  };
}

/** Árbol para pintar: nodos con profundidad, filtrado por texto (con sus ancestros). */
export interface TreeRow {
  id: string;
  name: string;
  depth: number;
  hasChildren: boolean;
}

export function flattenTree(
  categories: CategoryNodeLike[],
  opts: { query?: string; collapsed?: Set<string> } = {},
): TreeRow[] {
  const { byId, kids } = liveIndex(categories);
  const q = norm(opts.query ?? "");
  let keep: Set<string> | null = null;
  if (q) {
    keep = new Set<string>();
    for (const c of byId.values()) {
      if (!norm(c.name ?? "").includes(q)) continue;
      let cur: CategoryNodeLike | undefined = c;
      let guard = 0;
      while (cur && guard < 20) {
        keep.add(cur.id);
        cur = cur.parent_id ? byId.get(cur.parent_id) : undefined;
        guard += 1;
      }
    }
  }
  const out: TreeRow[] = [];
  const walk = (parentId: string | null, depth: number) => {
    if (depth > 20) return;
    const list = [...(kids.get(parentId) ?? [])].sort((a, b) => (a.name ?? "").localeCompare(b.name ?? "", "es"));
    for (const c of list) {
      if (keep && !keep.has(c.id)) continue;
      const children = kids.get(c.id) ?? [];
      out.push({ id: c.id, name: c.name ?? "", depth, hasChildren: children.length > 0 });
      // Buscando, todo abierto; si no, respeta lo colapsado.
      if (keep || !opts.collapsed?.has(c.id)) walk(c.id, depth + 1);
    }
  };
  walk(null, 0);
  return out;
}

function norm(s: string): string {
  return s
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .trim();
}
