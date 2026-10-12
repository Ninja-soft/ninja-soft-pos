"use client";

import { useEffect, useState } from "react";
import { ChevronUp, Trash2, Utensils, LayoutGrid } from "lucide-react";
import type { PosLayout } from "@/lib/pos/layout";
import { cn } from "@/lib/utils/cn";
import { PosSheet } from "../ui/PosSheet";
import { POS_CTA, POS_IDLE, POS_SELECTED, accentVars, money } from "../ui/posStyles";

// Esqueleto de la pantalla de venta. Ubica las piezas según el preset:
//  - Mostrador:   [productos | carrito]
//  - Boutique:    [colecciones | fotos | carrito]
//  - Salón:       [mesas | carta | cuenta]  (en tablet, Mesas/Carta en pestañas)
//  - Caja rápida: [escáner + ticket | total + teclado + cobro]
// En el celular el carrito vive en una hoja con barra fija abajo (o en una
// pestaña, según pos_layout.mobileCart). Sin scroll horizontal; alto en dvh.

export interface PosShellProps {
  layout: PosLayout;
  topBar: React.ReactNode;
  banners?: React.ReactNode;
  /** Centro: grilla de productos (o escáner + ticket en Caja rápida). */
  center: React.ReactNode;
  /** Riel izquierdo (Boutique: colecciones). */
  rail?: React.ReactNode;
  /** Mesas (Salón). */
  tables?: React.ReactNode;
  cartTitle: string;
  cartLines: React.ReactNode;
  cartSummary: React.ReactNode;
  itemCount: number;
  total: number;
  canCheckout: boolean;
  onCheckout: () => void;
  onClear: () => void;
  /** Caja rápida: el ticket va al centro y la columna derecha es el cobro. */
  linesInCenter?: boolean;
  /** Teclado (Caja rápida). */
  aside?: React.ReactNode;
  /** La hoja de cobro está abierta (cierra la hoja del carrito en mobile). */
  checkoutOpen?: boolean;
}

export function PosShell(p: PosShellProps) {
  const { layout } = p;
  const [cartOpen, setCartOpen] = useState(false);
  const [mobileTab, setMobileTab] = useState<"products" | "cart">("products");
  const [salonTab, setSalonTab] = useState<"carta" | "mesas">("carta");
  const [confirmClear, setConfirmClear] = useState(false);
  const tabs = layout.mobileCart === "tabs";
  const left = layout.cartSide === "left";
  useEffect(() => {
    if (p.checkoutOpen) setCartOpen(false);
  }, [p.checkoutOpen]);

  const clearBlock = p.itemCount > 0 && (
    <div className="relative">
      {confirmClear ? (
        <div className="flex items-center gap-1.5">
          <span className="text-[11px] font-semibold text-muted-foreground">¿Vaciar?</span>
          <button type="button" onClick={() => setConfirmClear(false)} className="h-7 rounded-full bg-muted px-2.5 text-[11px] font-bold">
            No
          </button>
          <button
            type="button"
            onClick={() => {
              setConfirmClear(false);
              p.onClear();
            }}
            className="h-7 rounded-full bg-danger/15 px-2.5 text-[11px] font-bold text-danger"
          >
            Vaciar
          </button>
        </div>
      ) : (
        <button
          type="button"
          onClick={() => setConfirmClear(true)}
          className="grid h-8 w-8 place-items-center rounded-full text-muted-foreground transition hover:bg-danger/15 hover:text-danger"
          aria-label="Vaciar carrito"
          title="Vaciar carrito"
        >
          <Trash2 size={15} />
        </button>
      )}
    </div>
  );

  const cartHeader = (
    <div className="flex h-12 shrink-0 items-center justify-between gap-2 px-4">
      <p className="flex items-center gap-2 font-display text-base font-black">
        {p.cartTitle}
        {p.itemCount > 0 && (
          <span className="rounded-full bg-muted px-2 py-0.5 text-[11px] font-bold tabular-nums text-muted-foreground">
            {p.itemCount}
          </span>
        )}
      </p>
      {clearBlock}
    </div>
  );

  const salon = layout.preset === "salon" && p.tables;
  const centerContent = salon ? (
    <>
      <div className="mb-3 grid grid-cols-2 gap-1 rounded-2xl bg-fg-6 p-1 xl:hidden">
        {(["carta", "mesas"] as const).map((t) => (
          <button
            key={t}
            type="button"
            onClick={() => setSalonTab(t)}
            className={cn(
              "flex h-10 items-center justify-center gap-2 rounded-xl text-sm font-bold transition",
              salonTab === t ? "bg-card text-foreground shadow-sm" : "text-muted-foreground",
            )}
          >
            {t === "carta" ? <Utensils size={15} /> : <LayoutGrid size={15} />}
            {t === "carta" ? "Carta" : "Mesas"}
          </button>
        ))}
      </div>
      <div className={cn(salonTab === "mesas" && "max-xl:hidden")}>{p.center}</div>
      <div className={cn("h-[60dvh] xl:hidden", salonTab === "carta" && "hidden")}>{p.tables}</div>
    </>
  ) : (
    p.center
  );

  return (
    <div
      className="pos-root relative flex h-[calc(100dvh-3.5rem-env(safe-area-inset-top))] flex-col overflow-hidden lg:h-dvh"
      style={{ ...accentVars(layout.accent), zoom: layout.fontScale !== 1 ? layout.fontScale : undefined }}
    >
      {/* Lleva la burbuja del asistente fuera del cobro: arriba de la barra en
          el celular y a la izquierda del carrito desde md. */}
      <style>{`
        @media (max-width: 767px) { html { --fab-lift: ${tabs ? 0 : 84}px; } }
        @media (min-width: 768px) { html { --fab-shift: ${left ? 0 : 396}px; } }
      `}</style>
      {p.topBar}
      {p.banners}

      {tabs && (
        <div className="mx-3 mb-2 grid shrink-0 grid-cols-2 gap-1 rounded-2xl bg-fg-6 p-1 md:hidden">
          <button
            type="button"
            onClick={() => setMobileTab("products")}
            className={cn("h-10 rounded-xl text-sm font-bold", mobileTab === "products" ? "bg-card shadow-sm" : "text-muted-foreground")}
          >
            Productos
          </button>
          <button
            type="button"
            onClick={() => setMobileTab("cart")}
            className={cn("h-10 rounded-xl text-sm font-bold", mobileTab === "cart" ? "bg-card shadow-sm" : "text-muted-foreground")}
          >
            Carrito {p.itemCount > 0 ? `· ${money(p.total)}` : ""}
          </button>
        </div>
      )}

      <div className={cn("flex min-h-0 flex-1 gap-3 px-3 pb-3 md:px-4 md:pb-4", left && "md:flex-row-reverse")}>
        {p.rail && (
          <aside className="hidden w-44 shrink-0 rounded-[24px] bg-card p-2 lg:block xl:w-52 xl:p-2.5">{p.rail}</aside>
        )}
        {salon && (
          <aside className="hidden w-[300px] shrink-0 rounded-[24px] bg-card p-3 xl:block">{p.tables}</aside>
        )}

        <main
          className={cn(
            "slim-scrollbar min-w-0 flex-1 overflow-y-auto overflow-x-hidden md:pb-2",
            tabs ? "pb-4" : "pb-28",
            tabs && mobileTab === "cart" && "max-md:hidden",
          )}
        >
          {centerContent}
        </main>

        {/* Carrito en el celular con pestañas */}
        {tabs && mobileTab === "cart" && (
          <section className="flex min-h-0 flex-1 flex-col md:hidden">
            {!p.linesInCenter && (
              <div className="slim-scrollbar min-h-0 flex-1 overflow-y-auto">{p.cartLines}</div>
            )}
            <div className="shrink-0 pt-2">{p.cartSummary}</div>
          </section>
        )}

        {/* Carrito lateral desde md */}
        <aside
          className={cn(
            "hidden min-h-0 shrink-0 flex-col overflow-hidden rounded-[26px] bg-card shadow-[0_20px_60px_-30px_rgba(0,0,0,0.6)] md:flex",
            p.linesInCenter ? "w-[330px] lg:w-[360px]" : "w-[330px] lg:w-[380px]",
          )}
        >
          {p.linesInCenter ? (
            <div className="slim-scrollbar flex min-h-0 flex-1 flex-col gap-3 overflow-y-auto p-3">
              {p.aside}
              <div className="mt-auto">{p.cartSummary}</div>
            </div>
          ) : (
            <>
              {cartHeader}
              <div className="slim-scrollbar min-h-[96px] flex-1 overflow-y-auto px-1.5">{p.cartLines}</div>
              <div className="slim-scrollbar max-h-[64%] shrink-0 overflow-y-auto border-t border-border p-3">
                {p.cartSummary}
              </div>
            </>
          )}
        </aside>
      </div>

      {/* Barra fija del carrito (celular) */}
      {!tabs && (
        <div className="pointer-events-none absolute inset-x-0 bottom-0 z-30 px-3 pb-[max(0.75rem,env(safe-area-inset-bottom))] md:hidden">
          <div className="pointer-events-auto flex items-center gap-2 rounded-[22px] bg-[color-mix(in_srgb,var(--popover)_92%,transparent)] p-2 shadow-[0_18px_50px_-12px_rgba(0,0,0,0.65)] ring-1 ring-border backdrop-blur-xl">
            <button
              type="button"
              onClick={() => setCartOpen(true)}
              className="flex min-w-0 flex-1 items-center gap-2.5 rounded-2xl px-2 py-1.5 text-left"
              aria-label="Ver carrito"
            >
              <span
                key={p.itemCount}
                className={cn(
                  "pos-pop grid h-10 min-w-10 shrink-0 place-items-center rounded-2xl px-2 font-price text-sm font-black tabular-nums",
                  p.itemCount > 0 ? POS_SELECTED : POS_IDLE,
                )}
              >
                {p.itemCount}
              </span>
              <span className="min-w-0">
                <span className="flex items-center gap-1 text-[11px] font-semibold text-muted-foreground">
                  {p.cartTitle} <ChevronUp size={12} />
                </span>
                <span className="block truncate font-price text-lg font-black leading-tight tabular-nums">
                  {money(p.total)}
                </span>
              </span>
            </button>
            <button
              type="button"
              disabled={!p.canCheckout}
              onClick={p.onCheckout}
              className={cn("h-12 shrink-0 rounded-2xl px-6 text-[15px] font-black", POS_CTA)}
            >
              Cobrar
            </button>
          </div>
        </div>
      )}

      <PosSheet
        open={cartOpen}
        onOpenChange={setCartOpen}
        title={p.cartTitle}
        style={accentVars(layout.accent)}
        className="md:hidden"
      >
        <div className="pr-12">{cartHeader}</div>
        {!p.linesInCenter && (
          <div className="slim-scrollbar min-h-0 flex-1 overflow-y-auto px-1.5">{p.cartLines}</div>
        )}
        <div className="shrink-0 border-t border-border p-3">{p.cartSummary}</div>
      </PosSheet>
    </div>
  );
}
