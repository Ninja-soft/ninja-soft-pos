"use client";

import * as ToastPrimitive from "@radix-ui/react-toast";
import { createContext, useCallback, useContext, useState } from "react";
import { cn } from "@/lib/utils/cn";

// Sistema de toasts sobre Radix Toast. Ver UI-NinjaSof.md §34.
type ToastVariant = "success" | "error" | "info";

interface ToastItem {
  id: number;
  title: string;
  description?: string;
  variant: ToastVariant;
}

interface ToastInput {
  title: string;
  description?: string;
  variant?: ToastVariant;
}

interface ToastContextValue {
  toast: (input: ToastInput) => void;
}

const ToastContext = createContext<ToastContextValue | null>(null);

const variantStyles: Record<ToastVariant, string> = {
  success: "border-emerald-400/20 bg-emerald-400/10 text-emerald-200",
  error: "border-red-400/20 bg-red-400/10 text-red-200",
  info: "border-border bg-card text-card-foreground",
};

let nextId = 0;

export function ToastProvider({ children }: { children: React.ReactNode }) {
  const [items, setItems] = useState<ToastItem[]>([]);

  const toast = useCallback((input: ToastInput) => {
    const id = nextId++;
    setItems((prev) => [
      ...prev,
      { id, variant: "info", ...input },
    ]);
  }, []);

  const remove = useCallback((id: number) => {
    setItems((prev) => prev.filter((t) => t.id !== id));
  }, []);

  return (
    <ToastContext.Provider value={{ toast }}>
      <ToastPrimitive.Provider swipeDirection="right" duration={4000}>
        {children}
        {items.map((item) => (
          <ToastPrimitive.Root
            key={item.id}
            onOpenChange={(open) => {
              if (!open) remove(item.id);
            }}
            className={cn(
              "rounded-ninjaLg border px-4 py-3 text-sm shadow-ninjaSoft backdrop-blur-xl data-[state=open]:animate-slide-up",
              variantStyles[item.variant],
            )}
          >
            <ToastPrimitive.Title className="font-semibold">
              {item.title}
            </ToastPrimitive.Title>
            {item.description && (
              <ToastPrimitive.Description className="mt-1 opacity-80">
                {item.description}
              </ToastPrimitive.Description>
            )}
          </ToastPrimitive.Root>
        ))}
        <ToastPrimitive.Viewport className="fixed bottom-0 right-0 z-[100] flex w-full max-w-sm flex-col gap-2 p-4 outline-none" />
      </ToastPrimitive.Provider>
    </ToastContext.Provider>
  );
}

export function useToast(): ToastContextValue {
  const ctx = useContext(ToastContext);
  if (!ctx) {
    throw new Error("useToast debe usarse dentro de <ToastProvider>");
  }
  return ctx;
}
