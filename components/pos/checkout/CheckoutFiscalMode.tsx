"use client";

import { useEffect, useRef } from "react";
import { AlertTriangle, FileText, Receipt } from "lucide-react";
import { cn } from "@/lib/utils/cn";
import { isValidCuit } from "@/lib/tax/catalog";
import { toggleFiscalChoice, ticketOnlyWarnings, type FiscalChoice } from "@/lib/billing/ticketMode";
import { useCheckoutCustomerFiscal } from "@/modules/customers/checkoutFiscal";
import { useTaxSettings } from "@/modules/tax/hooks";

// Factura o sólo ticket en la hoja de cobro (ADR-155). Controlado: la hoja
// guarda la elección y el servidor la registra antes de crear la venta
// (sale_ticket_only_set). Shift + F9 alterna sin tocar la pantalla.
export function CheckoutFiscalMode({
  open,
  value,
  onChange,
  customerId,
  letter,
  total,
  offline = false,
}: {
  open: boolean;
  value: FiscalChoice | null;
  onChange: (v: FiscalChoice) => void;
  customerId: string | null;
  /** Letra que corresponde a la venta (la que muestra CheckoutLetter). */
  letter: string | null;
  total: number;
  offline?: boolean;
}) {
  const tax = useTaxSettings(open);
  const cust = useCheckoutCustomerFiscal(customerId, open);
  const c = customerId ? cust.data : null;
  const hasCuit = c?.document_type === "cuit" && isValidCuit(c?.document_number);

  // Atajo: Shift + F9 con la hoja abierta (y sin otro diálogo encima).
  const valueRef = useRef(value);
  valueRef.current = value;
  const onChangeRef = useRef(onChange);
  onChangeRef.current = onChange;
  useEffect(() => {
    if (!open || offline) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "F9" || !e.shiftKey || e.ctrlKey || e.metaKey || e.altKey || e.repeat) return;
      const dialogs = document.querySelectorAll('[role="dialog"][data-state="open"], [role="alertdialog"][data-state="open"]');
      if (dialogs.length > 1) return;
      e.preventDefault();
      onChangeRef.current(toggleFiscalChoice(valueRef.current));
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, offline]);

  const warnings =
    value === "ticket"
      ? ticketOnlyWarnings({
          letter,
          hasCuit: Boolean(hasCuit),
          total,
          cfThreshold: tax.data?.cf_id_threshold ?? null,
          hasCustomer: Boolean(customerId),
        })
      : [];

  const opts: { v: FiscalChoice; label: string; icon: typeof Receipt }[] = [
    { v: "factura", label: letter ? `Factura ${letter}` : "Factura", icon: FileText },
    { v: "ticket", label: "Sólo ticket", icon: Receipt },
  ];

  return (
    <div className="mt-3 text-[13px]" data-testid="checkout-fiscal-mode">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <span className="font-medium text-muted-foreground">Comprobante</span>
        <div role="radiogroup" aria-label="Factura o sólo ticket" aria-keyshortcuts="Shift+F9" className="inline-flex rounded-lg bg-fg-4 p-0.5">
          {opts.map((o) => {
            const on = value === o.v;
            const Icon = o.icon;
            return (
              <button
                key={o.v}
                type="button"
                role="radio"
                aria-checked={on}
                disabled={offline}
                onClick={() => onChange(o.v)}
                title="Shift + F9 alterna"
                className={cn(
                  "inline-flex h-8 items-center gap-1.5 whitespace-nowrap rounded-md px-3 font-medium transition-colors",
                  "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
                  on ? "choice-on" : "text-muted-foreground hover:text-foreground",
                  offline && "cursor-not-allowed opacity-60",
                )}
              >
                <Icon size={14} aria-hidden /> {o.label}
              </button>
            );
          })}
        </div>
      </div>
      {offline ? (
        <p className="mt-1 text-xs text-muted-foreground">Sin conexión la venta sale con factura cuando se sincroniza.</p>
      ) : value === null ? (
        <p className="mt-1 text-xs font-medium text-warning" role="status">
          Elegí Factura o Sólo ticket para cobrar (Shift + F9).
        </p>
      ) : value === "ticket" ? (
        <div className="mt-1 space-y-0.5 text-xs">
          <p className="text-muted-foreground">Ticket no fiscal: esta venta no va a ARCA. Si después hace falta, se factura desde la venta.</p>
          {warnings.map((w) => (
            <p key={w.code} className="flex items-start gap-1 text-warning">
              <AlertTriangle size={12} className="mt-0.5 shrink-0" aria-hidden /> {w.text}
            </p>
          ))}
        </div>
      ) : null}
    </div>
  );
}
CheckoutFiscalMode.displayName = "CheckoutFiscalMode";
