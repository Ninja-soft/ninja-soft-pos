// =============================================================================
// _shared/mercadolibre/buyerMessage.ts (ADR-141, ADR-145). Cliente inyectado.
//
// Mensaje del vendedor al comprador de una venta. En ventas con Mercado
// Envíos ML no deja iniciar la conversación postventa: se usa la guía de
// acciones (opción OTHER, 350 caracteres) y, si ML la rechaza (opción ya
// usada, venta sin guía), el mensaje postventa común (3.500 caracteres).
// Lo usan la Edge ml_facturacion (link de la percepción) y el worker (aviso
// de la factura subida).
// =============================================================================
import { MlApiError, type MlClient } from "./client.ts";

export async function sendBuyerMessage(
  client: Pick<MlClient, "post">,
  pack: string,
  sellerId: number,
  buyerId: number | null,
  texts: { full: string; short: string },
): Promise<"action_guide" | "post_sale"> {
  try {
    await client.post(`/messages/action_guide/packs/${encodeURIComponent(pack)}/option`, { option_id: "OTHER", text: texts.short });
    return "action_guide";
  } catch (e) {
    if (!(e instanceof MlApiError) || !buyerId) throw e;
  }
  await client.post(`/messages/packs/${encodeURIComponent(pack)}/sellers/${sellerId}?tag=post_sale`, {
    from: { user_id: sellerId },
    to: { user_id: buyerId },
    text: texts.full,
  });
  return "post_sale";
}
