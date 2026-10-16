// Factura o sólo ticket en cada venta (ADR-155). PURO: el modo por defecto del
// negocio, la elección inicial de la hoja de cobro, los avisos de "sólo
// ticket" y los textos. El servidor marca la venta (sale_ticket_only_set +
// trigger de sales) y vuelve a calcular los avisos para la auditoría.

export type TicketMode = "factura" | "preguntar" | "ticket";
export type FiscalChoice = "factura" | "ticket";

export const TICKET_MODES: TicketMode[] = ["factura", "preguntar", "ticket"];

export const TICKET_MODE_INFO: Record<TicketMode, { label: string; short: string; help: string }> = {
  factura: {
    label: "Siempre factura",
    short: "Factura",
    help: "Cada venta sale con factura. Si un día querés sólo el ticket, lo cambiás en el cobro con un toque.",
  },
  preguntar: {
    label: "Preguntar en cada venta",
    short: "Preguntar",
    help: "En el cobro hay que elegir Factura o Sólo ticket antes de confirmar.",
  },
  ticket: {
    label: "Sólo ticket por defecto",
    short: "Sólo ticket",
    help: "Las ventas salen con ticket no fiscal. Cuando alguien necesita factura, la elegís en el cobro.",
  },
};

export function isTicketMode(v: unknown): v is TicketMode {
  return v === "factura" || v === "preguntar" || v === "ticket";
}

/** Elección con la que abre la hoja de cobro (null = hay que elegir). */
export function initialFiscalChoice(mode: TicketMode | null | undefined): FiscalChoice | null {
  if (mode === "ticket") return "ticket";
  if (mode === "preguntar") return null;
  return "factura";
}

/** La otra opción (atajo de teclado y toque en el interruptor). */
export function toggleFiscalChoice(c: FiscalChoice | null): FiscalChoice {
  return c === "factura" ? "ticket" : "factura";
}

/** Lo que impide confirmar el cobro (sólo en "Preguntar", sin elegir). */
export function fiscalChoiceBlocker(visible: boolean, choice: FiscalChoice | null): string | null {
  return visible && choice === null ? "Elegí Factura o Sólo ticket" : null;
}

export interface TicketOnlyContext {
  /** Letra que corresponde a la venta (inferLetter). */
  letter: string | null;
  /** El cliente tiene CUIT válida. */
  hasCuit: boolean;
  /** Total a cobrar. */
  total: number;
  /** Desde este monto ARCA pide identificar al consumidor final (null = sin tope). */
  cfThreshold: number | null;
  /** Hay un cliente elegido. */
  hasCustomer: boolean;
}

export interface TicketOnlyWarning {
  code: "factura_a" | "factura_m" | "cliente_con_cuit" | "monto_alto";
  text: string;
}

/**
 * Avisos de "sólo ticket": no bloquean (la decisión es del negocio y queda
 * auditada), pero dicen por qué esta venta probablemente necesita factura.
 */
export function ticketOnlyWarnings(c: TicketOnlyContext): TicketOnlyWarning[] {
  const out: TicketOnlyWarning[] = [];
  if (c.letter === "A" || c.letter === "M") {
    out.push({
      code: c.letter === "A" ? "factura_a" : "factura_m",
      text: `A este cliente le corresponde Factura ${c.letter}: la necesita para computar el IVA.`,
    });
  } else if (c.hasCuit) {
    out.push({ code: "cliente_con_cuit", text: "El cliente tiene CUIT: puede que necesite la factura." });
  }
  if (!c.hasCustomer && c.cfThreshold != null && c.cfThreshold > 0 && c.total >= c.cfThreshold) {
    out.push({
      code: "monto_alto",
      text: "Es una venta de monto alto: si el cliente pide factura, ARCA exige identificarlo.",
    });
  }
  return out;
}

/** Texto del error de sale_ticket_only_set. */
export function ticketOnlyErrorMessage(code: string): string {
  if (code.includes("not_enabled")) return "La facturación electrónica está apagada: la venta sale sin factura igual.";
  if (code.includes("feature_not_in_plan")) return "Tu plan no incluye la facturación electrónica.";
  if (code.includes("customer_not_found")) return "No encontramos el cliente de la venta.";
  if (code.includes("forbidden")) return "Tu usuario no puede cambiar el comprobante de la venta.";
  return "No se pudo marcar la venta como sólo ticket.";
}
