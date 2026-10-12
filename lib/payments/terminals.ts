// Registro de terminales de cobro (F17 · H93, ADR-049). Lógica pura: qué
// terminal usa el POS para un medio en la caja actual.
//
// Prioridad:
//   1. La default de la caja (is_default) para ese proveedor.
//   2. Otra terminal asignada a la caja.
//   3. Una flotante de la sucursal (sin caja).
//   4. La que el dispositivo recordaba (localStorage, compatibilidad con el
//      lector elegido antes del registro) si sigue siendo válida.
// Con más de una candidata en el mismo nivel no se adivina: el POS muestra el
// selector (salvo que una sea la recordada).

export type TerminalKind = "point" | "qr_caja" | "clover" | "posnet_manual" | "posnet_integrado" | "pinpad";

export interface PaymentTerminal {
  id: string;
  store_id: string;
  cash_register_id: string | null;
  provider_key: string;
  kind: TerminalKind;
  external_id: string | null;
  external_meta?: Record<string, unknown> | null;
  environment: "prod" | "test" | null;
  label: string;
  merchant_number: string | null;
  acquirer: string | null;
  is_default: boolean;
  active: boolean;
  last_seen_at: string | null;
  notes?: string | null;
  deleted_at?: string | null;
}

export const TERMINAL_KIND_LABEL: Record<TerminalKind, string> = {
  point: "Point / smart POS",
  qr_caja: "Caja QR",
  clover: "Clover",
  posnet_manual: "Posnet sin integrar",
  posnet_integrado: "Posnet integrado",
  pinpad: "Pinpad",
};

/** Proveedor → tipo de terminal que le corresponde. */
export function kindForProvider(provider: string): TerminalKind {
  if (provider === "mercadopago") return "qr_caja";
  if (provider === "fiserv_point") return "clover";
  if (provider.endsWith("_point")) return "point";
  return "posnet_manual";
}

export interface PickInput {
  terminals: PaymentTerminal[];
  providerKey: string;
  storeId: string | null;
  registerId: string | null;
  /** Ambiente actual (QR de MP): las de otro ambiente no sirven. */
  env?: "prod" | "test" | null;
  /** id externo recordado por el dispositivo (legado). */
  rememberedExternalId?: string | null;
  /** id de terminal recordado por el dispositivo. */
  rememberedTerminalId?: string | null;
}

export type PickReason = "register_default" | "register" | "store" | "remembered" | "none" | "ambiguous";

export interface PickResult {
  terminal: PaymentTerminal | null;
  /** Todas las válidas para la sucursal (para el selector de respaldo). */
  candidates: PaymentTerminal[];
  reason: PickReason;
}

export function usableTerminals(input: Omit<PickInput, "rememberedExternalId" | "rememberedTerminalId">): PaymentTerminal[] {
  return input.terminals.filter(
    (t) =>
      !t.deleted_at &&
      t.active &&
      t.provider_key === input.providerKey &&
      (!input.storeId || t.store_id === input.storeId) &&
      // Una terminal de OTRA caja de la sucursal no se ofrece.
      (!t.cash_register_id || !input.registerId || t.cash_register_id === input.registerId) &&
      (!input.env || !t.environment || t.environment === input.env),
  );
}

export function pickTerminal(input: PickInput): PickResult {
  const candidates = usableTerminals(input);
  const remembered =
    candidates.find((t) => input.rememberedTerminalId && t.id === input.rememberedTerminalId) ??
    candidates.find((t) => input.rememberedExternalId && t.external_id === input.rememberedExternalId) ??
    null;

  const own = candidates.filter((t) => input.registerId && t.cash_register_id === input.registerId);
  const def = own.find((t) => t.is_default);
  if (def) return { terminal: def, candidates, reason: "register_default" };
  if (own.length === 1) return { terminal: own[0]!, candidates, reason: "register" };
  if (own.length > 1) {
    return remembered && own.includes(remembered)
      ? { terminal: remembered, candidates, reason: "remembered" }
      : { terminal: null, candidates, reason: "ambiguous" };
  }
  const floating = candidates.filter((t) => !t.cash_register_id);
  if (floating.length === 1) return { terminal: floating[0]!, candidates, reason: "store" };
  if (remembered) return { terminal: remembered, candidates, reason: "remembered" };
  if (floating.length > 1) return { terminal: null, candidates, reason: "ambiguous" };
  return { terminal: null, candidates, reason: "none" };
}

/**
 * Terminal integrada (posnet integrado o pinpad, ADR-053) que usa la caja para
 * "Tarjeta". Misma prioridad que pickTerminal pero sin filtrar por marca: la
 * caja tiene una sola terminal de tarjeta integrada en uso.
 */
export function pickIntegratedTerminal(input: {
  terminals: PaymentTerminal[];
  storeId: string | null;
  registerId: string | null;
}): PickResult {
  const candidates = input.terminals.filter(
    (t) =>
      !t.deleted_at &&
      t.active &&
      (t.kind === "posnet_integrado" || t.kind === "pinpad") &&
      (!input.storeId || t.store_id === input.storeId) &&
      (!t.cash_register_id || !input.registerId || t.cash_register_id === input.registerId),
  );
  const own = candidates.filter((t) => input.registerId && t.cash_register_id === input.registerId);
  const def = own.find((t) => t.is_default);
  if (def) return { terminal: def, candidates, reason: "register_default" };
  if (own.length === 1) return { terminal: own[0]!, candidates, reason: "register" };
  if (own.length > 1) return { terminal: null, candidates, reason: "ambiguous" };
  const floating = candidates.filter((t) => !t.cash_register_id);
  if (floating.length === 1) return { terminal: floating[0]!, candidates, reason: "store" };
  if (floating.length > 1) return { terminal: null, candidates, reason: "ambiguous" };
  return { terminal: null, candidates, reason: "none" };
}

/** "Hace 5 min" / "Nunca" para last_seen_at. */
export function lastSeenLabel(iso: string | null, now: Date = new Date()): string {
  if (!iso) return "Sin uso";
  const ms = now.getTime() - new Date(iso).getTime();
  if (!Number.isFinite(ms) || ms < 0) return "Recién";
  const min = Math.floor(ms / 60_000);
  if (min < 1) return "Recién";
  if (min < 60) return `Hace ${min} min`;
  const h = Math.floor(min / 60);
  if (h < 24) return `Hace ${h} h`;
  const d = Math.floor(h / 24);
  return `Hace ${d} d`;
}

/** Valida el id externo según el tipo (espejo del check de la tabla). */
export function terminalExternalIdError(kind: TerminalKind, id: string): string | null {
  const v = id.trim();
  if (!v) return kind === "posnet_manual" ? null : "Cargá el identificador de la terminal.";
  if (!/^[A-Za-z0-9_.:-]{1,120}$/.test(v)) return "Sólo letras, números, guiones, puntos y dos puntos.";
  return null;
}
