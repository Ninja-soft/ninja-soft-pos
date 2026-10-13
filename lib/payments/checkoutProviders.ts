// Checkout PROPIO de NinjaPos (/pagar/[id]) por procesador (ADR-069). La
// página es la misma (marca del negocio, tarjeta, cuotas con su interés); cada
// procesador aporta su backend y su forma de tokenizar la tarjeta:
//
//   * payway: el navegador tokeniza DIRECTO en Payway con la API Key pública;
//     nuestro backend sólo recibe el token de un solo uso.
//   * getnet (Checkout API): Getnet no ofrece tokenización desde el navegador,
//     así que la tarjeta viaja a la Edge getnet_checkout, que la tokeniza en
//     Getnet en el mismo request y la descarta (sin guardarla ni loguearla).
//
// Lógica pura, testeable con Vitest.

export type CheckoutProvider = "payway" | "getnet";

/** Procesador del link (?p=getnet); sin parámetro, Payway (links viejos). */
export function checkoutProviderOf(param: string | null | undefined): CheckoutProvider {
  return param === "getnet" ? "getnet" : "payway";
}

export const CHECKOUT_EDGE: Record<CheckoutProvider, string> = {
  payway: "payway_checkout",
  getnet: "getnet_checkout",
};

export const PROCESSOR_NAME: Record<CheckoutProvider, string> = {
  payway: "Payway",
  getnet: "Getnet",
};

/** Texto de "Pago seguro" honesto según por dónde viaja la tarjeta. */
export const SECURE_COPY: Record<CheckoutProvider, string> = {
  payway: "Tus datos de tarjeta van cifrados directo a Payway. NinjaPOS y el comercio no los ven ni los guardan.",
  getnet:
    "Tus datos de tarjeta viajan cifrados y se envían a Getnet en el momento. NinjaPOS no los guarda y el comercio no los ve.",
};

export type CardForm = { number: string; exp: string; cvv: string; holder: string; dni: string };

/** Body del cobro de Getnet: la tarjeta va limpia (sólo dígitos, MM y AA). */
export function buildGetnetPayBody(
  intentId: string,
  brand: string,
  installments: number,
  f: CardForm,
): {
  action: "pay";
  intent_id: string;
  brand: string;
  installments: number;
  card: { number: string; exp_month: string; exp_year: string; cvv: string; holder: string; dni: string };
} {
  const [mm = "", yy = ""] = f.exp.split("/");
  return {
    action: "pay",
    intent_id: intentId,
    brand,
    installments: Math.max(1, Math.trunc(installments) || 1),
    card: {
      number: f.number.replace(/\D/g, ""),
      exp_month: mm.replace(/\D/g, "").padStart(2, "0").slice(-2),
      exp_year: yy.replace(/\D/g, "").slice(-2),
      cvv: f.cvv.replace(/\D/g, ""),
      holder: f.holder.trim().toUpperCase(),
      dni: f.dni.replace(/\D/g, ""),
    },
  };
}
