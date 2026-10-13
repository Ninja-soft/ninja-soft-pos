"use client";

import * as ToastPrimitive from "@radix-ui/react-toast";
import { createContext, useCallback, useContext, useState } from "react";
import { AlertTriangle, CheckCircle2, Info, X, XCircle } from "lucide-react";
import { cn } from "@/lib/utils/cn";

type ToastVariant = "success" | "error" | "warning" | "info";

// Acción del aviso (p. ej. "Imprimir ticket"). Cierra el aviso al tocarla.
export interface ToastAction {
  label: string;
  onClick: () => void;
}
interface ToastItem {
  id: number;
  title: string;
  description?: string;
  variant: ToastVariant;
  actions?: ToastAction[];
  duration?: number;
}
interface ToastInput {
  title: string;
  description?: string;
  variant?: ToastVariant;
  actions?: ToastAction[];
  /** ms visible (por defecto 4 s; con acciones conviene más). */
  duration?: number;
}
interface ToastContextValue {
  toast: (input: ToastInput) => void;
}

const ToastContext = createContext<ToastContextValue | null>(null);

const VARIANT = {
  success: {
    icon: CheckCircle2,
    iconCls: "text-success",
  },
  error: { icon: XCircle, iconCls: "text-danger" },
  warning: { icon: AlertTriangle, iconCls: "text-warning" },
  info: { icon: Info, iconCls: "text-ninja-flameSoft" },
} as const;

let nextId = 0;

export function ToastProvider({ children }: { children: React.ReactNode }) {
  const [items, setItems] = useState<ToastItem[]>([]);

  const toast = useCallback((input: ToastInput) => {
    const id = nextId++;
    setItems((prev) => [...prev, { id, variant: "info", ...input }]);
  }, []);

  const remove = useCallback((id: number) => {
    setItems((prev) => prev.filter((t) => t.id !== id));
  }, []);

  return (
    <ToastContext.Provider value={{ toast }}>
      <ToastPrimitive.Provider swipeDirection="right" duration={4000}>
        {children}
        {items.map((item) => {
          const v = VARIANT[item.variant];
          const Icon = v.icon;
          return (
            <ToastPrimitive.Root
              key={item.id}
              // Errores y advertencias: más tiempo en pantalla y anunciados
              // de inmediato por el lector (foreground = aria-live assertive).
              duration={item.duration ?? (item.variant === "error" || item.variant === "warning" ? 7000 : undefined)}
              type={item.variant === "error" || item.variant === "warning" ? "foreground" : "background"}
              onOpenChange={(open) => !open && remove(item.id)}
              className={cn(
                "group pointer-events-auto flex items-start gap-3 rounded-lg border border-border bg-popover/95 p-3.5 pr-9 text-popover-foreground backdrop-blur-xl",
                "data-[state=open]:animate-slide-up data-[swipe=move]:translate-x-[var(--radix-toast-swipe-move-x)] data-[swipe=cancel]:translate-x-0 data-[swipe=cancel]:transition-transform",
              )}
            >
              <Icon size={18} className={cn("mt-0.5 shrink-0", v.iconCls)} />
              <div className="min-w-0">
                <ToastPrimitive.Title className="text-sm font-semibold">
                  {item.title}
                </ToastPrimitive.Title>
                {item.description && (
                  <ToastPrimitive.Description className="mt-0.5 text-sm text-muted-foreground">
                    {item.description}
                  </ToastPrimitive.Description>
                )}
                {item.actions && item.actions.length > 0 && (
                  <div className="mt-2 flex flex-wrap gap-1.5">
                    {item.actions.map((a) => (
                      <ToastPrimitive.Action key={a.label} altText={a.label} asChild>
                        <button
                          type="button"
                          onClick={a.onClick}
                          className="rounded-md bg-ninja-flame/15 px-2.5 py-1 text-xs font-semibold text-ninja-flameSoft transition hover:bg-ninja-flame/25"
                        >
                          {a.label}
                        </button>
                      </ToastPrimitive.Action>
                    ))}
                  </div>
                )}
              </div>
              <ToastPrimitive.Close
                className="absolute right-2.5 top-2.5 rounded-md p-1 text-muted-foreground transition hover:bg-muted hover:text-foreground"
                aria-label="Cerrar"
              >
                <X size={14} />
              </ToastPrimitive.Close>
            </ToastPrimitive.Root>
          );
        })}
        <ToastPrimitive.Viewport className="fixed bottom-0 right-0 z-[100] flex w-full max-w-sm flex-col gap-2.5 p-4 outline-none" />
      </ToastPrimitive.Provider>
    </ToastContext.Provider>
  );
}

export function useToast(): ToastContextValue {
  const ctx = useContext(ToastContext);
  if (!ctx) throw new Error("useToast debe usarse dentro de <ToastProvider>");
  return ctx;
}
