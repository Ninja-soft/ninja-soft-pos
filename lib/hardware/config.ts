// Configuración de balanza y cajón (ADR-063). PURO salvo el emparejamiento.
//
// Dos niveles, con una regla simple para el dueño:
//
//   • QUÉ HACE EL NEGOCIO (por negocio, grupo o sucursal; herencia ADR-049):
//     vende pesables, cómo son sus etiquetas de balanza, si el cajón se abre
//     al cobrar en efectivo y si se puede abrir sin venta.
//     → pos_settings.scale_enabled / scale_label / drawer_open_on_cash /
//       drawer_no_sale, con overrides de grupo o sucursal.
//   • QUÉ TIENE ENCHUFADO CADA CAJA (por caja): la balanza (modelo, conexión,
//     protocolo) y el cajón (impresora que lo abre, pulso, o "sin cajón").
//     → register_hardware (registro de equipos, como terminales e impresoras).
//   • LO DE ESTA PC (navegador): qué puerto USB o serie se emparejó y el
//     token del puente local. El permiso de Web Serial / WebUSB es del
//     navegador y del equipo: no se guarda en la base.

import { DEFAULT_SERIAL, type DeviceMatch, type SerialSettings } from "@/lib/payments/terminal/transports";
import { DEFAULT_SCALE_FORMAT, parseScaleFormat, type ScaleLabelFormat } from "@/lib/barcode/scaleLabel";
import { parseDrawerPolicy, type DrawerPin, type DrawerPolicy } from "./drawer";
import {
  SCALE_PROTOCOLS,
  protocolDefaults,
  type ScaleMode,
  type ScaleProtocol,
  type ScaleProtocolConfig,
  type ScaleUnit,
} from "./scale/protocols";

// ── Nivel negocio / sucursal ─────────────────────────────────────────────────

export interface StoreHardware {
  scaleEnabled: boolean;
  scaleFormat: ScaleLabelFormat;
  drawer: DrawerPolicy;
}

export const DEFAULT_STORE_HARDWARE: StoreHardware = {
  scaleEnabled: false,
  scaleFormat: DEFAULT_SCALE_FORMAT,
  drawer: { openOnCash: true, noSale: "pin" },
};

/** De la configuración efectiva de pos_settings (con herencia ya aplicada). */
export function parseStoreHardware(eff: Record<string, unknown> | null | undefined): StoreHardware {
  return {
    scaleEnabled: eff?.scale_enabled === true,
    scaleFormat: parseScaleFormat(eff?.scale_label),
    drawer: parseDrawerPolicy(eff ?? null),
  };
}

/** Campos de pos_settings que son de la sucursal (para ScopedSection). */
export const STORE_HARDWARE_FIELDS = ["scale_enabled", "scale_label", "drawer_open_on_cash", "drawer_no_sale"];

// ── Nivel caja ───────────────────────────────────────────────────────────────

export type BridgeTarget = { kind: "serial"; path: string } | { kind: "tcp"; host: string; port: number };

export type ScaleTransport = "webserial" | "bridge" | "simulator";
export type DrawerTransport = "webserial" | "webusb" | "bridge" | "simulator" | "none";

export interface ScaleDevice {
  enabled: boolean;
  model: string;
  transport: ScaleTransport;
  protocol: ScaleProtocolConfig;
  serial: SerialSettings;
  bridge: BridgeTarget | null;
}

export interface DrawerDevice {
  /** false = "esta caja no tiene cajón". */
  hasDrawer: boolean;
  /** Impresora del registro (printers) a la que está enchufado el cajón. */
  printerId: string | null;
  transport: DrawerTransport;
  pin: DrawerPin;
  onMs: number;
  offMs: number;
  baud: number;
  bridge: BridgeTarget | null;
}

export interface RegisterHardware {
  registerId: string;
  storeId: string;
  scale: ScaleDevice;
  drawer: DrawerDevice;
  updatedAt: string | null;
}

export const SCALE_TRANSPORT_LABEL: Record<ScaleTransport, string> = {
  webserial: "USB o serie (Web Serial)",
  bridge: "Puente local NinjaPOS",
  simulator: "Simulador (sin balanza)",
};

export const DRAWER_TRANSPORT_LABEL: Record<DrawerTransport, string> = {
  webserial: "Impresora por USB o serie (Web Serial)",
  webusb: "Impresora USB directa (WebUSB)",
  bridge: "Puente local NinjaPOS (USB, serie o red)",
  simulator: "Simulador (sin cajón)",
  none: "Sin configurar",
};

export const DEFAULT_SCALE_DEVICE: ScaleDevice = {
  enabled: false,
  model: "",
  transport: "webserial",
  protocol: protocolDefaults("generic"),
  serial: DEFAULT_SERIAL,
  bridge: null,
};

export const DEFAULT_DRAWER_DEVICE: DrawerDevice = {
  hasDrawer: true,
  printerId: null,
  transport: "none",
  pin: 2,
  onMs: 120,
  offMs: 240,
  baud: 9600,
  bridge: null,
};

const BAUDS = [1200, 2400, 4800, 9600, 19200, 38400, 57600, 115200];
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function obj(v: unknown): Record<string, unknown> {
  return v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : {};
}

function parseBridge(o: Record<string, unknown>): BridgeTarget | null {
  if (o.bridge_kind === "serial" && typeof o.bridge_path === "string" && /^[A-Za-z0-9_./:-]{1,64}$/.test(o.bridge_path)) {
    return { kind: "serial", path: o.bridge_path };
  }
  const port = Number(o.bridge_port);
  if (
    o.bridge_kind === "tcp" &&
    typeof o.bridge_host === "string" &&
    /^[A-Za-z0-9.-]{1,253}$/.test(o.bridge_host) &&
    Number.isInteger(port) &&
    port > 0 &&
    port < 65536
  ) {
    return { kind: "tcp", host: o.bridge_host, port };
  }
  return null;
}

function bridgeOut(b: BridgeTarget | null): Record<string, unknown> {
  if (!b) return {};
  return b.kind === "serial"
    ? { bridge_kind: "serial", bridge_path: b.path }
    : { bridge_kind: "tcp", bridge_host: b.host, bridge_port: b.port };
}

const clampMs = (v: unknown, def: number) => {
  const n = Math.round(Number(v));
  return Number.isFinite(n) && n >= 2 && n <= 510 ? n : def;
};

/** Lee register_hardware.scale (snake_case) y lo sanea. */
export function parseScaleDevice(raw: unknown): ScaleDevice {
  const o = obj(raw);
  const protocol: ScaleProtocol = (Object.keys(SCALE_PROTOCOLS) as ScaleProtocol[]).includes(o.protocol as ScaleProtocol)
    ? (o.protocol as ScaleProtocol)
    : "generic";
  const base = protocolDefaults(protocol);
  const mode: ScaleMode = o.mode === "poll" || o.mode === "continuous" ? o.mode : base.mode;
  const unit: ScaleUnit = o.unit === "g" || o.unit === "kg" ? o.unit : base.unit;
  const pollMs = Math.round(Number(o.poll_ms));
  const transport: ScaleTransport =
    o.transport === "bridge" || o.transport === "simulator" || o.transport === "webserial" ? o.transport : "webserial";
  return {
    enabled: o.enabled === true,
    model: typeof o.model === "string" ? o.model.slice(0, 60) : "",
    transport,
    protocol: {
      protocol,
      mode,
      pollCommand: typeof o.poll_command === "string" ? o.poll_command.slice(0, 24) : base.pollCommand,
      pollMs: Number.isFinite(pollMs) && pollMs >= 100 && pollMs <= 5000 ? pollMs : base.pollMs,
      regex: typeof o.regex === "string" ? o.regex.slice(0, 200) : "",
      unit,
    },
    serial: {
      baudRate: BAUDS.includes(Number(o.baud)) ? Number(o.baud) : SCALE_PROTOCOLS[protocol].baud,
      dataBits: Number(o.data_bits) === 7 ? 7 : 8,
      stopBits: Number(o.stop_bits) === 2 ? 2 : 1,
      parity: o.parity === "even" || o.parity === "odd" ? o.parity : "none",
      flowControl: "none",
    },
    bridge: parseBridge(o),
  };
}

export function serializeScaleDevice(s: ScaleDevice): Record<string, unknown> {
  return {
    enabled: s.enabled,
    model: s.model.trim().slice(0, 60),
    transport: s.transport,
    protocol: s.protocol.protocol,
    mode: s.protocol.mode,
    poll_command: s.protocol.pollCommand.slice(0, 24),
    poll_ms: s.protocol.pollMs,
    regex: s.protocol.regex.trim().slice(0, 200),
    unit: s.protocol.unit,
    baud: s.serial.baudRate,
    data_bits: s.serial.dataBits,
    parity: s.serial.parity,
    stop_bits: s.serial.stopBits,
    ...bridgeOut(s.bridge),
  };
}

/** Lee register_hardware.drawer (snake_case) y lo sanea. */
export function parseDrawerDevice(raw: unknown): DrawerDevice {
  const o = obj(raw);
  const transport: DrawerTransport = (["webserial", "webusb", "bridge", "simulator", "none"] as const).includes(
    o.transport as DrawerTransport,
  )
    ? (o.transport as DrawerTransport)
    : "none";
  return {
    hasDrawer: o.has_drawer !== false,
    printerId: typeof o.printer_id === "string" && UUID.test(o.printer_id) ? o.printer_id : null,
    transport,
    pin: Number(o.pin) === 5 ? 5 : 2,
    onMs: clampMs(o.on_ms, DEFAULT_DRAWER_DEVICE.onMs),
    offMs: clampMs(o.off_ms, DEFAULT_DRAWER_DEVICE.offMs),
    baud: BAUDS.includes(Number(o.baud)) ? Number(o.baud) : DEFAULT_DRAWER_DEVICE.baud,
    bridge: parseBridge(o),
  };
}

export function serializeDrawerDevice(d: DrawerDevice): Record<string, unknown> {
  return {
    has_drawer: d.hasDrawer,
    printer_id: d.printerId,
    transport: d.hasDrawer ? d.transport : "none",
    pin: d.pin,
    on_ms: d.onMs,
    off_ms: d.offMs,
    baud: d.baud,
    ...bridgeOut(d.bridge),
  };
}

export function parseRegisterHardware(row: Record<string, unknown>): RegisterHardware {
  return {
    registerId: String(row.cash_register_id ?? ""),
    storeId: String(row.store_id ?? ""),
    scale: parseScaleDevice(row.scale),
    drawer: parseDrawerDevice(row.drawer),
    updatedAt: typeof row.updated_at === "string" ? row.updated_at : null,
  };
}

/** Lo que tiene una caja sin fila propia: sin balanza y con cajón sin configurar. */
export function emptyRegisterHardware(registerId: string, storeId: string): RegisterHardware {
  return {
    registerId,
    storeId,
    scale: { ...DEFAULT_SCALE_DEVICE },
    drawer: { ...DEFAULT_DRAWER_DEVICE },
    updatedAt: null,
  };
}

/** Problema de la configuración del cajón de la caja (null = listo). */
export function drawerDeviceProblem(d: DrawerDevice): string | null {
  if (!d.hasDrawer) return null;
  if (d.transport === "none") return "Falta elegir cómo se conecta la impresora que abre el cajón.";
  if (d.transport === "bridge" && !d.bridge) return "Falta el puerto o la IP de la impresora para el puente local.";
  return null;
}

/** Problema de la configuración de la balanza de la caja (null = lista o apagada). */
export function scaleDeviceProblem(s: ScaleDevice): string | null {
  if (!s.enabled) return null;
  if (s.transport === "bridge" && !s.bridge) return "Falta el puerto de la balanza para el puente local.";
  if (s.protocol.mode === "poll" && !s.protocol.pollCommand) return "Falta el comando para pedir el peso.";
  return null;
}

// ── Emparejamiento por equipo (localStorage) ────────────────────────────────

export type HardwareDevice = "scale" | "drawer";

export interface HardwarePairing {
  device?: DeviceMatch | null;
  pairedAt?: string;
}

export interface BridgeAuth {
  url: string;
  token: string;
}

const PAIR_KEY = (registerId: string, d: HardwareDevice) => `ninja.hw.pair.${registerId}.${d}`;
const BRIDGE_KEY = "ninja.hw.bridge";

export function loadHardwarePairing(registerId: string, d: HardwareDevice): HardwarePairing | null {
  try {
    const raw = window.localStorage.getItem(PAIR_KEY(registerId, d));
    if (!raw) return null;
    const p = JSON.parse(raw) as HardwarePairing;
    return p && typeof p === "object" ? p : null;
  } catch {
    return null;
  }
}

export function saveHardwarePairing(registerId: string, d: HardwareDevice, p: HardwarePairing | null): void {
  try {
    if (!p) window.localStorage.removeItem(PAIR_KEY(registerId, d));
    else window.localStorage.setItem(PAIR_KEY(registerId, d), JSON.stringify({ ...p, pairedAt: new Date().toISOString() }));
  } catch {
    /* modo privado: se empareja cada vez */
  }
}

/** URL y token del puente local de ESTA PC (uno para todos los equipos). */
export function loadBridgeAuth(): BridgeAuth | null {
  try {
    const raw = window.localStorage.getItem(BRIDGE_KEY);
    if (!raw) return null;
    const b = JSON.parse(raw) as BridgeAuth;
    return b?.url && b?.token ? b : null;
  } catch {
    return null;
  }
}

export function saveBridgeAuth(b: BridgeAuth | null): void {
  try {
    if (!b) window.localStorage.removeItem(BRIDGE_KEY);
    else window.localStorage.setItem(BRIDGE_KEY, JSON.stringify(b));
  } catch {
    /* sin almacenamiento */
  }
}

/** Qué falta en ESTA PC para usar el equipo (null = nada). */
export function pairingProblem(
  transport: ScaleTransport | DrawerTransport,
  pairing: HardwarePairing | null,
  bridge: BridgeAuth | null,
): string | null {
  if (transport === "simulator" || transport === "none") return null;
  if (transport === "bridge") return bridge ? null : "Falta emparejar el puente local en esta PC.";
  return pairing?.device ? null : "Falta elegir el puerto USB en esta PC (Emparejar).";
}
