"use client";

import { useState } from "react";
import {
  ChevronDown,
  CreditCard,
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
import { EmptyState } from "@/components/ui/EmptyState";
import { Switch } from "@/components/ui/Switch";
import { Spinner } from "@/components/ui/Spinner";
import { lineSubtotal, type CartLine } from "@/modules/pos/store";
import type { ResolvedTender } from "@/lib/pos/tenders";
import { formatQty } from "@/lib/utils/format";
import { cn } from "@/lib/utils/cn";
import { BrandIcon } from "../ui/BrandIcon";
import { POS_CTA, POS_QUIET, money } from "../ui/posStyles";

// Carrito del POS en dos piezas: CartLines (las líneas, con scroll propio) y
// CartSummary (cliente, descuento/cupón, total y cobro). Cada preset las ubica
// donde le conviene; en el celular viven dentro de una hoja.

// Botón del stepper: 32px con mouse, 44px en pantallas táctiles.
const stepBtn =
  "grid h-8 w-8 place-items-center rounded-md text-foreground transition-colors hover:bg-fg-10 [@media(pointer:coarse)]:h-11 [@media(pointer:coarse)]:w-11";
// Acción secundaria de una línea abierta.
const lineAction =
  "flex h-8 items-center gap-1.5 rounded-md px-2.5 text-xs font-semibold transition-colors [@media(pointer:coarse)]:h-10";
// Campo chico del bloque de totales (descuento, cupón).
const smallField =
  "h-9 rounded-md border border-border bg-background/40 px-2.5 text-foreground outline-none transition-colors placeholder:text-muted-foreground focus:border-[color-mix(in_srgb,var(--foreground)_30%,transparent)] focus-visible:!outline-none";

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
  // Cambio manual de precio (ADR-056). Sin handler no se ofrece.
  onEditPrice?: (lineId: string) => void;
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
  onEditPrice,
  emptyHint = "Tocá un producto o escaneá un código para empezar.",
}: CartLinesProps) {
  const [openId, setOpenId] = useState<string | null>(null);

  if (lines.length === 0) {
    return (
      <div className="flex h-full min-h-[180px] items-center justify-center">
        <EmptyState compact icon={ShoppingBag} title="El carrito está vacío" description={emptyHint} />
      </div>
    );
  }

  return (
    <ul className={cn(dense ? "divide-y divide-border" : "space-y-0.5")}>
      {lines.map((l, idx) => {
        const open = openId === l.lineId;
        const free = Boolean(l.packCreditId || l.giftPromoId);
        const credit = !l.packCreditId ? creditForLine(l) : null;
        const editable = !l.giftPromoId;
        const meta =
          [
            l.variantLabel,
            l.serial ? `S/N ${l.serial}` : null,
            l.modifiersLabel,
            l.unit === "kg"
              ? `${formatQty(l.quantity)} kg × ${money(l.unitPrice)}/kg`
              : l.quantity > 1
                ? `${l.quantity} × ${money(l.unitPrice)}`
                : null,
            l.packCreditId ? "Cubierto por el pack" : null,
            l.priceOverride && l.listPrice != null ? `Lista ${money(l.listPrice)}` : null,
          ]
            .filter(Boolean)
            .join(" · ") || money(l.unitPrice);
        return (
          <li
            key={l.lineId}
            className={cn("transition-colors", !dense && "rounded-lg", open ? "bg-fg-6" : "hover:bg-fg-4")}
          >
            <div className={cn("flex items-center gap-2.5 px-2.5", dense ? "py-1.5" : "py-2")}>
              {dense && (
                <span className="w-5 shrink-0 text-right font-mono text-[11px] tabular-nums text-muted-foreground">
                  {idx + 1}
                </span>
              )}
              <button
                type="button"
                onClick={() => setOpenId(open ? null : l.lineId)}
                className="min-w-0 flex-1 rounded-md text-left"
                aria-expanded={open}
              >
                <span className="flex min-w-0 items-start gap-1.5">
                  <span className="line-clamp-2 break-words text-[13px] font-medium leading-snug text-foreground">{l.name}</span>
                  {l.giftPromoId && (
                    <span className="inline-flex shrink-0 items-center gap-1 rounded-md bg-success/15 px-1.5 py-0.5 text-[11px] font-semibold text-success">
                      <Gift size={12} aria-hidden /> Regalo
                    </span>
                  )}
                  {l.priceOverride && (
                    <span className="inline-flex shrink-0 items-center gap-1 rounded-md bg-amber-400/15 px-1.5 py-0.5 text-[11px] font-semibold text-warning">
                      <Tag size={12} aria-hidden /> Precio manual
                    </span>
                  )}
                </span>
                <span className="mt-0.5 block truncate text-xs tabular-nums text-muted-foreground">{meta}</span>
              </button>
              {editable && l.unit !== "kg" && (
                <div className="flex shrink-0 items-center rounded-lg bg-fg-6 p-0.5">
                  <button
                    type="button"
                    onClick={() => onQty(l.lineId, l.quantity - 1)}
                    className={stepBtn}
                    aria-label={`Restar ${l.name}`}
                  >
                    <Minus size={16} aria-hidden />
                  </button>
                  <span className="w-7 text-center text-[13px] font-semibold tabular-nums">{l.quantity}</span>
                  <button
                    type="button"
                    onClick={() => onQty(l.lineId, l.quantity + 1)}
                    className={stepBtn}
                    aria-label={`Sumar ${l.name}`}
                  >
                    <Plus size={16} aria-hidden />
                  </button>
                </div>
              )}
              {!editable && <span className="text-xs tabular-nums text-muted-foreground">×{l.quantity}</span>}
              <span
                className={cn(
                  "w-[5.25rem] shrink-0 text-right font-price text-sm font-semibold tabular-nums",
                  free && "text-success",
                )}
              >
                {free ? "Gratis" : money(lineSubtotal(l))}
              </span>
            </div>

            {open && (
              <div className="flex flex-wrap items-center gap-1 px-2.5 pb-2.5">
                {editable && l.unit !== "kg" && !free &&
                  [2, 6, 12].map((q) => (
                    <button
                      key={q}
                      type="button"
                      onClick={() => onQty(l.lineId, l.quantity + q)}
                      className={cn(lineAction, "bg-card tabular-nums text-foreground hover:bg-fg-10")}
                    >
                      +{q}
                    </button>
                  ))}
                {l.packCreditId ? (
                  <button
                    type="button"
                    onClick={() => onUncover(l.lineId)}
                    className={cn(lineAction, "bg-success/15 text-success")}
                  >
                    <Package size={14} aria-hidden /> Quitar pack
                  </button>
                ) : (
                  credit && (
                    <button
                      type="button"
                      onClick={() => onCover(l.lineId, credit.id)}
                      className={cn(lineAction, "bg-success/15 text-success")}
                    >
                      <Package size={14} aria-hidden /> Usar sesión ({credit.sessions_left})
                    </button>
                  )
                )}
                {editable && !free && l.productId && onEditPrice && (
                  <button
                    type="button"
                    onClick={() => onEditPrice(l.lineId)}
                    className={cn(lineAction, "bg-card text-foreground hover:bg-fg-10")}
                  >
                    <Tag size={14} aria-hidden /> Cambiar precio
                  </button>
                )}
                {editable && (
                  <button
                    type="button"
                    onClick={() => {
                      onRemove(l.lineId);
                      setOpenId(null);
                    }}
                    className={cn(lineAction, "ml-auto text-danger hover:bg-danger/15")}
                  >
                    <Trash2 size={14} aria-hidden /> Quitar
                  </button>
                )}
              </div>
            )}
            {/* Oferta de sesión visible sin abrir la línea */}
            {!open && credit && (
              <button
                type="button"
                onClick={() => onCover(l.lineId, credit.id)}
                className="mx-2.5 mb-2 flex items-center gap-1.5 rounded-md bg-success/15 px-2 py-1 text-xs font-semibold text-success"
              >
                <Package size={14} aria-hidden /> Usar sesión del pack ({credit.sessions_left} restantes)
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
  // Sólo lo que pinta el botón: puede venir de la foto del arranque.
  pinned: { id: ResolvedTender["id"]; group: string; label: string; logo: string | null }[];
  hasShift: boolean;
  // El turno todavía no llegó (se muestra el último estado conocido, sin acción).
  shiftPending?: boolean;
  canCheckout: boolean;
  checkingOut?: boolean;
  onCheckout: (tenderId?: string) => void;
  onOpenShift: () => void;
  autoPrint: boolean;
  onAutoPrint: (v: boolean) => void;
  warrantySlot?: React.ReactNode;
  /** Lista y condición de pago (ADR-058). */
  priceSlot?: React.ReactNode;
  compact?: boolean;
}

export function CartSummary(p: CartSummaryProps) {
  const [adjustOpen, setAdjustOpen] = useState(false);
  const hasAdjust = p.discountTotal > 0 || Boolean(p.coupon) || Boolean(p.promo);
  const grand = p.total + p.deliveryFee;
  const missingCustomer = p.requireCustomer && !p.customer;

  return (
    <div className="space-y-3">
      {p.warrantySlot}
      {p.priceSlot}

      {/* Cliente + acciones de cuenta */}
      <div className="flex items-center gap-1.5">
        <button
          type="button"
          onClick={p.onCustomer}
          className={cn(
            "flex h-11 min-w-0 flex-1 items-center gap-2.5 rounded-lg pl-1.5 pr-3 text-left text-[13px] transition-colors",
            missingCustomer ? "bg-warning/10 hover:bg-warning/15" : "bg-fg-4 hover:bg-fg-6",
          )}
        >
          <span
            className={cn(
              "grid h-8 w-8 shrink-0 place-items-center rounded-md bg-fg-6 text-xs font-semibold",
              p.customer ? "text-foreground" : "text-muted-foreground",
            )}
            aria-hidden
          >
            {p.customer ? p.customer.name.trim().charAt(0).toUpperCase() : <User size={16} />}
          </span>
          <span className="min-w-0 flex-1 truncate font-medium">
            {p.customer ? p.customer.name : "Consumidor final"}
          </span>
          {p.customer && p.storeCredit > 0 && (
            <span className="shrink-0 rounded-md bg-success/15 px-1.5 py-0.5 text-[11px] font-semibold tabular-nums text-success">
              Vale {money(p.storeCredit)}
            </span>
          )}
          {/* Con vale a la vista, el nombre necesita el lugar de "Cambiar". */}
          {!(p.customer && p.storeCredit > 0) && (
            <span className={cn("shrink-0 text-xs font-medium", missingCustomer ? "text-warning" : "text-muted-foreground")}>
              {p.customer ? "Cambiar" : p.requireCustomer ? "Obligatorio" : "Elegir"}
            </span>
          )}
        </button>
        <button
          type="button"
          onClick={p.onVoucher}
          className="grid h-11 w-11 shrink-0 place-items-center rounded-lg bg-fg-4 text-muted-foreground transition-colors hover:bg-fg-6 hover:text-foreground"
          aria-label="Canjear vale"
          title="Canjear vale"
        >
          <Ticket size={18} aria-hidden />
        </button>
        {p.packsEnabled && (
          <button
            type="button"
            onClick={p.onSellPack}
            className="grid h-11 w-11 shrink-0 place-items-center rounded-lg bg-fg-4 text-muted-foreground transition-colors hover:bg-fg-6 hover:text-foreground"
            aria-label="Vender pack"
            title="Vender pack"
          >
            <Package size={18} aria-hidden />
          </button>
        )}
      </div>

      {/* Totales */}
      <div className="px-1">
        <button
          type="button"
          onClick={() => setAdjustOpen((o) => !o)}
          className="flex h-8 w-full items-center justify-between rounded-md text-[13px] text-muted-foreground transition-colors hover:text-foreground"
          aria-expanded={adjustOpen}
        >
          <span>
            Subtotal{" "}
            <span className="tabular-nums">
              · {p.itemCount} {p.itemCount === 1 ? "ítem" : "ítems"}
            </span>
          </span>
          <span className="flex items-center gap-1 font-price tabular-nums">
            {money(p.subtotal)}
            <ChevronDown size={16} aria-hidden className={cn("transition-transform", adjustOpen && "rotate-180")} />
          </span>
        </button>

        {(adjustOpen || hasAdjust) && (
          <div className="mt-1 space-y-2 text-[13px]">
            {/* Los campos (descuento, cupón) se abren con el subtotal; lo ya
                aplicado (promo, cupón, descuento) queda siempre a la vista. */}
            {(adjustOpen || p.discountTotal > 0) && (
              <div className="flex items-center justify-between gap-2 text-muted-foreground">
                <span className="flex items-center gap-1.5">
                  Descuento {p.discountLocked && <Lock size={14} aria-hidden />}
                </span>
                {p.discountLocked ? (
                  <button
                    type="button"
                    onClick={p.onDiscountLocked}
                    title="Descuentos: función no incluida en tu plan"
                    className="h-9 w-28 rounded-md bg-fg-6 px-2 text-right text-muted-foreground opacity-60"
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
                    className={cn(smallField, "w-28 text-right font-medium tabular-nums")}
                  />
                )}
              </div>
            )}
            {p.promo && (
              <div className="flex items-center justify-between gap-2 text-success">
                <span className="flex min-w-0 items-center gap-1.5">
                  <Tag size={14} className="shrink-0" aria-hidden />
                  <span className="truncate">{p.promo.name}</span>
                </span>
                <span className="shrink-0 font-price font-medium tabular-nums">−{money(p.promo.amount)}</span>
              </div>
            )}
            {p.coupon ? (
              <div className="flex items-center justify-between gap-2">
                <span className="flex min-w-0 items-center gap-1.5 text-success">
                  <Ticket size={14} className="shrink-0" aria-hidden />
                  <span className="truncate">Cupón {p.coupon.code}</span>
                  <button
                    type="button"
                    onClick={p.onRemoveCoupon}
                    className="grid h-6 w-6 shrink-0 place-items-center rounded-md text-muted-foreground transition-colors hover:bg-danger/15 hover:text-danger"
                    aria-label="Quitar cupón"
                  >
                    <X size={14} aria-hidden />
                  </button>
                </span>
                {p.coupon.amount > 0 ? (
                  <span className="shrink-0 font-price font-medium tabular-nums text-success">
                    −{money(p.coupon.amount)}
                  </span>
                ) : (
                  <span className="shrink-0 text-xs text-muted-foreground">falta el mínimo</span>
                )}
              </div>
            ) : adjustOpen ? (
              <div className="flex items-center gap-1.5">
                <input
                  value={p.couponInput}
                  onChange={(e) => p.onCouponInput(e.target.value)}
                  onKeyDown={(e) => e.key === "Enter" && p.onApplyCoupon()}
                  placeholder="Código de cupón"
                  aria-label="Código de cupón"
                  className={cn(smallField, "min-w-0 flex-1 uppercase placeholder:normal-case")}
                />
                <button
                  type="button"
                  disabled={!p.couponInput.trim()}
                  onClick={p.onApplyCoupon}
                  className={cn("h-9 rounded-md px-3 text-xs font-semibold", POS_QUIET)}
                >
                  Aplicar
                </button>
              </div>
            ) : null}
            {p.deliveryFee > 0 && (
              <div className="flex justify-between text-muted-foreground">
                <span>Envío</span>
                <span className="font-price tabular-nums">+{money(p.deliveryFee)}</span>
              </div>
            )}
          </div>
        )}

        <div className="mt-2 flex items-baseline justify-between gap-2 border-t border-border pt-3">
          <span className="text-sm font-semibold text-foreground">Total</span>
          <span className="font-price text-[1.75rem] font-bold leading-none tracking-tight tabular-nums text-foreground">
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
                  className={cn(
                    "flex h-11 min-w-0 items-center justify-center gap-2 rounded-lg px-2 text-[13px] font-medium",
                    POS_QUIET,
                  )}
                >
                  {t.group === "card" ? (
                    // Tarjeta manual (posnet propio): ícono genérico, no el logo de una red.
                    <CreditCard size={20} className="shrink-0 text-muted-foreground" aria-hidden />
                  ) : (
                    // Los logos tienen el peso visual abajo (sombra, fajos): subirlos 1px
                    // y bajar 1px el texto los alinea al ojo con la línea del texto.
                    <BrandIcon logo={t.logo} alt="" size={20} className="-translate-y-px" />
                  )}
                  {/* "Tarjeta en posnet" no entra en un botón de un tercio. */}
                  <span className="translate-y-px truncate leading-none">{t.group === "card" ? "Tarjeta" : t.label}</span>
                </button>
              ))}
            </div>
          )}
          <button
            type="button"
            disabled={!p.canCheckout || p.checkingOut}
            onClick={() => p.onCheckout()}
            className={cn("flex h-14 w-full items-center justify-between rounded-lg px-4 text-[17px] font-semibold", POS_CTA)}
          >
            <span className="flex items-center gap-2">
              {p.checkingOut && <Spinner size={16} className="!border-white/30 !border-t-[color:var(--pos-on)]" />}
              Cobrar
            </span>
            <span className="flex items-center gap-2.5">
              <span className="font-price text-lg font-bold tabular-nums">{money(grand)}</span>
              <kbd className="hidden rounded bg-white/20 px-1.5 py-0.5 font-mono text-[10px] font-medium lg:inline">
                F12
              </kbd>
            </span>
          </button>
        </div>
      ) : (
        <button
          type="button"
          onClick={p.shiftPending ? undefined : p.onOpenShift}
          aria-busy={p.shiftPending || undefined}
          className={cn("flex h-14 w-full items-center justify-center gap-2 rounded-lg text-[15px] font-semibold", POS_QUIET)}
        >
          <Lock size={18} className="text-muted-foreground" aria-hidden />
          Abrí la caja para vender
        </button>
      )}

      {!p.compact && (
        <label className="flex cursor-pointer items-center justify-between gap-2 px-1 text-[13px] text-muted-foreground">
          <span>Imprimir ticket al cobrar</span>
          <Switch checked={p.autoPrint} onCheckedChange={p.onAutoPrint} label="Imprimir ticket al cobrar" />
        </label>
      )}
    </div>
  );
}
