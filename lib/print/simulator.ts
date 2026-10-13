// Impresora térmica simulada (F10 · ADR-101). Recibe los mismos bytes
// ESC/POS que una real y los interpreta: sirve para probar la cola, los
// reintentos, el corte y el pulso del cajón sin equipo.

import { decodeEscpos, type EscposPreview } from "./escpos";
import type { PrintDriver, PrintJob } from "./queue";

export type SimulatedFault = "none" | "paper_out" | "offline" | "flaky";

export const SIMULATED_FAULT_LABELS: Record<SimulatedFault, string> = {
  none: "Sin fallas",
  paper_out: "Sin papel",
  offline: "Desconectada",
  flaky: "Falla el primer intento",
};

export interface SimulatedPrintout extends EscposPreview {
  jobId: string;
  at: number;
  bytes: number;
}

export class SimulatedPrinter implements PrintDriver {
  fault: SimulatedFault = "none";
  readonly printed: SimulatedPrintout[] = [];
  private seen = new Map<string, number>();

  constructor(
    private readonly delayMs = 350,
    private readonly now: () => number = () => Date.now(),
  ) {}

  async print(job: PrintJob, bytes: Uint8Array): Promise<void> {
    if (this.delayMs > 0) await new Promise((r) => setTimeout(r, this.delayMs));
    const tries = (this.seen.get(job.id) ?? 0) + 1;
    this.seen.set(job.id, tries);
    if (this.fault === "paper_out") throw new Error("Sin papel (simulado)");
    if (this.fault === "offline")
      throw new Error("La impresora no responde (simulado)");
    if (this.fault === "flaky" && tries === 1)
      throw new Error("Error de comunicación en el primer intento (simulado)");
    this.printed.unshift({
      jobId: job.id,
      at: this.now(),
      bytes: bytes.length,
      ...decodeEscpos(bytes),
    });
    if (this.printed.length > 10) this.printed.length = 10;
  }
}
