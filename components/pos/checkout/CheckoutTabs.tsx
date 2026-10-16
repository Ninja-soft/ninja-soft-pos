"use client";

import { createContext, useCallback, useContext, useMemo, useState } from "react";
import { CreditCard, Truck, UserRound, type LucideIcon } from "lucide-react";
import { cn } from "@/lib/utils/cn";

// Pestañas de la hoja de cobro (ADR-157, R3 de ADR-149): Pago / Cliente /
// Envío. La hoja (CheckoutSheet) tiene la pestaña activa y un contenedor fijo
// por pestaña; los bloques Cliente y Entrega (CheckoutFold con `tab`) se
// registran, dejan en Pago su renglón resumen (tocarlo abre la pestaña) y
// mandan su contenido al contenedor de su pestaña. El cobro rápido no cambia:
// si nadie toca las pestañas, todo queda como antes.

export type CheckoutTab = "pago" | "cliente" | "envio";
export type CheckoutSideTab = Exclude<CheckoutTab, "pago">;

export interface CheckoutTabsValue {
  tab: CheckoutTab;
  setTab: (t: CheckoutTab) => void;
  /** Contenedor de cada pestaña (siempre montado: lo que vive adentro no se pierde al cambiar). */
  panels: Partial<Record<CheckoutSideTab, HTMLElement>>;
  /** Un bloque avisa que existe y si tiene algo pendiente. Devuelve la baja. */
  register: (t: CheckoutSideTab, warning: boolean) => () => void;
}

const Ctx = createContext<CheckoutTabsValue | null>(null);

export const CheckoutTabsProvider = Ctx.Provider;

/** null fuera de la hoja de cobro (el bloque se comporta como plegable). */
export function useCheckoutTabs(): CheckoutTabsValue | null {
  return useContext(Ctx);
}

export const TAB_META: Record<CheckoutTab, { label: string; icon: LucideIcon }> = {
  pago: { label: "Pago", icon: CreditCard },
  cliente: { label: "Cliente", icon: UserRound },
  envio: { label: "Envío", icon: Truck },
};

const ORDER: CheckoutTab[] = ["pago", "cliente", "envio"];

/** Estado de las pestañas para la hoja (registro de bloques y contenedores). */
export function useCheckoutTabsState() {
  const [tab, setTab] = useState<CheckoutTab>("pago");
  const [panels, setPanels] = useState<Partial<Record<CheckoutSideTab, HTMLElement>>>({});
  const [registered, setRegistered] = useState<Partial<Record<CheckoutSideTab, boolean>>>({});

  const register = useCallback((t: CheckoutSideTab, warning: boolean) => {
    setRegistered((r) => (r[t] === warning ? r : { ...r, [t]: warning }));
    return () =>
      setRegistered((r) => {
        if (!(t in r)) return r;
        const next = { ...r };
        delete next[t];
        return next;
      });
  }, []);

  const panelRef = useCallback(
    (t: CheckoutSideTab) => (el: HTMLElement | null) => {
      if (el) setPanels((p) => (p[t] === el ? p : { ...p, [t]: el }));
    },
    [],
  );

  const tabs = useMemo(() => ORDER.filter((t) => t === "pago" || t in registered), [registered]);
  // Si se va el bloque de la pestaña abierta, volvemos a Pago.
  const current: CheckoutTab = tabs.includes(tab) ? tab : "pago";
  const value = useMemo<CheckoutTabsValue>(() => ({ tab: current, setTab, panels, register }), [current, panels, register]);
  return { value, tabs, registered, panelRef, tab: current, setTab };
}

export function CheckoutTabBar({
  tabs,
  tab,
  warnings,
  onTab,
}: {
  tabs: CheckoutTab[];
  tab: CheckoutTab;
  warnings: Partial<Record<CheckoutSideTab, boolean>>;
  onTab: (t: CheckoutTab) => void;
}) {
  return (
    <div role="tablist" aria-label="Cobro" className="flex shrink-0 gap-1 px-3 pb-1 pr-14 pt-2.5 md:px-5 md:pt-4">
      {tabs.map((t) => {
        const { label, icon: Icon } = TAB_META[t];
        const on = t === tab;
        const warn = t !== "pago" && warnings[t];
        return (
          <button
            key={t}
            type="button"
            role="tab"
            id={`checkout-tab-${t}`}
            aria-selected={on}
            aria-controls={`checkout-panel-${t}`}
            onClick={() => onTab(t)}
            className={cn(
              "relative inline-flex h-9 min-w-0 flex-1 items-center justify-center gap-1.5 rounded-lg px-2.5 text-[13px] font-semibold transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring sm:flex-none sm:px-3.5",
              on ? "bg-fg-6 text-foreground" : "text-muted-foreground hover:text-foreground",
            )}
          >
            <Icon size={15} aria-hidden className="shrink-0" />
            <span className="truncate">{label}</span>
            {warn && (
              <span className="h-1.5 w-1.5 shrink-0 rounded-full bg-warning" aria-label="Falta completar" role="img" />
            )}
          </button>
        );
      })}
    </div>
  );
}
CheckoutTabBar.displayName = "CheckoutTabBar";
