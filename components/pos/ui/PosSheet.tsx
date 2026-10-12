"use client";

import * as Dialog from "@radix-ui/react-dialog";
import { X } from "lucide-react";
import { cn } from "@/lib/utils/cn";

// Hoja del POS: en el celular sube desde abajo (bottom sheet con asa, alto en
// dvh y respeta el área segura); desde md es un panel centrado. La usan el
// cobro (CheckoutSheet) y el carrito en mobile.
export function PosSheet({
  open,
  onOpenChange,
  title,
  description,
  size = "md",
  hideClose,
  onRequestClose,
  focusContainer,
  className,
  style,
  children,
}: {
  open: boolean;
  onOpenChange: (o: boolean) => void;
  title: string;
  description?: string;
  size?: "md" | "xl";
  hideClose?: boolean;
  /** Si se pasa, cerrar (Esc, afuera, X) llama a esto en vez de cerrar. */
  onRequestClose?: () => void;
  /**
   * Al abrir, el foco va al contenedor y no al primer botón (evita que el
   * primer medio de cobro aparezca con el anillo de foco como si estuviera
   * elegido). Tab sigue recorriendo la hoja desde el principio.
   */
  focusContainer?: boolean;
  className?: string;
  style?: React.CSSProperties;
  children: React.ReactNode;
}) {
  const intercept = (e: Event) => {
    if (onRequestClose) {
      e.preventDefault();
      onRequestClose();
    }
  };
  return (
    <Dialog.Root open={open} onOpenChange={onOpenChange}>
      <Dialog.Portal>
        <Dialog.Overlay className="fixed inset-0 z-50 bg-black/50 backdrop-blur-[2px] data-[state=open]:animate-overlay-in data-[state=closed]:animate-overlay-out" />
        <Dialog.Content
          onEscapeKeyDown={intercept}
          onPointerDownOutside={intercept}
          onOpenAutoFocus={
            focusContainer
              ? (e) => {
                  e.preventDefault();
                  (e.currentTarget as HTMLElement | null)?.focus();
                }
              : undefined
          }
          style={style}
          className={cn(
            "pos-sheet fixed z-50 flex flex-col overflow-hidden border-border bg-popover text-popover-foreground shadow-[0_-12px_40px_-16px_rgba(0,0,0,0.45)] outline-none max-md:border-t md:border",
            // Mobile: bottom sheet.
            "inset-x-0 bottom-0 max-h-[94dvh] rounded-t-xl pb-[env(safe-area-inset-bottom)]",
            // Desde md: panel centrado.
            "md:inset-auto md:left-1/2 md:top-1/2 md:max-h-[min(92dvh,860px)] md:w-[calc(100%-3rem)] md:-translate-x-1/2 md:-translate-y-1/2 md:rounded-xl md:pb-0",
            size === "xl" ? "md:max-w-5xl" : "md:max-w-lg",
            className,
          )}
        >
          <div className="mx-auto mt-2 h-1 w-9 shrink-0 rounded-full bg-muted-foreground opacity-40 md:hidden" aria-hidden />
          <Dialog.Title className="sr-only">{title}</Dialog.Title>
          <Dialog.Description className="sr-only">{description ?? title}</Dialog.Description>
          {children}
          {!hideClose && (
            <button
              type="button"
              onClick={() => (onRequestClose ? onRequestClose() : onOpenChange(false))}
              className="absolute right-2.5 top-2.5 grid h-10 w-10 place-items-center rounded-lg text-muted-foreground transition-colors hover:bg-fg-6 hover:text-foreground"
              aria-label="Cerrar"
            >
              <X size={18} aria-hidden />
            </button>
          )}
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
