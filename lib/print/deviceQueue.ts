// Encolar un trabajo en la cola de impresión DEL EQUIPO (ADR-101) sin montar
// el hook: misma clave de localStorage que usePrintQueue. El trabajo queda
// pendiente y lo procesa la cola cuando hay un driver activo (Diagnóstico de
// hardware hoy; el puente local cuando exista). Lo usa Mercado Libre para las
// etiquetas ZPL (ADR-104). Sin storage devuelve false (el llamador ofrece
// descargar el archivo).
import { enqueue, parseQueue, type PrintJob } from "./queue";

export const PRINT_QUEUE_KEY = "ninja-print-queue";

export function enqueueOnDevice(
  job: Pick<PrintJob, "doc" | "label" | "printerId" | "payload"> & { maxAttempts?: number },
  now = Date.now(),
): boolean {
  try {
    const raw = window.localStorage.getItem(PRINT_QUEUE_KEY);
    const current = raw ? parseQueue(JSON.parse(raw)) : [];
    const id = `j_${now.toString(36)}${Math.random().toString(36).slice(2, 7)}`;
    window.localStorage.setItem(PRINT_QUEUE_KEY, JSON.stringify(enqueue(current, { ...job, id }, now)));
    return true;
  } catch {
    return false;
  }
}
