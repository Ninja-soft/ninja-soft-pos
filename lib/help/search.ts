// Buscador y filtros de la ayuda contextual (F15 · H72 · ADR-086).
// Lógica pura: sin React ni Supabase, para testear el ranking.
//
//  * normalize: minúsculas, sin tildes ni signos.
//  * Sinónimos simples por grupos ("anular" = "cancelar venta" = "borrar ticket").
//  * Puntaje por campo (título > frases de búsqueda > etiquetas > resumen > pasos)
//    multiplicado por la proporción de palabras de la consulta que encontró.
//  * Rol: un artículo que no es para el rol actual no aparece.
//  * Pantalla: lo de la ruta actual suma puntos y arma "En esta pantalla".
import type { HelpArticle, HelpRole } from "./types";

const STOPWORDS = new Set([
  "a", "al", "como", "con", "de", "del", "el", "en", "es", "hacer", "hago", "la", "las", "lo", "los",
  "me", "mi", "mis", "para", "por", "puedo", "que", "se", "su", "sus", "un", "una", "uno", "y", "o",
  "quiero", "necesito", "donde", "cual", "cuando", "esta", "este", "le", "les", "tengo", "hay", "si", "no",
]);

export function normalize(s: string): string {
  return s
    .toLowerCase()
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/[^a-z0-9ñ]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/** Raíz simple: saca plurales y la terminación más común ("ventas" -> "venta", "devoluciones" -> "devolucion"). */
export function stem(token: string): string {
  if (token.length > 5 && token.endsWith("ciones")) return token.slice(0, -2);
  if (token.length > 4 && token.endsWith("es") && /[lndz]es$/.test(token)) return token.slice(0, -2);
  if (token.length > 3 && token.endsWith("s")) return token.slice(0, -1);
  return token;
}

export function tokenize(s: string): string[] {
  return normalize(s)
    .split(" ")
    .filter((t) => t.length > 1 && !STOPWORDS.has(t))
    .map(stem);
}

export type SynonymGroups = readonly (readonly string[])[];

/**
 * Términos extra que aporta un grupo de sinónimos cuando la consulta contiene
 * alguna de sus frases (frase completa) o alguna de sus palabras sueltas.
 */
export function expandQuery(query: string, synonyms: SynonymGroups): string[] {
  const q = ` ${normalize(query)} `;
  const qTokens = new Set(tokenize(query));
  const extra = new Set<string>();
  for (const group of synonyms) {
    const hit = group.some((phrase) => {
      const p = normalize(phrase);
      if (!p) return false;
      if (q.includes(` ${p} `)) return true;
      const pt = tokenize(phrase);
      return pt.length === 1 && qTokens.has(pt[0]!);
    });
    if (!hit) continue;
    for (const phrase of group) for (const t of tokenize(phrase)) extra.add(t);
  }
  for (const t of qTokens) extra.delete(t);
  return [...extra];
}

/** La ruta del artículo aplica a la pantalla actual (mismo path o subruta). */
export function routeMatches(articleRoute: string, pathname: string | null | undefined): boolean {
  if (!pathname) return false;
  const path = pathname.split("?")[0]!.replace(/\/+$/, "") || "/";
  const r = articleRoute.replace(/\/+$/, "") || "/";
  if (r === "/") return path === "/";
  return path === r || path.startsWith(`${r}/`);
}

/** El artículo es para este rol. Rol desconocido (cargando, staff) ve todo. */
export function visibleForRole(article: Pick<HelpArticle, "roles">, role: HelpRole | null | undefined): boolean {
  if (!role) return true;
  return article.roles.includes(role);
}

/** Largo de la ruta más específica del artículo que aplica a la pantalla (0 si ninguna). */
function routeSpecificity(article: Pick<HelpArticle, "routes">, pathname: string | null | undefined): number {
  let best = 0;
  for (const r of article.routes) if (routeMatches(r, pathname)) best = Math.max(best, r.length);
  return best;
}

/** Artículos de la pantalla actual para el rol, del más específico al más general. */
export function articlesForContext(
  articles: readonly HelpArticle[],
  pathname: string | null | undefined,
  role: HelpRole | null | undefined,
): HelpArticle[] {
  return articles
    .map((a, i) => ({ a, i, s: routeSpecificity(a, pathname) }))
    .filter((x) => x.s > 0 && visibleForRole(x.a, role))
    .sort((x, y) => y.s - x.s || x.i - y.i)
    .map((x) => x.a);
}

interface Indexed {
  title: Set<string>;
  keywords: Set<string>;
  tags: Set<string>;
  summary: Set<string>;
  body: Set<string>;
}

const indexCache = new WeakMap<HelpArticle, Indexed>();

function indexOf(a: HelpArticle): Indexed {
  const hit = indexCache.get(a);
  if (hit) return hit;
  const idx: Indexed = {
    title: new Set(tokenize(a.title)),
    keywords: new Set(a.keywords.flatMap(tokenize)),
    tags: new Set([...a.tags, a.module].flatMap(tokenize)),
    summary: new Set(tokenize(a.summary)),
    body: new Set(
      [...a.steps, ...a.tips, ...a.errors.flatMap((e) => [e.problem, e.fix]), ...Object.values(a.roleNotes)].flatMap(
        tokenize,
      ),
    ),
  };
  indexCache.set(a, idx);
  return idx;
}

function has(set: Set<string>, term: string): boolean {
  if (set.has(term)) return true;
  if (term.length < 4) return false;
  for (const t of set) {
    if (t.startsWith(term)) return true;
    // "proveedore" (de "proveedores") encuentra "proveedor".
    if (t.length >= 5 && term.startsWith(t) && term.length - t.length <= 2) return true;
  }
  return false;
}

const WEIGHTS = { title: 6, keywords: 4, tags: 3, summary: 2, body: 1 } as const;

function termScore(idx: Indexed, term: string): number {
  let best = 0;
  for (const field of Object.keys(WEIGHTS) as (keyof typeof WEIGHTS)[]) {
    if (has(idx[field], term)) best = Math.max(best, WEIGHTS[field]);
  }
  return best;
}

export interface SearchOptions {
  role?: HelpRole | null;
  pathname?: string | null;
  synonyms?: SynonymGroups;
  limit?: number;
}

export interface SearchHit {
  article: HelpArticle;
  score: number;
  /** Aplica a la pantalla actual. */
  here: boolean;
}

export function searchArticles(
  articles: readonly HelpArticle[],
  query: string,
  opts: SearchOptions = {},
): SearchHit[] {
  const terms = [...new Set(tokenize(query))];
  if (terms.length === 0) return [];
  const extra = expandQuery(query, opts.synonyms ?? []);
  const nq = normalize(query);
  const hits: SearchHit[] = [];

  for (const article of articles) {
    if (!visibleForRole(article, opts.role)) continue;
    const idx = indexOf(article);
    let base = 0;
    let matched = 0;
    for (const t of terms) {
      const s = termScore(idx, t);
      if (s > 0) {
        matched += 1;
        base += s;
      }
    }
    let syn = 0;
    for (const t of extra) syn += termScore(idx, t) * 0.6;
    // Una palabra de la consulta que no está en ningún lado puede estar cubierta
    // por un sinónimo ("cancelar" encuentra "anular").
    const coverage = Math.min(1, (matched + (syn > 0 ? 1 : 0)) / terms.length);
    if (base + syn === 0 || coverage === 0) continue;
    let score = (base + syn) * coverage;
    if (normalize(article.title).includes(nq)) score += 8;
    else if (article.keywords.some((k) => normalize(k) === nq)) score += 6;
    const here = routeSpecificity(article, opts.pathname) > 0;
    if (here) score += 3;
    hits.push({ article, score: Math.round(score * 100) / 100, here });
  }

  hits.sort((a, b) => b.score - a.score || a.article.title.localeCompare(b.article.title, "es"));
  return typeof opts.limit === "number" ? hits.slice(0, opts.limit) : hits;
}

/** Nota del artículo para el rol de quien lee (o null). */
export function roleNoteFor(article: HelpArticle, role: HelpRole | null | undefined): string | null {
  if (!role) return null;
  return article.roleNotes[role] ?? null;
}

/** Artículos relacionados existentes y visibles para el rol. */
export function relatedArticles(
  article: HelpArticle,
  all: readonly HelpArticle[],
  role: HelpRole | null | undefined,
): HelpArticle[] {
  const byId = new Map(all.map((a) => [a.id, a]));
  return article.related
    .map((id) => byId.get(id))
    .filter((a): a is HelpArticle => Boolean(a) && visibleForRole(a!, role));
}
