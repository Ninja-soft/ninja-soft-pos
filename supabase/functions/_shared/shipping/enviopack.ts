// =============================================================================
// _shared/shipping/enviopack.ts  (ADR-103) · ESQUELETO (agregador)
//
// Envíopack: agregador multi-carrier (Andreani, OCA, Correo, Urbano y
// mensajerías; lista A CONFIRMAR). API REST en https://api.enviopack.com
// según su SDK PHP (enviopack/sdk); recursos y formato A CONFIRMAR con la
// documentación de la cuenta. Auth: API key + secret key que devuelven un
// access token. Cotización, alta y etiqueta (PDF; Zebra según
// configuración), seguimiento unificado y notificaciones por URL (webhook)
// por cambio de estado: cuando se integre, sumar la Edge pública
// `shipping_webhook` (config.toml y PUBLIC_FUNCTIONS de deploy-check) y
// parseWebhook con verificación de firma y dedupe.
//
// Credenciales que se piden: API key y secret key de la cuenta Envíopack.
// =============================================================================
import { GENERIC_STATUS_MAP, skeletonAdapter } from "./skeleton.ts";

export const enviopackAdapter = skeletonAdapter({
  key: "enviopack",
  name: "Envíopack",
  capabilities: { quote: true, label: true, points: true, track: true, cancel: true, webhooks: true, pickup: true },
  labelFormats: ["pdf"],
  statusMap: GENERIC_STATUS_MAP,
});
