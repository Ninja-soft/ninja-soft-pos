// Transportes de bytes del navegador hacia la terminal (ADR-053).
//
//   • Web Serial (Chrome / Edge de escritorio): pinpads y posnets con cable
//     serie o USB que el sistema ve como puerto COM (USB-CDC o adaptador).
//   • WebUSB: dispositivos USB "vendor specific" sin driver de puerto serie
//     del sistema (en Windows un dispositivo con driver COM no se puede
//     reclamar por WebUSB: para esos, Web Serial).
//   • Puente local NinjaPOS: WebSocket en 127.0.0.1 con token de
//     emparejamiento (tools/bridge). Para posnets por LAN (TCP), navegadores
//     sin Web Serial o equipos donde el puerto lo maneja otro proceso.
//
// Todo requiere contexto seguro (https o localhost) y, para pedir permiso al
// puerto o al dispositivo, un gesto del usuario (clic).

import { TerminalError } from "./types";
import type { ByteTransport } from "./framing";

// ── Tipos mínimos de Web Serial / WebUSB (no están en lib.dom de TS) ────────

interface SerialPortInfoLite {
  usbVendorId?: number;
  usbProductId?: number;
}
interface SerialOptionsLite {
  baudRate: number;
  dataBits?: 7 | 8;
  stopBits?: 1 | 2;
  parity?: "none" | "even" | "odd";
  flowControl?: "none" | "hardware";
}
interface SerialPortLite {
  readonly readable: ReadableStream<Uint8Array> | null;
  readonly writable: WritableStream<Uint8Array> | null;
  open(o: SerialOptionsLite): Promise<void>;
  close(): Promise<void>;
  getInfo(): SerialPortInfoLite;
}
interface SerialLite {
  requestPort(o?: { filters?: SerialPortInfoLite[] }): Promise<SerialPortLite>;
  getPorts(): Promise<SerialPortLite[]>;
}
interface USBEndpointLite {
  endpointNumber: number;
  direction: "in" | "out";
  type: "bulk" | "interrupt" | "isochronous";
  packetSize: number;
}
interface USBInterfaceLite {
  interfaceNumber: number;
  alternate: { interfaceClass: number; endpoints: USBEndpointLite[] };
}
interface USBDeviceLite {
  vendorId: number;
  productId: number;
  productName?: string;
  serialNumber?: string;
  opened: boolean;
  configuration: { interfaces: USBInterfaceLite[] } | null;
  open(): Promise<void>;
  close(): Promise<void>;
  selectConfiguration(n: number): Promise<void>;
  claimInterface(n: number): Promise<void>;
  releaseInterface(n: number): Promise<void>;
  transferIn(ep: number, len: number): Promise<{ data?: DataView; status: string }>;
  transferOut(ep: number, data: Uint8Array): Promise<{ status: string }>;
}
interface USBLite {
  requestDevice(o: { filters: { vendorId?: number; productId?: number }[] }): Promise<USBDeviceLite>;
  getDevices(): Promise<USBDeviceLite[]>;
}

function serialApi(): SerialLite | null {
  if (typeof navigator === "undefined") return null;
  return ((navigator as unknown as { serial?: SerialLite }).serial ?? null) as SerialLite | null;
}
function usbApi(): USBLite | null {
  if (typeof navigator === "undefined") return null;
  return ((navigator as unknown as { usb?: USBLite }).usb ?? null) as USBLite | null;
}

export function transportSupport(): { webserial: boolean; webusb: boolean; secure: boolean } {
  const secure = typeof window !== "undefined" && window.isSecureContext;
  return { webserial: Boolean(serialApi()), webusb: Boolean(usbApi()), secure };
}

// ── Emparejamiento (gesto del usuario) ──────────────────────────────────────

/** Identidad del dispositivo emparejado en ESTA PC (se guarda en el equipo). */
export interface DeviceMatch {
  vendorId: number | null;
  productId: number | null;
  /** Índice entre los puertos con la misma identidad (dos pinpads iguales). */
  index: number;
  /** Nombre legible (WebUSB) o "USB 0b00:0074". */
  name: string;
  serialNumber?: string | null;
}

const hex4 = (n: number | undefined | null) => (n == null ? "????" : n.toString(16).padStart(4, "0"));

function permissionError(e: unknown): TerminalError {
  const name = e instanceof Error ? e.name : "";
  if (name === "NotFoundError") return new TerminalError("cancelled", "No se eligió ningún dispositivo");
  if (name === "SecurityError") return new TerminalError("permission_denied", "El navegador no dio permiso");
  return new TerminalError("transport", e instanceof Error ? e.message : "Error del dispositivo");
}

export async function pairSerialPort(filters: SerialPortInfoLite[] = []): Promise<DeviceMatch> {
  const api = serialApi();
  if (!api) throw new TerminalError("unsupported", "Este navegador no soporta Web Serial (usá Chrome o Edge de escritorio)");
  let port: SerialPortLite;
  try {
    port = await api.requestPort(filters.length ? { filters } : undefined);
  } catch (e) {
    throw permissionError(e);
  }
  const info = port.getInfo();
  const all = await api.getPorts();
  const same = all.filter((p) => {
    const i = p.getInfo();
    return i.usbVendorId === info.usbVendorId && i.usbProductId === info.usbProductId;
  });
  return {
    vendorId: info.usbVendorId ?? null,
    productId: info.usbProductId ?? null,
    index: Math.max(0, same.indexOf(port)),
    name: info.usbVendorId != null ? `USB ${hex4(info.usbVendorId)}:${hex4(info.usbProductId)}` : "Puerto serie",
  };
}

export async function pairUsbDevice(filters: { vendorId?: number; productId?: number }[] = []): Promise<DeviceMatch> {
  const api = usbApi();
  if (!api) throw new TerminalError("unsupported", "Este navegador no soporta WebUSB (usá Chrome o Edge de escritorio)");
  let dev: USBDeviceLite;
  try {
    dev = await api.requestDevice({ filters });
  } catch (e) {
    throw permissionError(e);
  }
  return {
    vendorId: dev.vendorId,
    productId: dev.productId,
    index: 0,
    name: dev.productName || `USB ${hex4(dev.vendorId)}:${hex4(dev.productId)}`,
    serialNumber: dev.serialNumber ?? null,
  };
}

// ── Web Serial ──────────────────────────────────────────────────────────────

export interface SerialSettings {
  baudRate: number;
  dataBits: 7 | 8;
  stopBits: 1 | 2;
  parity: "none" | "even" | "odd";
  flowControl: "none" | "hardware";
}

export const DEFAULT_SERIAL: SerialSettings = {
  baudRate: 9600,
  dataBits: 8,
  stopBits: 1,
  parity: "none",
  flowControl: "none",
};

type Listener = (chunk: Uint8Array) => void;

export class WebSerialTransport implements ByteTransport {
  readonly kind = "webserial" as const;
  private port: SerialPortLite | null = null;
  private reader: ReadableStreamDefaultReader<Uint8Array> | null = null;
  private listeners = new Set<Listener>();
  private opened = false;

  constructor(
    private readonly match: DeviceMatch,
    private readonly settings: SerialSettings = DEFAULT_SERIAL,
  ) {}

  get isOpen() {
    return this.opened;
  }

  async open(): Promise<void> {
    if (this.opened) return;
    const api = serialApi();
    if (!api) throw new TerminalError("unsupported", "Este navegador no soporta Web Serial");
    const ports = (await api.getPorts()).filter((p) => {
      const i = p.getInfo();
      return (
        (this.match.vendorId == null || i.usbVendorId === this.match.vendorId) &&
        (this.match.productId == null || i.usbProductId === this.match.productId)
      );
    });
    const port = ports[this.match.index] ?? ports[0];
    if (!port) throw new TerminalError("not_connected", "No encontramos el dispositivo: conectalo y volvé a emparejarlo");
    try {
      await port.open({ ...this.settings });
    } catch (e) {
      // InvalidStateError = ya abierto (otra pestaña u otro programa).
      const name = e instanceof Error ? e.name : "";
      throw new TerminalError(
        name === "InvalidStateError" ? "busy" : "transport",
        name === "InvalidStateError"
          ? "El puerto está en uso por otra pestaña o programa"
          : "No se pudo abrir el puerto",
      );
    }
    this.port = port;
    this.opened = true;
    void this.readLoop();
  }

  private async readLoop(): Promise<void> {
    while (this.opened && this.port?.readable) {
      const reader = this.port.readable.getReader();
      this.reader = reader;
      try {
        for (;;) {
          const { value, done } = await reader.read();
          if (done) break;
          if (value?.length) this.listeners.forEach((cb) => cb(value));
        }
      } catch {
        // Error transitorio (framing, break): se reabre el reader.
      } finally {
        reader.releaseLock();
        this.reader = null;
      }
    }
  }

  async write(data: Uint8Array): Promise<void> {
    if (!this.port?.writable) throw new TerminalError("not_connected", "El puerto no está abierto");
    const w = this.port.writable.getWriter();
    try {
      await w.write(data);
    } finally {
      w.releaseLock();
    }
  }

  onData(cb: Listener): () => void {
    this.listeners.add(cb);
    return () => this.listeners.delete(cb);
  }

  async close(): Promise<void> {
    this.opened = false;
    try {
      await this.reader?.cancel();
    } catch {
      /* ya cerrado */
    }
    try {
      await this.port?.close();
    } catch {
      /* ya cerrado */
    }
    this.port = null;
  }
}

// ── WebUSB (bulk IN / OUT) ──────────────────────────────────────────────────

export class WebUsbTransport implements ByteTransport {
  readonly kind = "webusb" as const;
  private dev: USBDeviceLite | null = null;
  private iface = -1;
  private epIn = -1;
  private epOut = -1;
  private packet = 64;
  private listeners = new Set<Listener>();
  private opened = false;

  constructor(private readonly match: DeviceMatch) {}

  get isOpen() {
    return this.opened;
  }

  async open(): Promise<void> {
    if (this.opened) return;
    const api = usbApi();
    if (!api) throw new TerminalError("unsupported", "Este navegador no soporta WebUSB");
    const devs = (await api.getDevices()).filter(
      (d) =>
        (this.match.vendorId == null || d.vendorId === this.match.vendorId) &&
        (this.match.productId == null || d.productId === this.match.productId) &&
        (!this.match.serialNumber || d.serialNumber === this.match.serialNumber),
    );
    const dev = devs[this.match.index] ?? devs[0];
    if (!dev) throw new TerminalError("not_connected", "No encontramos el dispositivo: conectalo y volvé a emparejarlo");
    try {
      if (!dev.opened) await dev.open();
      if (!dev.configuration) await dev.selectConfiguration(1);
      const ifaces = dev.configuration?.interfaces ?? [];
      // Primera interfaz con un bulk IN y un bulk OUT.
      for (const i of ifaces) {
        const eps = i.alternate.endpoints.filter((e) => e.type === "bulk");
        const inn = eps.find((e) => e.direction === "in");
        const out = eps.find((e) => e.direction === "out");
        if (inn && out) {
          this.iface = i.interfaceNumber;
          this.epIn = inn.endpointNumber;
          this.epOut = out.endpointNumber;
          this.packet = inn.packetSize || 64;
          break;
        }
      }
      if (this.iface < 0) throw new TerminalError("unsupported", "El dispositivo no expone un canal de datos USB");
      await dev.claimInterface(this.iface);
    } catch (e) {
      if (e instanceof TerminalError) throw e;
      throw new TerminalError(
        "busy",
        "No se pudo tomar el dispositivo USB (en Windows, si tiene driver de puerto COM, usá Web Serial)",
      );
    }
    this.dev = dev;
    this.opened = true;
    void this.readLoop();
  }

  private async readLoop(): Promise<void> {
    while (this.opened && this.dev) {
      try {
        const r = await this.dev.transferIn(this.epIn, this.packet);
        if (r.data && r.data.byteLength > 0) {
          const chunk = new Uint8Array(r.data.buffer, r.data.byteOffset, r.data.byteLength).slice();
          this.listeners.forEach((cb) => cb(chunk));
        }
      } catch {
        if (!this.opened) break;
        await new Promise((r) => setTimeout(r, 50));
      }
    }
  }

  async write(data: Uint8Array): Promise<void> {
    if (!this.dev) throw new TerminalError("not_connected", "El dispositivo no está abierto");
    await this.dev.transferOut(this.epOut, data);
  }

  onData(cb: Listener): () => void {
    this.listeners.add(cb);
    return () => this.listeners.delete(cb);
  }

  async close(): Promise<void> {
    this.opened = false;
    try {
      if (this.dev && this.iface >= 0) await this.dev.releaseInterface(this.iface);
      await this.dev?.close();
    } catch {
      /* ya cerrado */
    }
    this.dev = null;
  }
}

// ── Puente local NinjaPOS (tools/bridge, protocolo en su README) ────────────

export const BRIDGE_DEFAULT_URL = "ws://127.0.0.1:47800";
export const BRIDGE_PROTOCOL_VERSION = 1;

/** Destino que el puente abre del lado de la PC. */
export type BridgeTarget =
  | ({ kind: "serial"; path: string } & Partial<SerialSettings>)
  | { kind: "tcp"; host: string; port: number };

export interface BridgeConfig {
  url: string;
  token: string;
  target: BridgeTarget;
}

/** Mensajes del protocolo del puente (JSON por WebSocket). */
export type BridgeMessage =
  | { type: "hello"; token: string; client: string; version: number }
  | { type: "welcome"; version: number; bridge: string }
  | { type: "open"; target: BridgeTarget }
  | { type: "opened" }
  | { type: "data"; b64: string }
  | { type: "close" }
  | { type: "closed"; reason?: string }
  | { type: "list" }
  | { type: "devices"; serial: { path: string; manufacturer?: string; vendorId?: string; productId?: string }[] }
  | { type: "error"; code: string; message?: string };

export function b64encode(bytes: Uint8Array): string {
  let s = "";
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s);
}
export function b64decode(s: string): Uint8Array {
  const bin = atob(s);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

type WsLike = {
  readyState: number;
  send(d: string): void;
  close(): void;
  onopen: ((ev: unknown) => void) | null;
  onmessage: ((ev: { data: unknown }) => void) | null;
  onclose: ((ev: unknown) => void) | null;
  onerror: ((ev: unknown) => void) | null;
};

export class BridgeTransport implements ByteTransport {
  readonly kind = "bridge" as const;
  private ws: WsLike | null = null;
  private listeners = new Set<Listener>();
  private opened = false;
  private pending: ((m: BridgeMessage) => void) | null = null;

  constructor(
    private readonly cfg: BridgeConfig,
    private readonly wsFactory: (url: string) => WsLike = (u) => new WebSocket(u) as unknown as WsLike,
    private readonly handshakeMs = 5000,
  ) {}

  get isOpen() {
    return this.opened;
  }

  private expect(types: BridgeMessage["type"][]): Promise<BridgeMessage> {
    return new Promise((resolve, reject) => {
      const t = setTimeout(() => {
        this.pending = null;
        reject(new TerminalError("timeout", "El puente local no respondió"));
      }, this.handshakeMs);
      this.pending = (m) => {
        if (m.type === "error") {
          clearTimeout(t);
          this.pending = null;
          reject(
            new TerminalError(
              m.code === "bad_token" || m.code === "origin_not_allowed" ? "bridge_auth" : "transport",
              m.message ?? m.code,
            ),
          );
        } else if (types.includes(m.type)) {
          clearTimeout(t);
          this.pending = null;
          resolve(m);
        }
      };
    });
  }

  async open(): Promise<void> {
    if (this.opened) return;
    const ws = this.wsFactory(this.cfg.url);
    this.ws = ws;
    await new Promise<void>((resolve, reject) => {
      ws.onopen = () => resolve();
      ws.onerror = () =>
        reject(new TerminalError("not_connected", "No se encontró el puente local: ¿está abierto en esta PC?"));
    });
    ws.onmessage = (ev) => {
      let m: BridgeMessage;
      try {
        m = JSON.parse(String(ev.data)) as BridgeMessage;
      } catch {
        return;
      }
      if (m.type === "data") {
        const bytes = b64decode(m.b64);
        this.listeners.forEach((cb) => cb(bytes));
        return;
      }
      if (m.type === "closed") this.opened = false;
      this.pending?.(m);
    };
    ws.onclose = () => {
      this.opened = false;
    };
    const welcome = this.expect(["welcome"]);
    this.sendMsg({ type: "hello", token: this.cfg.token, client: "ninjapos-web", version: BRIDGE_PROTOCOL_VERSION });
    await welcome;
    const opened = this.expect(["opened"]);
    this.sendMsg({ type: "open", target: this.cfg.target });
    await opened;
    this.opened = true;
  }

  private sendMsg(m: BridgeMessage) {
    this.ws?.send(JSON.stringify(m));
  }

  async write(data: Uint8Array): Promise<void> {
    if (!this.opened) throw new TerminalError("not_connected", "El puente local no está conectado");
    this.sendMsg({ type: "data", b64: b64encode(data) });
  }

  onData(cb: Listener): () => void {
    this.listeners.add(cb);
    return () => this.listeners.delete(cb);
  }

  async close(): Promise<void> {
    if (this.ws) {
      try {
        this.sendMsg({ type: "close" });
        this.ws.close();
      } catch {
        /* ya cerrado */
      }
    }
    this.ws = null;
    this.opened = false;
  }
}
