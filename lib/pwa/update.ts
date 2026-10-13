// Aviso de versión nueva del POS (H65, ADR-087). El service worker nuevo
// queda "esperando" hasta que el cajero toca Recargar; mientras haya un cobro
// en curso el botón espera. Lógica pura para testear el texto y el estado.

export const SW_URL = "/sw.js";
/** Sólo las pantallas del POS quedan controladas por el service worker. */
export const SW_SCOPE = "/pos";

export interface SwUpdateView {
  title: string;
  text: string;
  canReload: boolean;
  action: string;
}

export function swUpdateView(s: { updateReady: boolean; busy: boolean }): SwUpdateView | null {
  if (!s.updateReady) return null;
  if (s.busy) {
    return {
      title: "Hay una versión nueva",
      text: "Terminá el cobro en curso y después recargá.",
      canReload: false,
      action: "Recargar",
    };
  }
  return {
    title: "Hay una versión nueva",
    text: "Recargá para usarla. Las ventas sin conexión quedan guardadas.",
    canReload: true,
    action: "Recargar",
  };
}

/**
 * ¿Registrar el service worker? Sólo en build de producción (en desarrollo
 * los chunks cambian todo el tiempo) y en contexto seguro (https o localhost).
 */
export function shouldRegisterSw(i: {
  nodeEnv: string | undefined;
  hasSw: boolean;
  secure: boolean;
  optOut: boolean;
}): boolean {
  return i.nodeEnv === "production" && i.hasSw && i.secure && !i.optOut;
}
