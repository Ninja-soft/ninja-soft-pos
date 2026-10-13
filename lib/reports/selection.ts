// Selección múltiple y acciones en lote de la conciliación. Puro (sin React ni
// red): lo usan la pantalla y los tests.
//
//  * La selección es un Set de ids. Las funciones nunca mutan el Set recibido.
//  * Las acciones en lote parten los ids en tandas, las corren con una
//    concurrencia acotada, informan el avance y devuelven qué falló (sin
//    cortar en el primer error): el dueño ve "Se conciliaron 180 de 200".

export type SelectionState = "all" | "some" | "none";

/** Prende o apaga un conjunto de ids en la selección. */
export function setIds(selected: ReadonlySet<string>, ids: readonly string[], on: boolean): Set<string> {
  const next = new Set(selected);
  for (const id of ids) {
    if (on) next.add(id);
    else next.delete(id);
  }
  return next;
}

/** Estado del checkbox de un grupo (lote, día, filtro). */
export function selectionState(selected: ReadonlySet<string>, ids: readonly string[]): SelectionState {
  if (ids.length === 0) return "none";
  let n = 0;
  for (const id of ids) if (selected.has(id)) n++;
  return n === 0 ? "none" : n === ids.length ? "all" : "some";
}

/** Click en el checkbox de un grupo: si está todo, lo saca; si no, lo completa. */
export function toggleGroup(selected: ReadonlySet<string>, ids: readonly string[]): Set<string> {
  return setIds(selected, ids, selectionState(selected, ids) !== "all");
}

/** Deja sólo los ids que siguen visibles (cambio de filtro o de período). */
export function pruneSelection(selected: ReadonlySet<string>, visible: readonly string[]): Set<string> {
  const keep = new Set(visible);
  const next = new Set<string>();
  for (const id of selected) if (keep.has(id)) next.add(id);
  return next.size === selected.size ? (selected as Set<string>) : next;
}

/** Cantidad y monto de lo seleccionado. */
export function selectionTotals<T>(
  items: readonly T[],
  selected: ReadonlySet<string>,
  idOf: (t: T) => string,
  amountOf: (t: T) => number,
): { count: number; amount: number } {
  let count = 0;
  let amount = 0;
  for (const it of items) {
    if (!selected.has(idOf(it))) continue;
    count++;
    amount += Number(amountOf(it)) || 0;
  }
  return { count, amount: Math.round(amount * 100) / 100 };
}

/** Parte una lista en tandas de `size`. */
export function chunk<T>(items: readonly T[], size: number): T[][] {
  const n = Math.max(1, Math.floor(size));
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += n) out.push(items.slice(i, i + n));
  return out;
}

export interface BatchFailure<T> {
  items: T[];
  error: unknown;
}

export interface BatchReport<T> {
  total: number;
  done: number;
  failed: BatchFailure<T>[];
  /** Cantidad de ítems que fallaron. */
  failedCount: number;
}

export interface BatchOptions {
  /** Tandas en paralelo (default 1: en orden). */
  concurrency?: number;
  onProgress?: (done: number, total: number) => void;
}

/**
 * Corre `worker` por tandas. Una tanda que falla no corta las otras: queda en
 * `failed` con su error. `done` cuenta los ítems de las tandas que salieron bien.
 */
export async function runInBatches<T>(
  items: readonly T[],
  size: number,
  worker: (batch: T[]) => Promise<unknown>,
  opts: BatchOptions = {},
): Promise<BatchReport<T>> {
  const batches = chunk(items, size);
  const total = items.length;
  const failed: BatchFailure<T>[] = [];
  let done = 0;
  let processed = 0;
  let next = 0;
  const lanes = Math.max(1, Math.min(opts.concurrency ?? 1, batches.length || 1));

  async function lane() {
    while (next < batches.length) {
      const batch = batches[next++]!;
      try {
        await worker(batch);
        done += batch.length;
      } catch (error) {
        failed.push({ items: batch, error });
      }
      processed += batch.length;
      opts.onProgress?.(processed, total);
    }
  }

  await Promise.all(Array.from({ length: lanes }, lane));
  return { total, done, failed, failedCount: failed.reduce((a, f) => a + f.items.length, 0) };
}

/** Frase del resultado: "Listo: 12 cobros" o "Se guardaron 10 de 12". */
export function batchResultText(
  r: Pick<BatchReport<unknown>, "total" | "done" | "failedCount">,
  noun: { one: string; many: string },
  verb: { done: string; partial: string },
): string {
  const n = (k: number) => `${k} ${k === 1 ? noun.one : noun.many}`;
  if (r.failedCount === 0) return `${verb.done}: ${n(r.done)}.`;
  if (r.done === 0) return `No se pudo: ${n(r.failedCount)} sin cambios.`;
  return `${verb.partial} ${r.done} de ${n(r.total)}. ${r.failedCount} no se pudieron guardar.`;
}
