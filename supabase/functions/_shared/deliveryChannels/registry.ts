// =============================================================================
// _shared/deliveryChannels/registry.ts (ADR-102)
//
// Adaptador por proveedor. Uber Eats y Mercado Pago Delivery todavía no tienen
// esqueleto propio: responden "sin implementar" (A CONFIRMAR, ver
// docs/36-canales-delivery.md) y su webhook se rechaza.
// =============================================================================

import { pedidosyaAdapter } from "./pedidosya.ts";
import { rappiAdapter } from "./rappi.ts";
import { simulatorAdapter } from "./simulator.ts";
import { NotImplementedError, notImplemented, type ChannelProvider, type DeliveryChannelAdapter } from "./types.ts";

function pendingAdapter(provider: ChannelProvider): DeliveryChannelAdapter {
  return {
    provider,
    ready: false,
    async verifySignature() {
      return false;
    },
    parseEvent() {
      throw new NotImplementedError(provider, "parseEvent");
    },
    parseOrder() {
      throw new NotImplementedError(provider, "parseOrder");
    },
    async accept() {
      return notImplemented(provider, "accept");
    },
    async reject() {
      return notImplemented(provider, "reject");
    },
    async markReady() {
      return notImplemented(provider, "markReady");
    },
    async markPickedUp() {
      return notImplemented(provider, "markPickedUp");
    },
    async fetchRecentOrders() {
      throw new NotImplementedError(provider, "fetchRecentOrders");
    },
  };
}

const ADAPTERS: Record<ChannelProvider, DeliveryChannelAdapter> = {
  simulador: simulatorAdapter,
  pedidosya: pedidosyaAdapter,
  rappi: rappiAdapter,
  ubereats: pendingAdapter("ubereats"),
  mp_delivery: pendingAdapter("mp_delivery"),
};

export function getAdapter(provider: string): DeliveryChannelAdapter | null {
  return (ADAPTERS as Record<string, DeliveryChannelAdapter>)[provider] ?? null;
}
