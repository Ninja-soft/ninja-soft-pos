// Framing genérico de enlace serie para terminales de tarjeta (ADR-053).
//
// Muchos protocolos de "caja integrada" sobre RS-232 / USB-CDC usan el
// esquema de enlace clásico de ISO 1745: STX + datos + ETX + LRC (XOR de los
// bytes desde después del STX hasta el ETX inclusive), con ACK / NAK de un
// byte para confirmar cada trama y reintentos acotados. Este módulo
// implementa ese esquema de forma PARAMETRIZABLE (bytes de control, qué
// entra en el LRC, reintentos, tiempos) para que cada adaptador lo configure
// con los valores de SU especificación.
//
// IMPORTANTE: que un adquirente concreto (Payway, Fiserv, Getnet) use este
// esquema y con qué parámetros NO está verificado públicamente; los
// adaptadores lo marcan como pendiente del kit de integradores.

import { TerminalError, abortError, type TerminalEvent } from "./types";

export const STX = 0x02;
export const ETX = 0x03;
export const EOT = 0x04;
export const ACK = 0x06;
export const NAK = 0x15;

export interface FramingOptions {
  stx: number;
  etx: number;
  /** ¿El LRC incluye el STX? (ISO 1745: no). */
  lrcIncludesStx: boolean;
  /** ¿El LRC incluye el ETX? (ISO 1745: sí). */
  lrcIncludesEtx: boolean;
  /** Sin LRC (algunos protocolos usan CRC o nada). */
  noLrc?: boolean;
}

export const ISO1745: FramingOptions = { stx: STX, etx: ETX, lrcIncludesStx: false, lrcIncludesEtx: true };

const enc = new TextEncoder();
const dec = new TextDecoder("latin1");

export function toBytes(s: string): Uint8Array {
  return enc.encode(s);
}

export function latin1(bytes: Uint8Array): string {
  return dec.decode(bytes);
}

export function toHex(bytes: Uint8Array): string {
  return Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join(" ");
}

export function lrc(bytes: Uint8Array): number {
  let x = 0;
  for (const b of bytes) x ^= b;
  return x;
}

/** Arma STX + payload + ETX (+ LRC). */
export function encodeFrame(payload: Uint8Array, o: FramingOptions = ISO1745): Uint8Array {
  const out = new Uint8Array(payload.length + (o.noLrc ? 2 : 3));
  out[0] = o.stx;
  out.set(payload, 1);
  out[payload.length + 1] = o.etx;
  if (!o.noLrc) {
    const from = o.lrcIncludesStx ? 0 : 1;
    const to = o.lrcIncludesEtx ? payload.length + 2 : payload.length + 1;
    out[payload.length + 2] = lrc(out.subarray(from, to));
  }
  return out;
}

export type DecodedItem =
  | { type: "frame"; payload: Uint8Array; valid: boolean }
  | { type: "ack" }
  | { type: "nak" }
  | { type: "eot" };

/**
 * Decodificador incremental: se le empujan los bytes como llegan (en
 * cualquier partición) y devuelve tramas completas y ACK / NAK / EOT sueltos.
 * Los bytes fuera de trama que no son de control se descartan.
 */
export class FrameDecoder {
  private buf: number[] = [];
  private inFrame = false;
  private awaitingLrc = false;

  constructor(private readonly o: FramingOptions = ISO1745) {}

  push(chunk: Uint8Array): DecodedItem[] {
    const out: DecodedItem[] = [];
    for (const b of chunk) {
      if (this.awaitingLrc) {
        out.push(this.finish(b));
        continue;
      }
      if (!this.inFrame) {
        if (b === this.o.stx) {
          this.inFrame = true;
          this.buf = [];
        } else if (b === ACK) out.push({ type: "ack" });
        else if (b === NAK) out.push({ type: "nak" });
        else if (b === EOT) out.push({ type: "eot" });
        continue;
      }
      if (b === this.o.etx) {
        if (this.o.noLrc) out.push(this.finish(null));
        else this.awaitingLrc = true;
        continue;
      }
      this.buf.push(b);
    }
    return out;
  }

  private finish(got: number | null): DecodedItem {
    const payload = Uint8Array.from(this.buf);
    let valid = true;
    if (got != null) {
      const parts: number[] = [];
      if (this.o.lrcIncludesStx) parts.push(this.o.stx);
      parts.push(...this.buf);
      if (this.o.lrcIncludesEtx) parts.push(this.o.etx);
      valid = lrc(Uint8Array.from(parts)) === got;
    }
    this.buf = [];
    this.inFrame = false;
    this.awaitingLrc = false;
    return { type: "frame", payload, valid };
  }
}

/** Transporte de bytes (Web Serial, WebUSB, puente local o memoria). */
export interface ByteTransport {
  readonly kind: "webserial" | "webusb" | "bridge" | "memory";
  readonly isOpen: boolean;
  open(): Promise<void>;
  close(): Promise<void>;
  write(data: Uint8Array): Promise<void>;
  /** Suscribe a los bytes entrantes; devuelve la baja. */
  onData(cb: (chunk: Uint8Array) => void): () => void;
}

export interface LinkOptions {
  framing?: FramingOptions;
  /** Espera del ACK de cada trama enviada. */
  ackTimeoutMs?: number;
  /** Reintentos ante NAK o sin ACK. */
  maxRetries?: number;
}

/**
 * Sesión de enlace sobre un transporte: manda una trama y espera ACK (con
 * reintentos), y espera tramas de respuesta validando el LRC (ACK si está
 * bien, NAK si no). Es la capa que los adaptadores de protocolo reutilizan.
 */
export class LinkSession {
  private readonly decoder: FrameDecoder;
  private readonly queue: DecodedItem[] = [];
  private waiters: (() => void)[] = [];
  private unsub: (() => void) | null = null;
  readonly framing: FramingOptions;
  readonly ackTimeoutMs: number;
  readonly maxRetries: number;

  constructor(
    private readonly transport: ByteTransport,
    o: LinkOptions = {},
  ) {
    this.framing = o.framing ?? ISO1745;
    this.decoder = new FrameDecoder(this.framing);
    this.ackTimeoutMs = o.ackTimeoutMs ?? 2000;
    this.maxRetries = o.maxRetries ?? 3;
  }

  attach(): void {
    if (this.unsub) return;
    this.unsub = this.transport.onData((chunk) => {
      this.queue.push(...this.decoder.push(chunk));
      const w = this.waiters;
      this.waiters = [];
      w.forEach((f) => f());
    });
  }

  detach(): void {
    this.unsub?.();
    this.unsub = null;
  }

  /** Próximo ítem decodificado (o timeout / cancelación). */
  async next(timeoutMs: number, signal?: AbortSignal): Promise<DecodedItem> {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      if (signal?.aborted) throw abortError(signal);
      const item = this.queue.shift();
      if (item) return item;
      const left = deadline - Date.now();
      if (left <= 0) throw new TerminalError("timeout", "La terminal no respondió a tiempo");
      await new Promise<void>((resolve) => {
        const done = () => {
          clearTimeout(t);
          signal?.removeEventListener("abort", done);
          resolve();
        };
        const t = setTimeout(done, left);
        signal?.addEventListener("abort", done, { once: true });
        this.waiters.push(done);
      });
    }
  }

  /** Envía una trama y espera su ACK; NAK o silencio reintentan. */
  async send(payload: Uint8Array, signal?: AbortSignal, onEvent?: (e: TerminalEvent) => void): Promise<void> {
    const frame = encodeFrame(payload, this.framing);
    for (let attempt = 0; attempt <= this.maxRetries; attempt++) {
      if (attempt > 0) onEvent?.({ type: "retry", attempt });
      await this.transport.write(frame);
      onEvent?.({ type: "sent" });
      try {
        // Ignora tramas viejas hasta el ACK / NAK de ésta.
        for (;;) {
          const it = await this.next(this.ackTimeoutMs, signal);
          if (it.type === "ack") {
            onEvent?.({ type: "ack" });
            return;
          }
          if (it.type === "nak") break;
        }
      } catch (e) {
        if (e instanceof TerminalError && e.code === "timeout") continue;
        throw e;
      }
    }
    throw new TerminalError("protocol", "La terminal no confirmó el mensaje");
  }

  /** Espera una trama de datos válida (ACK automático; NAK y espera si el LRC falla). */
  async receive(timeoutMs: number, signal?: AbortSignal): Promise<Uint8Array> {
    const deadline = Date.now() + timeoutMs;
    let bad = 0;
    for (;;) {
      const it = await this.next(Math.max(0, deadline - Date.now()), signal);
      if (it.type !== "frame") continue;
      if (it.valid) {
        await this.transport.write(Uint8Array.of(ACK));
        return it.payload;
      }
      await this.transport.write(Uint8Array.of(NAK));
      if (++bad > this.maxRetries) throw new TerminalError("protocol", "Respuesta dañada de la terminal");
    }
  }
}

/** Par de transportes en memoria conectados entre sí (tests y simulaciones). */
export function memoryPair(): [ByteTransport, ByteTransport] {
  const subs: [Set<(c: Uint8Array) => void>, Set<(c: Uint8Array) => void>] = [new Set(), new Set()];
  const make = (me: 0 | 1): ByteTransport => {
    let open = false;
    return {
      kind: "memory",
      get isOpen() {
        return open;
      },
      async open() {
        open = true;
      },
      async close() {
        open = false;
      },
      async write(data) {
        if (!open) throw new TerminalError("not_connected");
        const copy = Uint8Array.from(data);
        // Asíncrono como un puerto real.
        queueMicrotask(() => subs[me === 0 ? 1 : 0].forEach((cb) => cb(copy)));
      },
      onData(cb) {
        subs[me].add(cb);
        return () => subs[me].delete(cb);
      },
    };
  };
  return [make(0), make(1)];
}
