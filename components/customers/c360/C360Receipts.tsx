"use client";

import { useMemo, useState } from "react";
import { Eye, Mail, Printer, Receipt } from "lucide-react";
import { Button } from "@/components/ui/Button";
import { Badge } from "@/components/ui/Badge";
import { TicketModal } from "@/components/sales/TicketModal";
import { formatCurrency } from "@/lib/utils/format";
import { mergePages } from "@/lib/customers/c360";
import { useCustomer360Timeline, type TimelineFilters } from "@/modules/customers/c360";

const when = (iso: string) =>
  new Date(iso).toLocaleString("es-AR", { day: "2-digit", month: "2-digit", year: "numeric", hour: "2-digit", minute: "2-digit" });

type Action = { saleId: string; startWith?: "print" | "email" };

// Comprobantes del cliente (ADR-169): cada venta con Ver, Reimprimir y
// Reenviar por email. Reusa el detalle de la venta (TicketModal): mismo
// formato, factura con CAE si la tiene y el email del negocio.
export function C360Receipts({ customerId, storeId, email }: { customerId: string; storeId: string | null; email: string | null }) {
  const filters: TimelineFilters = useMemo(() => ({ kinds: ["sale"], from: null, to: null, storeId }), [storeId]);
  const q = useCustomer360Timeline(customerId, filters);
  const items = mergePages(q.data?.pages ?? []);
  const [action, setAction] = useState<Action | null>(null);
  const [limit, setLimit] = useState(8);
  const shown = items.slice(0, limit);

  return (
    <section className="rounded-xl border border-border bg-card p-4">
      <h2 className="flex items-center gap-2 text-sm font-semibold">
        <Receipt size={15} className="text-muted-foreground" /> Comprobantes
      </h2>
      <p className="mt-1 text-xs text-muted-foreground">
        {email ? `Reenviar manda el comprobante a ${email} (lo podés cambiar antes de enviar).` : "Este cliente no tiene email: al reenviar lo cargás."}
      </p>

      <div className="mt-3">
        {q.isLoading ? (
          <p className="text-sm text-muted-foreground">Cargando comprobantes...</p>
        ) : q.isError ? (
          <p className="text-sm text-danger">No se pudieron cargar los comprobantes.</p>
        ) : items.length === 0 ? (
          <p className="text-sm text-muted-foreground">Todavía no tiene compras.</p>
        ) : (
          <ul className="divide-y divide-border">
            {shown.map((it) => {
              const voided = it.status === "voided";
              return (
                <li key={it.id} className="flex flex-wrap items-center gap-x-3 gap-y-2 py-2.5">
                  <span className="min-w-0 flex-1">
                    <span className="flex items-center gap-2 text-sm font-medium">
                      Venta #{it.ref}
                      {voided && <Badge tone="neutral">Anulada</Badge>}
                    </span>
                    <span className="block text-xs text-muted-foreground">
                      {when(it.at)}
                      {it.store_name ? ` · ${it.store_name}` : ""}
                    </span>
                  </span>
                  <span className="text-sm font-semibold tabular-nums">{formatCurrency(it.amount)}</span>
                  <span className="flex w-full gap-1.5 sm:w-auto">
                    <Button variant="ghost" className="h-9 flex-1 px-2.5 sm:flex-none" onClick={() => setAction({ saleId: it.sale_id ?? it.id })}>
                      <Eye size={15} /> Ver
                    </Button>
                    <Button
                      variant="secondary"
                      className="h-9 flex-1 px-2.5 sm:flex-none"
                      onClick={() => setAction({ saleId: it.sale_id ?? it.id, startWith: "print" })}
                    >
                      <Printer size={15} /> Reimprimir
                    </Button>
                    <Button
                      variant="secondary"
                      className="h-9 flex-1 px-2.5 sm:flex-none"
                      disabled={voided}
                      title={voided ? "Una venta anulada no se reenvía" : undefined}
                      onClick={() => setAction({ saleId: it.sale_id ?? it.id, startWith: "email" })}
                    >
                      <Mail size={15} /> Reenviar
                    </Button>
                  </span>
                </li>
              );
            })}
          </ul>
        )}
        {(items.length > limit || q.hasNextPage) && (
          <div className="mt-3 flex justify-center">
            <Button
              variant="secondary"
              loading={q.isFetchingNextPage}
              onClick={() => {
                if (items.length <= limit + 8 && q.hasNextPage) void q.fetchNextPage();
                setLimit((n) => n + 8);
              }}
            >
              Ver más comprobantes
            </Button>
          </div>
        )}
      </div>

      {action && (
        <TicketModal
          open
          onOpenChange={(o) => !o && setAction(null)}
          saleId={action.saleId}
          startWith={action.startWith}
        />
      )}
    </section>
  );
}
