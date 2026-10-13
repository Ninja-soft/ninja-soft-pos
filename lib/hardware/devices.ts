// Balanza y cajón sobre los transportes de bytes de ADR-053 (ADR-063).
//
// Reusa los transportes de la terminal integrada (Web Serial, WebUSB y el
// puente local NinjaPOS de tools/bridge): el ByteTransport es el mismo para
// un posnet, una balanza o una impresora. Acá se arman según la
// configuración de la caja y se suman simuladores para probar sin hardware.

import type { ByteTransport } from "@/lib/payments/terminal/framing";
import {
  BRIDGE_DEFAULT_URL,
  BridgeTransport,
  DEFAULT_SERIAL,
  WebSerialTransport,
  WebUsbTransport,
} from "@/lib/payments/terminal/transports";
import { TerminalError } from "@/lib/payments/terminal/types";
import type { BridgeAuth, DrawerDevice, HardwarePairing, ScaleDevice } from "./config";
import { escposDrawerPulse } from "./drawer";
import { FrameSplitter, decodeCommand, parseFrame, type ScaleProtocolConfig } from "./scale/protocols";
import { DEFAULT_STABLE, StableDetector, netWeight, type StableOptions } from "./scale/stable";

export { TerminalError as HardwareError };

type Listener = (chunk: Uint8Array) => void;

// ── Simuladores ──────────────────────────────────────────────────────────────

/**
 * Balanza simulada: contesta como una balanza "genérica" con marca de
 * estabilidad ("US,GS,+0000.352kg" mientras se mueve, "ST,GS,..." quieta).
 * Sirve en modo continuo (manda sola) y a pedido (contesta cada escritura).
 */
export class ScaleSimulatorTransport implements ByteTransport {
  readonly kind = "memory" as const;
  private listeners = new Set<Listener>();
  private opened = false;
  private timer: ReturnType<typeof setInterval> | null = null;
  private target = 0.35;
  private settle = 0;

  constructor(
    private readonly continuousMs: number | null = 200,
    private readonly settleFrames = 4,
  ) {}

  get isOpen() {
    return this.opened;
  }

  /** Cambia el peso apoyado (kg): unas lecturas en movimiento y después quieto. */
  place(kg: number) {
    this.target = Math.max(0, Math.round(kg * 1000) / 1000);
    this.settle = this.settleFrames;
  }

  frame(): string {
    const moving = this.settle > 0;
    if (moving) this.settle -= 1;
    const noise = moving ? ((this.settle % 2 === 0 ? 1 : -1) * 0.004 * this.settle) : 0;
    const kg = Math.max(0, this.target + noise);
    const txt = `${moving ? "US" : "ST"},GS,+${kg.toFixed(3).padStart(9, "0")}kg`;
    return `${txt}\r\n`;
  }

  private emit() {
    const bytes = new TextEncoder().encode(this.frame());
    this.listeners.forEach((cb) => cb(bytes));
  }

  async open(): Promise<void> {
    this.opened = true;
    if (this.continuousMs) this.timer = setInterval(() => this.emit(), this.continuousMs);
  }

  async write(): Promise<void> {
    if (!this.opened) throw new TerminalError("not_connected", "La balanza simulada no está abierta");
    // A pedido: cada comando recibe una trama.
    setTimeout(() => this.emit(), 10);
  }

  onData(cb: Listener): () => void {
    this.listeners.add(cb);
    return () => this.listeners.delete(cb);
  }

  async close(): Promise<void> {
    this.opened = false;
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }
}

/** Impresora / cajón simulado: guarda lo que recibe (para pruebas y demos). */
export class DrawerSimulatorTransport implements ByteTransport {
  readonly kind = "memory" as const;
  readonly received: Uint8Array[] = [];
  private opened = false;
  get isOpen() {
    return this.opened;
  }
  async open() {
    this.opened = true;
  }
  async write(data: Uint8Array) {
    this.received.push(data);
  }
  onData() {
    return () => {};
  }
  async close() {
    this.opened = false;
  }
}

// ── Fábrica de transportes ──────────────────────────────────────────────────

function bridgeTransport(
  auth: BridgeAuth | null,
  target: DrawerDevice["bridge"],
  serial: { baudRate: number },
): ByteTransport {
  if (!auth) throw new TerminalError("bridge_auth", "Falta emparejar el puente local en esta PC");
  if (!target) throw new TerminalError("not_connected", "Falta el puerto o la IP para el puente local");
  return new BridgeTransport({
    url: auth.url || BRIDGE_DEFAULT_URL,
    token: auth.token,
    target: target.kind === "serial" ? { kind: "serial", path: target.path, baudRate: serial.baudRate } : target,
  });
}

export function scaleTransport(
  s: ScaleDevice,
  pairing: HardwarePairing | null,
  bridge: BridgeAuth | null,
): ByteTransport {
  if (s.transport === "simulator") return new ScaleSimulatorTransport(s.protocol.mode === "continuous" ? 200 : null);
  if (s.transport === "bridge") return bridgeTransport(bridge, s.bridge, s.serial);
  if (!pairing?.device) throw new TerminalError("not_connected", "Falta emparejar la balanza en esta PC");
  return new WebSerialTransport(pairing.device, s.serial);
}

export function drawerTransport(
  d: DrawerDevice,
  pairing: HardwarePairing | null,
  bridge: BridgeAuth | null,
): ByteTransport {
  if (d.transport === "simulator") return new DrawerSimulatorTransport();
  if (d.transport === "bridge") return bridgeTransport(bridge, d.bridge, { baudRate: d.baud });
  if (d.transport === "none") throw new TerminalError("not_connected", "El cajón de esta caja no está configurado");
  if (!pairing?.device) throw new TerminalError("not_connected", "Falta emparejar la impresora del cajón en esta PC");
  if (d.transport === "webusb") return new WebUsbTransport(pairing.device);
  return new WebSerialTransport(pairing.device, { ...DEFAULT_SERIAL, baudRate: d.baud });
}

// ── Cajón ────────────────────────────────────────────────────────────────────

/**
 * Manda el pulso ESC/POS. Llamar SÓLO con la apertura ya autorizada por el
 * servidor (cash_drawer_open → allowed). Abre, escribe y cierra el puerto:
 * la impresión sigue por su camino (web print) y no queda el puerto tomado.
 */
export async function kickDrawer(d: DrawerDevice, transport: ByteTransport): Promise<void> {
  const wasOpen = transport.isOpen;
  if (!wasOpen) await transport.open();
  try {
    await transport.write(escposDrawerPulse(d.pin, d.onMs, d.offMs));
    // El puente y algunas impresoras necesitan un instante antes de cerrar.
    await new Promise((r) => setTimeout(r, 80));
  } finally {
    if (!wasOpen) await transport.close();
  }
}

// ── Lectura de la balanza ───────────────────────────────────────────────────

export interface ScaleReading {
  grossKg: number;
  netKg: number;
  tareKg: number;
  stable: boolean;
  at: number;
  /** Última trama cruda (diagnóstico). */
  raw: string;
}

export type ScaleStatus = "idle" | "connecting" | "reading" | "error";

/**
 * Lee la balanza: abre el transporte, pide el peso (modo poll) o escucha
 * (continuo), interpreta cada trama y avisa el peso neto y si está estable.
 */
export class ScaleReader {
  private splitter = new FrameSplitter();
  private detector: StableDetector;
  private off: (() => void) | null = null;
  private poll: ReturnType<typeof setInterval> | null = null;
  private listeners = new Set<(r: ScaleReading) => void>();
  private errorListeners = new Set<(e: string) => void>();
  private tare = 0;
  private last: ScaleReading | null = null;
  private lastFrameAt = 0;

  constructor(
    readonly transport: ByteTransport,
    private readonly cfg: ScaleProtocolConfig,
    stable: StableOptions = DEFAULT_STABLE,
    private readonly now: () => number = () => Date.now(),
  ) {
    this.detector = new StableDetector(stable);
  }

  get reading(): ScaleReading | null {
    return this.last;
  }

  get tareKg(): number {
    return this.tare;
  }

  onReading(cb: (r: ScaleReading) => void): () => void {
    this.listeners.add(cb);
    return () => this.listeners.delete(cb);
  }

  onError(cb: (e: string) => void): () => void {
    this.errorListeners.add(cb);
    return () => this.errorListeners.delete(cb);
  }

  /** Procesa bytes (público para tests y para transportes externos). */
  feed(chunk: Uint8Array): void {
    for (const frame of this.splitter.push(chunk)) {
      const r = parseFrame(frame, this.cfg);
      if ("error" in r) {
        if (r.error !== "no_match") this.errorListeners.forEach((cb) => cb(r.error));
        continue;
      }
      const at = this.now();
      this.lastFrameAt = at;
      const stable = this.detector.push({ weightKg: r.weightKg, at, stableFlag: r.stableFlag });
      this.last = {
        grossKg: r.weightKg,
        netKg: netWeight(r.weightKg, this.tare),
        tareKg: this.tare,
        stable,
        at,
        raw: frame,
      };
      const out = this.last;
      this.listeners.forEach((cb) => cb(out));
    }
  }

  async start(): Promise<void> {
    await this.transport.open();
    this.off = this.transport.onData((c) => this.feed(c));
    if (this.cfg.mode === "poll") {
      const cmd = decodeCommand(this.cfg.pollCommand);
      const ask = () => {
        if (!this.transport.isOpen) return;
        this.transport.write(cmd).catch(() => this.errorListeners.forEach((cb) => cb("write_failed")));
      };
      ask();
      this.poll = setInterval(ask, Math.max(100, this.cfg.pollMs));
    }
  }

  /** Milisegundos desde la última trama válida (para "la balanza no responde"). */
  silenceMs(): number {
    return this.lastFrameAt ? this.now() - this.lastFrameAt : Infinity;
  }

  /** Tara con el peso bruto actual (envase apoyado). */
  tareNow(): number {
    this.tare = Math.max(0, this.last?.grossKg ?? 0);
    this.detector.reset();
    return this.tare;
  }

  setTare(kg: number): void {
    this.tare = Math.max(0, Math.round(kg * 1000) / 1000);
    this.detector.reset();
  }

  async stop(): Promise<void> {
    if (this.poll) clearInterval(this.poll);
    this.poll = null;
    this.off?.();
    this.off = null;
    this.splitter.reset();
    this.detector.reset();
    try {
      await this.transport.close();
    } catch {
      /* ya cerrado */
    }
  }
}
