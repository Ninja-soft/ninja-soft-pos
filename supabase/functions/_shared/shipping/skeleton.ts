// =============================================================================
// _shared/shipping/skeleton.ts  (ADR-103)
//
// Base de los adaptadores "esqueleto": logísticas con el contrato de la
// interfaz, capacidades esperadas y credenciales que se piden, pero SIN
// endpoints confirmados. Cada método falla con not_implemented; la base
// (shipping_providers.status = 'skeleton') y la Edge impiden operar con ellos.
// Al confirmar la documentación con el carrier se reemplaza el método.
// =============================================================================
import { CarrierError, type CarrierAdapter, type Capabilities, type LabelFormat, type ShipmentStatus } from "./types.ts";

export interface SkeletonDef {
  key: string;
  name: string;
  capabilities: Capabilities;
  labelFormats: LabelFormat[];
  /** Mapeo de estados conocido (texto normalizado → estado). A CONFIRMAR. */
  statusMap?: [RegExp, ShipmentStatus][];
}

export function skeletonAdapter(def: SkeletonDef): CarrierAdapter {
  const fail = (what: string): never => {
    throw new CarrierError("not_implemented", `${def.name}: ${what} todavía no está integrado (endpoints A CONFIRMAR con el carrier).`);
  };
  return {
    key: def.key,
    name: def.name,
    capabilities: def.capabilities,
    labelFormats: def.labelFormats,
    mapStatus(carrierStatus) {
      const s = carrierStatus
        .normalize("NFD")
        .replace(/[̀-ͯ]/g, "")
        .toLowerCase();
      for (const [re, st] of def.statusMap ?? []) if (re.test(s)) return st;
      return null;
    },
    testConnection: async () => fail("probar la conexión"),
    quote: async () => fail("cotizar"),
    listPoints: async () => fail("listar sucursales"),
    create: async () => fail("crear envíos"),
    label: async () => fail("generar etiquetas"),
    track: async () => fail("el seguimiento"),
    cancel: async () => fail("cancelar"),
  };
}

/** Estados genéricos en castellano, base de los mapeos A CONFIRMAR. */
export const GENERIC_STATUS_MAP: [RegExp, ShipmentStatus][] = [
  [/anulad|cancelad/, "cancelled"],
  [/no entregad|visita|ausente|sin exito/, "failed_attempt"],
  [/devuelto|devolucion entregada/, "returned"],
  [/entregad/, "delivered"],
  [/para retir|en sucursal de destino|disponible/, "ready_for_pickup"],
  [/en distribucion|en reparto|en camino/, "out_for_delivery"],
  [/admitid|retirad|recibid|ingres/, "picked_up"],
  [/transito|en viaje|despachad/, "in_transit"],
  [/pendiente|generad|creada|importad/, "created"],
];
