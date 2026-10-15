"use client";

import { useEffect, useState } from "react";
import { ChevronUp, LayoutGrid, ShoppingBag, Utensils } from "lucide-react";
import type { PosLayout } from "@/lib/pos/layout";
import { Segmented } from "@/components/ui/Segmented";
import { cn } from "@/lib/utils/cn";
import { PosSheet } from "../ui/PosSheet";
import { POS_CTA, POS_PANEL, accentVars, money } from "../ui/posStyles";

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
  const tabs = layout.mobileCart === "tabs";
  const left = layout.cartSide === "left";
  useEffect(() => {
    if (p.checkoutOpen) setCartOpen(false);
  }, [p.checkoutOpen]);
  // Venta pausada o limpiada (ADR-106): el POS queda listo para el siguiente.
  useEffect(() => {
    if (p.itemCount === 0) setCartOpen(false);
  }, [p.itemCount]);

  const cartHeader = (
    <div className="flex h-14 shrink-0 items-center justify-between gap-2 px-4">
      <p className="flex items-center gap-2 font-display text-base font-semibold tracking-tight">
        {p.cartTitle}
        {p.itemCount > 0 && (
          <span className="rounded-md bg-fg-6 px-1.5 py-0.5 text-xs font-semibold tabular-nums text-muted-foreground">
            {p.itemCount}
          </span>
        )}
      </p>
    </div>
  );

  const salon = layout.preset === "salon" && p.tables;
  const centerContent = salon ? (
    <>
      <div className="mb-3 xl:hidden">
        <Segmented
          fill
          aria-label="Vista del salón"
          value={salonTab}
          onChange={setSalonTab}
          options={[
            { value: "carta", label: "Carta", icon: <Utensils size={16} /> },
            { value: "mesas", label: "Mesas", icon: <LayoutGrid size={16} /> },
          ]}
          className="w-full"
        />
      </div>
      <div className={cn(salonTab === "mesas" && "max-xl:hidden")}>{p.center}</div>
      <div className={cn("h-[60dvh] xl:hidden", salonTab === "carta" && "hidden")}>{p.tables}</div>
    </>
  ) : (
    p.center
  );

  return (
    <div
      data-preset={layout.preset}
      data-checkout={layout.checkout.layout}
      className="pos-root relative flex h-[calc(100dvh-3.5rem-env(safe-area-inset-top))] flex-col overflow-hidden lg:h-dvh"
      style={{ ...accentVars(layout.accent), zoom: layout.fontScale !== 1 ? layout.fontScale : undefined }}
    >
      {/* Lleva la burbuja del asistente fuera del cobro: arriba de la barra en
          el celular y a la izquierda del carrito desde md. */}
      <style>{`
        @media (max-width: 767px) { html { --fab-lift: ${tabs ? 0 : 80}px; } }
        @media (min-width: 768px) { html { --fab-shift: ${left ? 0 : 396}px; } }
      `}</style>
      {p.topBar}
      {p.banners}

      {tabs && (
        <div className="mx-3 mb-2 shrink-0 md:hidden">
          <Segmented
            fill
            aria-label="Vista"
            value={mobileTab}
            onChange={setMobileTab}
            options={[
              { value: "products", label: "Productos" },
              { value: "cart", label: p.itemCount > 0 ? `${p.cartTitle} · ${money(p.total)}` : p.cartTitle },
            ]}
            className="w-full"
          />
        </div>
      )}

      <div className={cn("flex min-h-0 flex-1 gap-3 px-3 pb-3 md:px-4 md:pb-4", left && "md:flex-row-reverse")}>
        {p.rail && <aside className={cn("hidden w-48 shrink-0 p-2 xl:block 2xl:w-52", POS_PANEL)}>{p.rail}</aside>}
        {salon && <aside className={cn("hidden w-[300px] shrink-0 p-3 xl:block", POS_PANEL)}>{p.tables}</aside>}

        <main
          className={cn(
            "slim-scrollbar min-w-0 flex-1 overflow-y-auto overflow-x-hidden md:pb-2",
            // Sin pestañas, la barra fija del carrito (62px + su aire inferior,
            // que crece con el safe area) tapa el final: el último contenido
            // queda siempre visible arriba de la barra.
            tabs ? "pb-4" : "pb-[calc(6rem+env(safe-area-inset-bottom))]",
            tabs && mobileTab === "cart" && "max-md:hidden",
          )}
        >
          {centerContent}
        </main>

        {/* Carrito en el celular con pestañas */}
        {tabs && mobileTab === "cart" && (
          <section className="flex min-h-0 flex-1 flex-col md:hidden">
            {!p.linesInCenter && <div className="slim-scrollbar min-h-0 flex-1 overflow-y-auto">{p.cartLines}</div>}
            <div className="shrink-0 pt-2">{p.cartSummary}</div>
          </section>
        )}

        {/* Carrito lateral desde md */}
        <aside
          className={cn(
            "hidden min-h-0 shrink-0 flex-col overflow-hidden md:flex",
            POS_PANEL,
            p.linesInCenter ? "w-[330px] lg:w-[360px]" : "w-[330px] lg:w-[380px]",
          )}
          aria-label={p.cartTitle}
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
          <div className="pointer-events-auto flex items-center gap-2 rounded-xl border border-border bg-popover p-1.5">
            <button
              type="button"
              onClick={() => setCartOpen(true)}
              className="flex h-12 min-w-0 flex-1 items-center gap-2.5 rounded-lg px-2 text-left transition-colors hover:bg-fg-4"
              aria-label="Ver carrito"
            >
              <span className="relative grid h-9 w-9 shrink-0 place-items-center rounded-md bg-fg-6 text-muted-foreground">
                <ShoppingBag size={18} aria-hidden />
                {p.itemCount > 0 && (
                  <span
                    key={p.itemCount}
                    className="pos-pop absolute -right-1.5 -top-1.5 grid h-5 min-w-5 place-items-center rounded-md bg-[var(--pos-solid)] px-1 text-[11px] font-semibold tabular-nums text-[color:var(--pos-on)]"
                  >
                    {p.itemCount}
                  </span>
                )}
              </span>
              <span className="min-w-0">
                <span className="flex items-center gap-1 text-xs text-muted-foreground">
                  {p.cartTitle} <ChevronUp size={14} aria-hidden />
                </span>
                <span className="block truncate font-price text-base font-semibold leading-tight tabular-nums">
                  {money(p.total)}
                </span>
              </span>
            </button>
            <button
              type="button"
              disabled={!p.canCheckout}
              onClick={p.onCheckout}
              className={cn("h-12 shrink-0 rounded-lg px-6 text-base font-semibold", POS_CTA)}
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
        {!p.linesInCenter && <div className="slim-scrollbar min-h-0 flex-1 overflow-y-auto px-1.5">{p.cartLines}</div>}
        <div className="shrink-0 border-t border-border p-3">{p.cartSummary}</div>
      </PosSheet>
    </div>
  );
}
