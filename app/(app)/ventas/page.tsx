"use client";

import { useState } from "react";
import { Ban, Download, Receipt, RotateCcw, Search } from "lucide-react";
import { Button } from "@/components/ui/Button";
import { Eyebrow, Display } from "@/components/ui/Typography";
import { useToast } from "@/components/ui/Toast";
import { TicketModal } from "@/components/sales/TicketModal";
import { ReturnModal } from "@/components/sales/ReturnModal";
import { ConfirmDialog } from "@/components/ui/ConfirmDialog";
import { useSales, useVoidSale, useSaleNumberFormat } from "@/modules/sales/hooks";
import { formatCurrency } from "@/lib/utils/format";
import { formatSaleNumber, saleMatchesQuery } from "@/lib/utils/saleNumber";
import { exportXlsx } from "@/lib/utils/xlsx";

const SALE_STATUS: Record<string, string> = {
  completed: "Completada",
  voided: "Anulada",
};

export default function VentasPage() {
  const { toast } = useToast();
  const { data: sales, isLoading } = useSales();
  const { data: numFmt } = useSaleNumberFormat();
  const voidSale = useVoidSale();
  const [search, setSearch] = useState("");
  const [statusFilter, setStatusFilter] = useState("");
  const q = search.trim().toLowerCase();
  const visible = (sales ?? [])
    .filter(
      (s) =>
        saleMatchesQuery(s.number, numFmt, search) ||
        (q.length > 0 && (s.customers?.name ?? "").toLowerCase().includes(q)),
    )
    .filter((s) => !statusFilter || s.status === statusFilter);
  const [ticketId, setTicketId] = useState<string | null>(null);
  const [ticketOpen, setTicketOpen] = useState(false);
  const [returnId, setReturnId] = useState<string | null>(null);
  const [returnOpen, setReturnOpen] = useState(false);
  const [voidTarget, setVoidTarget] = useState<{ id: string; number: number } | null>(null);

  function openTicket(id: string) {
    setTicketId(id);
    setTicketOpen(true);
  }

  async function exportVentas() {
    await exportXlsx("ventas", [
      {
        name: "Ventas",
        title: "Ventas — NinjaPos",
        columns: [
          { header: "N°", key: "number", type: "number", width: 10 },
          { header: "Fecha", key: "fecha", width: 22 },
          { header: "Cliente", key: "cliente", width: 24 },
          { header: "Total", key: "total", type: "money" },
          { header: "Estado", key: "estado", width: 14 },
        ],
        rows: (sales ?? []).map((s) => ({
          number: s.number,
          fecha: new Date(s.created_at).toLocaleString("es-AR"),
          cliente: s.customers?.name ?? "",
          total: s.total,
          estado: SALE_STATUS[s.status] ?? s.status,
        })),
        totals: {
          total: (sales ?? [])
            .filter((s) => s.status === "completed")
            .reduce((a, s) => a + s.total, 0),
        },
      },
    ]);
  }

  async function onVoid(reason: string) {
    if (!voidTarget) return;
    const { id, number } = voidTarget;
    try {
      await voidSale.mutateAsync({ id, reason });
      setVoidTarget(null);
      toast({ title: `Venta #${number} anulada`, variant: "success" });
    } catch (e) {
      toast({
        title: "No se pudo anular",
        description: e instanceof Error ? e.message : undefined,
        variant: "error",
      });
    }
  }

  return (
    <>
<div className="mx-auto max-w-6xl px-6 py-8">
        <div className="flex flex-wrap items-end justify-between gap-4">
          <div>
            <Eyebrow>Operación</Eyebrow>
            <Display className="mt-3 text-3xl md:text-4xl">Ventas</Display>
          </div>
          <Button variant="secondary" onClick={exportVentas} disabled={!sales?.length}>
            <Download size={16} /> Exportar XLSX
          </Button>
        </div>

        <div className="mt-5 flex flex-wrap gap-2">
          <div className="relative min-w-0 flex-1 sm:max-w-sm">
            <Search
              size={16}
              className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-muted-foreground"
            />
            <input
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder="Buscar por N°, ticket o cliente…"
              className="h-10 w-full rounded-lg border border-input bg-background pl-9 pr-3 text-sm text-foreground outline-none focus:border-ninja-flameSoft"
            />
          </div>
          <select
            value={statusFilter}
            onChange={(e) => setStatusFilter(e.target.value)}
            className="h-10 rounded-lg border border-input bg-background px-3 text-sm text-foreground outline-none focus:border-ninja-flameSoft"
          >
            <option value="">Todos los estados</option>
            <option value="completed">Completadas</option>
            <option value="voided">Anuladas</option>
          </select>
        </div>

        <div className="mt-6 overflow-x-auto rounded-lg border border-border bg-card">
          <table className="w-full min-w-[560px] text-sm">
            <thead className="bg-muted text-left text-xs uppercase tracking-[0.14em] text-muted-foreground">
              <tr>
                <th className="px-4 py-3">#</th>
                <th className="px-4 py-3">Fecha</th>
                <th className="px-4 py-3">Cliente</th>
                <th className="px-4 py-3 text-right">Total</th>
                <th className="px-4 py-3">Estado</th>
                <th className="px-4 py-3 text-right">Acciones</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-border text-foreground">
              {isLoading && (
                <tr>
                  <td colSpan={6} className="px-4 py-10 text-center text-muted-foreground">
                    Cargando…
                  </td>
                </tr>
              )}
              {!isLoading && visible.length === 0 && (
                <tr>
                  <td colSpan={6} className="px-4 py-10 text-center text-muted-foreground">
                    {search ? "Sin resultados para la búsqueda." : "No hay ventas registradas."}
                  </td>
                </tr>
              )}
              {visible.map((s) => (
                <tr key={s.id} className="transition hover:bg-muted/40">
                  <td className="px-4 py-3 font-mono">{formatSaleNumber(s.number, numFmt)}</td>
                  <td className="px-4 py-3 text-muted-foreground">
                    {new Date(s.created_at).toLocaleString("es-AR")}
                  </td>
                  <td className="px-4 py-3 text-muted-foreground">
                    {s.customers?.name ?? "—"}
                  </td>
                  <td className="px-4 py-3 text-right font-semibold">
                    {formatCurrency(s.total)}
                  </td>
                  <td className="px-4 py-3">
                    {s.status === "voided" ? (
                      <span className="inline-flex rounded-full border border-red-400/25 bg-red-400/10 px-2.5 py-0.5 text-xs font-semibold text-red-300">
                        Anulada
                      </span>
                    ) : (
                      <span className="inline-flex rounded-full border border-emerald-400/25 bg-emerald-400/10 px-2.5 py-0.5 text-xs font-semibold text-emerald-300">
                        Completada
                      </span>
                    )}
                  </td>
                  <td className="px-4 py-3">
                    <div className="flex justify-end gap-1">
                      <button
                        onClick={() => openTicket(s.id)}
                        title="Ticket"
                        className="rounded-md p-2 text-muted-foreground transition hover:bg-muted hover:text-foreground"
                      >
                        <Receipt size={16} />
                      </button>
                      {s.status === "completed" && (
                        <button
                          onClick={() => {
                            setReturnId(s.id);
                            setReturnOpen(true);
                          }}
                          title="Devolución / cambio"
                          className="rounded-md p-2 text-muted-foreground transition hover:bg-muted hover:text-ninja-flameSoft"
                        >
                          <RotateCcw size={16} />
                        </button>
                      )}
                      {s.status === "completed" && (
                        <button
                          onClick={() => setVoidTarget({ id: s.id, number: s.number })}
                          title="Anular"
                          className="rounded-md p-2 text-muted-foreground transition hover:bg-red-400/15 hover:text-red-300"
                        >
                          <Ban size={16} />
                        </button>
                      )}
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>

      <TicketModal open={ticketOpen} onOpenChange={setTicketOpen} saleId={ticketId} />
      <ReturnModal open={returnOpen} onOpenChange={setReturnOpen} saleId={returnId} />
      <ConfirmDialog
        open={voidTarget !== null}
        onOpenChange={(o) => !o && setVoidTarget(null)}
        title={`Anular venta #${voidTarget?.number ?? ""}`}
        description="La venta se marca como anulada y se repone el stock. Esta acción queda auditada."
        confirmLabel="Anular venta"
        danger
        loading={voidSale.isPending}
        withReason
        reasonLabel="Motivo de anulación"
        reasonPlaceholder="Ej. error de carga, pedido del cliente…"
        onConfirm={onVoid}
      />
    </>
  );
}
