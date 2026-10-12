// Base de los adaptadores de adquirente sobre un transporte de bytes
// (ADR-053). Resuelve abrir / cerrar el transporte, la sesión de enlace
// (framing parametrizable) y el estado de conexión. Mientras falte la
// especificación del adquirente, las operaciones devuelven
// TerminalError("spec_pending") con un mensaje claro para el cajero, y el POS
// ofrece cargar el cupón a mano.

import { LinkSession, type ByteTransport, type LinkOptions } from "../framing";
import {
  TerminalError,
  abortError,
  type AdapterCapabilities,
  type AdapterKey,
  type CloseBatchResult,
  type OpOptions,
  type RefundRequest,
  type SaleRequest,
  type SpecStatus,
  type TerminalAdapter,
  type TerminalResult,
  type TerminalStatus,
  type VoidRequest,
} from "../types";

export abstract class TransportAdapter implements TerminalAdapter {
  abstract readonly key: AdapterKey;
  abstract readonly label: string;
  abstract readonly specStatus: SpecStatus;
  abstract readonly capabilities: AdapterCapabilities;
  protected link: LinkSession;

  constructor(
    protected readonly transport: ByteTransport,
    linkOptions: LinkOptions = {},
  ) {
    this.link = new LinkSession(transport, linkOptions);
  }

  async connect(opts?: OpOptions): Promise<void> {
    if (opts?.signal?.aborted) throw abortError(opts.signal);
    if (!this.transport.isOpen) await this.transport.open();
    this.link.attach();
  }

  async disconnect(): Promise<void> {
    this.link.detach();
    await this.transport.close();
  }

  async status(): Promise<TerminalStatus> {
    // Sin comando de "eco" público, conectado = el puerto está abierto.
    return {
      connected: this.transport.isOpen,
      ready: this.transport.isOpen && this.specStatus === "ready",
      message:
        this.specStatus === "ready"
          ? null
          : "Conexión física lista. Falta la especificación del adquirente para cobrar.",
    };
  }

  sale(_req: SaleRequest, _opts?: OpOptions): Promise<TerminalResult> {
    return Promise.reject(this.pendingError("la venta"));
  }
  void(_req: VoidRequest, _opts?: OpOptions): Promise<TerminalResult> {
    return Promise.reject(this.pendingError("la anulación"));
  }
  refund(_req: RefundRequest, _opts?: OpOptions): Promise<TerminalResult> {
    return Promise.reject(this.pendingError("la devolución"));
  }
  closeBatch(_opts?: OpOptions): Promise<CloseBatchResult> {
    return Promise.reject(this.pendingError("el cierre de lote"));
  }

  protected pendingError(op: string): TerminalError {
    return new TerminalError(
      "spec_pending",
      `${this.label}: ${op} queda pendiente de la especificación del adquirente (kit de integradores). Cobrá con Tarjeta en posnet y cargá el cupón.`,
    );
  }
}

/** Monto en centavos, sin separadores, con ancho fijo ("000000012350"). */
export function amountCents(amount: number, width = 12): string {
  const c = Math.round(amount * 100);
  if (!Number.isFinite(c) || c < 0) throw new TerminalError("protocol", "Monto inválido");
  const s = String(c);
  if (s.length > width) throw new TerminalError("protocol", "Monto demasiado grande para la terminal");
  return s.padStart(width, "0");
}

/** Campo alfanumérico de ancho fijo (relleno a la derecha con espacios). */
export function fixedText(v: string, width: number): string {
  // Sólo ASCII imprimible: los protocolos de terminal no aceptan acentos.
  const ascii = v.normalize("NFD").replace(/[^\x20-\x7e]/g, "");
  return ascii.slice(0, width).padEnd(width, " ");
}
