"use client";

import { useEffect, useRef, useState } from "react";

// =============================================================================
// Pantalla del cliente / doble pantalla (F10 · H25)
// -----------------------------------------------------------------------------
// El POS (ventana del cajero) PUBLICA el estado de la venta en curso; la ruta
// /customer-display (ventana del 2do monitor/tablet) lo SUSCRIBE y lo muestra en
// vivo, sin recargar.
//
// Transporte:
//   1) BroadcastChannel('ninja-customer-display') — mismo origen, misma máquina:
//      es instantáneo y no toca el servidor (la venta en curso nunca sale del
//      dispositivo).
//   2) localStorage (STORAGE_KEY) como respaldo: a) navegadores sin
//      BroadcastChannel reciben el cambio por el evento `storage` (que NO se
//      dispara en la pestaña que escribe, pero sí en las otras — justo lo que
//      necesitamos: POS escribe, display recibe); b) sirve de “última foto” para
//      que una ventana de display recién abierta hidrate el estado actual sin
//      esperar al próximo cambio.
//
// LIMITACIÓN TÉCNICA (documentada): el navegador NO controla monitores como una
// app nativa. No se puede “mandar” la ventana a un monitor concreto ni forzar
// fullscreen sin gesto del usuario. El flujo robusto y portable es: el cajero
// abre la URL /customer-display en una ventana nueva, la arrastra al 2do monitor
// y (opcional) la pone en pantalla completa (F11 / botón de la propia pantalla).
// La sincronización en vivo la resuelve este módulo.
//
// SEGURIDAD: el payload solo lleva datos de la venta EN CURSO (ítems, totales,
// vuelto, QR de pago). Nunca tokens, datos del cajero, panel interno ni info de
// otros clientes. El canal es same-origin / same-device. La ruta vive dentro de
// la sesión del tenant.
// =============================================================================

export const DISPLAY_CHANNEL = "ninja-customer-display";
export const DISPLAY_STORAGE_KEY = "ninja-customer-display-state";

// Identidad del negocio que muestra la pantalla (logo + acento + nombre + caja).
export interface DisplayBranding {
  businessName: string | null;
  logoUrl: string | null;
  accent: string | null;
  // Caja / sucursal activa (ej. "Caja 1 · Sucursal Centro"). Opcional.
  registerLabel: string | null;
  // Textos configurables (idle / agradecimiento). NULL → el front usa defaults.
  welcomeMessage: string | null;
  thanksMessage: string | null;
  // Mostrar el precio unitario por ítem (config del tenant). Default true.
  showUnitPrices: boolean;
}

// Línea del carrito tal como la ve el cliente (subconjunto seguro de CartLine).
export interface DisplayCartLine {
  lineId: string;
  name: string;
  variantLabel?: string | null;
  unit: string; // 'un' | 'kg' …
  quantity: number;
  unitPrice: number;
  lineTotal: number; // unitPrice*quantity - discount (ya calculado)
}

// Cobro por QR activo (Mercado Pago / MODO / Mobbex) listo para escanear.
export interface DisplayQr {
  providerName: string; // "Mercado Pago" | "MODO" | "Mobbex"
  initPoint: string; // URL / deeplink que se renderiza como QR
  amount: number; // monto a cobrar (con recargo de plan si aplica)
}

// Fase de la pantalla:
//   idle   → sin venta (logo + bienvenida)
//   cart   → carrito en construcción (ítems + totales)
//   paying → cobro por QR en curso (QR + monto)
//   paid   → venta confirmada (“Pago recibido ✓ / ¡Gracias!”) → vuelve a idle
export type DisplayPhase = "idle" | "cart" | "paying" | "paid";

export interface DisplayState {
  v: 1; // versión del payload (compat futura)
  phase: DisplayPhase;
  branding: DisplayBranding;
  lines: DisplayCartLine[];
  subtotal: number;
  discountTotal: number;
  total: number;
  // Vuelto (efectivo): cuando la última venta se cobró en efectivo y hubo
  // diferencia a favor del cliente. 0/undefined = no mostrar.
  change?: number;
  qr?: DisplayQr | null;
  // Timestamp de emisión (para ordenar / descartar mensajes viejos).
  at: number;
}

export const EMPTY_BRANDING: DisplayBranding = {
  businessName: null,
  logoUrl: null,
  accent: null,
  registerLabel: null,
  welcomeMessage: null,
  thanksMessage: null,
  showUnitPrices: true,
};

export function idleState(branding: DisplayBranding): DisplayState {
  return {
    v: 1,
    phase: "idle",
    branding,
    lines: [],
    subtotal: 0,
    discountTotal: 0,
    total: 0,
    qr: null,
    at: Date.now(),
  };
}

// ---------------------------------------------------------------------------
// Publisher (lado POS). Mantiene un único BroadcastChannel y publica en él +
// en localStorage. Llamar getDisplayPublisher() una vez y reutilizar.
// ---------------------------------------------------------------------------
type Publisher = {
  publish: (state: DisplayState) => void;
  close: () => void;
};

function makePublisher(): Publisher {
  let channel: BroadcastChannel | null = null;
  if (typeof window !== "undefined" && "BroadcastChannel" in window) {
    try {
      channel = new BroadcastChannel(DISPLAY_CHANNEL);
    } catch {
      channel = null;
    }
  }
  return {
    publish(state) {
      const payload: DisplayState = { ...state, at: Date.now() };
      try {
        channel?.postMessage(payload);
      } catch {
        /* canal cerrado: el respaldo de localStorage cubre */
      }
      try {
        // Respaldo + “última foto” para ventanas de display nuevas. El evento
        // `storage` que dispara esta escritura es lo que reciben las OTRAS
        // pestañas (la pantalla del cliente) en navegadores sin BroadcastChannel.
        window.localStorage.setItem(DISPLAY_STORAGE_KEY, JSON.stringify(payload));
      } catch {
        /* almacenamiento lleno / bloqueado: nada que hacer */
      }
    },
    close() {
      try {
        channel?.close();
      } catch {
        /* noop */
      }
      channel = null;
    },
  };
}

let sharedPublisher: Publisher | null = null;

/** Publisher compartido del POS (singleton por pestaña). */
export function getDisplayPublisher(): Publisher {
  if (!sharedPublisher) sharedPublisher = makePublisher();
  return sharedPublisher;
}

/** Publica un estado de pantalla del cliente (atajo del singleton). */
export function publishDisplayState(state: DisplayState): void {
  getDisplayPublisher().publish(state);
}

// ---------------------------------------------------------------------------
// Subscriber (lado /customer-display). Hidrata de localStorage al montar y
// escucha BroadcastChannel + evento `storage`. Devuelve el último estado o null
// (mientras no llegó nada). Descarta mensajes más viejos que el ya visto.
// ---------------------------------------------------------------------------
function parseState(raw: string | null): DisplayState | null {
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw) as DisplayState;
    if (parsed && typeof parsed === "object" && parsed.v === 1) return parsed;
    return null;
  } catch {
    return null;
  }
}

export function useCustomerDisplayState(): DisplayState | null {
  const [state, setState] = useState<DisplayState | null>(null);
  // Timestamp del último estado aplicado: ignora mensajes fuera de orden.
  const lastAt = useRef(0);

  useEffect(() => {
    if (typeof window === "undefined") return;

    const apply = (next: DisplayState | null) => {
      if (!next) return;
      if (next.at < lastAt.current) return;
      lastAt.current = next.at;
      setState(next);
    };

    // 1) Hidratar con la última foto guardada.
    apply(parseState(window.localStorage.getItem(DISPLAY_STORAGE_KEY)));

    // 2) BroadcastChannel (transporte primario).
    let channel: BroadcastChannel | null = null;
    if ("BroadcastChannel" in window) {
      try {
        channel = new BroadcastChannel(DISPLAY_CHANNEL);
        channel.onmessage = (e) => apply(e.data as DisplayState);
      } catch {
        channel = null;
      }
    }

    // 3) Respaldo: evento `storage` (otra pestaña escribió la clave).
    const onStorage = (e: StorageEvent) => {
      if (e.key !== DISPLAY_STORAGE_KEY) return;
      apply(parseState(e.newValue));
    };
    window.addEventListener("storage", onStorage);

    return () => {
      window.removeEventListener("storage", onStorage);
      try {
        channel?.close();
      } catch {
        /* noop */
      }
    };
  }, []);

  return state;
}
