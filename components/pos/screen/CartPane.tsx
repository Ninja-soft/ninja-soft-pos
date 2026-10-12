"use client";

import { useState } from "react";
import {
  ChevronDown,
  Gift,
  Lock,
  Minus,
  Package,
  Plus,
  ShoppingBag,
  Tag,
  Ticket,
  Trash2,
  User,
  X,
} from "lucide-react";
import { Switch } from "@/components/ui/Switch";
import { Spinner } from "@/components/ui/Spinner";
import { lineSubtotal, type CartLine } from "@/modules/pos/store";
import type { ResolvedTender } from "@/lib/pos/tenders";
import { formatQty } from "@/lib/utils/format";
import { cn } from "@/lib/utils/cn";
import { BrandIcon } from "../ui/BrandIcon";
import { POS_CTA, POS_SELECTED, money } from "../ui/posStyles";

// Carrito del POS en dos piezas: CartLines (las líneas, con scroll propio) y
// CartSummary (cliente, descuento/cupón, total y cobro). Cada preset las ubica
// donde le conviene; en el celular viven dentro de una hoja.

export interface PackCredit {
  id: string;
  sessions_left: number;
}

export interface CartLinesProps {
  lines: CartLine[];
  dense?: boolean;
  onQty: (lineId: string, qty: number) => void;
  onRemove: (lineId: string) => void;
  creditForLine: (l: CartLine) => PackCredit | null;
  onCover: (lineId: string, creditId: string) => void;
  onUncover: (lineId: string) => void;
  emptyHint?: string;
}

export function CartLines({
  lines,
  dense,
  onQty,
  onRemove,
  creditForLine,
  onCover,
  onUncover,
  emptyHint = "Tocá un producto o escaneá un código para empezar.",
}: CartLinesProps) {
  const [openId, setOpenId] = useState<string | null>(null);

  if (lines.length === 0) {
    return (
      <div className="flex h-full min-h-[180px] flex-col items-center justify-center gap-3 px-6 text-center">
        <span className="grid h-16 w-16 place-items-center rounded-[22px] bg-[color-mix(in_srgb,var(--pos-from)_14%,transparent)]">
          <ShoppingBag size={28} className="text-[color:var(--pos-from)]" />
        </span>
        <p className="text-sm font-bold">El carrito está vacío</p>
        <p className="max-w-[16rem] text-xs text-muted-foreground">{emptyHint}</p>
      </div>
    );
  }

  return (
    <ul className={cn("space-y-1", dense && "space-y-0.5")}>
      {lines.map((l, idx) => {
        const open = openId === l.lineId;
        const free = Boolean(l.packCreditId || l.giftPromoId);
        const credit = !l.packCreditId ? creditForLine(l) : null;
        const editable = !l.giftPromoId;
        return (
          <li
            key={l.lineId}
            className={cn("rounded-2xl transition", open ? "bg-muted" : "hover:bg-muted/60")}
          >
            <div className={cn("flex items-center gap-2.5 px-2.5", dense ? "py-1.5" : "py-2")}>
              {dense && (
                <span className="w-5 shrink-0 text-right font-mono text-[11px] text-muted-foreground">
                  {idx + 1}
                </span>
              )}
              <button
                type="button"
                onClick={() => setOpenId(open ? null : l.lineId)}
                className="min-w-0 flex-1 text-left"
                aria-expanded={open}
              >
                <span className="flex items-center gap-1.5">
                  <span className="truncate text-[13px] font-semibold text-foreground">{l.name}</span>
                  {l.giftPromoId && (
                    <span className="inline-flex shrink-0 items-center gap-0.5 rounded-full bg-success/15 px-1.5 py-0.5 text-[10px] font-bold uppercase text-success">
                      <Gift size={10} /> Regalo
                    </span>
                  )}
                </span>
                <span className="block truncate text-[11px] text-muted-foreground">
                  {[
                    l.variantLabel,
                    l.serial ? `S/N ${l.serial}` : null,
                    l.modifiersLabel,
                    l.unit === "kg"
                      ? `${formatQty(l.quantity)} kg × ${money(l.unitPrice)}/kg`
                      : l.quantity > 1
                        ? `${l.quantity} × ${money(l.unitPrice)}`
                        : null,
                    l.packCreditId ? "Cubierto por el pack" : null,
                  ]
                    .filter(Boolean)
                    .join(" · ") || money(l.unitPrice)}
                </span>
              </button>
              {editable && l.unit !== "kg" && (
                <div className="flex shrink-0 items-center rounded-full bg-muted/80">
                  <button
                    type="button"
                    onClick={() => onQty(l.lineId, l.quantity - 1)}
                    className="grid h-8 w-8 place-items-center rounded-full transition hover:bg-foreground/10 active:scale-90"
                    aria-label={`Restar ${l.name}`}
                  >
                    <Minus size={14} />
                  </button>
                  <span className="w-6 text-center text-[13px] font-bold tabular-nums">{l.quantity}</span>
                  <button
                    type="button"
                    onClick={() => onQty(l.lineId, l.quantity + 1)}
                    className="grid h-8 w-8 place-items-center rounded-full transition hover:bg-foreground/10 active:scale-90"
                    aria-label={`Sumar ${l.name}`}
                  >
                    <Plus size={14} />
                  </button>
                </div>
              )}
              {!editable && <span className="text-xs text-muted-foreground">×{l.quantity}</span>}
              <span
                className={cn(
                  "w-[5.5rem] shrink-0 text-right font-price text-[13px] font-black tabular-nums",
                  free && "text-success",
                )}
              >
                {free ? "Gratis" : money(lineSubtotal(l))}
              </span>
            </div>

            {open && (
              <div className="flex flex-wrap items-center gap-1.5 px-2.5 pb-2.5">
                {editable && l.unit !== "kg" && !free &&
                  [2, 6, 12].map((q) => (
                    <button
                      key={q}
                      type="button"
                      onClick={() => onQty(l.lineId, l.quantity + q)}
                      className="h-8 rounded-full bg-card px-3 text-xs font-bold transition active:scale-95"
                    >
                      +{q}
                    </button>
                  ))}
                {l.packCreditId ? (
                  <button
                    type="button"
                    onClick={() => onUncover(l.lineId)}
                    className="flex h-8 items-center gap-1.5 rounded-full bg-success/15 px-3 text-xs font-bold text-success"
                  >
                    <Package size={13} /> Quitar pack
                  </button>
                ) : (
                  credit && (
                    <button
                      type="button"
                      onClick={() => onCover(l.lineId, credit.id)}
                      className="flex h-8 items-center gap-1.5 rounded-full bg-success/15 px-3 text-xs font-bold text-success"
                    >
                      <Package size={13} /> Usar sesión ({credit.sessions_left})
                    </button>
                  )
                )}
                {editable && (
                  <button
                    type="button"
                    onClick={() => {
                      onRemove(l.lineId);
                      setOpenId(null);
                    }}
                    className="ml-auto flex h-8 items-center gap-1.5 rounded-full bg-danger/15 px-3 text-xs font-bold text-danger transition hover:bg-danger/20"
                  >
                    <Trash2 size={13} /> Quitar
                  </button>
                )}
              </div>
            )}
            {/* Oferta de sesión visible sin abrir la línea */}
            {!open && credit && (
              <button
                type="button"
                onClick={() => onCover(l.lineId, credit.id)}
                className="mx-2.5 mb-2 flex items-center gap-1.5 rounded-full bg-success/15 px-2.5 py-1 text-[11px] font-bold text-success"
              >
                <Package size={12} /> Usar sesión del pack ({credit.sessions_left} restantes)
              </button>
            )}
          </li>
        );
      })}
    </ul>
  );
}

export interface CartSummaryProps {
  customer: { id: string; name: string } | null;
  requireCustomer: boolean;
  storeCredit: number;
  onCustomer: () => void;
  onVoucher: () => void;
  packsEnabled: boolean;
  onSellPack: () => void;
  subtotal: number;
  discountTotal: number;
  discountLocked: boolean;
  onDiscount: (v: number) => void;
  onDiscountLocked: () => void;
  promo: { name: string; amount: number } | null;
  coupon: { code: string; amount: number } | null;
  couponInput: string;
  onCouponInput: (v: string) => void;
  onApplyCoupon: () => void;
  onRemoveCoupon: () => void;
  deliveryFee: number;
  total: number;
  itemCount: number;
  pinned: ResolvedTender[];
  hasShift: boolean;
  canCheckout: boolean;
  checkingOut?: boolean;
  onCheckout: (tenderId?: string) => void;
  onOpenShift: () => void;
  autoPrint: boolean;
  onAutoPrint: (v: boolean) => void;
  warrantySlot?: React.ReactNode;
  compact?: boolean;
}

export function CartSummary(p: CartSummaryProps) {
  const [adjustOpen, setAdjustOpen] = useState(false);
  const hasAdjust = p.discountTotal > 0 || Boolean(p.coupon) || Boolean(p.promo);
  const grand = p.total + p.deliveryFee;

  return (
    <div className="space-y-2.5">
      {p.warrantySlot}

      {/* Cliente + acciones de cuenta */}
      <div className="flex items-center gap-1.5">
        <button
          type="button"
          onClick={p.onCustomer}
          className={cn(
            "flex h-11 min-w-0 flex-1 items-center gap-2 rounded-2xl px-3 text-left text-[13px] transition",
            p.requireCustomer && !p.customer
              ? "bg-[color-mix(in_srgb,var(--pos-from)_16%,transparent)]"
              : "bg-muted/70 hover:bg-muted",
          )}
        >
          <User size={15} className="shrink-0 text-muted-foreground" />
          <span className="min-w-0 flex-1 truncate font-semibold">
            {p.customer ? p.customer.name : "Consumidor final"}
          </span>
          {p.customer && p.storeCredit > 0 && (
            <span className="shrink-0 rounded-full bg-success/15 px-2 py-0.5 text-[11px] font-bold text-success">
              Vale {money(p.storeCredit)}
            </span>
          )}
          <span className="shrink-0 text-[11px] font-bold text-muted-foreground">
            {p.customer ? "Cambiar" : p.requireCustomer ? "Obligatorio" : "Elegir"}
          </span>
        </button>
        <button
          type="button"
          onClick={p.onVoucher}
          className="grid h-11 w-11 shrink-0 place-items-center rounded-2xl bg-muted/70 text-muted-foreground transition hover:bg-muted hover:text-foreground"
          aria-label="Canjear vale"
          title="Canjear vale"
        >
          <Ticket size={17} />
        </button>
        {p.packsEnabled && (
          <button
            type="button"
            onClick={p.onSellPack}
            className="grid h-11 w-11 shrink-0 place-items-center rounded-2xl bg-muted/70 text-muted-foreground transition hover:bg-muted hover:text-foreground"
            aria-label="Vender pack"
            title="Vender pack"
          >
            <Package size={17} />
          </button>
        )}
      </div>

      {/* Totales */}
      <div className="rounded-2xl bg-muted/40 px-3 py-2.5">
        <button
          type="button"
          onClick={() => setAdjustOpen((o) => !o)}
          className="flex w-full items-center justify-between text-[13px] text-muted-foreground"
          aria-expanded={adjustOpen}
        >
          <span className="flex items-center gap-1.5">
            Subtotal
            <span className="rounded-full bg-muted px-2 py-0.5 text-[10px] font-bold">
              {p.itemCount} {p.itemCount === 1 ? "ítem" : "ítems"}
            </span>
          </span>
          <span className="flex items-center gap-1.5 tabular-nums">
            {money(p.subtotal)}
            <ChevronDown size={14} className={cn("transition", adjustOpen && "rotate-180")} />
          </span>
        </button>

        {(adjustOpen || hasAdjust) && (
          <div className="mt-2 space-y-2 text-[13px]">
            <div className="flex items-center justify-between gap-2 text-muted-foreground">
              <span className="flex items-center gap-1.5">
                Descuento {p.discountLocked && <Lock size={12} />}
              </span>
              {p.discountLocked ? (
                <button
                  type="button"
                  onClick={p.onDiscountLocked}
                  title="Descuentos: función no incluida en tu plan"
                  className="h-8 w-28 rounded-xl bg-muted/60 px-2 text-right text-muted-foreground/60"
                >
                  0
                </button>
              ) : (
                <input
                  type="number"
                  step="0.01"
                  inputMode="decimal"
                  value={p.discountTotal || ""}
                  onChange={(e) => p.onDiscount(Number(e.target.value) || 0)}
                  placeholder="0"
                  aria-label="Descuento"
                  className="h-8 w-28 rounded-xl bg-muted px-2 text-right font-semibold tabular-nums text-foreground outline-none focus:bg-card"
                />
              )}
            </div>
            {p.promo && (
              <div className="flex items-center justify-between gap-2 text-success">
                <span className="flex min-w-0 items-center gap-1.5">
                  <Tag size={13} className="shrink-0" />
                  <span className="truncate">{p.promo.name}</span>
                </span>
                <span className="shrink-0 font-semibold tabular-nums">−{money(p.promo.amount)}</span>
              </div>
            )}
            {p.coupon ? (
              <div className="flex items-center justify-between gap-2">
                <span className="flex min-w-0 items-center gap-1.5 text-success">
                  <Ticket size={13} className="shrink-0" />
                  <span className="truncate">Cupón {p.coupon.code}</span>
                  <button
                    type="button"
                    onClick={p.onRemoveCoupon}
                    className="text-muted-foreground hover:text-danger"
                    aria-label="Quitar cupón"
                  >
                    <X size={13} />
                  </button>
                </span>
                {p.coupon.amount > 0 ? (
                  <span className="shrink-0 font-semibold tabular-nums text-success">−{money(p.coupon.amount)}</span>
                ) : (
                  <span className="shrink-0 text-xs text-muted-foreground">falta el mínimo</span>
                )}
              </div>
            ) : (
              <div className="flex items-center gap-1.5">
                <input
                  value={p.couponInput}
                  onChange={(e) => p.onCouponInput(e.target.value)}
                  onKeyDown={(e) => e.key === "Enter" && p.onApplyCoupon()}
                  placeholder="Código de cupón"
                  aria-label="Código de cupón"
                  className="h-8 min-w-0 flex-1 rounded-xl bg-muted px-2.5 uppercase outline-none placeholder:normal-case focus:bg-card"
                />
                <button
                  type="button"
                  disabled={!p.couponInput.trim()}
                  onClick={p.onApplyCoupon}
                  className="h-8 rounded-xl bg-muted px-3 text-xs font-bold transition hover:bg-foreground/10 disabled:opacity-40"
                >
                  Aplicar
                </button>
              </div>
            )}
            {p.deliveryFee > 0 && (
              <div className="flex justify-between text-muted-foreground">
                <span>Envío</span>
                <span className="tabular-nums">+{money(p.deliveryFee)}</span>
              </div>
            )}
          </div>
        )}

        <div className="mt-2 flex items-end justify-between gap-2 border-t border-border/60 pt-2">
          <span className="font-display text-base font-black">Total</span>
          <span className="price-hl font-price text-[2rem] font-black leading-none tabular-nums">
            {money(grand)}
          </span>
        </div>
      </div>

      {/* Cobro */}
      {p.hasShift ? (
        <div className="space-y-2">
          {p.pinned.length > 0 && (
            <div className="grid gap-1.5" style={{ gridTemplateColumns: `repeat(${p.pinned.length}, minmax(0,1fr))` }}>
              {p.pinned.map((t) => (
                <button
                  key={t.id}
                  type="button"
                  disabled={!p.canCheckout}
                  onClick={() => p.onCheckout(t.id)}
                  className="flex h-12 min-w-0 items-center justify-center gap-2 rounded-2xl bg-muted/80 px-2 text-[13px] font-bold transition hover:bg-muted active:scale-[0.98] disabled:opacity-40"
                >
                  <BrandIcon logo={t.logo} alt={t.brandLabel} size={24} />
                  <span className="truncate">
                    {t.group === "cash" || t.group === "transfer" || t.group === "card" ? t.label : `${t.label}`}
                  </span>
                </button>
              ))}
            </div>
          )}
          <button
            type="button"
            disabled={!p.canCheckout || p.checkingOut}
            onClick={() => p.onCheckout()}
            className={cn(
              "flex h-14 w-full items-center justify-between rounded-2xl px-5 text-base font-black",
              POS_CTA,
            )}
          >
            <span className="flex items-center gap-2">
              {p.checkingOut && <Spinner size={16} className="!border-black/20 !border-t-[color:var(--pos-ink)]" />}
              Cobrar
            </span>
            <span className="flex items-center gap-2">
              <span className="font-price tabular-nums">{money(grand)}</span>
              <kbd className="hidden rounded-md bg-black/15 px-1.5 py-0.5 font-mono text-[10px] font-bold lg:inline">
                F12
              </kbd>
            </span>
          </button>
        </div>
      ) : (
        <button
          type="button"
          onClick={p.onOpenShift}
          className={cn("flex h-14 w-full items-center justify-center rounded-2xl text-base font-black", POS_SELECTED)}
        >
          Abrí la caja para vender
        </button>
      )}

      {!p.compact && (
        <label className="flex cursor-pointer items-center justify-between gap-2 px-1 text-xs text-muted-foreground">
          <span>Imprimir ticket al cobrar</span>
          <Switch checked={p.autoPrint} onCheckedChange={p.onAutoPrint} label="Imprimir ticket al cobrar" />
        </label>
      )}
    </div>
  );
}
