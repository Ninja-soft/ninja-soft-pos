// Menú lateral personalizable por usuario (ADR-134). Lógica pura, sin React:
// - el orden guardado se mezcla con el menú por defecto de la versión actual
//   (los ítems nuevos aparecen en su lugar, los que ya no existen se descartan);
// - los ítems que el usuario no puede ver (permisos, plan, toggles del negocio)
//   se filtran al mostrar, pero conservan su lugar en el orden guardado;
// - movimientos de teclado (un lugar arriba o abajo, cruzando grupos y entrando
//   o saliendo de "Ocultos").
//
// "Inicio" no forma parte del layout: queda siempre primero. El grupo
// `TOP_GROUP` (sin título) queda siempre arriba de los grupos con título.

export const TOP_GROUP = "inicio";
export const HIDDEN_ID = "ocultos";
export const LAYOUT_VERSION = 1;

export interface MenuGroupLayout {
  id: string;
  items: string[];
}

export interface MenuLayout {
  v: number;
  groups: MenuGroupLayout[];
  hidden: string[];
}

/** Menú por defecto: grupos en orden, cada uno con sus ítems (ids = href). */
export interface MenuDefaults {
  groups: MenuGroupLayout[];
}

function clone(l: MenuLayout): MenuLayout {
  return { v: l.v, groups: l.groups.map((g) => ({ id: g.id, items: [...g.items] })), hidden: [...l.hidden] };
}

export function defaultLayout(defaults: MenuDefaults): MenuLayout {
  return { v: LAYOUT_VERSION, groups: defaults.groups.map((g) => ({ id: g.id, items: [...g.items] })), hidden: [] };
}

/** Valida la forma de lo guardado en users.settings. null si no sirve. */
export function sanitizeLayout(raw: unknown): MenuLayout | null {
  if (!raw || typeof raw !== "object") return null;
  const r = raw as { v?: unknown; groups?: unknown; hidden?: unknown };
  if (!Array.isArray(r.groups)) return null;
  const strings = (a: unknown): string[] =>
    Array.isArray(a) ? a.filter((x): x is string => typeof x === "string" && x.length > 0 && x.length < 200) : [];
  const groups: MenuGroupLayout[] = [];
  for (const g of r.groups) {
    if (!g || typeof g !== "object") continue;
    const id = (g as { id?: unknown }).id;
    if (typeof id !== "string" || !id) continue;
    groups.push({ id, items: strings((g as { items?: unknown }).items) });
  }
  return { v: typeof r.v === "number" ? r.v : LAYOUT_VERSION, groups, hidden: strings(r.hidden) };
}

/**
 * Mezcla el orden guardado con el menú por defecto. Resultado: cada ítem y cada
 * grupo del menú actual aparece exactamente una vez.
 * - Grupos y ítems desconocidos (de versiones viejas) se descartan.
 * - Duplicados: gana la primera aparición.
 * - Grupos nuevos: después del grupo que los precede en el menú por defecto.
 * - Ítems nuevos: en su grupo por defecto, después del hermano anterior (o antes
 *   del siguiente) si está en ese grupo; si no, al final.
 */
export function mergeLayout(defaults: MenuDefaults, saved: MenuLayout | null): MenuLayout {
  if (!saved) return defaultLayout(defaults);
  const knownGroups = new Set(defaults.groups.map((g) => g.id));
  const knownItems = new Set(defaults.groups.flatMap((g) => g.items));
  const seenItems = new Set<string>();
  const seenGroups = new Set<string>();
  const take = (ids: string[]) =>
    ids.filter((id) => {
      if (!knownItems.has(id) || seenItems.has(id)) return false;
      seenItems.add(id);
      return true;
    });

  const groups: MenuGroupLayout[] = [];
  for (const g of saved.groups) {
    if (!knownGroups.has(g.id) || seenGroups.has(g.id)) continue;
    seenGroups.add(g.id);
    groups.push({ id: g.id, items: take(g.items) });
  }
  const hidden = take(saved.hidden);

  // El grupo sin título siempre arriba.
  const topIdx = groups.findIndex((g) => g.id === TOP_GROUP);
  if (topIdx > 0) groups.unshift(...groups.splice(topIdx, 1));

  // Grupos que faltan, en su lugar por defecto.
  defaults.groups.forEach((dg, i) => {
    if (seenGroups.has(dg.id)) return;
    seenGroups.add(dg.id);
    let at = 0;
    for (let j = i - 1; j >= 0; j--) {
      const k = groups.findIndex((g) => g.id === defaults.groups[j]?.id);
      if (k >= 0) {
        at = k + 1;
        break;
      }
    }
    groups.splice(at, 0, { id: dg.id, items: [] });
  });

  // Ítems que faltan, en su grupo por defecto.
  for (const dg of defaults.groups) {
    const target = groups.find((g) => g.id === dg.id)!;
    dg.items.forEach((id, i) => {
      if (seenItems.has(id)) return;
      seenItems.add(id);
      let at = -1;
      for (let j = i - 1; j >= 0 && at < 0; j--) {
        const k = target.items.indexOf(dg.items[j] ?? "");
        if (k >= 0) at = k + 1;
      }
      for (let j = i + 1; j < dg.items.length && at < 0; j++) {
        const k = target.items.indexOf(dg.items[j] ?? "");
        if (k >= 0) at = k;
      }
      if (at < 0) at = target.items.length;
      target.items.splice(at, 0, id);
    });
  }

  return { v: LAYOUT_VERSION, groups, hidden };
}

/** Lo que el usuario puede ver: mismos grupos (aunque queden vacíos), sin los ítems filtrados. */
export function visibleLayout(full: MenuLayout, isVisible: (id: string) => boolean): MenuLayout {
  return {
    v: full.v,
    groups: full.groups.map((g) => ({ id: g.id, items: g.items.filter(isVisible) })),
    hidden: full.hidden.filter(isVisible),
  };
}

function reinsert(original: string[], edited: string[], visible: Set<string>, placed: Set<string>): string[] {
  // Invisibles agrupados por el visible que tenían adelante (null = al principio).
  const byAnchor = new Map<string | null, string[]>();
  let anchor: string | null = null;
  for (const id of original) {
    if (visible.has(id)) {
      anchor = id;
      continue;
    }
    if (placed.has(id)) continue;
    placed.add(id);
    byAnchor.set(anchor, [...(byAnchor.get(anchor) ?? []), id]);
  }
  const out: string[] = [...(byAnchor.get(null) ?? [])];
  byAnchor.delete(null);
  for (const id of edited) {
    out.push(id);
    const tail = byAnchor.get(id);
    if (tail) {
      out.push(...tail);
      byAnchor.delete(id);
    }
  }
  // El ancla se fue a otro contenedor: quedan al final.
  for (const rest of byAnchor.values()) out.push(...rest);
  return out;
}

/**
 * Aplica lo editado (sólo con ítems visibles) sobre el layout completo: los
 * ítems invisibles quedan en su contenedor, detrás del visible que tenían antes.
 */
export function applyVisible(full: MenuLayout, edited: MenuLayout, isVisible: (id: string) => boolean): MenuLayout {
  const visible = new Set<string>();
  for (const g of edited.groups) g.items.forEach((id) => visible.add(id));
  edited.hidden.forEach((id) => visible.add(id));
  // Un ítem que el usuario ve pero no vino en lo editado (no debería pasar):
  // sigue como invisible para no perderlo.
  const isEditedVisible = (id: string) => visible.has(id) && isVisible(id);
  const vis = new Set([...visible].filter(isEditedVisible));
  const placed = new Set<string>();
  const byId = new Map(full.groups.map((g) => [g.id, g.items]));
  const groups = edited.groups.map((g) => ({
    id: g.id,
    items: reinsert(byId.get(g.id) ?? [], g.items.filter((id) => vis.has(id)), vis, placed),
  }));
  // Grupos del layout completo que no vinieron en lo editado: al final.
  for (const g of full.groups) {
    if (!groups.some((x) => x.id === g.id)) groups.push({ id: g.id, items: g.items.filter((id) => !vis.has(id)) });
  }
  const hidden = reinsert(full.hidden, edited.hidden.filter((id) => vis.has(id)), vis, placed);
  return { v: LAYOUT_VERSION, groups, hidden };
}

// ---------------------------------------------------------------------------
// Movimientos (teclado y helpers del arrastre)
// ---------------------------------------------------------------------------

/** Contenedores en orden de lectura: grupos y al final "Ocultos". */
export function containers(l: MenuLayout): { id: string; items: string[] }[] {
  return [...l.groups, { id: HIDDEN_ID, items: l.hidden }];
}

export function findContainer(l: MenuLayout, itemId: string): string | null {
  for (const c of containers(l)) if (c.items.includes(itemId)) return c.id;
  return null;
}

function withContainer(l: MenuLayout, id: string, items: string[]): MenuLayout {
  if (id === HIDDEN_ID) return { ...l, hidden: items };
  return { ...l, groups: l.groups.map((g) => (g.id === id ? { ...g, items } : g)) };
}

/** Pone `itemId` en `toContainer` en la posición `index` (lo saca de donde esté). */
export function placeItem(l: MenuLayout, itemId: string, toContainer: string, index: number): MenuLayout {
  const from = findContainer(l, itemId);
  if (!from) return l;
  let next = clone(l);
  const fromItems = containers(next).find((c) => c.id === from)!.items.filter((x) => x !== itemId);
  next = withContainer(next, from, fromItems);
  const toItems = [...(containers(next).find((c) => c.id === toContainer)?.items ?? [])];
  const at = Math.max(0, Math.min(index, toItems.length));
  toItems.splice(at, 0, itemId);
  return withContainer(next, toContainer, toItems);
}

/**
 * Mueve un ítem un lugar (dir -1 arriba, +1 abajo) en el recorrido de lectura.
 * Al llegar al borde de su grupo pasa al grupo vecino (al final del de arriba o
 * al principio del de abajo), incluido "Ocultos". Devuelve el mismo objeto si
 * no se puede mover.
 */
export function moveItemBy(l: MenuLayout, itemId: string, dir: -1 | 1): MenuLayout {
  const cs = containers(l);
  const ci = cs.findIndex((c) => c.items.includes(itemId));
  const cur = cs[ci];
  if (!cur) return l;
  const target = cur.items.indexOf(itemId) + dir;
  if (target >= 0 && target < cur.items.length) return placeItem(l, itemId, cur.id, target);
  const nb = cs[ci + dir];
  if (!nb) return l;
  return placeItem(l, itemId, nb.id, dir < 0 ? nb.items.length : 0);
}

/** Saca un ítem a "Ocultos" (al final) o lo devuelve a su grupo por defecto. */
export function toggleHidden(l: MenuLayout, itemId: string, defaults: MenuDefaults): MenuLayout {
  const from = findContainer(l, itemId);
  if (!from) return l;
  if (from !== HIDDEN_ID) return placeItem(l, itemId, HIDDEN_ID, l.hidden.length);
  const home = defaults.groups.find((g) => g.items.includes(itemId))?.id ?? l.groups[0]?.id;
  if (!home) return l;
  const target = l.groups.find((g) => g.id === home)!;
  return placeItem(l, itemId, home, target.items.length);
}

/** Mueve un grupo con título un lugar. El grupo sin título no se mueve ni se pasa. */
export function moveGroupBy(l: MenuLayout, groupId: string, dir: -1 | 1): MenuLayout {
  if (groupId === TOP_GROUP) return l;
  const i = l.groups.findIndex((g) => g.id === groupId);
  const a = l.groups[i];
  const b = l.groups[i + dir];
  if (!a || !b || b.id === TOP_GROUP) return l;
  const groups = [...l.groups];
  groups[i] = b;
  groups[i + dir] = a;
  return { ...l, groups };
}

/** Reordena grupos con el arrastre (el grupo sin título queda primero). */
export function placeGroup(l: MenuLayout, groupId: string, index: number): MenuLayout {
  if (groupId === TOP_GROUP) return l;
  const groups = l.groups.filter((g) => g.id !== groupId);
  const moving = l.groups.find((g) => g.id === groupId);
  if (!moving) return l;
  const min = groups[0]?.id === TOP_GROUP ? 1 : 0;
  groups.splice(Math.max(min, Math.min(index, groups.length)), 0, moving);
  return { ...l, groups };
}

/** Igual al menú por defecto (para no guardar nada y mostrar "Restablecer" apagado). */
export function isDefault(l: MenuLayout, defaults: MenuDefaults): boolean {
  const d = defaultLayout(defaults);
  return JSON.stringify({ g: l.groups, h: l.hidden }) === JSON.stringify({ g: d.groups, h: d.hidden });
}

export function sameLayout(a: MenuLayout, b: MenuLayout): boolean {
  return JSON.stringify({ g: a.groups, h: a.hidden }) === JSON.stringify({ g: b.groups, h: b.hidden });
}
