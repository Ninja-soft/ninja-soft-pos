// =============================================================================
// _shared/mercadolibre/perceptionLink.ts (ADR-141). PURO.
//
// Cobro de la percepción de IIBB por link de pago (criterio de ANDESMAR,
// meli-omni crearLinkPagoMP / holdMensajear):
//   • preferencia de Checkout Pro de Mercado Pago por el monto exacto, un
//     solo ítem "Percepción IIBB · Venta Mercado Libre #pack", referencia
//     externa = intent (mp_webhook la valida) y vencimiento;
//   • el link completo, nunca acortado (con acortadores el pago bajó del 61 %
//     al 3 % en ANDESMAR);
//   • mensaje al comprador con el monto, el detalle por jurisdicción, los días
//     y el link, recortado sin cortar la URL (action_guide admite 350
//     caracteres; mensajes postventa, 3.500).
// =============================================================================
import { perceptionMessage, trimKeepingUrl, type PerceptionLine } from "./invoicePlan.ts";

export const ACTION_GUIDE_MAX = 350;
export const POST_SALE_MAX = 3500;

const JUR_SHORT: Record<string, string> = {
  "901": "CABA", "902": "Buenos Aires", "903": "Catamarca", "904": "Córdoba", "905": "Corrientes", "906": "Chaco",
  "907": "Chubut", "908": "Entre Ríos", "909": "Formosa", "910": "Jujuy", "911": "La Pampa", "912": "La Rioja",
  "913": "Mendoza", "914": "Misiones", "915": "Neuquén", "916": "Río Negro", "917": "Salta", "918": "San Juan",
  "919": "San Luis", "920": "Santa Cruz", "921": "Santa Fe", "922": "Santiago del Estero", "923": "Tierra del Fuego",
  "924": "Tucumán",
};

export const jurisdictionName = (code: string) => JUR_SHORT[code] ?? code;

/** "Buenos Aires 3 %, Santa Fe 1,5 %". */
export function perceptionDetail(lines: Array<Pick<PerceptionLine, "jurisdiction" | "effective_rate">>): string {
  return lines
    .map((l) => `${jurisdictionName(l.jurisdiction)} ${String(Math.round(l.effective_rate * 100) / 100).replace(".", ",")} %`)
    .join(", ");
}

/** Cuerpo de POST /checkout/preferences de Mercado Pago. */
export function perceptionPreference(v: {
  amount: number;
  packKey: string;
  intentId: string;
  notificationUrl: string;
  days: number;
  now?: Date;
}): Record<string, unknown> {
  const now = v.now ?? new Date();
  const to = new Date(now.getTime() + Math.max(1, Math.min(30, v.days)) * 86400_000);
  return {
    items: [
      {
        title: `Percepción IIBB · Venta Mercado Libre #${v.packKey}`.slice(0, 120),
        quantity: 1,
        unit_price: Math.round(v.amount * 100) / 100,
        currency_id: "ARS",
      },
    ],
    external_reference: v.intentId,
    notification_url: v.notificationUrl,
    binary_mode: true,
    expires: true,
    expiration_date_from: now.toISOString(),
    expiration_date_to: to.toISOString(),
    metadata: { tipo: "percepcion_iibb", pack_key: v.packKey },
  };
}

/** Mensaje al comprador (y su versión corta para la guía de acciones). */
export function perceptionTexts(v: {
  template: string | null | undefined;
  buyer: string;
  amount: number;
  link: string;
  days: number;
  lines: Array<Pick<PerceptionLine, "jurisdiction" | "effective_rate">>;
}): { full: string; short: string } {
  const full = perceptionMessage(v.template, {
    nombre: v.buyer || "",
    monto: v.amount,
    link: v.link,
    dias: v.days,
    detalle: perceptionDetail(v.lines),
  })
    .replace(/\s+/g, " ")
    .replace(/Hola\s+,/, "Hola,")
    .trim();
  return { full: trimKeepingUrl(full, POST_SALE_MAX), short: trimKeepingUrl(full, ACTION_GUIDE_MAX) };
}
