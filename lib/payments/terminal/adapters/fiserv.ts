// Fiserv / Posnet integrado por cable (ADR-053). PLACEHOLDER.
//
// Lo público: el posnet tiene que tener cargada la aplicación "TRANSACT" para
// hablar con la PC, configurada por personal de Posnet (manual de Tango,
// "Tesorería Tarjetas: POS Integrado", net.axoft.com). No hay especificación
// pública del protocolo ni código abierto.
//
// TODO(kit Fiserv): framing, comandos y campos. Mientras tanto la conexión
// física (Web Serial / WebUSB / puente) funciona y las operaciones devuelven
// "spec_pending". Para Clover la vía integrada es Cloud Pay Display (ADR-047).

import { TransportAdapter } from "./base";
import type { AdapterCapabilities } from "../types";

export class FiservPosnetAdapter extends TransportAdapter {
  readonly key = "fiserv_posnet" as const;
  readonly label = "Fiserv Posnet";
  readonly specStatus = "pending_kit" as const;
  readonly capabilities: AdapterCapabilities = {
    void: false,
    refund: false,
    closeBatch: false,
    installments: false,
    cancelInFlight: false,
    requiresBrand: false,
    lastTransaction: false,
  };
}
