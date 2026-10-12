// =============================================================================
// Registro de terminales de cobro (F17 · H93 · ADR-049) del lado de las Edges.
//
// Las Edges de cobro presencial (mp_point, nave_point, clover_point, mp_qr)
// aceptan `terminal_id` (payment_terminals.id). Se valida en el servidor con
// la RPC terminal_for_user (service_role): la terminal tiene que ser del
// negocio, estar activa, ser del proveedor esperado y estar en una sucursal
// que el usuario puede operar (y, si el POS manda store_id, en ESA sucursal).
// Los parámetros viejos (device_id, la caja QR única de config.mp_qr) siguen
// funcionando: terminal_id es opcional.
//
// Además: medio apagado por la sucursal o la caja (config_overrides, H92) →
// payment_method_disabled_in_store, para no depender sólo del front.
// =============================================================================

// deno-lint-ignore no-explicit-any
type Admin = any;

export type TerminalRow = {
  id: string;
  tenant_id: string;
  store_id: string;
  cash_register_id: string | null;
  provider_key: string;
  kind: string;
  external_id: string | null;
  external_meta: Record<string, unknown> | null;
  environment: string | null;
  label: string;
  merchant_number: string | null;
};

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export const isUuid = (v: unknown): v is string => typeof v === "string" && UUID_RE.test(v);

/** store_id / register_id opcionales del body (sólo si son uuid). */
export function locationOf(b: Record<string, unknown>): { storeId: string | null; registerId: string | null } {
  return {
    storeId: isUuid(b.store_id) ? b.store_id : null,
    registerId: isUuid(b.register_id) ? b.register_id : null,
  };
}

export type ResolveResult = { ok: true; terminal: TerminalRow } | { ok: false; error: string };

/**
 * Valida la terminal pedida para el usuario. `providers`: proveedores
 * aceptados (p. ej. ["mercadopago_point"]).
 */
export async function resolveTerminal(
  admin: Admin,
  args: { tenantId: string; userId: string; terminalId: unknown; providers: string[]; storeId?: string | null },
): Promise<ResolveResult> {
  if (!isUuid(args.terminalId)) return { ok: false, error: "invalid_terminal" };
  const { data, error } = await admin.rpc("terminal_for_user", {
    p_tenant: args.tenantId,
    p_user: args.userId,
    p_terminal: args.terminalId,
    p_store: args.storeId ?? null,
  });
  if (error) return { ok: false, error: "terminal_lookup_failed" };
  const row = (Array.isArray(data) ? data[0] : data) as TerminalRow | undefined;
  if (!row) return { ok: false, error: "terminal_not_found" };
  if (!args.providers.includes(row.provider_key)) return { ok: false, error: "terminal_provider_mismatch" };
  if (!row.external_id) return { ok: false, error: "terminal_without_id" };
  return { ok: true, terminal: row };
}

/** last_seen_at = ahora (best effort, no corta el cobro). */
export async function touchTerminal(admin: Admin, id: string | null | undefined): Promise<void> {
  if (!id) return;
  try {
    await admin.from("payment_terminals").update({ last_seen_at: new Date().toISOString() }).eq("id", id);
  } catch {
    // Sin importancia para el cobro.
  }
}

/** ¿La sucursal / caja apagó este medio? (config_overrides). */
export async function methodBlockedAt(
  admin: Admin,
  tenantId: string,
  providerKey: string,
  storeId: string | null,
  registerId: string | null,
): Promise<boolean> {
  if (!storeId && !registerId) return false;
  const { data, error } = await admin.rpc("payment_method_blocked_at", {
    p_tenant: tenantId,
    p_provider: providerKey,
    p_store_id: storeId,
    p_register_id: registerId,
  });
  // Si la RPC no existe todavía (Edge desplegada antes que la migración), no
  // se bloquea: el trigger de payments vuelve a mirar al registrar la venta.
  if (error) return false;
  return data === true;
}
