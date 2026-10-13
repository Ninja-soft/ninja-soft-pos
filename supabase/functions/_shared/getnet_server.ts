// =============================================================================
// Getnet: helpers server-side (Deno) compartidos por `getnet`,
// `getnet_webhook` y `payment_provider_data` (ADR-065). Resuelven el token con
// el perfil de API guardado (o lo detectan y lo guardan), y dejan un log
// estructurado de cada rechazo, sin secretos. La lógica pura vive en
// ./getnet.ts (Vitest).
// =============================================================================
import {
  describeDetectFailure,
  type DetectResult,
  detectGetnetProfile,
  fetchGetnetSeller,
  type GetnetDiag,
  type GetnetEnv,
  logGetnetError,
  resolveGetnetAuth,
  type ResolvedAuth,
  type SellerInfo,
} from "./getnet.ts";
import { type LoadedSecret, loadProviderSecret, updateSecretRow } from "./paymentSecrets.ts";
import {
  type ApiAuth,
  apiCredsOf,
  classifyCredential,
  hasWebCheckoutCreds,
  requestApiToken,
  type SlotKey,
} from "./getnet_api.ts";

// deno-lint-ignore no-explicit-any
type Admin = any;

// =============================================================================
// Dos slots de credenciales en la misma fila de Getnet (ADR-069):
//   * web_checkout: client_id / client_secret (QR + link hosted, ADR-065).
//   * checkout_api: api_client_id / api_client_secret (checkout propio /pagar).
// Cada slot se hereda por separado: si la credencial de la sucursal no trae
// ese slot, se usa el del negocio.
// =============================================================================
const hasSlot = (slot: SlotKey, sec: Record<string, unknown> | null | undefined) =>
  slot === "checkout_api" ? apiCredsOf(sec) !== null : hasWebCheckoutCreds(sec);

/**
 * Credencial de Getnet con el slot pedido. `storeId`: sucursal donde se cobra
 * (create). `scopeStoreId`: alcance registrado en el intent (status, pay).
 */
export async function loadGetnetSlot(
  admin: Admin,
  tenantId: string,
  slot: SlotKey,
  opts: { storeId?: string | null; scopeStoreId?: string | null },
): Promise<LoadedSecret | null> {
  const row = await loadProviderSecret(admin, tenantId, "getnet", opts);
  if (row && hasSlot(slot, row.secrets)) return row;
  if (row?.scopeStoreId) {
    const tenantRow = await loadProviderSecret(admin, tenantId, "getnet", { scopeStoreId: null });
    if (tenantRow && tenantRow.scopeStoreId === null && hasSlot(slot, tenantRow.secrets)) return tenantRow;
  }
  return null;
}

/**
 * Checkout propio con la Checkout API: la tarjeta pasa por nuestra Edge para
 * tokenizarla (Getnet no ofrece tokenización desde el navegador). Queda
 * APAGADO hasta que NinjaSoft tenga la validación PCI DSS que lo permite
 * (secret de Supabase GETNET_CHECKOUT_API_PCI_ATTESTED=true). ADR-069.
 */
export function getnetPanRelayEnabled(): boolean {
  return (Deno.env.get("GETNET_CHECKOUT_API_PCI_ATTESTED") ?? "").trim().toLowerCase() === "true";
}

/** Switch Sandbox del medio (fallback del ambiente si la credencial no lo trae). */
export async function loadGetnetSandbox(admin: Admin, tenantId: string): Promise<boolean> {
  const { data } = await admin
    .from("tenant_payment_methods")
    .select("sandbox")
    .eq("tenant_id", tenantId)
    .eq("provider_key", "getnet")
    .maybeSingle();
  return (data as { sandbox?: boolean } | null)?.sandbox === true;
}

export type AuthOk = Extract<ResolvedAuth, { ok: true }>;
export type AuthFail = { ok: false; detail: string; attempts: GetnetDiag[]; env: string };

/**
 * Token para la credencial cargada. Si el perfil se detectó ahora (credencial
 * vieja sin api_profile, o el guardado dejó de andar), se guarda en la fila
 * para no volver a probar todos los servicios en cada cobro.
 */
export async function getnetAuth(
  admin: Admin,
  tenantId: string,
  row: LoadedSecret,
  fn: string,
): Promise<AuthOk | AuthFail> {
  const sec = row.secrets ?? {};
  const sandbox = await loadGetnetSandbox(admin, tenantId);
  const r = await resolveGetnetAuth(sec, sandbox);
  if (!r.ok) {
    for (const d of r.attempts) logGetnetError(fn, d, { tenant_id: tenantId, mismatch: r.mismatch });
    return { ok: false, detail: describeDetectFailure(r), attempts: r.attempts, env: r.env };
  }
  if (r.detected) {
    try {
      await updateSecretRow(
        admin,
        { rowId: row.rowId, tenantId, providerKey: "getnet", storeId: row.scopeStoreId },
        { ...sec, api_profile: r.profile.key, environment: r.env },
      );
    } catch (e) {
      console.error(JSON.stringify({ fn, step: "persist_profile", error: String(e).slice(0, 200) }));
    }
  }
  return r;
}

// =============================================================================
// ¿Qué credencial es? (ADR-069). Prueba la credencial contra Web Checkout
// (token + GET /sellers) y contra la Checkout API (token Basic). La usan
// "Probar" (Edge getnet) y el guardado (set_payment_secret), así los dos
// deciden igual. No guarda nada ni devuelve secretos.
// =============================================================================
export type GetnetAssessment = {
  web: DetectResult;
  /** Web Checkout es su producto: true (GET /sellers ok o Geopagos), false (401/403/404), null (no se pudo saber). */
  webProduct: boolean | null;
  seller: SellerInfo | null;
  sellerDiag: GetnetDiag | null;
  api: ApiAuth;
  verdict: ReturnType<typeof classifyCredential>;
};

export async function assessGetnetCredential(opts: {
  slot: SlotKey;
  clientId: string;
  clientSecret: string;
  env: GetnetEnv;
  preferred?: unknown;
  crossEnv?: boolean;
}): Promise<GetnetAssessment> {
  const web = await detectGetnetProfile(opts.clientId, opts.clientSecret, {
    env: opts.env,
    preferred: opts.preferred,
    crossEnv: opts.crossEnv === true,
  });
  let seller: SellerInfo | null = null;
  let webProduct: boolean | null = null;
  let sellerDiag: GetnetDiag | null = null;
  if (web.ok && web.profile.api === "global") {
    const s = await fetchGetnetSeller(web.profile, web.token);
    if (s.ok) {
      seller = s.seller;
      webProduct = s.seller.checkout_enabled !== false;
    } else {
      sellerDiag = s.diag;
      // 401/403/404 en /sellers: el token sale, pero Web Checkout no es su producto.
      webProduct = [401, 403, 404].includes(s.diag.http_status) ? false : null;
    }
  } else if (web.ok) {
    webProduct = true; // Geopagos: el token alcanza.
  }
  const api = await requestApiToken({ clientId: opts.clientId, clientSecret: opts.clientSecret, env: opts.env });
  const verdict = classifyCredential({ slot: opts.slot, webToken: web.ok, webProduct, apiToken: api.ok });
  return { web, webProduct, seller, sellerDiag, api, verdict };
}
