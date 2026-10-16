// Cola offline de la app del repartidor (ADR-161). Cada acción (salir,
// llegué, entregado, no entregado, cerrar) se guarda con el id que genera el
// teléfono y sus fotos y firma como Blob. Al volver la señal se suben las
// fotos y se manda la acción: las RPC son idempotentes por ese id, así que
// mandar dos veces no duplica. Lógica pura con un almacén y un transporte
// inyectables (tests con memoria; la app usa IndexedDB y Supabase).

import type { StopStatus, RouteStatus } from "./logic";

export type QueuedKind = "start" | "event" | "close";

export interface QueuedMedia {
  path: string;
  blob: Blob;
  contentType: string;
  uploaded: boolean;
}

export interface QueuedAction {
  /** id del evento (lo genera el teléfono). */
  id: string;
  kind: QueuedKind;
  routeId: string;
  stopId: string | null;
  /** Tipo del evento (llegada, entregado, no_entregado, nota; parcial = por producto, ADR-165) si kind = event. */
  eventType?: "llegada" | "entregado" | "no_entregado" | "nota" | "parcial";
  payload: Record<string, unknown>;
  media: QueuedMedia[];
  createdAt: string;
  attempts: number;
  lastError: string | null;
  /** Error de datos: no se reintenta solo (se muestra para descartar). */
  failed: boolean;
}

export interface ActionStore {
  getAll(): Promise<QueuedAction[]>;
  put(a: QueuedAction): Promise<void>;
  delete(id: string): Promise<void>;
}

export interface Transport {
  upload(path: string, blob: Blob, contentType: string): Promise<void>;
  send(a: QueuedAction): Promise<unknown>;
}

export interface SyncResult {
  sent: number;
  failed: number;
  pending: number;
  /** Se cortó por falta de red (lo que queda se manda en el próximo intento). */
  offline: boolean;
}

export function sortQueue(list: readonly QueuedAction[]): QueuedAction[] {
  return [...list].sort((a, b) => (a.createdAt < b.createdAt ? -1 : a.createdAt > b.createdAt ? 1 : a.id.localeCompare(b.id)));
}

/** El archivo ya estaba subido (reintento después de un corte). */
export function alreadyUploaded(e: unknown): boolean {
  const msg = String((e as { message?: string; statusCode?: string | number })?.message ?? e ?? "");
  const code = String((e as { statusCode?: string | number })?.statusCode ?? "");
  return code === "409" || /already exists|Duplicate/i.test(msg);
}

/**
 * Manda la cola en orden. Un error de red corta (el orden importa: no se
 * puede entregar antes de salir); un error de datos marca la acción como
 * fallida y sigue con la siguiente.
 */
export async function syncQueue(
  store: ActionStore,
  transport: Transport,
  isPermanent: (e: unknown) => boolean,
): Promise<SyncResult> {
  const list = sortQueue(await store.getAll());
  let sent = 0;
  let failed = 0;
  for (const a of list) {
    if (a.failed) {
      failed++;
      continue;
    }
    try {
      for (const m of a.media) {
        if (m.uploaded) continue;
        try {
          await transport.upload(m.path, m.blob, m.contentType);
        } catch (e) {
          if (!alreadyUploaded(e)) throw e;
        }
        m.uploaded = true;
        await store.put(a);
      }
      await transport.send(a);
      await store.delete(a.id);
      sent++;
    } catch (e) {
      const permanent = isPermanent(e);
      const next: QueuedAction = {
        ...a,
        attempts: a.attempts + 1,
        lastError: String((e as { message?: string })?.message ?? e ?? "error").slice(0, 300),
        failed: permanent,
      };
      await store.put(next);
      if (permanent) {
        failed++;
        continue;
      }
      const pending = (await store.getAll()).filter((x) => !x.failed).length;
      return { sent, failed, pending, offline: true };
    }
  }
  const pending = (await store.getAll()).filter((x) => !x.failed).length;
  return { sent, failed, pending, offline: false };
}

/** Almacén en memoria (tests y respaldo si no hay IndexedDB). */
export function memoryStore(initial: QueuedAction[] = []): ActionStore & { items: Map<string, QueuedAction> } {
  const items = new Map(initial.map((a) => [a.id, a]));
  return {
    items,
    getAll: async () => [...items.values()].map((a) => ({ ...a, media: a.media.map((m) => ({ ...m })) })),
    put: async (a) => {
      items.set(a.id, { ...a, media: a.media.map((m) => ({ ...m })) });
    },
    delete: async (id) => {
      items.delete(id);
    },
  };
}

// -----------------------------------------------------------------------------
// Lo que el repartidor ve mientras la cola no se mandó (optimista)
// -----------------------------------------------------------------------------
export interface StopLike {
  id: string;
  status: StopStatus;
}

export interface RouteLike<S extends StopLike> {
  route: { id: string; status: RouteStatus };
  stops: S[];
}

/** Aplica la cola pendiente sobre el detalle guardado de la hoja. */
export function applyPending<S extends StopLike, D extends RouteLike<S>>(detail: D, queue: readonly QueuedAction[]): D {
  const mine = sortQueue(queue.filter((a) => a.routeId === detail.route.id && !a.failed));
  if (!mine.length) return detail;
  let status = detail.route.status;
  const stops = detail.stops.map((s) => ({ ...s }));
  for (const a of mine) {
    if (a.kind === "start" && (status === "planificada" || status === "cargando")) {
      status = "en_curso";
      for (const s of stops) if (s.status === "pendiente") s.status = "en_camino";
    } else if (a.kind === "close") {
      status = "cerrada";
      for (const s of stops) if (s.status === "pendiente" || s.status === "en_camino" || s.status === "en_el_lugar") s.status = "saltada";
    } else if (a.kind === "event" && a.stopId) {
      const s = stops.find((x) => x.id === a.stopId);
      if (!s) continue;
      if (a.eventType === "llegada" && (s.status === "pendiente" || s.status === "en_camino")) s.status = "en_el_lugar";
      if (a.eventType === "entregado") s.status = "entregada";
      if (a.eventType === "no_entregado") s.status = "no_entregada";
      if (a.eventType === "parcial") {
        const r = a.payload as { any_delivered?: boolean; complete?: boolean };
        s.status = r.any_delivered ? (r.complete ? "entregada" : "parcial") : "no_entregada";
      }
    }
  }
  return { ...detail, route: { ...detail.route, status }, stops };
}

/** "3 entregas sin enviar" para el indicador. */
export function pendingLabel(n: number): string {
  if (n <= 0) return "Todo enviado";
  return n === 1 ? "1 acción sin enviar" : `${n} acciones sin enviar`;
}

/** Ruta del archivo en el bucket: <negocio>/routes/<hoja>/<id>-<tipo>.webp */
export function routeMediaPath(tenantId: string, routeId: string, eventId: string, kind: string, ext = "webp"): string {
  const safe = kind.replace(/[^a-z0-9_-]/gi, "").slice(0, 20) || "foto";
  return `${tenantId}/routes/${routeId}/${eventId}-${safe}.${ext}`;
}
