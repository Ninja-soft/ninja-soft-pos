// App de Mercado Libre de NinjaSoft en el panel interno (ADR-126).
// Puro: tópicos a suscribir en DevCenter, URLs sugeridas y el estado legible
// de la config (qué origen rige y qué falta). Lo usan la sección interna
// Mercado Libre y sus tests.

import { HOOKS_HOST } from "@/lib/hooks";
import type { MlAppField, MlConfigOrigin } from "@/supabase/functions/_shared/mercadolibre/config";

export type MlTopicPhase = "mvp" | "v2" | "v3";

/** Tópicos a tildar en DevCenter (docs/38-mercadolibre.md §1.2). */
export const ML_TOPICS: { topic: string; phase: MlTopicPhase; use: string }[] = [
  { topic: "orders_v2", phase: "mvp", use: "Ventas: altas, pagos, cancelaciones y fraude" },
  { topic: "items", phase: "mvp", use: "Cambios de publicaciones hechos desde Mercado Libre" },
  { topic: "items_prices", phase: "mvp", use: "Precio cambiado en Mercado Libre" },
  { topic: "questions", phase: "mvp", use: "Bandeja de preguntas" },
  { topic: "shipments", phase: "mvp", use: "Estado del envío y etiquetas" },
  { topic: "user_products", phase: "v2", use: "Se guardan sin procesar hasta v2" },
  { topic: "stock-location", phase: "v2", use: "Se guardan sin procesar hasta v2" },
  { topic: "fbm_stock_operations", phase: "v2", use: "Se guardan sin procesar hasta v2" },
  { topic: "flex-handshakes", phase: "v2", use: "Se guardan sin procesar hasta v2" },
  { topic: "messages", phase: "v2", use: "Se guardan sin procesar hasta v2" },
  { topic: "post_purchase", phase: "v2", use: "Se guardan sin procesar hasta v2" },
  { topic: "payments", phase: "v2", use: "Se guardan sin procesar hasta v2" },
  { topic: "invoices", phase: "v2", use: "Se guardan sin procesar hasta v2" },
  { topic: "public_offers", phase: "v3", use: "Se guardan sin procesar hasta v3" },
  { topic: "public_candidates", phase: "v3", use: "Se guardan sin procesar hasta v3" },
  { topic: "catalog_item_competition_status", phase: "v3", use: "Se guardan sin procesar hasta v3" },
  { topic: "price_suggestion", phase: "v3", use: "Se guardan sin procesar hasta v3" },
];

/** URL de notificaciones con el dominio propio de webhooks (ADR-069, lib/hooks.ts). */
export function mlWebhookUrl(): string {
  return `https://${HOOKS_HOST}/ml`;
}

/** URL directa de la Edge (alternativa, por si el dominio propio no responde). */
export function mlWebhookDirectUrl(supabaseUrl: string | undefined): string | null {
  const base = (supabaseUrl ?? "").trim().replace(/\/+$/, "");
  return base ? `${base}/functions/v1/ml_webhook` : null;
}

export function mlRedirectUri(appOrigin: string): string {
  return `${appOrigin.replace(/\/+$/, "")}/api/ml/oauth/callback`;
}

export type MlAppStatus = {
  updated_at: string | null;
  client_id: string | null;
  client_secret: boolean;
  redirect_uri: string | null;
  hints?: Partial<Record<"client_secret", string | null>>;
  missing: MlAppField[];
  origin: MlConfigOrigin | null;
  effective: { client_id: string; redirect_uri: string } | null;
  env: { client_id: string | null; client_secret: boolean; redirect_uri: string | null };
  stats?: MlAppStats | null;
};

export type MlAppStats = {
  tenants_connected: number;
  accounts_active: number;
  accounts_reauth: number;
  notifications_24h: number;
  notifications_errors_24h: number;
  last_notifications: { topic: string; status: string; source: string; received_at: string }[];
};

export type MlAppTestResult = {
  ok: boolean;
  error?: string;
  origin?: MlConfigOrigin | null;
  client_id?: string;
  method?: "client_credentials" | "token_probe";
  app?: {
    id: number | string | null;
    name: string | null;
    site_id: string | null;
    redirect_uri: string | null;
    notifications_url: string | null;
    topics: string[] | null;
  } | null;
  at: string;
};

const FIELD_LABEL: Record<MlAppField, string> = {
  client_id: "App ID",
  client_secret: "Clave secreta",
  redirect_uri: "Redirect URI",
};

export type MlReadiness =
  | { tone: "ok"; title: string; detail: string }
  | { tone: "warn"; title: string; detail: string }
  | { tone: "bad"; title: string; detail: string };

/** Estado legible: qué config rige y qué le falta a la del panel. */
export function mlReadiness(s: MlAppStatus): MlReadiness {
  const list = (fs: MlAppField[]) => fs.map((f) => FIELD_LABEL[f]).join(", ");
  if (s.origin === "platform") {
    // La redirect es opcional en el panel si los secrets de Edge la definen.
    return {
      tone: "ok",
      title: "Configurada",
      detail: s.missing.includes("redirect_uri")
        ? "Rige la configuración de este panel (la Redirect URI sale de los secrets de Edge)."
        : "Rige la configuración de este panel.",
    };
  }
  const panelHasSomething = Boolean(s.client_id || s.client_secret || s.redirect_uri);
  const missingPanel = s.missing.filter((f) => f !== "redirect_uri");
  if (s.origin === "env") {
    return {
      tone: "warn",
      title: "Configurada con secrets de Edge",
      detail: panelHasSomething
        ? `Lo cargado acá todavía no rige: falta ${list(missingPanel)}.`
        : "Funciona con ML_CLIENT_ID y ML_CLIENT_SECRET. Cargala acá para manejarla desde el panel.",
    };
  }
  const all = s.missing.length > 0 ? s.missing : (["client_id", "client_secret"] as MlAppField[]);
  return {
    tone: "bad",
    title: "Sin configurar",
    detail: `Falta ${list(all)}. Los negocios no pueden conectar su cuenta de Mercado Libre.`,
  };
}
