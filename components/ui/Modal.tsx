"use client";

import * as Dialog from "@radix-ui/react-dialog";
import { X } from "lucide-react";
import { cn } from "@/lib/utils/cn";

// Modal sólido sobre Radix Dialog. Ver UI-NinjaSof.md §23.
interface ModalProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  title?: string;
  description?: string;
  children?: React.ReactNode;
  className?: string;
}

export function Modal({
  open,
  onOpenChange,
  title,
  description,
  children,
  className,
}: ModalProps) {
  return (
    <Dialog.Root open={open} onOpenChange={onOpenChange}>
      <Dialog.Portal>
        <Dialog.Overlay className="fixed inset-0 z-50 bg-black/60 backdrop-blur-sm data-[state=open]:animate-fade-in" />
        <Dialog.Content
          className={cn(
            "fixed left-1/2 top-1/2 z-50 w-full max-w-lg -translate-x-1/2 -translate-y-1/2 rounded-ninjaXl border border-border bg-popover p-6 text-popover-foreground shadow-ninjaSoft data-[state=open]:animate-slide-up",
            className,
          )}
        >
          {title && (
            <Dialog.Title className="font-display text-xl font-bold tracking-tight">
              {title}
            </Dialog.Title>
          )}
          {description && (
            <Dialog.Description className="mt-1 text-sm text-muted-foreground">
              {description}
            </Dialog.Description>
          )}
          <div className={cn(title || description ? "mt-4" : undefined)}>
            {children}
          </div>
          <Dialog.Close
            className="absolute right-4 top-4 rounded-ninjaSm p-1 text-muted-foreground transition hover:bg-secondary/60 hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
            aria-label="Cerrar"
          >
            <X size={18} />
          </Dialog.Close>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}

export const ModalTrigger = Dialog.Trigger;
