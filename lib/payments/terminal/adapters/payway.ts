// Payway (ex Prisma / LaPos): "POS Integrado" por cable (ADR-053).
//
// ESTADO: `unverified`. El framing y los campos siguen DOS fuentes públicas
// NO oficiales del protocolo "VPI PC" (IngStore) de LaPos:
//   • github.com/leonelvsc/webserial-lapos-integrado (MIT, 2022): Web Serial,
//     19200 8N1, comandos VEN / ANV / DEV / AND / CIE / ULT / TAR / PLA / TES
//     y offsets de la respuesta.
//   • github.com/gsaracca/LaPos (vpipc.c, MIT): estructuras de entrada y
//     salida y códigos de retorno de la DLL vpipc.
// Payway no publica la especificación. Falta confirmar con el kit: versión de
// protocolo vigente en la Payway Classic (PAX S920) y en el pinpad Lane/3000,
// VID/PID USB, si la respuesta trae LRC, la tabla de códigos de tarjeta y el
// significado exacto del "status" de 3 dígitos. Ver
// docs/payments/terminal-integrada-payway.md. No se copió código de esas
// fuentes: es una implementación propia del formato descripto.
//
// Trama de pedido:   ENQ, luego STX + cmd(3) + largo(2, little-endian) + datos + ETX + LRC
//                    (LRC = XOR de todos los bytes después del STX, ETX incluido).
// Trama de respuesta: STX + cmd(3) + status(3 ASCII) + largo(2, LE) + datos + ETX [+ LRC?]

import { ACK, ETX, STX, encodeFrame, latin1, toBytes, toHex, type ByteTransport } from "../framing";
import {
  TerminalError,
  abortError,
  type AdapterCapabilities,
  type CloseBatchResult,
  type OpOptions,
  type RefundRequest,
  type SaleRequest,
  type TerminalOp,
  type TerminalResult,
  type TerminalStatus,
  type VoidRequest,
} from "../types";
import { TransportAdapter, amountCents } from "./base";

export const ENQ = 0x05;

/** Parámetros de puerto publicados por ambas fuentes. */
export const VPI_SERIAL = { baudRate: 19200, dataBits: 8, stopBits: 1, parity: "none", flowControl: "none" } as const;
/** VID/PID que usa la implementación de la comunidad (terminales Ingenico LaPos). Sin confirmar en S920 / Lane. */
export const VPI_USB_FILTER = { usbVendorId: 0x1234, usbProductId: 0x0101 } as const;

export type VpiCommand = "VEN" | "ANV" | "DEV" | "AND" | "CIE" | "ULT" | "TAR" | "PLA" | "TES";

/** Status "000" = última (o única) respuesta; "001" = hay más registros. */
export const VPI_STATUS_OK = "000";
export const VPI_STATUS_MORE = "001";

/** Códigos de retorno de vpipc (gsaracca/LaPos, vpipc.c). Uso como status: inferido. */
export const VPI_CODES: Record<string, string> = {
  "011": "El comando no pudo ser enviado",
  "012": "Tiempo de espera agotado",
  "101": "El código de tarjeta no existe en la terminal",
  "102": "El número de cupón no existe",
  "103": "El código de plan no existe",
  "104": "No existe el índice",
  "105": "El lote está vacío",
  "201": "Operación cancelada en la terminal",
  "202": "La tarjeta no coincide con la elegida",
  "203": "Tarjeta inválida",
  "204": "Tarjeta vencida",
  "205": "La operación original no existe",
  "301": "La terminal no pudo comunicarse con Payway",
  "302": "La terminal no pudo imprimir el cupón",
  "901": "Comando inexistente",
  "902": "Formato de un dato de entrada incorrecto",
  "903": "Comando no válido",
  "909": "Error general en la terminal",
};

// ── Armado de pedidos ───────────────────────────────────────────────────────

const digits = (v: string | number, width: number) => {
  const s = String(v).replace(/\D/g, "");
  if (s.length > width) throw new TerminalError("protocol", `Dato numérico demasiado largo (${width})`);
  return s.padStart(width, "0");
};
const left = (v: string, width: number) => ascii(v).slice(0, width).padStart(width, " ");
const right = (v: string, width: number) => ascii(v).slice(0, width).padEnd(width, " ");
function ascii(v: string): string {
  return v.normalize("NFD").replace(/[^\x20-\x7e]/g, "");
}
const code3 = (v: string | null | undefined) => ascii(v ?? "").slice(0, 3).padStart(3, "0");

/** Trama completa (sin el ENQ previo). */
export function buildVpiRequest(cmd: VpiCommand, data: string | Uint8Array = ""): Uint8Array {
  const body = typeof data === "string" ? toBytes(data) : data;
  if (body.length > 0xffff) throw new TerminalError("protocol", "Datos demasiado largos");
  const payload = new Uint8Array(5 + body.length);
  payload.set(toBytes(cmd), 0);
  payload[3] = body.length & 0xff;
  payload[4] = (body.length >> 8) & 0xff;
  payload.set(body, 5);
  return encodeFrame(payload);
}

export interface VpiMerchant {
  merchantCode: string;
  merchantName: string;
  cuit: string;
}

/** VEN: 12 monto + 12 factura + 2 cuotas + 3 tarjeta + 1 plan + 12 propina + 15 comercio + 23 razón social + 23 CUIT + 1 online. */
export function encodeSale(p: {
  amount: number;
  receipt: string;
  installments: number;
  cardCode: string | null;
  planCode?: string;
  tip?: number;
  online?: boolean;
} & VpiMerchant): string {
  return (
    amountCents(p.amount) +
    digits(p.receipt, 12) +
    digits(Math.max(1, Math.min(99, p.installments)), 2) +
    code3(p.cardCode) +
    ascii(p.planCode ?? "0").slice(0, 1).padStart(1, "0") +
    amountCents(p.tip ?? 0) +
    right(p.merchantCode, 15) +
    left(p.merchantName, 23) +
    left(p.cuit, 23) +
    String.fromCharCode(p.online === false ? 0x00 : 0x01)
  );
}

/** ANV / AND: 7 cupón + 3 tarjeta. */
export function encodeVoid(p: { cupon: string; cardCode: string | null }): string {
  return digits(p.cupon, 7) + code3(p.cardCode);
}

/** DEV: 12 monto + 3 tarjeta + 1 plan + 2 cuotas + 7 cupón original + 10 fecha original + 12 factura + 15 + 23 + 23 + 1. */
export function encodeRefund(p: {
  amount: number;
  cardCode: string | null;
  planCode?: string;
  installments: number;
  originalCupon: string;
  originalDate: string;
  receipt: string;
  online?: boolean;
} & VpiMerchant): string {
  return (
    amountCents(p.amount) +
    code3(p.cardCode) +
    ascii(p.planCode ?? "0").slice(0, 1).padStart(1, "0") +
    digits(Math.max(1, Math.min(99, p.installments)), 2) +
    digits(p.originalCupon || "0", 7) +
    ascii(p.originalDate).slice(0, 10).padStart(10, "0") +
    digits(p.receipt, 12) +
    left(p.merchantCode, 15) +
    left(p.merchantName, 23) +
    left(p.cuit, 23) +
    String.fromCharCode(p.online === false ? 0x00 : 0x01)
  );
}

// ── Lectura de respuestas ───────────────────────────────────────────────────

export interface VpiResponse {
  command: string;
  status: string;
  data: Uint8Array;
  /** true / false si vino LRC; null si no vino (sin confirmar en el protocolo). */
  lrcOk: boolean | null;
  raw: Uint8Array;
}

/**
 * Decodificador por LARGO (no por ETX: el largo binario puede valer 0x03).
 * Después del ETX, un byte que no sea STX se toma como LRC (opcional).
 */
export class VpiDecoder {
  private buf: number[] = [];
  private state: "idle" | "frame" | "lrc" = "idle";
  private pending: VpiResponse | null = null;

  push(chunk: Uint8Array): VpiResponse[] {
    const out: VpiResponse[] = [];
    for (const b of chunk) {
      if (this.state === "lrc") {
        const p = this.pending!;
        this.pending = null;
        this.state = "idle";
        if (b !== STX) {
          let x = 0;
          for (const v of p.raw.subarray(1)) x ^= v;
          p.lrcOk = x === b;
          p.raw = Uint8Array.from([...p.raw, b]);
          out.push(p);
          continue;
        }
        out.push(p);
        // b es el STX de la próxima trama: sigue abajo.
      }
      if (this.state === "idle") {
        if (b === STX) {
          this.state = "frame";
          this.buf = [b];
        }
        continue;
      }
      this.buf.push(b);
      // STX + cmd(3) + status(3) + len(2) = 9 bytes de cabecera.
      if (this.buf.length >= 9) {
        const len = this.buf[7]! | (this.buf[8]! << 8);
        const total = 9 + len + 1;
        if (this.buf.length === total) {
          const raw = Uint8Array.from(this.buf);
          this.buf = [];
          if (raw[total - 1] !== ETX) {
            this.state = "idle";
            continue; // trama corrupta: se descarta
          }
          this.pending = {
            command: latin1(raw.subarray(1, 4)),
            status: latin1(raw.subarray(4, 7)),
            data: raw.subarray(9, 9 + len),
            lrcOk: null,
            raw,
          };
          this.state = "lrc";
        }
      }
    }
    return out;
  }

  /** Entrega la trama que quedó esperando un LRC que no llegó. */
  flush(): VpiResponse[] {
    if (this.state !== "lrc" || !this.pending) return [];
    const p = this.pending;
    this.pending = null;
    this.state = "idle";
    return [p];
  }
}

export interface VpiTrxData {
  hostCode: string;
  hostMessage: string;
  authCode: string;
  cupon: string;
  lote: string;
  customerName: string;
  last4: string;
  first6: string;
  date: string;
  time: string;
  terminalId: string;
}

/** Datos de VEN / ANV / DEV / AND (offsets de la implementación de la comunidad). */
export function parseTrxData(data: Uint8Array, offset = 0): VpiTrxData {
  const s = latin1(data);
  const f = (a: number, b: number) => s.slice(offset + a, offset + b).trim();
  return {
    hostCode: f(0, 2),
    hostMessage: f(2, 34),
    authCode: f(34, 40),
    cupon: f(40, 47),
    lote: f(47, 50),
    customerName: f(50, 76),
    last4: f(76, 80),
    first6: f(80, 86),
    date: f(86, 96),
    time: f(96, 104),
    terminalId: f(104, 112),
  };
}

/** Marca por BIN (primeros 6). Sólo rangos de red ampliamente conocidos. */
export function brandFromBin(first6: string): string | null {
  const d = first6.replace(/\D/g, "");
  if (d.length < 2) return null;
  if (d.startsWith("4")) return "VISA";
  const two = Number(d.slice(0, 2));
  const four = Number(d.slice(0, 4));
  if ((two >= 51 && two <= 55) || (four >= 2221 && four <= 2720)) return "MASTERCARD";
  if (two === 34 || two === 37) return "AMEX";
  if (two === 36 || two === 38 || (two === 30 && Number(d[2]) <= 5)) return "DINERS";
  return null;
}

export function vpiToResult(
  op: TerminalOp,
  resp: VpiResponse,
  ctx: { amount: number | null; installments: number | null; cardBrandLabel: string | null; merchantNumber: string | null },
  at: Date = new Date(),
): TerminalResult {
  const okStatus = resp.status === VPI_STATUS_OK || resp.status === VPI_STATUS_MORE;
  const d = resp.data.length >= 50 ? parseTrxData(resp.data) : null;
  // Aprobado = status OK y código de host "00" (convención ISO 8583; inferido).
  const approved = okStatus && d?.hostCode === "00";
  return {
    approved,
    op,
    amount: ctx.amount,
    authCode: d?.authCode || null,
    lote: d?.lote || null,
    cupon: d?.cupon || null,
    cardBrand: ctx.cardBrandLabel ?? (d ? brandFromBin(d.first6) : null),
    cardType: null,
    last4: d?.last4 || null,
    installments: ctx.installments,
    merchantNumber: ctx.merchantNumber,
    terminalNumber: d?.terminalId || null,
    responseCode: okStatus ? (d?.hostCode ?? null) : resp.status,
    message: okStatus ? (d?.hostMessage ?? null) : (VPI_CODES[resp.status] ?? `Error de la terminal (${resp.status})`),
    raw: toHex(resp.raw),
    at: at.toISOString(),
  };
}

// ── Adaptador ───────────────────────────────────────────────────────────────

export interface PaywayOptions {
  cardCodes?: Record<string, string>;
  merchantNumber?: string | null;
  merchantName?: string;
  cuit?: string;
  /** Timeout de las operaciones con tarjeta (VPI "alto": 60 s). */
  trxTimeoutMs?: number;
  /** Timeout de comandos cortos (VPI "estándar": 3 s). */
  shortTimeoutMs?: number;
}

const BRAND_LABELS: Record<string, string> = {
  visa: "Visa",
  master: "Mastercard",
  amex: "American Express",
  cabal: "Cabal",
  naranja: "Naranja",
  maestro: "Maestro",
  diners: "Diners",
};

export class PaywayAdapter extends TransportAdapter {
  readonly key = "payway_lapos" as const;
  readonly label = "Payway";
  readonly specStatus = "unverified" as const;
  readonly capabilities: AdapterCapabilities = {
    void: true,
    refund: true,
    closeBatch: true,
    installments: true,
    cancelInFlight: false,
    requiresBrand: true,
    lastTransaction: true,
  };
  private readonly decoder = new VpiDecoder();
  private readonly queue: VpiResponse[] = [];
  private wake: (() => void) | null = null;
  private unsubRaw: (() => void) | null = null;
  private busy = false;
  private seq = 0;

  constructor(
    transport: ByteTransport,
    private readonly o: PaywayOptions = {},
  ) {
    super(transport);
  }

  override async connect(opts?: OpOptions): Promise<void> {
    if (opts?.signal?.aborted) throw abortError(opts.signal);
    if (!this.transport.isOpen) await this.transport.open();
    if (!this.unsubRaw) {
      this.unsubRaw = this.transport.onData((chunk) => {
        this.queue.push(...this.decoder.push(chunk));
        this.wake?.();
      });
    }
  }

  override async disconnect(): Promise<void> {
    this.unsubRaw?.();
    this.unsubRaw = null;
    await this.transport.close();
  }

  private async next(timeoutMs: number, signal?: AbortSignal): Promise<VpiResponse> {
    const deadline = Date.now() + timeoutMs;
    let flushAt = 0;
    for (;;) {
      if (signal?.aborted) throw abortError(signal);
      const r = this.queue.shift();
      if (r) return r;
      // Trama completa esperando un LRC que no llega: se entrega a los 150 ms.
      if (flushAt && Date.now() >= flushAt) {
        const f = this.decoder.flush();
        if (f.length) {
          this.queue.push(...f);
          continue;
        }
      }
      const left = deadline - Date.now();
      if (left <= 0) throw new TerminalError("timeout", "La terminal no respondió a tiempo");
      if (!flushAt) flushAt = Date.now() + 150;
      await new Promise<void>((resolve) => {
        const done = () => {
          clearTimeout(t);
          signal?.removeEventListener("abort", done);
          this.wake = null;
          resolve();
        };
        const t = setTimeout(done, Math.min(left, 150));
        signal?.addEventListener("abort", done, { once: true });
        this.wake = done;
      });
    }
  }

  /** ENQ + trama; espera la respuesta del mismo comando y la confirma con ACK. */
  private async exchange(cmd: VpiCommand, data: string, timeoutMs: number, opts: OpOptions = {}): Promise<VpiResponse> {
    if (!this.transport.isOpen) throw new TerminalError("not_connected", "La terminal no está conectada");
    if (this.busy) throw new TerminalError("busy", "La terminal tiene una operación en curso");
    this.busy = true;
    this.queue.length = 0;
    try {
      await this.transport.write(Uint8Array.of(ENQ));
      await this.transport.write(buildVpiRequest(cmd, data));
      opts.onEvent?.({ type: "sent" });
      for (;;) {
        const r = await this.next(timeoutMs, opts.signal);
        await this.transport.write(Uint8Array.of(ACK));
        if (r.command === cmd) return r;
      }
    } finally {
      this.busy = false;
    }
  }

  private cardCode(brand: string | null | undefined): string | null {
    if (!brand) return null;
    const c = this.o.cardCodes?.[brand];
    if (!c) {
      throw new TerminalError(
        "protocol",
        "Falta el código de esa tarjeta para la terminal (Configuración, Terminales, códigos de tarjeta).",
      );
    }
    return c;
  }

  private merchant(): VpiMerchant {
    return {
      merchantCode: this.o.merchantNumber ?? "",
      merchantName: this.o.merchantName ?? "",
      cuit: this.o.cuit ?? "",
    };
  }

  private receipt(reference: string): string {
    const d = reference.replace(/\D/g, "").slice(-12);
    return d || String(Date.now() % 1e12) + String(++this.seq % 10);
  }

  override async sale(req: SaleRequest, opts: OpOptions = {}): Promise<TerminalResult> {
    const cardCode = this.cardCode(req.cardBrand);
    opts.onEvent?.({ type: "prompt", message: "Seguí las indicaciones de la terminal" });
    const r = await this.exchange(
      "VEN",
      encodeSale({
        amount: req.amount,
        receipt: this.receipt(req.reference),
        installments: req.installments ?? 1,
        cardCode,
        ...this.merchant(),
      }),
      this.o.trxTimeoutMs ?? 60_000,
      opts,
    );
    return vpiToResult("sale", r, {
      amount: req.amount,
      installments: req.installments ?? 1,
      cardBrandLabel: req.cardBrand ? (BRAND_LABELS[req.cardBrand] ?? null) : null,
      merchantNumber: this.o.merchantNumber ?? null,
    });
  }

  override async void(req: VoidRequest, opts: OpOptions = {}): Promise<TerminalResult> {
    const r = await this.exchange(
      "ANV",
      encodeVoid({ cupon: req.cupon, cardCode: this.cardCode(req.cardBrand) }),
      this.o.trxTimeoutMs ?? 60_000,
      opts,
    );
    return vpiToResult("void", r, {
      amount: req.amount,
      installments: null,
      cardBrandLabel: req.cardBrand ? (BRAND_LABELS[req.cardBrand] ?? null) : null,
      merchantNumber: this.o.merchantNumber ?? null,
    });
  }

  override async refund(req: RefundRequest, opts: OpOptions = {}): Promise<TerminalResult> {
    const r = await this.exchange(
      "DEV",
      encodeRefund({
        amount: req.amount,
        cardCode: this.cardCode(req.cardBrand),
        installments: req.installments ?? 1,
        originalCupon: req.cupon ?? "",
        originalDate: req.originalDate ?? "",
        receipt: this.receipt(req.reference),
        ...this.merchant(),
      }),
      this.o.trxTimeoutMs ?? 60_000,
      opts,
    );
    return vpiToResult("refund", r, {
      amount: req.amount,
      installments: req.installments ?? null,
      cardBrandLabel: req.cardBrand ? (BRAND_LABELS[req.cardBrand] ?? null) : null,
      merchantNumber: this.o.merchantNumber ?? null,
    });
  }

  override async closeBatch(opts: OpOptions = {}): Promise<CloseBatchResult> {
    const r = await this.exchange("CIE", "", this.o.trxTimeoutMs ?? 60_000, opts);
    const ok = r.status === VPI_STATUS_OK || r.status === VPI_STATUS_MORE;
    // El detalle del cierre (vpiGetBatchCloseData) no tiene offsets públicos: queda en raw.
    return {
      ok,
      lote: null,
      count: null,
      total: null,
      message: ok ? "Cierre de lote enviado" : (VPI_CODES[r.status] ?? `Error de la terminal (${r.status})`),
      raw: toHex(r.raw),
      at: new Date().toISOString(),
    };
  }

  async lastTransaction(opts: OpOptions = {}): Promise<TerminalResult | null> {
    const r = await this.exchange("ULT", "", this.o.shortTimeoutMs ?? 10_000, opts);
    if (r.status !== VPI_STATUS_OK || r.data.length < 51) return null;
    // ULT antepone 1 byte de tipo (1 venta, 2 anulación, 3 devolución, 4 anulación de devolución).
    const tipo = latin1(r.data.subarray(0, 1));
    const op: TerminalOp = tipo === "2" || tipo === "4" ? "void" : tipo === "3" ? "refund" : "sale";
    const shifted: VpiResponse = { ...r, data: r.data.subarray(1) };
    return vpiToResult(op, shifted, {
      amount: null,
      installments: null,
      cardBrandLabel: null,
      merchantNumber: this.o.merchantNumber ?? null,
    });
  }

  override async status(opts: OpOptions = {}): Promise<TerminalStatus> {
    if (!this.transport.isOpen) return { connected: false, ready: false, message: "Desconectada" };
    try {
      const r = await this.exchange("TES", "", this.o.shortTimeoutMs ?? 3000, opts);
      return {
        connected: true,
        ready: r.status === VPI_STATUS_OK,
        message: r.status === VPI_STATUS_OK ? "Lista" : (VPI_CODES[r.status] ?? `Status ${r.status}`),
      };
    } catch (e) {
      return { connected: true, ready: false, message: e instanceof Error ? e.message : "Sin respuesta" };
    }
  }
}
