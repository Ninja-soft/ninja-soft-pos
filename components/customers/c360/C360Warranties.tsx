"use client";

import { ShieldCheck } from "lucide-react";
import { Badge } from "@/components/ui/Badge";
import { todayAr } from "@/lib/catalog/mode";
import { formatCurrency } from "@/lib/utils/format";
import { formatDateAr, monthsLabel } from "@/lib/warranty/pricing";
import { warrantyStatus } from "@/lib/warranty/ticket";
import { useFeature } from "@/modules/saas/gating";
import { useCustomerWarranties } from "@/modules/warranty/hooks";

const TONE = { vigente: "success", vencida: "neutral", anulada: "danger" } as const;
const LABEL = { vigente: "Vigente", vencida: "Vencida", anulada: "Anulada" } as const;

// Garantías extendidas compradas por el cliente (ADR-139): qué cubren, de qué
// venta salieron y hasta cuándo. Sin garantías vendidas, no se muestra.
export function C360Warranties({ customerId }: { customerId: string }) {
  const feature = useFeature("garantias");
  const { data } = useCustomerWarranties(customerId, feature === true);
  const rows = (data ?? []).filter((w) => w.warranty_expires_on);
  if (rows.length === 0) return null;
  const today = todayAr();
  return (
    <section className="rounded-xl border border-border bg-card p-4" aria-labelledby="c360-warranties">
      <h2 id="c360-warranties" className="flex items-center gap-2 text-sm font-semibold">
        <ShieldCheck size={15} className="text-muted-foreground" aria-hidden /> Garantías extendidas
      </h2>
      <ul className="mt-3 space-y-2">
        {rows.map((w) => {
          const returned = Number(w.returned_qty) > 0;
          const st = warrantyStatus(w.warranty_expires_on, today, w.sale.status === "voided" || returned);
          return (
            <li key={w.id} className="flex items-start justify-between gap-3 rounded-lg bg-muted/40 px-3 py-2.5">
              <div className="min-w-0">
                <p className="truncate text-sm font-medium text-foreground">
                  {w.covered?.product_name ?? "Producto"}
                  {w.covered?.serial ? <span className="text-muted-foreground"> · {w.covered.serial}</span> : null}
                </p>
                <p className="text-xs text-muted-foreground">
                  {w.product_name}
                  {w.warranty_months ? ` (+${monthsLabel(w.warranty_months)})` : ""} · venta
                  {w.sale.number != null ? ` #${w.sale.number}` : ""} del {formatDateAr(todayAr(new Date(w.sale.created_at)))}
                </p>
                <p className="text-xs text-muted-foreground">
                  {st === "vigente" ? "Cubre hasta el " : "Hasta el "}
                  {formatDateAr(w.warranty_expires_on)} · {formatCurrency(Number(w.subtotal) || 0)}
                </p>
              </div>
              <Badge tone={TONE[st]}>{LABEL[st]}</Badge>
            </li>
          );
        })}
      </ul>
    </section>
  );
}
