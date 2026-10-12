// Getnet (Santander) "Get POS Integrado" (ADR-053). PLACEHOLDER.
//
// Lo público (docs.globalgetnet.com, In-Store Payments, Integrated POS):
// una librería oficial ("Integrated POS Library", ejemplos sólo en C#) más
// una "Connector App" en la terminal, con tres modos de conexión:
//   • CreateUsb  (serie / USB)
//   • CreateHttp (Wi-Fi / Ethernet en la red local, host + puerto)
//   • CreateCloud (Cloud2Cloud, sin host ni puerto)
// Operaciones: Sale, Refund, GetReports, PreAuth, Polling, Close. Respuesta:
// Code ("0" = éxito), Message, CommerceCode, TerminalId, AuthorizationCode,
// Amount, AccountingDate, RealDate, SaleType, OperationMode, OriginalAmount.
// La página de Getnet Argentina confirma "conexión local (USB o Wi-Fi)" o
// "Cloud to Cloud (C2C)" con "clave comercio" (getnet.net/ar, Get POS
// Integrado). El formato de los mensajes en el cable o en la red NO es
// público: la librería lo encapsula.
//
// TODO(kit Getnet): el protocolo de USB / HTTP local, o la API REST de
// Cloud2Cloud para hacerlo desde una Edge Function (sin puente). Mientras
// tanto la conexión física funciona y las operaciones devuelven
// "spec_pending".

import { TransportAdapter } from "./base";
import type { AdapterCapabilities } from "../types";

/** Código de éxito de la respuesta de la librería de Getnet. */
export const GETNET_SUCCESS_CODE = "0";

export class GetnetAdapter extends TransportAdapter {
  readonly key = "getnet" as const;
  readonly label = "Getnet";
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
