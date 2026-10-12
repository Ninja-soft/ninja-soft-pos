// =============================================================================
// Credenciales de proveedor por sucursal (F17 · H93 · ADR-057).
//
// payment_secrets tiene una fila del negocio (store_id null) y, opcionalmente,
// una fila por sucursal que la pisa. Resolución: sucursal → negocio.
//
//   * pickSecretRow(rows, storeId): la de la sucursal pedida si existe; si no,
//     la del negocio. Las filas de OTRAS sucursales nunca se usan.
//   * exactScopeRow(rows, scopeStoreId): la credencial con la que se creó un
//     cobro (mp_payment_intents.secret_store_id). Si esa fila ya no existe, la
//     del negocio (mejor intentar que dejar el cobro colgado).
//   * loadProviderSecret / saveProviderSecret / updateSecretRow: acceso con
//     service_role. Compatibles con una base SIN la migración 20261020100000
//     (sin columnas id / store_id): caen a la consulta de siempre.
//
// Las funciones puras no usan Deno: las importa Vitest.
// =============================================================================

// deno-lint-ignore no-explicit-any
type Admin = any;

export type SecretRow = {
  id?: string | null;
  store_id: string | null;
  secrets: Record<string, unknown> | null;
};

export type LoadedSecret = {
  secrets: Record<string, unknown>;
  /** Sucursal de la fila usada (null = credencial del negocio). */
  scopeStoreId: string | null;
  rowId: string | null;
};

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export const isScopeUuid = (v: unknown): v is string => typeof v === "string" && UUID_RE.test(v);

/** Fila efectiva para una sucursal: la propia → la del negocio. */
export function pickSecretRow<T extends SecretRow>(rows: T[] | null | undefined, storeId: string | null | undefined): T | null {
  const list = rows ?? [];
  if (storeId) {
    const own = list.find((r) => r.store_id === storeId);
    if (own) return own;
  }
  return list.find((r) => r.store_id == null) ?? null;
}

/** Fila exacta del alcance registrado; si ya no existe, la del negocio. */
export function exactScopeRow<T extends SecretRow>(
  rows: T[] | null | undefined,
  scopeStoreId: string | null | undefined,
): T | null {
  const list = rows ?? [];
  if (scopeStoreId) {
    const own = list.find((r) => r.store_id === scopeStoreId);
    if (own) return own;
  }
  return list.find((r) => r.store_id == null) ?? null;
}

function toLoaded(row: SecretRow | null): LoadedSecret | null {
  if (!row) return null;
  return {
    secrets: (row.secrets ?? {}) as Record<string, unknown>,
    scopeStoreId: row.store_id ?? null,
    rowId: row.id ?? null,
  };
}

/**
 * Credencial de un proveedor para un negocio.
 * - `scopeStoreId` definido (incluso null): alcance exacto registrado en el
 *   cobro (webhooks, status, cancel).
 * - si no, se resuelve por `storeId` (sucursal donde se cobra).
 */
export async function loadProviderSecret(
  admin: Admin,
  tenantId: string,
  providerKey: string,
  opts: { storeId?: string | null; scopeStoreId?: string | null } = {},
): Promise<LoadedSecret | null> {
  const exact = opts.scopeStoreId !== undefined;
  const wanted = exact ? opts.scopeStoreId : opts.storeId;
  const branch = isScopeUuid(wanted) ? wanted : null;

  let q = admin
    .from("payment_secrets")
    .select("id, store_id, secrets")
    .eq("tenant_id", tenantId)
    .eq("provider_key", providerKey);
  q = branch ? q.or(`store_id.is.null,store_id.eq.${branch}`) : q.is("store_id", null);
  const { data, error } = await q;
  if (!error) {
    const rows = (data ?? []) as SecretRow[];
    return toLoaded(exact ? exactScopeRow(rows, branch) : pickSecretRow(rows, branch));
  }

  // Base sin la migración: una fila por (negocio, proveedor).
  const legacy = await admin
    .from("payment_secrets")
    .select("secrets")
    .eq("tenant_id", tenantId)
    .eq("provider_key", providerKey)
    .maybeSingle();
  if (legacy.error || !legacy.data) return null;
  return { secrets: (legacy.data.secrets ?? {}) as Record<string, unknown>, scopeStoreId: null, rowId: null };
}

/** Upsert de la credencial de un alcance (null = negocio). */
export async function saveProviderSecret(
  admin: Admin,
  args: { tenantId: string; providerKey: string; storeId: string | null; secrets: Record<string, unknown> },
): Promise<{ error: { message: string } | null }> {
  const up = await admin.from("payment_secrets").upsert(
    {
      tenant_id: args.tenantId,
      provider_key: args.providerKey,
      store_id: args.storeId,
      secrets: args.secrets,
      updated_at: new Date().toISOString(),
    },
    { onConflict: "tenant_id,provider_key,store_id" },
  );
  if (!up.error) return { error: null };
  if (args.storeId) return { error: up.error };
  // Base sin la migración.
  const legacy = await admin.from("payment_secrets").upsert(
    { tenant_id: args.tenantId, provider_key: args.providerKey, secrets: args.secrets },
    { onConflict: "tenant_id,provider_key" },
  );
  return { error: legacy.error ?? null };
}

/** Reescribe los secretos de la fila usada (p. ej. refresh de un token). */
export async function updateSecretRow(
  admin: Admin,
  ref: { rowId: string | null; tenantId: string; providerKey: string; storeId: string | null },
  secrets: Record<string, unknown>,
): Promise<void> {
  if (ref.rowId) {
    await admin.from("payment_secrets").update({ secrets }).eq("id", ref.rowId);
    return;
  }
  let q = admin
    .from("payment_secrets")
    .update({ secrets })
    .eq("tenant_id", ref.tenantId)
    .eq("provider_key", ref.providerKey);
  if (ref.storeId) q = q.eq("store_id", ref.storeId);
  await q;
}

/** Borra la credencial de un alcance (null = la del negocio). */
export async function deleteProviderSecret(
  admin: Admin,
  args: { tenantId: string; providerKey: string; storeId: string | null },
): Promise<void> {
  const q = admin
    .from("payment_secrets")
    .delete()
    .eq("tenant_id", args.tenantId)
    .eq("provider_key", args.providerKey);
  const { error } = await (args.storeId ? q.eq("store_id", args.storeId) : q.is("store_id", null));
  if (error && !args.storeId) {
    // Base sin la migración.
    await admin.from("payment_secrets").delete().eq("tenant_id", args.tenantId).eq("provider_key", args.providerKey);
  }
}

/**
 * Sucursal del cobro (body.store_id). No hace falta validarla contra el
 * negocio: la consulta filtra por tenant_id y el trigger de payment_secrets
 * garantiza que una fila de sucursal es de una sucursal del mismo negocio;
 * una sucursal ajena simplemente no encuentra fila y se usa la del negocio.
 */
export function bodyStoreId(b: Record<string, unknown> | null | undefined): string | null {
  return isScopeUuid(b?.store_id) ? (b!.store_id as string) : null;
}

/**
 * Inserta un intent con secret_store_id; si la columna todavía no existe
 * (Edge desplegada antes que la migración), reintenta sin ella.
 */
export async function insertIntentWithScope<T = unknown>(
  admin: Admin,
  row: Record<string, unknown>,
  scopeStoreId: string | null,
  select = "id",
): Promise<{ data: T | null; error: { message: string } | null }> {
  const first = await admin
    .from("mp_payment_intents")
    .insert({ ...row, secret_store_id: scopeStoreId })
    .select(select)
    .single();
  if (!first.error) return first;
  if (!String(first.error.message ?? "").includes("secret_store_id")) return first;
  return await admin.from("mp_payment_intents").insert(row).select(select).single();
}

/** secret_store_id de un intent (null si no tiene o la columna no existe). */
export async function intentSecretScope(admin: Admin, intentId: string): Promise<string | null> {
  const { data, error } = await admin
    .from("mp_payment_intents")
    .select("secret_store_id")
    .eq("id", intentId)
    .maybeSingle();
  if (error || !data) return null;
  return (data as { secret_store_id?: string | null }).secret_store_id ?? null;
}

// OAuth de Mercado Pago por sucursal: la sucursal viaja dentro del state
// ("<uuid>.s.<store uuid>"). El state es la PK de mp_oauth_states y sólo existe
// si lo creó mp_oauth_start, así que no se puede forjar una sucursal ajena.
const STATE_SEP = ".s.";

export function oauthStateFor(base: string, storeId: string | null): string {
  return storeId && isScopeUuid(storeId) ? `${base}${STATE_SEP}${storeId}` : base;
}

export function storeFromOAuthState(state: string): string | null {
  const i = state.indexOf(STATE_SEP);
  if (i < 0) return null;
  const s = state.slice(i + STATE_SEP.length);
  return isScopeUuid(s) ? s : null;
}

/** Código de error de payment_secret_scope_check → status HTTP. */
export function scopeErrorStatus(code: string): number {
  if (code === "store_not_found") return 404;
  if (code === "feature_not_in_plan") return 402;
  return 403;
}
