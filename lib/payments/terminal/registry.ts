// Fábrica de adaptadores (ADR-053): arma el transporte según la
// configuración compartida y el emparejamiento de esta PC, y le pone encima
// el adaptador del adquirente.

import type { DevicePairing, IntegrationConfig } from "./config";
import type { ByteTransport } from "./framing";
import { BridgeTransport, WebSerialTransport, WebUsbTransport } from "./transports";
import { SimulatorAdapter, type SimulatorOptions } from "./simulator";
import { PaywayAdapter } from "./adapters/payway";
import { FiservPosnetAdapter } from "./adapters/fiserv";
import { GetnetAdapter } from "./adapters/getnet";
import { TerminalError, type TerminalAdapter } from "./types";

export function createTransport(cfg: IntegrationConfig, pairing: DevicePairing | null): ByteTransport {
  if (cfg.transport === "bridge") {
    if (!pairing?.bridge?.token || !cfg.bridgeTarget) {
      throw new TerminalError("not_connected", "Falta emparejar el puente local en esta PC");
    }
    const target =
      cfg.bridgeTarget.kind === "serial" ? { ...cfg.bridgeTarget, ...cfg.serial } : cfg.bridgeTarget;
    return new BridgeTransport({ url: pairing.bridge.url, token: pairing.bridge.token, target });
  }
  if (!pairing?.device) throw new TerminalError("not_connected", "Falta emparejar el dispositivo en esta PC");
  if (cfg.transport === "webusb") return new WebUsbTransport(pairing.device);
  return new WebSerialTransport(pairing.device, cfg.serial);
}

export function createAdapter(
  cfg: IntegrationConfig,
  pairing: DevicePairing | null,
  ctx: { merchantNumber?: string | null; terminalNumber?: string | null; sim?: SimulatorOptions } = {},
): TerminalAdapter {
  switch (cfg.adapter) {
    case "simulator":
      return new SimulatorAdapter({
        merchantNumber: ctx.merchantNumber ?? undefined,
        terminalNumber: ctx.terminalNumber ?? undefined,
        ...ctx.sim,
      });
    case "payway_lapos":
      return new PaywayAdapter(createTransport(cfg, pairing), {
        cardCodes: cfg.cardCodes,
        merchantNumber: ctx.merchantNumber ?? null,
        merchantName: cfg.merchantName,
        cuit: cfg.cuit,
        trxTimeoutMs: cfg.timeoutSec * 1000,
      });
    case "fiserv_posnet":
      return new FiservPosnetAdapter(createTransport(cfg, pairing));
    case "getnet":
      return new GetnetAdapter(createTransport(cfg, pairing));
  }
}
