// =============================================================================
// Heartbeat de cada caja (F17 · H99 · ADR-080). Puro y testeable.
//
// El POS manda una señal por minuto (register_heartbeat) con la versión de la
// app y el estado del equipo; el monitor de sucursales muestra la última señal
// de cada caja y avisa las que quedaron mudas con un turno abierto.
// Espeja la whitelist de heartbeat_info_clean (SQL): lo que no esté acá, el
// servidor lo descarta.
// =============================================================================

export const HEARTBEAT_INTERVAL_MS = 60_000;
/** La pantalla del cliente avisa que está viva cada 30 s. */
export const DISPLAY_PRESENCE_INTERVAL_MS = 30_000;
/** Sin aviso de la pantalla en 90 s = desconectada. */
export const DISPLAY_PRESENCE_TTL_MS = 90_000;
export const DISPLAY_PRESENCE_CHANNEL = "ninja-customer-display-presence";

export type PeripheralState = "ok" | "error" | "off" | "none" | "unknown";

export interface HeartbeatInfo {
  printer?: PeripheralState;
  display?: PeripheralState;
  scale?: PeripheralState;
  drawer?: PeripheralState;
  terminal?: PeripheralState;
  online?: boolean;
  visible?: boolean;
  platform?: string;
  browser?: string;
}

export interface HeartbeatEnv {
  online: boolean;
  visible: boolean;
  userAgent?: string | null;
  platform?: string | null;
  /** Último aviso de la pantalla del cliente (ms epoch) o null si nunca. */
  displaySeenAt?: number | null;
  now: number;
}

/** "Chrome 129", "Edge 128", "Firefox 131", "Safari 17"; null si no se reconoce. */
export function browserName(ua: string | null | undefined): string | null {
  if (!ua) return null;
  const pick = (re: RegExp, name: string) => {
    const m = ua.match(re);
    return m ? `${name} ${m[1]}` : null;
  };
  return (
    pick(/Edg\/(\d+)/, "Edge") ??
    pick(/OPR\/(\d+)/, "Opera") ??
    pick(/SamsungBrowser\/(\d+)/, "Samsung") ??
    pick(/Firefox\/(\d+)/, "Firefox") ??
    pick(/Chrome\/(\d+)/, "Chrome") ??
    (/Safari\//.test(ua) ? pick(/Version\/(\d+)/, "Safari") : null)
  );
}

const SAFE = /[^A-Za-z0-9 ._()/-]/g;
const clean = (s: string | null | undefined, max = 60) =>
  s ? s.replace(SAFE, "").slice(0, max) || undefined : undefined;

/** Información del equipo que viaja en cada señal. */
export function buildHeartbeatInfo(env: HeartbeatEnv): HeartbeatInfo {
  const info: HeartbeatInfo = { online: env.online, visible: env.visible };
  const browser = clean(browserName(env.userAgent));
  if (browser) info.browser = browser;
  const platform = clean(env.platform);
  if (platform) info.platform = platform;
  if (env.displaySeenAt != null) {
    info.display = env.now - env.displaySeenAt <= DISPLAY_PRESENCE_TTL_MS ? "ok" : "off";
  } else {
    info.display = "none";
  }
  return info;
}

export type RegisterSignal = "online" | "stale" | "never";

/** Estado de la señal de una caja según su último ping. */
export function registerSignal(
  lastPingAt: string | null | undefined,
  now: Date,
  staleMinutes: number,
): RegisterSignal {
  if (!lastPingAt) return "never";
  const age = (now.getTime() - new Date(lastPingAt).getTime()) / 60_000;
  return age > Math.max(1, staleMinutes) ? "stale" : "online";
}

export const SIGNAL_LABEL: Record<RegisterSignal, string> = {
  online: "Con señal",
  stale: "Sin señal",
  never: "Nunca conectada",
};

/** Texto corto del equipo: "Chrome 129 · Windows · pantalla conectada". */
export function deviceSummary(info: HeartbeatInfo | null | undefined, appVersion?: string | null): string {
  const parts: string[] = [];
  if (info?.browser) parts.push(info.browser);
  if (info?.platform) parts.push(info.platform);
  if (info?.display === "ok") parts.push("pantalla conectada");
  else if (info?.display === "off") parts.push("pantalla desconectada");
  if (info?.online === false) parts.push("sin internet");
  if (appVersion) parts.push(`v${appVersion}`);
  return parts.join(" · ");
}
