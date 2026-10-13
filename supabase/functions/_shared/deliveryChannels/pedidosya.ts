// =============================================================================
// _shared/deliveryChannels/pedidosya.ts (ADR-102) · ESQUELETO, flujo INDIRECTO
//
// PedidosYa (Delivery Hero) Integration Middleware. Fuente:
// research-delivery-apps.md §1.1 e integrar.pedidosya.com/es/documentation.
// Primer adaptador productivo recomendado: flujo INDIRECTO (el local acepta en
// la tablet de PedidosYa y al POS llegan sólo pedidos ya aceptados; si
// NinjaSoft se cae, el local sigue operando).
//
// TODO (PedidosYa), en orden:
//   * Alta (SEGURO): NDA + formulario get-started; par de claves PGP, la
//     credencial llega cifrada por email; login por el endpoint Login del
//     middleware. Usuario y secreto van en credentials (delivery_channel_set_credentials).
//   * Red (SEGURO): el middleware sólo entrega a IPs en whitelist y exige SSL.
//     Validar con Delivery Hero si aceptan el dominio *.supabase.co de la Edge
//     o hace falta un dominio propio (A CONFIRMAR). Las IPs de origen de DH
//     (para filtrar en verifySignature): A CONFIRMAR.
//   * Autenticación del Plugin API hacia nosotros (token, básica, firma): A
//     CONFIRMAR. Hasta saberlo verifySignature rechaza todo (fail closed).
//   * Recibir pedidos (SEGURO): webhook Order Dispatch (Plugin API). Campos
//     del pedido: A CONFIRMAR con el payload de staging.
//   * Cancelaciones (SEGURO): webhook Order Status Update.
//   * Flujo indirecto: no se acepta ni rechaza desde NinjaSoft (la conexión
//     va con flow = 'indirecto' y el servidor no encola llamadas salientes).
//   * Flujo directo (más adelante): Update Order Status (accept con fecha y
//     hora de aceptación en formato estricto, reject con motivo válido, picked
//     up) y Mark Order as Prepared (SEGURO); campo del tiempo de preparación:
//     A CONFIRMAR.
//   * Recuperación (SEGURO): Order Report Service (ids de las últimas 24 h +
//     detalle) -> fetchRecentOrders.
//   * Menú (SEGURO): Submit Catalog (PUT) con remoteCode = id externo del mapeo.
//   * Disponibilidad del local (SEGURO): Update/Get Vendor Availability;
//     estados exactos A CONFIRMAR.
//   * Tracking del repartidor y logística: no documentado (A CONFIRMAR).
//   * Liquidaciones: sin API financiera pública; import del portal (A CONFIRMAR).
//   * Operación (SEGURO): avisar mantenimientos con 24 h a
//     log_vendor_pos_integrations@deliveryhero.com.
// =============================================================================

import { NotImplementedError, notImplemented, type DeliveryChannelAdapter } from "./types.ts";

export const pedidosyaAdapter: DeliveryChannelAdapter = {
  provider: "pedidosya",
  ready: false,
  async verifySignature() {
    // TODO(pedidosya): whitelist de IPs de Delivery Hero + autenticación del
    // Plugin API (A CONFIRMAR). Fail closed mientras tanto.
    return false;
  },
  parseEvent() {
    // TODO(pedidosya): Order Dispatch -> order.new; Order Status Update ->
    // order.cancelled / order.status. Campos A CONFIRMAR.
    throw new NotImplementedError("pedidosya", "parseEvent");
  },
  parseOrder() {
    throw new NotImplementedError("pedidosya", "parseOrder");
  },
  async accept() {
    // Flujo indirecto: se acepta en la tablet de PedidosYa.
    return notImplemented("pedidosya", "accept (flujo directo)");
  },
  async reject() {
    return notImplemented("pedidosya", "reject (flujo directo)");
  },
  async markReady() {
    // TODO(pedidosya): Mark Order as Prepared (flujo directo).
    return notImplemented("pedidosya", "markReady");
  },
  async markPickedUp() {
    // TODO(pedidosya): Update Order Status picked up (flujo directo).
    return notImplemented("pedidosya", "markPickedUp");
  },
  async fetchRecentOrders() {
    // TODO(pedidosya): Order Report Service (últimas 24 h).
    throw new NotImplementedError("pedidosya", "fetchRecentOrders");
  },
  async syncMenu() {
    // TODO(pedidosya): Submit Catalog (PUT), asíncrono con callback e Import Log.
    return notImplemented("pedidosya", "syncMenu");
  },
  async toggleStore() {
    // TODO(pedidosya): Update Vendor Availability.
    return notImplemented("pedidosya", "toggleStore");
  },
};
