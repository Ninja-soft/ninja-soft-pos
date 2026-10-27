// Cupón de pago en efectivo de Mercado Pago (Rapipago / Pago Fácil, ADR-180):
// textos y validación del lado del POS. Puro (sin React ni Supabase) para
// testearlo. El servidor (Edge mp_cupon) vuelve a validar todo.

import { checkCuponAmount, type CuponLimit } from "@/supabase/functions/_shared/mpCupon";
import { formatCurrency } from "@/lib/utils/format";

export { checkCuponAmount, type CuponLimit, type CuponLimits } from "@/supabase/functions/_shared/mpCupon";

export type CuponMethod = "rapipago" | "pagofacil";

export const CUPON_METHOD_LABEL: Record<CuponMethod, string> = {
  rapipago: "Rapipago",
  pagofacil: "Pago Fácil",
};

export interface CuponPayerDraft {
  email: string;
  name: string;
  docNumber: string;
}

export type CuponPayerErrors = Partial<Record<keyof CuponPayerDraft, string>>;

const EMAIL_RE = /^[^\s@]{1,64}@[^\s@]{1,190}\.[^\s@]{2,24}$/;

/** Mismas reglas que el servidor: email, nombre y apellido, DNI o CUIT / CUIL. */
export function validateCuponPayer(d: CuponPayerDraft): CuponPayerErrors {
  const e: CuponPayerErrors = {};
  if (!EMAIL_RE.test(d.email.trim())) e.email = "Ingresá un email válido: Mercado Pago le manda el cupón.";
  if (d.name.replace(/\s+/g, " ").trim().split(" ").filter(Boolean).length < 2) e.name = "Ingresá nombre y apellido.";
  const doc = d.docNumber.replace(/[\s.-]/g, "");
  if (!/^\d{7,8}$|^\d{11}$/.test(doc)) e.docNumber = "DNI (7 u 8 números) o CUIT / CUIL (11 números).";
  return e;
}

/** Agrupa el número del código de barras de a 4 para dictarlo o tipearlo. */
export function formatBarcode(code: string | null | undefined): string {
  const digits = String(code ?? "").replace(/\D/g, "");
  return digits.replace(/(\d{4})(?=\d)/g, "$1 ");
}

/** "Vence el lunes 26/10" (hora de Argentina). */
export function cuponExpiryLabel(iso: string | null | undefined): string | null {
  if (!iso) return null;
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return null;
  // Por partes: el separador de fecha cambia según el ICU del navegador.
  const parts = new Intl.DateTimeFormat("es-AR", {
    timeZone: "America/Argentina/Buenos_Aires",
    weekday: "long",
    day: "2-digit",
    month: "2-digit",
  }).formatToParts(d);
  const get = (t: string) => parts.find((x) => x.type === t)?.value ?? "";
  return `Vence el ${get("weekday")} ${get("day")}/${get("month")}`;
}

/** Copy del error de la Edge mp_cupon (null = no es un error del cupón). */
export function cuponErrorCopy(code: string): string | null {
  switch (code) {
    case "payer_email_invalid":
      return "Mercado Pago necesita un email válido del cliente para emitir el cupón.";
    case "payer_doc_invalid":
      return "Mercado Pago necesita el DNI o CUIT / CUIL del cliente para emitir el cupón.";
    case "payer_name_invalid":
      return "Mercado Pago necesita el nombre y el apellido del cliente para emitir el cupón.";
    case "invalid_method":
      return "Elegí Rapipago o Pago Fácil.";
    case "mp_cupon_auth_failed":
      return "Mercado Pago rechazó la conexión. Reconectala en Configuración → Medios de pago → Mercado Pago.";
    case "mp_cupon_amount_above_max":
      return "El total supera el máximo que Mercado Pago permite para un cupón en efectivo. Cobrá con otro medio o dividí el pago.";
    case "mp_cupon_amount_below_min":
      return "El total es menor al mínimo que Mercado Pago permite para un cupón en efectivo.";
    case "mp_cupon_forbidden":
      return "Mercado Pago no habilitó los cupones de pago en efectivo para esta cuenta. La conexión sigue bien para QR y Point; consultá a Mercado Pago o cobrá con otro medio.";
    case "mp_cupon_payer_rejected":
      return "Mercado Pago rechazó los datos del cliente. Revisá el email y el documento.";
    case "mp_cupon_amount_rejected":
      return "Mercado Pago no acepta este monto para un cupón en efectivo. Probá con otro medio.";
    case "mp_cupon_method_unavailable":
      return "Este medio no está disponible en tu cuenta de Mercado Pago. Probá con el otro.";
    default:
      return null;
  }
}

/**
 * Aviso del tope de monto para el medio elegido (null = el total entra o no
 * hay datos). El servidor vuelve a validar con los mismos datos.
 */
export function cuponLimitWarning(amount: number, method: CuponMethod, limit: CuponLimit | null): string | null {
  const where = CUPON_METHOD_LABEL[method];
  switch (checkCuponAmount(amount, limit)) {
    case "above_max":
      return `${where} acepta cupones de hasta ${formatCurrency(limit!.max!)} en tu cuenta de Mercado Pago. Cobrá con otro medio o dividí el pago.`;
    case "below_min":
      return `${where} acepta cupones desde ${formatCurrency(limit!.min!)}.`;
    case "inactive":
      return `${where} no está disponible en tu cuenta de Mercado Pago.`;
    default:
      return null;
  }
}
