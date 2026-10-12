// Una instancia de adaptador por terminal y pestaña (ADR-053): el puerto
// abierto y el estado del simulador (lote, cupones) sobreviven entre cobros.
// Si cambia la configuración o el emparejamiento, se descarta y se rearma.

import type { PaymentTerminal } from "@/lib/payments/terminals";
import { loadPairing, parseIntegration, type IntegrationConfig } from "./config";
import { createAdapter } from "./registry";
import type { TerminalAdapter } from "./types";

const cache = new Map<string, { sig: string; adapter: TerminalAdapter }>();

export function terminalConfig(t: Pick<PaymentTerminal, "external_meta">): IntegrationConfig {
  return parseIntegration(t.external_meta);
}

/** Adaptador listo para usar (puede tirar TerminalError si falta emparejar). */
export function adapterFor(t: PaymentTerminal): TerminalAdapter {
  const cfg = terminalConfig(t);
  const pairing = cfg.adapter === "simulator" ? null : loadPairing(t.id);
  const sig = JSON.stringify([cfg, pairing?.device ?? null, pairing?.bridge ?? null, t.merchant_number, t.external_id]);
  const hit = cache.get(t.id);
  if (hit && hit.sig === sig) return hit.adapter;
  if (hit) void hit.adapter.disconnect().catch(() => undefined);
  const adapter = createAdapter(cfg, pairing, { merchantNumber: t.merchant_number, terminalNumber: t.external_id });
  cache.set(t.id, { sig, adapter });
  return adapter;
}

/** Cierra y olvida el adaptador (después de reemparejar o de un error de puerto). */
export async function dropAdapter(terminalId: string): Promise<void> {
  const hit = cache.get(terminalId);
  cache.delete(terminalId);
  if (hit) await hit.adapter.disconnect().catch(() => undefined);
}
