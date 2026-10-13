// Cola de impresión con reintentos (F10 · H22 · ADR-101). PURO.
//
// Estados: pendiente → imprimiendo → impreso | fallido. Un fallo vuelve a
// pendiente con espera creciente (backoff) hasta agotar los intentos; ahí
// queda "fallido" y el cajero decide: reintentar, reimprimir o cancelar.
// Un impreso se puede reimprimir (vuelve a pendiente con intentos en cero).
//
// La cola no sabe CÓMO se imprime: el que la procesa (runQueueStep) recibe un
// "driver" (impresora simulada, puente local, Web Serial). El estado es un
// arreglo plano serializable: se guarda en localStorage del equipo, porque la
// impresora es de esta PC y los trabajos no tienen que viajar a la base.

export type PrintJobStatus =
  | "pending"
  | "printing"
  | "printed"
  | "failed"
  | "cancelled";

export const PRINT_STATUS_LABELS: Record<PrintJobStatus, string> = {
  pending: "Pendiente",
  printing: "Imprimiendo",
  printed: "Impreso",
  failed: "Falló",
  cancelled: "Cancelado",
};

export type PrintDocKind =
  | "sale_ticket"
  | "z_report"
  | "cash_move"
  | "return"
  | "label"
  | "kitchen"
  | "etiqueta_envio"
  | "test";

export const PRINT_DOC_LABELS: Record<PrintDocKind, string> = {
  sale_ticket: "Ticket de venta",
  z_report: "Cierre Z",
  cash_move: "Movimiento de caja",
  return: "Devolución",
  label: "Etiqueta",
  kitchen: "Comanda",
  // Envíos (ADR-103): etiqueta ZPL de una logística, para térmica Zebra.
  etiqueta_envio: "Etiqueta de envío",
  test: "Prueba",
};

export interface PrintJob {
  id: string;
  doc: PrintDocKind;
  /** Texto corto para la lista ("Venta #123"). Sin datos personales. */
  label: string;
  /** Impresora destino (printers.id o "simulator"). */
  printerId: string;
  /** Bytes ESC/POS en base64 (serializable). */
  payload: string;
  status: PrintJobStatus;
  attempts: number;
  maxAttempts: number;
  lastError: string | null;
  createdAt: number;
  updatedAt: number;
  /** No reintentar antes de este momento (ms). */
  nextAttemptAt: number;
}

export const DEFAULT_MAX_ATTEMPTS = 3;
/** Cuántos trabajos terminados (impresos o cancelados) se conservan. */
export const KEEP_FINISHED = 30;

/** Espera antes del intento n (1-based): 2 s, 4 s, 8 s... tope 30 s. */
export function backoffMs(attempt: number): number {
  return Math.min(30_000, 2_000 * 2 ** Math.max(0, attempt - 1));
}

export function enqueue(
  queue: PrintJob[],
  job: Pick<PrintJob, "id" | "doc" | "label" | "printerId" | "payload"> & {
    maxAttempts?: number;
  },
  now: number,
): PrintJob[] {
  const full: PrintJob = {
    ...job,
    status: "pending",
    attempts: 0,
    maxAttempts: Math.max(
      1,
      Math.min(10, job.maxAttempts ?? DEFAULT_MAX_ATTEMPTS),
    ),
    lastError: null,
    createdAt: now,
    updatedAt: now,
    nextAttemptAt: now,
  };
  return prune([...queue, full]);
}

/** Próximo trabajo listo para imprimir (FIFO; uno por impresora a la vez). */
export function nextJob(queue: PrintJob[], now: number): PrintJob | null {
  const busy = new Set(
    queue.filter((j) => j.status === "printing").map((j) => j.printerId),
  );
  return (
    queue
      .filter(
        (j) =>
          j.status === "pending" &&
          j.nextAttemptAt <= now &&
          !busy.has(j.printerId),
      )
      .sort((a, b) => a.createdAt - b.createdAt)[0] ?? null
  );
}

function patch(
  queue: PrintJob[],
  id: string,
  fn: (j: PrintJob) => PrintJob | null,
): PrintJob[] {
  return queue.map((j) => (j.id === id ? (fn(j) ?? j) : j));
}

export function markPrinting(
  queue: PrintJob[],
  id: string,
  now: number,
): PrintJob[] {
  return patch(queue, id, (j) =>
    j.status === "pending"
      ? { ...j, status: "printing", attempts: j.attempts + 1, updatedAt: now }
      : null,
  );
}

export function markPrinted(
  queue: PrintJob[],
  id: string,
  now: number,
): PrintJob[] {
  return prune(
    patch(queue, id, (j) =>
      j.status === "printing"
        ? { ...j, status: "printed", lastError: null, updatedAt: now }
        : null,
    ),
  );
}

/** Fallo de un intento: reintenta solo con espera o queda "fallido". */
export function markFailed(
  queue: PrintJob[],
  id: string,
  error: string,
  now: number,
): PrintJob[] {
  return patch(queue, id, (j) => {
    if (j.status !== "printing") return null;
    const exhausted = j.attempts >= j.maxAttempts;
    return {
      ...j,
      status: exhausted ? "failed" : "pending",
      lastError: error,
      updatedAt: now,
      nextAttemptAt: exhausted ? j.nextAttemptAt : now + backoffMs(j.attempts),
    };
  });
}

/** Reintentar un fallido ahora (los intentos vuelven a cero). */
export function retry(queue: PrintJob[], id: string, now: number): PrintJob[] {
  return patch(queue, id, (j) =>
    j.status === "failed" || j.status === "pending"
      ? {
          ...j,
          status: "pending",
          attempts: 0,
          nextAttemptAt: now,
          updatedAt: now,
        }
      : null,
  );
}

/** Reimprimir un impreso: entra como trabajo nuevo al final de la cola. */
export function reprint(
  queue: PrintJob[],
  id: string,
  newId: string,
  now: number,
): PrintJob[] {
  const j = queue.find((x) => x.id === id);
  if (!j || (j.status !== "printed" && j.status !== "cancelled")) return queue;
  return enqueue(
    queue,
    {
      id: newId,
      doc: j.doc,
      label: `${j.label} (reimpresión)`,
      printerId: j.printerId,
      payload: j.payload,
      maxAttempts: j.maxAttempts,
    },
    now,
  );
}

/** Cancelar lo que no se imprimió (no se puede cancelar lo que está saliendo). */
export function cancel(queue: PrintJob[], id: string, now: number): PrintJob[] {
  return prune(
    patch(queue, id, (j) =>
      j.status === "pending" || j.status === "failed"
        ? { ...j, status: "cancelled", updatedAt: now }
        : null,
    ),
  );
}

/**
 * Al abrir la pantalla: lo que quedó "imprimiendo" (se cerró la pestaña a
 * mitad de un trabajo) vuelve a pendiente para no perderlo.
 */
export function recover(queue: PrintJob[], now: number): PrintJob[] {
  return queue.map((j) =>
    j.status === "printing"
      ? { ...j, status: "pending", nextAttemptAt: now, updatedAt: now }
      : j,
  );
}

/** Deja los activos y los últimos KEEP_FINISHED terminados. */
export function prune(queue: PrintJob[]): PrintJob[] {
  const done = queue
    .filter((j) => j.status === "printed" || j.status === "cancelled")
    .sort((a, b) => b.updatedAt - a.updatedAt)
    .slice(0, KEEP_FINISHED);
  const keep = new Set(done.map((j) => j.id));
  return queue.filter(
    (j) =>
      (j.status !== "printed" && j.status !== "cancelled") || keep.has(j.id),
  );
}

export function queueCounts(queue: PrintJob[]): Record<PrintJobStatus, number> {
  const c: Record<PrintJobStatus, number> = {
    pending: 0,
    printing: 0,
    printed: 0,
    failed: 0,
    cancelled: 0,
  };
  for (const j of queue) c[j.status] += 1;
  return c;
}

/** Sanea lo leído de localStorage. */
export function parseQueue(raw: unknown): PrintJob[] {
  if (!Array.isArray(raw)) return [];
  const statuses = Object.keys(PRINT_STATUS_LABELS);
  const docs = Object.keys(PRINT_DOC_LABELS);
  return raw.filter(
    (j): j is PrintJob =>
      !!j &&
      typeof j === "object" &&
      typeof (j as PrintJob).id === "string" &&
      typeof (j as PrintJob).payload === "string" &&
      statuses.includes((j as PrintJob).status) &&
      docs.includes((j as PrintJob).doc) &&
      Number.isFinite((j as PrintJob).createdAt),
  );
}

// ── Procesamiento ────────────────────────────────────────────────────────────

export interface PrintDriver {
  print(job: PrintJob, bytes: Uint8Array): Promise<void>;
}

export function toBase64(bytes: Uint8Array): string {
  let s = "";
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s);
}

export function fromBase64(b64: string): Uint8Array {
  const s = atob(b64);
  const out = new Uint8Array(s.length);
  for (let i = 0; i < s.length; i++) out[i] = s.charCodeAt(i);
  return out;
}

/**
 * Procesa UN trabajo listo (si hay): lo marca imprimiendo, llama al driver y
 * lo marca impreso o fallido. Lee el estado con `get` antes de cada paso (el
 * cajero puede cancelar otro trabajo mientras se imprime) y lo publica con
 * `set`. Devuelve el trabajo procesado o null si no había ninguno listo.
 */
export async function runQueueStep(
  get: () => PrintJob[],
  set: (q: PrintJob[]) => void,
  driver: PrintDriver,
  now: () => number = () => Date.now(),
): Promise<PrintJob | null> {
  const job = nextJob(get(), now());
  if (!job) return null;
  set(markPrinting(get(), job.id, now()));
  try {
    await driver.print(job, fromBase64(job.payload));
    set(markPrinted(get(), job.id, now()));
  } catch (e) {
    const msg =
      e instanceof Error && e.message ? e.message : "Error de impresión";
    set(markFailed(get(), job.id, msg, now()));
  }
  return get().find((j) => j.id === job.id) ?? null;
}
