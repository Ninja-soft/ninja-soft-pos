// COT (Código de Operación de Traslado) del remito (ADR-136).
//
// Hoy el número lo carga el negocio a mano: lo obtiene en ARBA (Provincia de
// Buenos Aires), en AGIP (CABA) o en el organismo que corresponda y lo copia
// en el remito (`cot_source = 'manual'`).
//
// Hook para la obtención automática: un proveedor recibe el remito y devuelve
// el número y su vigencia. El de ARBA (presentación del archivo o del
// servicio web con la CIT del negocio) queda como siguiente paso; la base ya
// acepta `cot_source = 'arba_ws'` para ese camino.
import type { CotJurisdiction, Remito } from "@/lib/remitos/logic";

export interface CotRequest {
  remito: Pick<
    Remito,
    "id" | "pto_vta" | "number" | "issued_at" | "issuer" | "receiver_name" | "receiver_doc" | "delivery_address" | "declared_value" | "items"
  > & { vehicle_plate?: string | null; carrier_cuit?: string | null };
  jurisdiction: CotJurisdiction;
}

export interface CotResult {
  cot: string;
  validUntil: string | null;
  source: "manual" | "arba_ws";
}

export interface CotProvider {
  key: "manual" | "arba_ws";
  /** ¿Puede pedir el COT solo para esta jurisdicción? */
  supports: (j: CotJurisdiction) => boolean;
  request: (req: CotRequest) => Promise<CotResult>;
}

/** Carga manual: no pide nada, el número lo escribe el usuario. */
export const manualCotProvider: CotProvider = {
  key: "manual",
  supports: () => false,
  request: async () => {
    throw new Error("cot_manual");
  },
};

/** Proveedor de ARBA: pendiente (ADR-136, siguiente paso). */
export const arbaCotProvider: CotProvider = {
  key: "arba_ws",
  supports: () => false,
  request: async () => {
    throw new Error("cot_provider_not_available");
  },
};

/** Proveedor para una jurisdicción (hoy siempre la carga manual). */
export function cotProviderFor(j: CotJurisdiction): CotProvider {
  return arbaCotProvider.supports(j) ? arbaCotProvider : manualCotProvider;
}
