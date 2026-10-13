// =============================================================================
// _shared/shipping/registry.ts  (ADR-103)
// Adaptadores por shipping_providers.key. Los "planned" no tienen adaptador.
// =============================================================================
import { andreaniAdapter } from "./andreani.ts";
import { correoArgentinoAdapter } from "./correoArgentino.ts";
import { enviopackAdapter } from "./enviopack.ts";
import { ocaAdapter } from "./oca.ts";
import { simulatorAdapter } from "./simulator.ts";
import type { CarrierAdapter } from "./types.ts";

export const ADAPTERS: Record<string, CarrierAdapter> = {
  simulador: simulatorAdapter,
  andreani: andreaniAdapter,
  correo_argentino: correoArgentinoAdapter,
  oca: ocaAdapter,
  enviopack: enviopackAdapter,
};

/** Adaptadores que operan de verdad (status 'active' en shipping_providers). */
export const ACTIVE_ADAPTERS = ["simulador", "andreani"] as const;

export function adapterFor(key: string | null | undefined): CarrierAdapter | null {
  return key ? (ADAPTERS[key] ?? null) : null;
}
