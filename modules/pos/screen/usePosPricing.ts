"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { useToast } from "@/components/ui/Toast";
import { useProductsByIds } from "@/modules/products/hooks";
import type { Product } from "@/modules/products/api";
import { useActivePromotions, usePromotionUsage } from "@/modules/promotions/hooks";
import { couponsApi } from "@/modules/coupons/api";
import {
  arPromoClock,
  evaluatePromotions,
  r2,
  type AppliedPromo,
  type PromoEvaluation,
  type Promotion,
  type PromoCartLine,
  type PromoContext,
  type PromoPayment,
} from "@/lib/promotions/engine";
import { cartSubtotal, lineSubtotal, useCartStore, type CartLine } from "@/modules/pos/store";

// Precios del carrito del POS: promociones (F9, ADR-074: mismo motor que
// create_sale), cupón, regalos, total redondeado y promo por medio de pago.

// Mensajes legibles para los rechazos de validate_coupon (F9 · H54).
export function couponReasonMsg(reason?: string): string {
  switch (reason) {
    case "not_found":
      return "Cupón inexistente";
    case "inactive":
      return "El cupón está inactivo";
    case "not_yet":
      return "El cupón todavía no está vigente";
    case "expired":
      return "El cupón está vencido";
    case "usage_exceeded":
      return "El cupón alcanzó su límite de usos";
    case "customer_exceeded":
      return "Este cliente ya usó el cupón el máximo de veces";
    case "needs_customer":
      return "Elegí un cliente para usar este cupón";
    case "min_amount":
      return "El carrito no llega al monto mínimo del cupón";
    default:
      return "No se pudo aplicar el cupón";
  }
}

interface ProductMeta {
  category_id: string | null;
  brand_id: string | null;
}

// Mismas líneas que arma create_sale: categoría y marca del producto, importe
// redondeado a centavos; regalos y sesiones de pack no participan.
function toPromoLines(ls: CartLine[], meta: Map<string, ProductMeta>): PromoCartLine[] {
  return ls.map((l) => {
    const m = l.productId ? meta.get(l.productId) : undefined;
    return {
      productId: l.productId,
      categoryId: m ? m.category_id : (l.categoryId ?? null),
      brandId: m?.brand_id ?? null,
      unitPrice: l.unitPrice,
      quantity: l.quantity,
      lineTotal: r2(lineSubtotal(l)),
      excluded: Boolean(l.giftPromoId || l.packCreditId),
    };
  });
}

/** Promo final para el cobro: total y cada promo aplicada. */
export interface PricingPromo {
  discount: number;
  id: string | null;
  name: string | null;
  applied?: { label: string; discount: number }[];
}

export interface AppliedCoupon {
  coupon_id: string;
  code: string;
  discount_type: "percent" | "amount";
  discount_value: number;
  min_amount: number;
}

export function usePosPricing({
  rounding,
  customerId,
  storeId = null,
  priceListId = null,
}: {
  rounding: number;
  customerId: string | null;
  /** Sucursal del turno (promos por sucursal). */
  storeId?: string | null;
  /** Lista de precios con la que se vende (promos por lista). */
  priceListId?: string | null;
}) {
  const { toast } = useToast();
  const lines = useCartStore((s) => s.lines);
  const discountTotal = useCartStore((s) => s.discountTotal);
  const syncGiftLines = useCartStore((s) => s.syncGiftLines);
  const { data: activePromos } = useActivePromotions();
  const promos = useMemo(() => activePromos ?? [], [activePromos]);

  const hasCaps = promos.some((p) => p.max_uses_total != null || p.max_uses_per_customer != null);
  const { data: usage } = usePromotionUsage(customerId, hasCaps);

  // Categoría y marca de cada producto del carrito (alcance por marca).
  const cartProductIds = useMemo(
    () =>
      promos.length > 0
        ? [...new Set(lines.map((l) => l.productId).filter((x): x is string => Boolean(x)))]
        : [],
    [lines, promos.length],
  );
  const { data: cartProducts } = useProductsByIds(cartProductIds);
  const meta = useMemo(() => {
    const m = new Map<string, ProductMeta>();
    for (const p of cartProducts ?? []) {
      const r = p as Product & { brand_id?: string | null };
      m.set(r.id, { category_id: r.category_id ?? null, brand_id: r.brand_id ?? null });
    }
    return m;
  }, [cartProducts]);

  // Reloj de las franjas horarias: se reevalúa cada 30 segundos.
  const [clock, setClock] = useState(() => arPromoClock());
  useEffect(() => {
    const t = setInterval(() => setClock(arPromoClock()), 30_000);
    return () => clearInterval(t);
  }, []);

  const [couponInput, setCouponInput] = useState("");
  const [appliedCoupon, setAppliedCoupon] = useState<AppliedCoupon | null>(null);

  const subtotal = cartSubtotal(lines);
  const promoLines = useMemo(() => toPromoLines(lines, meta), [lines, meta]);
  const baseCtx = useMemo<PromoContext>(
    () => ({ ...clock, storeId, priceListId, customerId, usage: usage ?? null }),
    [clock, storeId, priceListId, customerId, usage],
  );

  // Promociones del carrito sin medio de pago (F9, ADR-074).
  const promoEval = useMemo(() => {
    if (promos.length === 0 || lines.length === 0) return null;
    return evaluatePromotions(promoLines, promos, baseCtx);
  }, [promos, lines.length, promoLines, baseCtx]);

  const cap = Math.max(0, subtotal - discountTotal);
  const toPromo = useCallback(
    (ev: PromoEvaluation | null): PricingPromo | null => {
      if (!ev || ev.discount <= 0 || ev.applied.length === 0) return null;
      const discount = r2(Math.min(ev.discount, cap));
      if (discount <= 0) return null;
      return {
        discount,
        id: ev.applied[0]!.promotionId,
        name: ev.applied.map((a) => a.label).join(" + "),
        applied: ev.applied.map((a) => ({ label: a.label, discount: a.discount })),
      };
    },
    [cap],
  );

  const promoResult =
    promoEval && promoEval.discount > 0 && promoEval.applied.length > 0
      ? {
          promotionId: promoEval.applied[0]!.promotionId,
          name: promoEval.applied.map((a) => a.label).join(" + "),
          discount: promoEval.discount,
        }
      : null;
  const promoDiscount = promoResult ? r2(Math.min(promoResult.discount, cap)) : 0;

  // Cupón (H54): excluyente con la promo de descuento (los regalos conviven).
  const couponDiscount = useMemo(() => {
    if (!appliedCoupon) return 0;
    if (subtotal < (appliedCoupon.min_amount ?? 0)) return 0;
    const raw =
      appliedCoupon.discount_type === "percent"
        ? (subtotal * appliedCoupon.discount_value) / 100
        : appliedCoupon.discount_value;
    return Math.round(Math.min(Math.max(raw, 0), Math.max(0, subtotal - discountTotal)) * 100) / 100;
  }, [appliedCoupon, subtotal, discountTotal]);
  // Con cupón aplicado el servidor no aplica promos de descuento.
  const promoActive = !appliedCoupon;
  const effectivePromoDiscount = promoActive ? promoDiscount : 0;

  async function applyCoupon() {
    const code = couponInput.trim();
    if (!code) return;
    try {
      const v = await couponsApi.validate(code, subtotal, customerId);
      if (!v.ok || !v.coupon_id) {
        toast({ title: couponReasonMsg(v.reason), variant: "error" });
        return;
      }
      setAppliedCoupon({
        coupon_id: v.coupon_id,
        code: v.code ?? code,
        discount_type: v.discount_type ?? "percent",
        discount_value: v.discount_value ?? 0,
        min_amount: v.min_amount ?? 0,
      });
      setCouponInput("");
      toast({ title: `Cupón ${v.code ?? code} aplicado`, variant: "success" });
    } catch (e) {
      toast({
        title: "No se pudo validar el cupón",
        description: e instanceof Error ? e.message : undefined,
        variant: "error",
      });
    }
  }

  function clearCoupon() {
    setAppliedCoupon(null);
    setCouponInput("");
  }

  // Promo método-AGNÓSTICA del carrito (ya restada en rawTotal).
  const cartPromo: PricingPromo | null = promoActive ? toPromo(promoEval) : null;

  // Mejor combinación CONSIDERANDO los pagos (medio, marca de tarjeta y banco).
  const promoForPayments = useCallback(
    (pays: PromoPayment[]): PricingPromo | null => {
      if (appliedCoupon) return null;
      if (promos.length === 0 || lines.length === 0) return null;
      return toPromo(evaluatePromotions(promoLines, promos, { ...baseCtx, payments: pays }));
    },
    [appliedCoupon, promos, lines.length, promoLines, baseCtx, toPromo],
  );
  const promoForMethod = useCallback(
    (method: string) => promoForPayments([{ method }]),
    [promoForPayments],
  );

  // ── Regalo por compra (H54) ─────────────────────────────────────────────────
  const giftProductIds = useMemo(
    () =>
      promos
        .filter((p: Promotion) => p.action_type === "gift" && p.gift_product_id)
        .map((p: Promotion) => p.gift_product_id as string),
    [promos],
  );
  const { data: giftProductsData } = useProductsByIds(giftProductIds);
  const giftProductById = useMemo(() => {
    const m = new Map<string, Product>();
    for (const p of giftProductsData ?? []) m.set(p.id, p);
    return m;
  }, [giftProductsData]);

  const desiredGifts = useMemo(() => {
    if (promos.length === 0) return [];
    if (!lines.some((l) => !l.giftPromoId)) return [];
    const out: { promoId: string; productId: string; name: string; sku: string | null; quantity: number }[] = [];
    for (const g of promoEval?.gifts ?? []) {
      const p = giftProductById.get(g.giftProductId);
      if (!p) continue;
      if (p.track_stock && Number(p.stock ?? 0) < g.giftQty) continue;
      out.push({ promoId: g.promotionId, productId: p.id, name: p.name, sku: p.sku, quantity: g.giftQty });
    }
    return out;
  }, [promos.length, lines, promoEval, giftProductById]);

  useEffect(() => {
    const current = lines
      .filter((l) => l.giftPromoId)
      .map((l) => `${l.giftPromoId}:${l.productId}:${l.quantity}`)
      .sort()
      .join("|");
    const wanted = desiredGifts
      .map((g) => `${g.promoId}:${g.productId}:${g.quantity}`)
      .sort()
      .join("|");
    if (current !== wanted) syncGiftLines(desiredGifts);
  }, [desiredGifts, lines, syncGiftLines]);

  const rawTotal = Math.max(0, subtotal - discountTotal - effectivePromoDiscount - couponDiscount);
  // Redondeo del total al múltiplo configurado (H30); create_sale lo reaplica.
  const total = rounding > 0 ? Math.round(rawTotal / rounding) * rounding : rawTotal;

  // Ítems para dividir "por ítem" (H44).
  const splitItems = useMemo(
    () =>
      lines.map((l) => ({
        id: l.lineId,
        label: l.variantLabel ? `${l.name} (${l.variantLabel})` : l.name,
        amount: lineSubtotal(l),
      })),
    [lines],
  );

  // Qué promo toca cada línea del carrito y cuánto.
  const promoByLine = useMemo(() => {
    const out: Record<string, { label: string; amount: number }[]> = {};
    if (!promoActive || !promoEval) return out;
    promoEval.applied.forEach((a: AppliedPromo) =>
      a.lines.forEach((amt, i) => {
        const l = lines[i];
        if (!l || amt <= 0) return;
        (out[l.lineId] ??= []).push({ label: a.label, amount: amt });
      }),
    );
    return out;
  }, [promoActive, promoEval, lines]);

  // Bancos que piden las promos activas (el cobro con tarjeta los ofrece).
  const promoBanks = useMemo(() => [...new Set(promos.flatMap((p) => p.banks ?? []))], [promos]);

  // Promo final para create_sale cuando la hoja no manda una (p. ej. reintentos).
  const salePromo = (appliedPromo?: PricingPromo | null): PricingPromo | null =>
    !promoActive ? null : appliedPromo && appliedPromo.discount > 0 ? appliedPromo : cartPromo;

  return {
    lines,
    discountTotal,
    subtotal,
    promoResult,
    promoDiscount,
    promoActive,
    couponDiscount,
    appliedCoupon,
    couponInput,
    setCouponInput,
    applyCoupon,
    clearCoupon,
    cartPromo,
    promoForMethod,
    promoForPayments,
    promoByLine,
    promoBanks,
    rawTotal,
    total,
    splitItems,
    salePromo,
  };
}
