// Cajón de dinero (F10 / F17, ADR-063). PURO.
//
// El cajón se conecta a la impresora térmica (ficha RJ11 "DK") y se abre con
// un pulso que la impresora manda cuando recibe el comando ESC/POS
//   ESC p m t1 t2   (1B 70 m t1 t2)
// m = 0 (pin 2) o 1 (pin 5); t1 y t2 = tiempo encendido y apagado en
// unidades de 2 ms. La mayoría de los cajones abre con pin 2 y 100 a 200 ms.
//
// Quién puede abrirlo lo decide el servidor (cash_drawer_open): esto es el
// espejo para que la pantalla sepa qué ofrecer y los bytes del pulso.

export type DrawerPin = 2 | 5;

/** Política de la sucursal para abrir el cajón sin venta. */
export type DrawerNoSalePolicy = "allow" | "pin" | "deny";

export interface DrawerPolicy {
  /** Abrir al cerrar una venta cobrada (en todo o en parte) en efectivo. */
  openOnCash: boolean;
  noSale: DrawerNoSalePolicy;
}

export const DEFAULT_DRAWER_POLICY: DrawerPolicy = { openOnCash: true, noSale: "pin" };

export const NO_SALE_LABEL: Record<DrawerNoSalePolicy, string> = {
  allow: "Permitido",
  pin: "Con PIN de supervisor",
  deny: "Prohibido",
};

export const NO_SALE_HINT: Record<DrawerNoSalePolicy, string> = {
  allow: "Cualquier cajero lo abre dejando un motivo.",
  pin: "El cajero deja un motivo y un supervisor autoriza con su PIN (un supervisor lo abre directo).",
  deny: "Sólo se abre al cobrar en efectivo. Las pruebas de hardware las hace el dueño o un encargado.",
};

/** Lee la política de la configuración efectiva (pos_settings + herencia). */
export function parseDrawerPolicy(eff: Record<string, unknown> | null | undefined): DrawerPolicy {
  const ns = eff?.drawer_no_sale;
  return {
    openOnCash: eff?.drawer_open_on_cash !== false,
    noSale: ns === "allow" || ns === "deny" || ns === "pin" ? ns : "pin",
  };
}

const clampUnits = (ms: number) => Math.min(255, Math.max(1, Math.round(ms / 2)));

/** Bytes ESC/POS del pulso de apertura. */
export function escposDrawerPulse(pin: DrawerPin, onMs: number, offMs: number): Uint8Array {
  return new Uint8Array([0x1b, 0x70, pin === 5 ? 1 : 0, clampUnits(onMs), clampUnits(offMs)]);
}

export type DrawerKind = "sale" | "no_sale" | "test";

export type DrawerAction =
  /** Pedir la apertura al servidor y, si la permite, mandar el pulso. */
  | "open"
  /** Pedir motivo y PIN de supervisor antes (el servidor igual lo exige). */
  | "ask_pin"
  /** No se ofrece (con el motivo). */
  | "deny"
  /** No corresponde abrir (venta sin efectivo, política apagada). */
  | "skip";

export interface DrawerContext {
  hasDrawer: boolean;
  hasShift: boolean;
  isSupervisor: boolean;
  isManager: boolean;
  /** Para 'sale': la venta tuvo un cobro en efectivo. */
  hadCash?: boolean;
}

export type DrawerDenyReason = "no_drawer" | "no_shift" | "policy_deny" | "forbidden";

/**
 * Qué hacer en la pantalla (espejo de cash_drawer_open). El servidor decide
 * de verdad y registra cada pedido; esto evita ofrecer un botón que va a
 * fallar y pide el PIN antes de intentar.
 */
export function drawerDecision(
  kind: DrawerKind,
  policy: DrawerPolicy,
  ctx: DrawerContext,
): { action: DrawerAction; reason?: DrawerDenyReason } {
  if (!ctx.hasDrawer) return { action: kind === "sale" ? "skip" : "deny", reason: "no_drawer" };
  if (kind === "test") return ctx.isManager ? { action: "open" } : { action: "deny", reason: "forbidden" };
  if (kind === "sale") return policy.openOnCash && ctx.hadCash && ctx.hasShift ? { action: "open" } : { action: "skip" };
  if (!ctx.hasShift) return { action: "deny", reason: "no_shift" };
  if (policy.noSale === "deny") return { action: "deny", reason: "policy_deny" };
  if (policy.noSale === "pin" && !ctx.isSupervisor) return { action: "ask_pin" };
  return { action: "open" };
}

/** Mensaje de un rechazo del servidor o de la pantalla. */
export function drawerDeniedMessage(reason: string | null | undefined): string {
  switch (reason) {
    case "no_drawer":
      return "Esta caja está marcada sin cajón.";
    case "no_shift":
      return "Abrí la caja para usar el cajón.";
    case "shift_not_owned":
      return "La caja abierta es de otra persona.";
    case "policy_deny":
      return "En esta sucursal no se puede abrir el cajón sin una venta.";
    case "policy_off":
      return "En esta sucursal el cajón no se abre solo al cobrar.";
    case "sale_not_cash":
      return "La venta no tiene un cobro en efectivo de esta caja.";
    case "already_opened":
      return "El cajón ya se abrió para esta venta.";
    case "forbidden":
      return "Sólo el dueño o un encargado pueden hacer la prueba.";
    default:
      return "No se pudo abrir el cajón.";
  }
}
