// Configuración de una terminal integrada (ADR-053).
//
//   • Compartida (payment_terminals.external_meta.integration): adaptador,
//     transporte, parámetros del puerto o destino TCP y timeout. La edita el
//     dueño o encargado en Configuración, Terminales.
//   • Del equipo (localStorage): qué dispositivo USB / puerto quedó emparejado
//     en ESTA PC y la URL y el token del puente local. El permiso de Web
//     Serial / WebUSB es por navegador y equipo: no tiene sentido guardarlo
//     en la base.

import { DEFAULT_SERIAL, BRIDGE_DEFAULT_URL, type DeviceMatch, type SerialSettings } from "./transports";
import type { AdapterKey, IntegratedKind, TransportKind } from "./types";

export const INTEGRATED_KINDS: IntegratedKind[] = ["posnet_integrado", "pinpad"];

export function isIntegratedKind(k: string | null | undefined): k is IntegratedKind {
  return k === "posnet_integrado" || k === "pinpad";
}

/** Proveedores (marca adquirente) que admiten terminal integrada. Espejo del trigger SQL. */
export const INTEGRATED_PROVIDERS = ["payway", "fiserv", "getnet"] as const;

export interface IntegrationConfig {
  adapter: AdapterKey;
  transport: TransportKind;
  serial: SerialSettings;
  /** Puente: puerto de la PC ("COM3", "/dev/ttyUSB0") o destino TCP. */
  bridgeTarget: { kind: "serial"; path: string } | { kind: "tcp"; host: string; port: number } | null;
  /** Segundos esperando la respuesta de la terminal. */
  timeoutSec: number;
  /**
   * Código de tarjeta del adquirente por marca (clave de lib/pos/cardBrands →
   * código de 3 caracteres de la tabla de la terminal). Lo pide VPI (Payway /
   * LaPos): la tabla viene en el kit o la informa Payway.
   */
  cardCodes: Record<string, string>;
  /** Razón social y CUIT que algunos protocolos mandan en cada venta. */
  merchantName: string;
  cuit: string;
}

export const ADAPTER_LABEL: Record<AdapterKey, string> = {
  simulator: "Simulador (sin hardware)",
  payway_lapos: "Payway (posnet o pinpad)",
  fiserv_posnet: "Fiserv Posnet",
  getnet: "Getnet",
};

export const TRANSPORT_LABEL: Record<TransportKind, string> = {
  webserial: "USB o serie (Web Serial)",
  webusb: "USB directo (WebUSB)",
  bridge: "Puente local NinjaPOS",
  none: "Sin conexión física",
};

/** Adaptador por defecto para la marca. */
export function adapterForProvider(provider: string): AdapterKey {
  if (provider === "payway") return "payway_lapos";
  if (provider === "fiserv") return "fiserv_posnet";
  if (provider === "getnet") return "getnet";
  return "simulator";
}

export const DEFAULT_INTEGRATION: IntegrationConfig = {
  adapter: "simulator",
  transport: "none",
  serial: DEFAULT_SERIAL,
  bridgeTarget: null,
  timeoutSec: 120,
  cardCodes: {},
  merchantName: "",
  cuit: "",
};

const ADAPTERS: AdapterKey[] = ["simulator", "payway_lapos", "fiserv_posnet", "getnet"];
const TRANSPORTS: TransportKind[] = ["webserial", "webusb", "bridge", "none"];
const BAUDS = [1200, 2400, 4800, 9600, 19200, 38400, 57600, 115200];

function obj(v: unknown): Record<string, unknown> {
  return v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : {};
}

/** Lee y sanea external_meta.integration (tolera basura y campos faltantes). */
export function parseIntegration(meta: unknown): IntegrationConfig {
  const i = obj(obj(meta).integration);
  const adapter = ADAPTERS.includes(i.adapter as AdapterKey) ? (i.adapter as AdapterKey) : DEFAULT_INTEGRATION.adapter;
  let transport = TRANSPORTS.includes(i.transport as TransportKind)
    ? (i.transport as TransportKind)
    : DEFAULT_INTEGRATION.transport;
  if (adapter === "simulator") transport = "none";
  else if (transport === "none") transport = "webserial";
  const s = obj(i.serial);
  const serial: SerialSettings = {
    // Payway VPI: 19200 8N1 (fuentes públicas no oficiales, ver adapters/payway.ts).
    baudRate: BAUDS.includes(Number(s.baudRate))
      ? Number(s.baudRate)
      : adapter === "payway_lapos"
        ? 19200
        : DEFAULT_SERIAL.baudRate,
    dataBits: s.dataBits === 7 ? 7 : 8,
    stopBits: s.stopBits === 2 ? 2 : 1,
    parity: s.parity === "even" || s.parity === "odd" ? s.parity : "none",
    flowControl: s.flowControl === "hardware" ? "hardware" : "none",
  };
  const bt = obj(i.bridgeTarget);
  let bridgeTarget: IntegrationConfig["bridgeTarget"] = null;
  if (bt.kind === "serial" && typeof bt.path === "string" && /^[A-Za-z0-9_./:-]{1,64}$/.test(bt.path)) {
    bridgeTarget = { kind: "serial", path: bt.path };
  } else if (
    bt.kind === "tcp" &&
    typeof bt.host === "string" &&
    /^[A-Za-z0-9.-]{1,253}$/.test(bt.host) &&
    Number.isInteger(Number(bt.port)) &&
    Number(bt.port) > 0 &&
    Number(bt.port) < 65536
  ) {
    bridgeTarget = { kind: "tcp", host: bt.host, port: Number(bt.port) };
  }
  const t = Number(i.timeoutSec);
  const timeoutSec = Number.isFinite(t) ? Math.min(300, Math.max(20, Math.round(t))) : DEFAULT_INTEGRATION.timeoutSec;
  const cardCodes: Record<string, string> = {};
  for (const [k, v] of Object.entries(obj(i.cardCodes))) {
    if (/^[a-z_]{2,20}$/.test(k) && typeof v === "string" && /^[A-Za-z0-9]{1,3}$/.test(v.trim())) {
      cardCodes[k] = v.trim().toUpperCase();
    }
  }
  const merchantName = typeof i.merchantName === "string" ? i.merchantName.trim().slice(0, 23) : "";
  const cuit = typeof i.cuit === "string" ? i.cuit.replace(/\D/g, "").slice(0, 11) : "";
  return { adapter, transport, serial, bridgeTarget, timeoutSec, cardCodes, merchantName, cuit };
}

/** external_meta con la integración escrita (conserva el resto de las claves). */
export function withIntegration(meta: unknown, cfg: IntegrationConfig): Record<string, unknown> {
  return { ...obj(meta), integration: { ...cfg } };
}

/** Problema de configuración que impide cobrar (null = ok). */
export function integrationProblem(cfg: IntegrationConfig, pairing: DevicePairing | null): string | null {
  if (cfg.adapter === "simulator") return null;
  if (cfg.transport === "bridge") {
    if (!cfg.bridgeTarget) return "Falta el puerto o la dirección de red de la terminal para el puente local.";
    if (!pairing?.bridge?.token) return "Falta emparejar el puente local en esta PC.";
    return null;
  }
  if ((cfg.transport === "webserial" || cfg.transport === "webusb") && !pairing?.device) {
    return "Falta emparejar el dispositivo en esta PC.";
  }
  return null;
}

// ── Emparejamiento por equipo (localStorage) ────────────────────────────────

export interface DevicePairing {
  device?: DeviceMatch | null;
  bridge?: { url: string; token: string } | null;
  pairedAt?: string;
}

const LS = (terminalId: string) => `ninja.terminal.pair.${terminalId}`;

export function loadPairing(terminalId: string): DevicePairing | null {
  try {
    const raw = window.localStorage.getItem(LS(terminalId));
    if (!raw) return null;
    const p = JSON.parse(raw) as DevicePairing;
    return p && typeof p === "object" ? p : null;
  } catch {
    return null;
  }
}

export function savePairing(terminalId: string, p: DevicePairing | null): void {
  try {
    if (!p) window.localStorage.removeItem(LS(terminalId));
    else window.localStorage.setItem(LS(terminalId), JSON.stringify({ ...p, pairedAt: new Date().toISOString() }));
  } catch {
    /* modo privado: se empareja cada vez */
  }
}

export function bridgeUrlOk(url: string): boolean {
  // Sólo el propio equipo: el puente nunca se expone a la red.
  return /^ws:\/\/(127\.0\.0\.1|localhost|\[::1\]):\d{2,5}\/?$/.test(url.trim());
}

export { BRIDGE_DEFAULT_URL };
