// Agrupación del KDS por pedido y por curso (F13 · H46, ADR-097). Helpers puros.

export interface KdsItemLike {
  order_id: string;
  course: number;
  priority?: string | null;
  created_at: string;
}

export interface KdsHeldLike {
  order_id: string;
  course: number;
  held: number;
  priority?: string | null;
  first_at: string;
}

export function isUrgent(p: string | null | undefined): boolean {
  return p === "urgente";
}

// Ítems por curso ascendente (entrada, principal, postre…), FIFO dentro del curso.
export function groupByCourse<T extends KdsItemLike>(items: T[]): { course: number; items: T[] }[] {
  const map = new Map<number, T[]>();
  for (const it of items) {
    const c = it.course ?? 1;
    map.set(c, [...(map.get(c) ?? []), it]);
  }
  return [...map.entries()].sort((a, b) => a[0] - b[0]).map(([course, list]) => ({ course, items: list }));
}

// Columnas por pedido: urgentes primero, después por orden de llegada (el primer
// ítem que trae la RPC fija la posición, que ya viene FIFO).
export function orderColumns<T extends KdsItemLike>(
  items: T[],
): { orderId: string; urgent: boolean; items: T[] }[] {
  const cols = new Map<string, { orderId: string; urgent: boolean; items: T[]; idx: number }>();
  items.forEach((it, idx) => {
    const c = cols.get(it.order_id);
    if (c) {
      c.items.push(it);
      c.urgent = c.urgent || isUrgent(it.priority);
    } else {
      cols.set(it.order_id, { orderId: it.order_id, urgent: isUrgent(it.priority), items: [it], idx });
    }
  });
  return [...cols.values()]
    .sort((a, b) => (a.urgent === b.urgent ? a.idx - b.idx : a.urgent ? -1 : 1))
    .map(({ orderId, urgent, items: list }) => ({ orderId, urgent, items: list }));
}

// Columnas por curso (vista "por curso"): todos los pedidos de un curso juntos,
// urgentes primero dentro del curso.
export function courseColumns<T extends KdsItemLike>(items: T[]): { course: number; items: T[] }[] {
  return groupByCourse(items).map((g) => ({
    course: g.course,
    items: [...g.items].sort((a, b) => {
      const ua = isUrgent(a.priority) ? 0 : 1;
      const ub = isUrgent(b.priority) ? 0 : 1;
      if (ua !== ub) return ua - ub;
      return new Date(a.created_at).getTime() - new Date(b.created_at).getTime();
    }),
  }));
}

// Próximo curso en espera de un pedido (el menor). null si no queda nada.
export function nextHeldCourse<T extends KdsHeldLike>(held: T[], orderId: string): T | null {
  const mine = held.filter((h) => h.order_id === orderId && h.held > 0);
  if (mine.length === 0) return null;
  return mine.reduce((a, b) => (b.course < a.course ? b : a));
}

// Pedidos que sólo tienen cursos en espera (nada en preparación): la cocina los
// ve igual para saber qué viene.
export function heldOnlyOrders<T extends KdsHeldLike>(held: T[], activeOrderIds: Set<string>): T[] {
  const seen = new Set<string>();
  const out: T[] = [];
  const sorted = [...held].sort((a, b) => {
    const ua = isUrgent(a.priority) ? 0 : 1;
    const ub = isUrgent(b.priority) ? 0 : 1;
    if (ua !== ub) return ua - ub;
    if (a.first_at !== b.first_at) return new Date(a.first_at).getTime() - new Date(b.first_at).getTime();
    return a.course - b.course;
  });
  for (const h of sorted) {
    if (activeOrderIds.has(h.order_id) || seen.has(h.order_id)) continue;
    seen.add(h.order_id);
    out.push(nextHeldCourse(held, h.order_id) ?? h);
  }
  return out;
}
