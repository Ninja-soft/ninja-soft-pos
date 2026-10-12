"use client";

import * as Dialog from "@radix-ui/react-dialog";
import { X } from "lucide-react";
import { cn } from "@/lib/utils/cn";

// Modal sólido sobre Radix Dialog. Ver UI-NinjaSof.md §23.
// En mobile (<640px) se presenta como hoja inferior (estilo iOS) con safe
// area; desde sm es un diálogo centrado. `footer` queda fijo abajo, fuera
// del scroll, para que las acciones siempre estén a mano.
interface ModalProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  title?: string;
  description?: string;
  children?: React.ReactNode;
  footer?: React.ReactNode;
  className?: string;
}

export function Modal({
  open,
  onOpenChange,
  title,
  description,
  children,
  footer,
  className,
}: ModalProps) {
  return (
    <Dialog.Root open={open} onOpenChange={onOpenChange}>
      <Dialog.Portal>
        <Dialog.Overlay className="fixed inset-0 z-50 bg-black/55 backdrop-blur-[3px] data-[state=open]:animate-overlay-in data-[state=closed]:animate-overlay-out" />
        <Dialog.Content
          className={cn(
            // Mobile: hoja inferior.
            "fixed inset-x-0 bottom-0 z-50 mx-auto flex max-h-[92dvh] w-full max-w-lg flex-col overflow-hidden rounded-t-[22px] border border-b-0 border-border bg-popover text-popover-foreground shadow-ninjaSoft outline-none data-[state=open]:animate-sheet-in data-[state=closed]:animate-sheet-out",
            // Desde sm: diálogo centrado.
            "sm:inset-x-auto sm:bottom-auto sm:left-1/2 sm:top-1/2 sm:mx-0 sm:w-[calc(100%-2rem)] sm:-translate-x-1/2 sm:-translate-y-1/2 sm:rounded-[20px] sm:border-b sm:data-[state=open]:animate-modal-in sm:data-[state=closed]:animate-modal-out",
            className,
          )}
        >
          {/* Grabber de hoja (sólo mobile). */}
          <span
            aria-hidden
            className="mx-auto mt-2 h-1 w-9 shrink-0 rounded-full bg-muted-foreground/30 sm:hidden"
          />
          {(title || description) && (
            <div className="shrink-0 border-b border-border px-5 pb-4 pt-3 pr-12 sm:px-6 sm:pt-4">
              {title && (
                <Dialog.Title className="text-lg font-bold tracking-tight">
                  {title}
                </Dialog.Title>
              )}
              {description && (
                <Dialog.Description className="mt-1 text-sm text-muted-foreground">
                  {description}
                </Dialog.Description>
              )}
            </div>
          )}
          {/* Descripción accesible siempre presente (evita warning de Radix). */}
          {!description && (
            <Dialog.Description className="sr-only">
              {title ?? "Diálogo"}
            </Dialog.Description>
          )}
          <div
            className={cn(
              "min-h-0 flex-1 overflow-y-auto overscroll-contain p-5 sm:p-6",
              !footer && "pb-[calc(1.25rem+env(safe-area-inset-bottom))] sm:pb-6",
            )}
          >
            {children}
          </div>
          {footer && (
            <div className="flex shrink-0 flex-col-reverse gap-2 border-t border-border bg-popover px-5 pb-[calc(1rem+env(safe-area-inset-bottom))] pt-3 sm:flex-row sm:justify-end sm:px-6 sm:pb-4 [&>*]:w-full sm:[&>*]:w-auto">
              {footer}
            </div>
          )}
          <Dialog.Close
            className="absolute right-3 top-3 grid h-8 w-8 place-items-center rounded-full bg-muted text-muted-foreground transition hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring sm:top-3.5"
            aria-label="Cerrar"
          >
            <X size={16} />
          </Dialog.Close>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}

export const ModalTrigger = Dialog.Trigger;
