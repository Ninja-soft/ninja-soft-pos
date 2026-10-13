// =============================================================================
// lib/shipping/print.ts  (Envíos · ADR-103)
// Impresión de etiquetas: el PDF se abre en una pestaña para imprimirlo por
// el navegador (impresión web, igual que los tickets); el ZPL se encola en la
// cola de impresión del equipo (ADR-101) como trabajo `etiqueta_envio`, que
// procesa el Mostrador simulado o, cuando exista, el puente local a la Zebra.
// =============================================================================
import { toBase64 } from "@/lib/print/queue";
import { addToDeviceQueue } from "@/lib/print/usePrintQueue";

/** Bytes del texto ZPL (ASCII; lo que no lo es se reemplaza). */
export function zplBytes(zpl: string): Uint8Array {
  const out = new Uint8Array(zpl.length);
  for (let i = 0; i < zpl.length; i++) {
    const c = zpl.charCodeAt(i);
    out[i] = c < 128 ? c : 63;
  }
  return out;
}

/** Encola una o varias etiquetas ZPL en la cola de este equipo. */
export function enqueueZplLabel(zpl: string, label: string, printerId = "simulator"): number {
  const q = addToDeviceQueue({
    doc: "etiqueta_envio",
    label: label.slice(0, 60),
    printerId,
    payload: toBase64(zplBytes(zpl)),
  });
  return q.filter((j) => j.status === "pending").length;
}

/** Abre el PDF firmado para imprimir. Devuelve false si el navegador bloqueó la pestaña. */
export function openPdfForPrint(url: string): boolean {
  // Sin "noopener" en features: con él window.open devuelve null siempre.
  const w = window.open(url, "_blank");
  if (w) w.opener = null;
  return w !== null;
}
