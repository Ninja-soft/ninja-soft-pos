"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { useToast } from "@/components/ui/Toast";
import { useProductsByIds } from "@/modules/products/hooks";
import type { Product } from "@/modules/products/api";
import { useActivePromotions } from "@/modules/promotions/hooks";
import { couponsApi } from "@/modules/coupons/api";
import {
  evaluateCart,
  evaluateGifts,
  type Promotion,
  type PromoCartLine,
  type PromoContext,
} from "@/lib/promotions/engine";
import { cartSubtotal, lineSubtotal, useCartStore, type CartLine } from "@/modules/pos/store";

// Precios del carrito del POS: promociones (H53/H54), cupón, regalos, total
// redondeado y promo por medio de pago. Movido tal cual desde la página.

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

function arContext(paymentMethod?: string): PromoContext {
  const arNow = new Date(
    new Date().toLocaleString("en-US", { timeZone: "America/Argentina/Buenos_Aires" }),
  );
  return {
    weekday: arNow.getDay(),
    minutes: arNow.getHours() * 60 + arNow.getMinutes(),
    date: `${arNow.getFullYear()}-${String(arNow.getMonth() + 1).padStart(2, "0")}-${String(arNow.getDate()).padStart(2, "0")}`,
    ...(paymentMethod ? { paymentMethod } : {}),
  };
}

const toPromoLines = (ls: CartLine[]): PromoCartLine[] =>
  ls.map((l) => ({
    productId: l.productId,
    categoryId: l.categoryId ?? null,
    unitPrice: l.unitPrice,
    quantity: l.quantity,
    lineTotal: lineSubtotal(l),
  }));

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
}: {
  rounding: number;
  customerId: string | null;
}) {
  const { toast } = useToast();
  const lines = useCartStore((s) => s.lines);
  const discountTotal = useCartStore((s) => s.discountTotal);
  const syncGiftLines = useCartStore((s) => s.syncGiftLines);
  const { data: activePromos } = useActivePromotions();

  const [couponInput, setCouponInput] = useState("");
  const [appliedCoupon, setAppliedCoupon] = useState<AppliedCoupon | null>(null);

  const subtotal = cartSubtotal(lines);

  // Promoción aplicable (F9 · H53): mejor promo ACTIVA para el carrito.
  const promoResult = useMemo(() => {
    if (!activePromos || activePromos.length === 0 || lines.length === 0) return null;
    return evaluateCart(toPromoLines(lines), activePromos, arContext());
  }, [activePromos, lines]);

  // Descuento de promo acotado a lo que queda tras el descuento manual.
  const promoDiscount = promoResult ? Math.min(promoResult.discount, Math.max(0, subtotal - discountTotal)) : 0;

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
  const promoActive = couponDiscount <= 0;
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
  const cartPromo =
    promoActive && promoResult && promoDiscount > 0
      ? { discount: promoDiscount, id: promoResult.promotionId, name: promoResult.name }
      : null;

  // Mejor promo CONSIDERANDO el medio de pago (H54).
  const promoForMethod = useCallback(
    (method: string): { discount: number; id: string | null; name: string | null } | null => {
      if (couponDiscount > 0) return null;
      if (!activePromos || activePromos.length === 0 || lines.length === 0) return null;
      const r = evaluateCart(toPromoLines(lines), activePromos, arContext(method));
      if (!r) return null;
      const capped = Math.min(r.discount, Math.max(0, subtotal - discountTotal));
      if (capped <= 0) return null;
      return { discount: capped, id: r.promotionId, name: r.name };
    },
    [activePromos, lines, subtotal, discountTotal, couponDiscount],
  );

  // ── Regalo por compra (H54) ─────────────────────────────────────────────────
  const giftProductIds = useMemo(
    () =>
      (activePromos ?? [])
        .filter((p: Promotion) => p.action_type === "gift" && p.gift_product_id)
        .map((p: Promotion) => p.gift_product_id as string),
    [activePromos],
  );
  const { data: giftProductsData } = useProductsByIds(giftProductIds);
  const giftProductById = useMemo(() => {
    const m = new Map<string, Product>();
    for (const p of giftProductsData ?? []) m.set(p.id, p);
    return m;
  }, [giftProductsData]);

  const desiredGifts = useMemo(() => {
    if (!activePromos || activePromos.length === 0) return [];
    const realLines = lines.filter((l) => !l.giftPromoId);
    if (realLines.length === 0) return [];
    const out: { promoId: string; productId: string; name: string; sku: string | null; quantity: number }[] = [];
    for (const g of evaluateGifts(toPromoLines(realLines), activePromos, arContext())) {
      const p = giftProductById.get(g.giftProductId);
      if (!p) continue;
      if (p.track_stock && Number(p.stock ?? 0) < g.giftQty) continue;
      out.push({ promoId: g.promotionId, productId: p.id, name: p.name, sku: p.sku, quantity: g.giftQty });
    }
    return out;
  }, [activePromos, lines, giftProductById]);

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

  // Promo final para create_sale cuando la hoja no manda una (p. ej. reintentos).
  const salePromo = (appliedPromo?: { discount: number; id: string | null; name: string | null } | null) =>
    !promoActive
      ? null
      : appliedPromo && appliedPromo.discount > 0
        ? appliedPromo
        : promoResult && promoDiscount > 0
          ? { discount: promoDiscount, id: promoResult.promotionId, name: promoResult.name }
          : null;

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
    rawTotal,
    total,
    splitItems,
    salePromo,
  };
}
