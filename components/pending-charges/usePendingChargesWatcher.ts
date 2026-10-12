"use client";

import { useEffect, useMemo, useRef } from "react";
import { useToast } from "@/components/ui/Toast";
import { formatCurrency } from "@/lib/utils/format";
import { usePendingChargeMutations, usePendingCharges, usePendingChargesSync } from "@/modules/pending-charges/hooks";
import { effectiveStatus } from "@/modules/pending-charges/logic";

// Aviso en el POS cuando un cobro en espera de la sucursal se acredita
// (ADR-048): toast con "Imprimir ticket" / "Emitir factura" / "Visto". El
// "visto" es del cobro (lo deja de avisar en todos los POS de la sucursal).
// También sondea los cobros abiertos contra el proveedor mientras el POS está
// abierto y devuelve el contador para el botón de la barra.

const SEEN_KEY = "pc_toasted";

function seenSet(): Set<string> {
  try {
    return new Set(JSON.parse(sessionStorage.getItem(SEEN_KEY) ?? "[]") as string[]);
  } catch {
    return new Set();
  }
}

export function usePendingChargesWatcher(opts: {
  storeId: string | null;
  enabled: boolean;
  onPrint: (saleId: string) => void;
  onInvoice: (saleId: string) => void;
  onOpen: (id: string) => void;
}) {
  const { toast } = useToast();
  const { ack } = usePendingChargeMutations();
  const since = useMemo(() => new Date(Date.now() - 24 * 3600_000).toISOString(), []);
  const { data } = usePendingCharges(
    { storeId: opts.storeId, statuses: ["waiting", "paid", "completed"], since: null, limit: 100 },
    opts.enabled && Boolean(opts.storeId),
  );
  const open = useMemo(
    () => (data ?? []).filter((c) => c.status === "waiting" || c.status === "paid"),
    [data],
  );
  usePendingChargesSync(open, opts.enabled);

  const optsRef = useRef(opts);
  optsRef.current = opts;

  useEffect(() => {
    if (!data) return;
    const seen = seenSet();
    let changed = false;
    for (const c of data) {
      const fresh = c.completed_at && c.completed_at >= since;
      if (c.status === "completed" && fresh && !c.acknowledged_at && c.sale_id && !seen.has(c.id)) {
        seen.add(c.id);
        changed = true;
        const saleId = c.sale_id;
        toast({
          title: `Cobro acreditado${c.sale_number != null ? `: venta #${c.sale_number}` : ""}`,
          description: `${formatCurrency(c.paid_amount ?? c.amount)}${c.customer_name ? ` de ${c.customer_name}` : ""}`,
          variant: "success",
          duration: 20_000,
          actions: [
            {
              label: "Imprimir ticket",
              onClick: () => {
                ack.mutate(c.id);
                optsRef.current.onPrint(saleId);
              },
            },
            {
              label: "Emitir factura",
              onClick: () => {
                ack.mutate(c.id);
                optsRef.current.onInvoice(saleId);
              },
            },
            { label: "Visto", onClick: () => ack.mutate(c.id) },
          ],
        });
      } else if (c.status === "paid" && c.needs_review && !seen.has(`r:${c.id}`)) {
        seen.add(`r:${c.id}`);
        changed = true;
        toast({
          title: "Un cobro en espera necesita revisión",
          description: `${formatCurrency(c.paid_amount ?? c.amount)}${c.customer_name ? ` de ${c.customer_name}` : ""}`,
          variant: "info",
          duration: 20_000,
          actions: [{ label: "Ver", onClick: () => optsRef.current.onOpen(c.id) }],
        });
      }
    }
    if (changed) {
      try {
        sessionStorage.setItem(SEEN_KEY, JSON.stringify([...seen].slice(-300)));
      } catch {
        /* sin storage: puede repetir el aviso, no rompe */
      }
    }
  }, [data, since, toast, ack]);

  const waiting = open.filter((c) => effectiveStatus(c) === "waiting").length;
  const attention = open.filter((c) => c.status === "paid").length;
  const unseen = (data ?? []).filter(
    (c) => c.status === "completed" && !c.acknowledged_at && c.completed_at && c.completed_at >= since,
  ).length;
  return { waiting, attention, unseen, open };
}
