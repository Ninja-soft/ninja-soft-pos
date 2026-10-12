// Terminal integrada (ADR-053): contrato vendor-agnóstico entre el POS y una
// terminal de tarjeta que cobra y le devuelve los datos del cupón al POS
// (posnet integrado por cable o LAN, o pinpad conectado a la PC).
//
// El POS sólo conoce `TerminalAdapter` y `TerminalResult`. Cada adquirente
// (Payway, Fiserv, Getnet) implementa su adaptador sobre un `ByteTransport`
// (Web Serial, WebUSB o el puente local). El simulador cumple el mismo
// contrato sin hardware, para demos y tests.

/** Tipo de terminal integrada en payment_terminals.kind. */
export type IntegratedKind = "posnet_integrado" | "pinpad";

/** Adaptador de protocolo. */
export type AdapterKey = "simulator" | "payway_lapos" | "fiserv_posnet" | "getnet";

/** Cómo llegan los bytes a la terminal. */
export type TransportKind = "webserial" | "webusb" | "bridge" | "none";

export type TerminalOp = "sale" | "void" | "refund" | "close_batch" | "status";

export type CardType = "debit" | "credit";

/**
 * Resultado normalizado de una operación. Los campos que la terminal no
 * informa quedan en null; `raw` guarda la respuesta tal cual (texto o hex)
 * para auditoría y soporte.
 */
export interface TerminalResult {
  approved: boolean;
  op: TerminalOp;
  /** Monto confirmado por la terminal, en pesos (null si no lo informa). */
  amount: number | null;
  authCode: string | null;
  lote: string | null;
  cupon: string | null;
  /** Marca tal como la informa la terminal ("VISA", "MASTERCARD"...). */
  cardBrand: string | null;
  cardType: CardType | null;
  last4: string | null;
  installments: number | null;
  merchantNumber: string | null;
  terminalNumber: string | null;
  /** Código de respuesta del autorizador ("00" aprobado, etc.). */
  responseCode: string | null;
  /** Texto para el cajero (motivo del rechazo, leyenda de la terminal). */
  message: string | null;
  raw: string;
  /** ISO de cuando el POS recibió la respuesta. */
  at: string;
}

export interface SaleRequest {
  /** Pesos con 2 decimales. */
  amount: number;
  /** null = que el cliente elija en la terminal (si el protocolo lo permite). */
  installments: number | null;
  /** Referencia propia del POS (va como ticket / factura si el protocolo la acepta). */
  reference: string;
  /** Sugerencia del cajero; la terminal decide con la tarjeta real. */
  cardType?: CardType | null;
  /**
   * Marca elegida por el cajero (clave de lib/pos/cardBrands). Algunos
   * protocolos (VPI de LaPos / Payway) piden el código de tarjeta antes de
   * pasarla: ver `capabilities.requiresBrand`.
   */
  cardBrand?: string | null;
}

export interface VoidRequest {
  /** Cupón (ticket) de la operación a anular. */
  cupon: string;
  cardBrand?: string | null;
  amount: number;
  reference: string;
}

export interface RefundRequest {
  amount: number;
  /** Cupón y fecha de la operación original (los piden muchos adquirentes). */
  cupon?: string | null;
  originalDate?: string | null;
  installments?: number | null;
  cardBrand?: string | null;
  reference: string;
}

export interface CloseBatchResult {
  ok: boolean;
  lote: string | null;
  count: number | null;
  total: number | null;
  message: string | null;
  raw: string;
  at: string;
}

export interface TerminalStatus {
  connected: boolean;
  /** Lista para cobrar (sin operación en curso). */
  ready: boolean;
  model?: string | null;
  serial?: string | null;
  message?: string | null;
}

/** Eventos intermedios para la UI ("Pasá la tarjeta", "Ingresá el PIN"...). */
export type TerminalEvent =
  | { type: "sent" }
  | { type: "ack" }
  | { type: "prompt"; message: string }
  | { type: "retry"; attempt: number };

export interface OpOptions {
  signal?: AbortSignal;
  onEvent?: (e: TerminalEvent) => void;
}

export interface AdapterCapabilities {
  void: boolean;
  refund: boolean;
  closeBatch: boolean;
  /** Se pueden mandar las cuotas desde el POS. */
  installments: boolean;
  /** Se puede cancelar una operación en curso desde el POS. */
  cancelInFlight: boolean;
  /** El cajero tiene que elegir la marca antes de mandar el cobro. */
  requiresBrand: boolean;
  /** Se puede consultar la última operación (recuperar un timeout). */
  lastTransaction: boolean;
}

/**
 * `ready`: protocolo implementado y probado.
 * `unverified`: framing implementado según una fuente pública NO oficial
 * (implementación de la comunidad); falta validarlo con el adquirente.
 * `pending_kit`: falta la especificación del adquirente (kit de integradores);
 * las operaciones devuelven `TerminalError("spec_pending")`.
 */
export type SpecStatus = "ready" | "unverified" | "pending_kit";

export interface TerminalAdapter {
  readonly key: AdapterKey;
  readonly label: string;
  readonly specStatus: SpecStatus;
  readonly capabilities: AdapterCapabilities;
  connect(opts?: OpOptions): Promise<void>;
  disconnect(): Promise<void>;
  sale(req: SaleRequest, opts?: OpOptions): Promise<TerminalResult>;
  void(req: VoidRequest, opts?: OpOptions): Promise<TerminalResult>;
  refund(req: RefundRequest, opts?: OpOptions): Promise<TerminalResult>;
  closeBatch(opts?: OpOptions): Promise<CloseBatchResult>;
  status(opts?: OpOptions): Promise<TerminalStatus>;
  /** Última operación registrada en la terminal (para resolver un timeout). */
  lastTransaction?(opts?: OpOptions): Promise<TerminalResult | null>;
}

export type TerminalErrorCode =
  | "not_connected"
  | "permission_denied"
  | "unsupported"
  | "spec_pending"
  | "timeout"
  | "cancelled"
  | "busy"
  | "protocol"
  | "transport"
  | "bridge_auth";

export class TerminalError extends Error {
  readonly code: TerminalErrorCode;
  constructor(code: TerminalErrorCode, message?: string) {
    super(message ?? code);
    this.name = "TerminalError";
    this.code = code;
  }
}

export function isTerminalError(e: unknown, code?: TerminalErrorCode): e is TerminalError {
  return e instanceof TerminalError && (!code || e.code === code);
}

/** Error de "operación cancelada" con el motivo del AbortSignal. */
export function abortError(signal?: AbortSignal): TerminalError {
  const r = signal?.reason;
  if (r instanceof TerminalError) return r;
  return new TerminalError("cancelled", "Operación cancelada");
}
