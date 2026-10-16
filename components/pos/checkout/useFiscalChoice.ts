"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { useToast } from "@/components/ui/Toast";
import { useArcaStatus } from "@/modules/arca/hooks";
import { arcaApi } from "@/modules/arca/api";
import {
  fiscalChoiceBlocker,
  initialFiscalChoice,
  isTicketMode,
  ticketOnlyErrorMessage,
  type FiscalChoice,
} from "@/lib/billing/ticketMode";
import type { CheckoutSheetProps } from "./CheckoutSheet";

type Confirm = CheckoutSheetProps["onConfirm"];

/**
 * Factura o sólo ticket en la hoja de cobro (ADR-155). Sólo aparece si el
 * negocio factura con ARCA y la base tiene la migración (arca_status trae
 * ticket_mode); arranca con el modo del negocio cada vez que se abre la hoja.
 * Al confirmar con "Sólo ticket" registra la elección en el servidor ANTES de
 * crear la venta (el trigger de sales la aplica a esa venta). Si no se puede,
 * la venta sale con factura: nunca se pierde un cobro ya hecho.
 */
export function useFiscalChoice({
  open,
  offline,
  customerId,
  onConfirm,
}: {
  open: boolean;
  offline: boolean;
  customerId: string | null;
  onConfirm: Confirm;
}) {
  const { toast } = useToast();
  const status = useArcaStatus(open);
  const mode = status.data?.enabled && isTicketMode(status.data.ticket_mode) ? status.data.ticket_mode : null;
  const visible = mode !== null;
  const [choice, setChoice] = useState<FiscalChoice | null>("factura");
  useEffect(() => {
    if (open) setChoice(initialFiscalChoice(mode));
  }, [open, mode]);

  // Hay una elección "sólo ticket" registrada en el servidor sin usar: se
  // descarta al cerrar la hoja (si la venta salió, ya se usó y no pasa nada).
  const pending = useRef(false);
  useEffect(() => {
    if (!open && pending.current) {
      pending.current = false;
      void arcaApi.ticketOnlyClear().catch(() => undefined);
    }
  }, [open]);

  const active = visible && !offline;
  const ticketOnly = active && choice === "ticket";
  const commitBlocker = active ? fiscalChoiceBlocker(true, choice) : null;
  // Doble toque mientras se registra: se descarta (create_sale tiene su
  // propia guarda en usePosSale).
  const registering = useRef(false);

  const confirm = useCallback<Confirm>(
    (payments, extras, change, promo) => {
      if (!active || (!ticketOnly && !pending.current)) {
        onConfirm(payments, extras, change, promo);
        return;
      }
      if (registering.current) return;
      registering.current = true;
      void (async () => {
        try {
          if (ticketOnly) {
            await arcaApi.ticketOnlySet(customerId);
            pending.current = true;
          } else {
            await arcaApi.ticketOnlyClear();
            pending.current = false;
          }
        } catch (e) {
          toast(
            ticketOnly
              ? {
                  title: "La venta sale con factura",
                  description: ticketOnlyErrorMessage(e instanceof Error ? e.message : ""),
                  variant: "error",
                }
              : {
                  title: "No se pudo confirmar la factura",
                  description: "Revisá la venta en Ventas: si salió sin factura, la hacés desde ahí.",
                  variant: "error",
                },
          );
        }
        registering.current = false;
        onConfirm(payments, extras, change, promo);
      })();
    },
    [active, ticketOnly, customerId, onConfirm, toast],
  );

  return { visible, choice, setChoice, ticketOnly, commitBlocker, onConfirm: confirm };
}
