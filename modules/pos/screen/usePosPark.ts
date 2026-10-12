"use client";

import { useQuery } from "@tanstack/react-query";
import { useToast } from "@/components/ui/Toast";
import type { Promo, SheetParkRequest } from "@/components/pos/checkout/types";
import { createClient } from "@/lib/supabase/client";
import { formatCurrency } from "@/lib/utils/format";
import { getActiveShiftId } from "@/modules/branches/store";
import { pendingChargesApi } from "@/modules/pending-charges/api";
import { usePendingChargeMutations } from "@/modules/pending-charges/hooks";
import { buildSaleItemsAndExtras, displayLines, pendingChargeErrorCopy } from "@/modules/pending-charges/logic";
import type { CartLine } from "@/modules/pos/store";
import { cartToSaleLines } from "./usePosSale";
import { usePriceRefresh } from "./usePriceRefresh";

// "Dejar en espera" desde la hoja de cobro (ADR-048): arma los argumentos de
// create_sale con el MISMO mapeo que la venta inmediata, guarda el carrito para
// poder editarlo y estaciona el cobro en el servidor. Si el POS está editando
// un cobro en espera, en vez de crear uno nuevo le cambia el link y el carrito.

export interface EditingCharge {
  id: string;
  version: number;
  provider: string;
  number: string;
}

export function usePosPark(ctx: {
  lines: CartLine[];
  discountTotal: number;
  customer: { id: string; name: string } | null;
  salePromo: (p?: Promo | null) => Promo | null;
  couponId: string | null;
  couponCode: string | null;
  editing: EditingCharge | null;
  onParked: (r: { id: string; edited: boolean }) => void;
}) {
  const { toast } = useToast();
  const m = usePendingChargeMutations();
  const handlePriceMismatch = usePriceRefresh();

  // Email y celular del cliente para compartir (prefill).
  const { data: contact } = useQuery({
    queryKey: ["customers", "contact", ctx.customer?.id ?? null],
    enabled: Boolean(ctx.customer?.id),
    staleTime: 60_000,
    queryFn: async () => {
      const { data } = await createClient()
        .from("customers")
        .select("email, phone")
        .eq("id", ctx.customer!.id)
        .maybeSingle();
      return (data ?? null) as { email: string | null; phone: string | null } | null;
    },
  });

  async function onPark(req: SheetParkRequest): Promise<{ id: string } | null> {
    const { items, extras } = buildSaleItemsAndExtras(cartToSaleLines(ctx.lines), req.extras);
    const promo = ctx.salePromo(req.promo);
    const promoDisc = promo && promo.discount > 0 ? promo.discount : 0;
    const sale = {
      items,
      extras,
      discount_total: ctx.discountTotal,
      customer_id: ctx.customer?.id ?? null,
      ...(promoDisc > 0 ? { promo_discount: promoDisc, promo_id: promo?.id ?? null, promo_name: promo?.name ?? null } : {}),
      ...(ctx.couponId ? { coupon_id: ctx.couponId } : {}),
    };
    const cart = {
      lines: ctx.lines,
      discountTotal: ctx.discountTotal,
      customer: ctx.customer,
      couponCode: ctx.couponCode,
    };
    const lines = displayLines(
      ctx.lines.map((l) => ({ ...cartToSaleLines([l])[0]!, variantLabel: l.variantLabel, unit: l.unit })),
      req.extras,
    );
    const q = req.qr;
    try {
      let id: string;
      if (ctx.editing) {
        const r = await m.replace.mutateAsync({
          id: ctx.editing.id,
          newIntentId: q.intentId,
          version: ctx.editing.version,
          sale,
          cart,
          lines,
          channel: q.channel,
          shareUrl: q.shareUrl,
          qrData: q.qrData,
          expiresMinutes: q.expiresMinutes,
        });
        id = r.id;
      } else {
        const r = await m.park.mutateAsync({
          intentId: q.intentId,
          sale,
          cart,
          lines,
          cashShiftId: getActiveShiftId(),
          channel: q.channel,
          shareUrl: q.shareUrl,
          qrData: q.qrData,
          customerName: ctx.customer?.name ?? null,
          customerEmail: q.customerEmail ?? contact?.email ?? null,
          customerPhone: q.customerPhone ?? contact?.phone ?? null,
          expiresMinutes: q.expiresMinutes,
        });
        id = r.id;
      }
      // Lo que ya se compartió antes de estacionar queda en la línea de tiempo.
      for (const sh of q.sharedVia) {
        await pendingChargesApi.markShared(id, sh.via, sh.to).catch(() => null);
      }
      toast({
        title: ctx.editing ? "Cobro en espera actualizado" : "Cobro en espera",
        description: `${formatCurrency(q.amount)}. Te avisamos cuando se acredite.`,
        variant: "success",
      });
      ctx.onParked({ id, edited: Boolean(ctx.editing) });
      return { id };
    } catch (e) {
      const msg = e instanceof Error ? e.message : "";
      // El modal maneja "ya pagó" (registra la venta como siempre).
      if (msg.includes("intent_already_paid")) throw e;
      // ADR-056: el ensayo rechazó un precio viejo → se reprecia y se avisa.
      if (handlePriceMismatch(e, ctx.lines)) return null;
      toast({ title: pendingChargeErrorCopy(msg), variant: "error" });
      return null;
    }
  }

  async function onEmail(chargeId: string, to: string, note: string) {
    await m.sendEmail.mutateAsync({ id: chargeId, to, note });
  }

  return {
    onPark,
    onEmail,
    parking: m.park.isPending || m.replace.isPending,
    customerEmail: contact?.email ?? null,
    customerPhone: contact?.phone ?? null,
  };
}
