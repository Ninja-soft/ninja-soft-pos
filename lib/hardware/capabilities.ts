"use client";

// =============================================================================
// Centro de diagnóstico de hardware (F10 · H26) — capacidades del navegador
// -----------------------------------------------------------------------------
// Detecta, de forma honesta, qué APIs de hardware soporta REALMENTE el navegador
// del equipo. Soporte de NinjaSoft usa esto para saber qué puede y qué no puede
// hacer la máquina del cliente sin conectarse a ella.
//
// IMPORTANTE — honestidad sobre los límites del navegador: detectar que una API
// "existe" (p. ej. `navigator.usb`) NO significa que haya un dispositivo
// conectado ni que el cliente lo haya autorizado. Solo informa que la
// plataforma la expone. La activación real de cada periférico requiere permiso
// del usuario y, en varios casos, un conector local (ver cajón de dinero).
// =============================================================================

export type CapStatus = "ok" | "partial" | "unavailable";

export interface Capability {
  key: string;
  label: string;
  status: CapStatus;
  // Detalle legible para soporte (qué significa y por qué).
  detail: string;
}

export interface EnvInfo {
  userAgent: string;
  platform: string;
  language: string;
  // Pantalla / resolución del equipo (para saber si entra la doble pantalla).
  screen: string;
  viewport: string;
  devicePixelRatio: number;
  online: boolean;
  // Núcleos lógicos / memoria aproximada (cuando el navegador los expone).
  hardwareConcurrency: number | null;
  deviceMemoryGb: number | null;
  touch: boolean;
  // Origen seguro: WebUSB/WebSerial solo funcionan sobre HTTPS o localhost.
  secureContext: boolean;
}

function has(obj: unknown, key: string): boolean {
  try {
    return typeof obj === "object" && obj !== null && key in obj;
  } catch {
    return false;
  }
}

// Lista de capacidades de hardware relevantes para el POS, con su estado real.
export function detectCapabilities(): Capability[] {
  if (typeof window === "undefined" || typeof navigator === "undefined") {
    return [];
  }
  const nav = navigator as Navigator & {
    usb?: unknown;
    serial?: unknown;
    bluetooth?: unknown;
  };
  const secure = Boolean(window.isSecureContext);

  const caps: Capability[] = [];

  // BroadcastChannel — base de la pantalla del cliente (H25).
  caps.push({
    key: "broadcastChannel",
    label: "BroadcastChannel",
    status: "BroadcastChannel" in window ? "ok" : "unavailable",
    detail:
      "BroadcastChannel" in window
        ? "Disponible: la pantalla del cliente se sincroniza en vivo en este equipo."
        : "No disponible: la pantalla del cliente cae al respaldo por localStorage (también funciona).",
  });

  // BarcodeDetector — escaneo por cámara como fallback del lector USB.
  caps.push({
    key: "barcodeDetector",
    label: "BarcodeDetector (cámara)",
    status: "BarcodeDetector" in window ? "ok" : "unavailable",
    detail:
      "BarcodeDetector" in window
        ? "Disponible: la cámara del equipo puede leer códigos como fallback del lector."
        : "No disponible en este navegador: usá un lector USB/HID o la entrada manual. (Suele faltar en Firefox/Safari de escritorio.)",
  });

  // WebUSB — necesario para hablar con algunas térmicas/cajones por conector.
  caps.push({
    key: "webusb",
    label: "WebUSB",
    status: has(nav, "usb") ? (secure ? "ok" : "partial") : "unavailable",
    detail: has(nav, "usb")
      ? secure
        ? "Disponible: el navegador puede pedir permiso para dispositivos USB. Requiere autorización del usuario por dispositivo."
        : "Presente pero requiere origen seguro (HTTPS): hoy el sitio no es contexto seguro."
      : "No disponible: este navegador no expone WebUSB (Firefox/Safari no lo soportan).",
  });

  // WebSerial — balanzas, displays seriales, algunas impresoras.
  caps.push({
    key: "webserial",
    label: "WebSerial",
    status: has(nav, "serial") ? (secure ? "ok" : "partial") : "unavailable",
    detail: has(nav, "serial")
      ? secure
        ? "Disponible: el navegador puede abrir puertos serie (balanza/display), con permiso del usuario."
        : "Presente pero requiere origen seguro (HTTPS): hoy el sitio no es contexto seguro."
      : "No disponible: este navegador no expone WebSerial (Firefox/Safari no lo soportan).",
  });

  // Web Bluetooth — lectores/balanzas BLE.
  caps.push({
    key: "webbluetooth",
    label: "Web Bluetooth",
    status: has(nav, "bluetooth") ? (secure ? "ok" : "partial") : "unavailable",
    detail: has(nav, "bluetooth")
      ? secure
        ? "Disponible: el navegador puede vincular dispositivos Bluetooth con permiso del usuario."
        : "Presente pero requiere origen seguro (HTTPS)."
      : "No disponible: este navegador no expone Web Bluetooth.",
  });

  // Impresión web — universal; window.print() siempre está.
  caps.push({
    key: "webprint",
    label: "Impresión web (window.print)",
    status: typeof window.print === "function" ? "ok" : "unavailable",
    detail:
      typeof window.print === "function"
        ? "Disponible: imprime por el diálogo del sistema (térmica 58/80mm o A4). Es el método universal del POS."
        : "No disponible: el navegador no expone window.print().",
  });

  // Clipboard — útil para copiar el diagnóstico/IDs a soporte.
  caps.push({
    key: "clipboard",
    label: "Portapapeles",
    status: has(nav, "clipboard") ? "ok" : "partial",
    detail: has(nav, "clipboard")
      ? "Disponible: se puede copiar el diagnóstico al portapapeles."
      : "Limitado: usá el botón de descarga del diagnóstico.",
  });

  return caps;
}

// Información del entorno/equipo (no es una capacidad on/off, son datos).
export function detectEnv(): EnvInfo | null {
  if (typeof window === "undefined" || typeof navigator === "undefined") {
    return null;
  }
  const nav = navigator as Navigator & {
    deviceMemory?: number;
    hardwareConcurrency?: number;
    maxTouchPoints?: number;
  };
  const scr = window.screen;
  return {
    userAgent: nav.userAgent ?? "—",
    platform:
      (nav as unknown as { platform?: string }).platform ??
      (nav as unknown as { userAgentData?: { platform?: string } }).userAgentData
        ?.platform ??
      "—",
    language: nav.language ?? "—",
    screen: scr ? `${scr.width}×${scr.height}` : "—",
    viewport: `${window.innerWidth}×${window.innerHeight}`,
    devicePixelRatio: Math.round((window.devicePixelRatio || 1) * 100) / 100,
    online: typeof nav.onLine === "boolean" ? nav.onLine : true,
    hardwareConcurrency:
      typeof nav.hardwareConcurrency === "number" ? nav.hardwareConcurrency : null,
    deviceMemoryGb: typeof nav.deviceMemory === "number" ? nav.deviceMemory : null,
    touch: (nav.maxTouchPoints ?? 0) > 0,
    secureContext: Boolean(window.isSecureContext),
  };
}
