// Árbol de jerarquía de categorías (rubro > categoría > subcategoría...).
// Lógica PURA para el editor de ruta: partir la ruta del catálogo, sugerir el
// mapeo contra las categorías del negocio y reconstruir la ruta de una hoja.

export interface CategoryLike {
  id: string;
  name: string;
  parent_id: string | null;
}

/** Un nivel de la ruta: id de una categoría existente o null (se crea). */
export interface CategoryNode {
  id: string | null;
  name: string;
}

export const MAX_CATEGORY_DEPTH = 10;

const LEVEL_LABELS = ["Rubro", "Categoría", "Subcategoría"];
export function levelLabel(i: number): string {
  return LEVEL_LABELS[i] ?? `Nivel ${i + 1}`;
}

/** "Almacén > Desayuno > Café" → ["Almacén", "Desayuno", "Café"]. */
export function splitCategoryPath(path: string | null | undefined): string[] {
  if (!path) return [];
  return path
    .split(/\s*[>›/]\s*/)
    .map((s) => s.trim())
    .filter(Boolean)
    .slice(0, MAX_CATEGORY_DEPTH);
}

/** Comparación tolerante: sin mayúsculas, acentos ni espacios repetidos. */
export function sameName(a: string, b: string): boolean {
  const n = (s: string) =>
    s
      .normalize("NFD")
      .replace(/[̀-ͯ]/g, "")
      .replace(/\s+/g, " ")
      .trim()
      .toLowerCase();
  return n(a) === n(b);
}

export function childrenOf<T extends CategoryLike>(parentId: string | null, all: T[]): T[] {
  return all
    .filter((c) => (c.parent_id ?? null) === parentId)
    .sort((a, b) => a.name.localeCompare(b.name, "es"));
}

/**
 * Sugiere el mapeo de una ruta del catálogo a las categorías del negocio:
 * en cada nivel reusa la hija existente con el mismo nombre; si no existe, el
 * nodo (y todos los de abajo) quedan como nuevos.
 */
export function suggestCategoryNodes(segments: string[], all: CategoryLike[]): CategoryNode[] {
  const out: CategoryNode[] = [];
  let parent: string | null = null;
  let broken = false;
  for (const name of segments) {
    if (broken) {
      out.push({ id: null, name });
      continue;
    }
    const match: CategoryLike | undefined = childrenOf(parent, all).find((c) => sameName(c.name, name));
    if (match) {
      out.push({ id: match.id, name: match.name });
      parent = match.id;
    } else {
      out.push({ id: null, name });
      broken = true;
    }
  }
  return out;
}

/** Ruta (raíz → hoja) de una categoría existente. */
export function pathToCategory(id: string | null | undefined, all: CategoryLike[]): CategoryNode[] {
  if (!id) return [];
  const byId = new Map(all.map((c) => [c.id, c]));
  const out: CategoryNode[] = [];
  let cur = byId.get(id);
  let guard = 0;
  while (cur && guard < MAX_CATEGORY_DEPTH + 2) {
    out.unshift({ id: cur.id, name: cur.name });
    cur = cur.parent_id ? byId.get(cur.parent_id) : undefined;
    guard += 1;
  }
  return out;
}

/**
 * Normaliza la ruta editada: corta niveles vacíos y, si un nodo existente no
 * cuelga del padre resuelto (porque se cambió un nivel de arriba), lo pasa a
 * "nuevo" con el mismo nombre. Mantiene coherente lo que se manda al server.
 */
export function normalizeNodes(nodes: CategoryNode[], all: CategoryLike[]): CategoryNode[] {
  const byId = new Map(all.map((c) => [c.id, c]));
  const out: CategoryNode[] = [];
  let parent: string | null = null;
  let broken = false;
  for (const n of nodes) {
    const name = n.name.trim();
    if (!name && !n.id) continue;
    const existing = n.id ? byId.get(n.id) : undefined;
    if (!broken && existing && (existing.parent_id ?? null) === parent) {
      out.push({ id: existing.id, name: existing.name });
      parent = existing.id;
    } else {
      // Nodo nuevo: ¿hay una hermana con ese nombre? reusarla.
      const twin: CategoryLike | undefined = broken ? undefined : childrenOf(parent, all).find((c) => sameName(c.name, name));
      if (twin) {
        out.push({ id: twin.id, name: twin.name });
        parent = twin.id;
      } else {
        out.push({ id: null, name: name || existing?.name || "" });
        broken = true;
      }
    }
  }
  return out.slice(0, MAX_CATEGORY_DEPTH);
}

/** "Almacén › Desayuno › Café". */
export function formatCategoryPath(nodes: CategoryNode[]): string {
  return nodes.map((n) => n.name).filter(Boolean).join(" › ");
}
