"use client";

import { useEffect, useState } from "react";
import dynamic from "next/dynamic";
import { Ban, Download, Lock, Mail, QrCode, Receipt, RotateCcw, Search, X } from "lucide-react";
import { Button } from "@/components/ui/Button";
import { InfoHint } from "@/components/ui/InfoHint";
import { useToast } from "@/components/ui/Toast";
import { MountWhenOpened } from "@/components/ui/MountWhenOpened";
import { ConfirmDialog } from "@/components/ui/ConfirmDialog";
import { Pagination } from "@/components/ui/Pagination";
import { GatedButton, useFeatureGate } from "@/components/saas/GatedAction";
import { useSalesPaged, useVoidSale, useSaleNumberFormat } from "@/modules/sales/hooks";
import { salesApi } from "@/modules/sales/api";
import { usePageSize } from "@/hooks/usePageSize";
import { useDebouncedValue } from "@/hooks/useDebouncedValue";
import { formatCurrency } from "@/lib/utils/format";
import { formatSaleNumber } from "@/lib/utils/saleNumber";
import { exportXlsx } from "@/lib/utils/xlsx";
import { DateRangePicker, type DateRange } from "@/components/ui/DateRangePicker";
import { NoData } from "@/components/ui/NoData";
import { PageHeader } from "@/components/ui/PageHeader";
import { EmptyState } from "@/components/ui/EmptyState";
import { Badge } from "@/components/ui/Badge";
import { TableStateRow, TableWrap } from "@/components/ui/Table";
import { useBranchContext } from "@/modules/branches/hooks";
import { BranchDot } from "@/components/branches/BranchSwitcher";
import { saleAlertBadges, type PaymentDisputeRow } from "@/lib/reports/paymentDisputes";
import { useSaleDisputes } from "@/modules/reports/paymentDisputes";

// Modales en chunks aparte, montados recién al abrirlos (ticket, devolución /
// cambio y cobros QR son pesados y no hacen falta para listar ventas).
const TicketModal = dynamic(
  () => import("@/components/sales/TicketModal").then((m) => m.TicketModal),
  { ssr: false },
);
const ReturnModal = dynamic(
  () => import("@/components/sales/ReturnModal").then((m) => m.ReturnModal),
  { ssr: false },
);
const QrIntentsModal = dynamic(
  () => import("@/components/sales/QrIntentsModal").then((m) => m.QrIntentsModal),
  { ssr: false },
);

const SALE_STATUS: Record<string, string> = {
  completed: "Completada",
  voided: "Anulada",
};

export default function VentasPage() {
  const { toast } = useToast();
  const pageSize = usePageSize();
  const [range, setRange] = useState<DateRange | undefined>(undefined);
  const [search, setSearch] = useState("");
  const [statusFilter, setStatusFilter] = useState("");
  const [page, setPage] = useState(1);
  const debouncedSearch = useDebouncedValue(search, 350);
  // F17 · H90: filtro global de sucursal (chip del panel). Con "todas" se
  // muestra la columna Sucursal.
  const branch = useBranchContext();
  const storeId = branch.filterStoreId;
  const showBranchCol = branch.isMulti && !storeId;
  const cols = showBranchCol ? 7 : 6;

  const saleRange = range?.from
    ? { from: range.from, to: range.to ?? range.from }
    : undefined;

  // Volver a la página 1 cuando cambian los filtros (búsqueda, estado, fechas).
  useEffect(() => {
    setPage(1);
  }, [debouncedSearch, statusFilter, range?.from, range?.to, pageSize, storeId]);

  const { data, isLoading, isPlaceholderData, isError, refetch } = useSalesPaged({
    page,
    pageSize,
    search: debouncedSearch,
    status: statusFilter,
    range: saleRange,
    storeId,
  });
  const visible = data?.rows ?? [];
  const total = data?.total ?? 0;

  const { data: numFmt } = useSaleNumberFormat();
  const voidSale = useVoidSale();
  const [ticketId, setTicketId] = useState<string | null>(null);
  const [ticketOpen, setTicketOpen] = useState(false);
  const [ticketTab, setTicketTab] = useState<"ticket" | "cobros">("ticket");
  const [returnId, setReturnId] = useState<string | null>(null);
  const [returnOpen, setReturnOpen] = useState(false);
  const [voidTarget, setVoidTarget] = useState<{ id: string; number: number } | null>(null);
  const [qrOpen, setQrOpen] = useState(false);
  const [exporting, setExporting] = useState(false);
  // Devoluciones/cambios es feature de plan (Pro): gatea el botón por fila.
  const returnGate = useFeatureGate("devoluciones", "Devoluciones");

  function openTicket(id: string, tab: "ticket" | "cobros" = "ticket") {
    setTicketId(id);
    setTicketTab(tab);
    setTicketOpen(true);
  }

  // Links de los avisos (ADR-064): /ventas?venta=<id>&tab=cobros abre el
  // detalle; /ventas?alertas=1 filtra las ventas con alertas.
  useEffect(() => {
    const q = new URLSearchParams(window.location.search);
    const venta = q.get("venta");
    if (venta && /^[0-9a-f-]{36}$/i.test(venta)) {
      setTicketId(venta);
      setTicketTab(q.get("tab") === "cobros" ? "cobros" : "ticket");
      setTicketOpen(true);
    }
    if (q.get("alertas") === "1") setStatusFilter("alerts");
  }, []);

  // Marcas de contracargos y devoluciones de MP (sólo dueño o encargado: RLS).
  const disputesQ = useSaleDisputes(
    visible.map((s) => s.id),
    visible.length > 0,
  );
  const disputesBySale = new Map<string, PaymentDisputeRow[]>();
  for (const d of disputesQ.data ?? []) {
    if (!d.sale_id) continue;
    disputesBySale.set(d.sale_id, [...(disputesBySale.get(d.sale_id) ?? []), d]);
  }

  async function exportVentas() {
    setExporting(true);
    try {
      // Exporta TODO lo que matchea los filtros activos (no solo la página).
      const rows = await salesApi.exportRows({
        search: debouncedSearch,
        status: statusFilter,
        range: saleRange,
        storeId,
      });
      await exportXlsx("ventas", [
        {
          name: "Ventas",
          title: "Ventas • NinjaPos",
          columns: [
            { header: "N°", key: "number", type: "number", width: 10 },
            { header: "Fecha", key: "fecha", width: 22 },
            { header: "Cliente", key: "cliente", width: 24 },
            ...(branch.isMulti ? [{ header: "Sucursal", key: "sucursal", width: 20 }] : []),
            { header: "Total", key: "total", type: "money" },
            { header: "Estado", key: "estado", width: 14 },
          ],
          rows: rows.map((s) => ({
            number: s.number,
            fecha: new Date(s.created_at).toLocaleString("es-AR"),
            cliente: s.customers?.name ?? "",
            sucursal: branch.branchName(s.store_id) ?? "",
            total: s.total,
            estado: SALE_STATUS[s.status] ?? s.status,
          })),
          totals: {
            total: rows
              .filter((s) => s.status === "completed")
              .reduce((a, s) => a + s.total, 0),
          },
        },
      ]);
    } catch (e) {
      toast({
        title: "No se pudo exportar",
        description: e instanceof Error ? e.message : undefined,
        variant: "error",
      });
    } finally {
      setExporting(false);
    }
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
      <div className="mx-auto w-full max-w-6xl px-4 pb-[calc(2.5rem+env(safe-area-inset-bottom))] pt-6 sm:px-6 sm:pt-8">
        <PageHeader
          eyebrow="Operación"
          title="Ventas"
          description={branch.isMulti ? (branch.filterStore ? `Sucursal ${branch.filterStore.name}` : "Todas las sucursales") : undefined}
          icon={Receipt}
          help={<InfoHint section="ventas" size={18} />}
          actions={
            <>
            <GatedButton
              feature="mercado_pago"
              featureLabel="Cobros con QR · Mercado Pago"
              variant="secondary"
              onClick={() => setQrOpen(true)}
            >
              <QrCode size={16} /> Cobros QR
            </GatedButton>
            <GatedButton
              feature="export_xlsx"
              featureLabel="Exportar a Excel"
              variant="secondary"
              onClick={exportVentas}
              loading={exporting}
              disabled={total === 0 || exporting}
            >
              <Download size={16} /> Exportar XLSX
            </GatedButton>
            </>
          }
        />

        <div className="mt-5 flex flex-wrap gap-2">
          <div className="relative min-w-0 basis-full sm:max-w-sm sm:flex-1 sm:basis-auto">
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
          <DateRangePicker value={range} onChange={setRange} className="h-10" />
          {range?.from && (
            <button
              onClick={() => setRange(undefined)}
              className="inline-flex h-10 items-center gap-1.5 rounded-lg border border-border px-3 text-sm text-muted-foreground transition hover:bg-muted hover:text-foreground"
              title="Quitar filtro de fechas"
            >
              <X size={14} /> Fechas
            </button>
          )}
          <select
            value={statusFilter}
            onChange={(e) => setStatusFilter(e.target.value)}
            className="h-10 rounded-lg border border-input bg-background px-3 text-sm text-foreground outline-none focus:border-ninja-flameSoft"
          >
            <option value="">Todos los estados</option>
            <option value="completed">Completadas</option>
            <option value="voided">Anuladas</option>
            <option value="alerts">Con alertas (contracargos y devoluciones de MP)</option>
          </select>
        </div>

        <TableWrap className="mt-6">
          <table className="w-full min-w-[560px] text-sm">
            <thead className="bg-muted text-left text-xs uppercase tracking-[0.14em] text-muted-foreground">
              <tr>
                <th className="px-4 py-3">#</th>
                <th className="px-4 py-3">Fecha</th>
                <th className="px-4 py-3">Cliente</th>
                {showBranchCol && <th className="px-4 py-3">Sucursal</th>}
                <th className="px-4 py-3 text-right">Total</th>
                <th className="px-4 py-3">Estado</th>
                <th className="px-4 py-3 text-right">Acciones</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-border text-foreground">
              {isLoading && <TableStateRow colSpan={cols} loading />}
              {isError && !isLoading && (
                <tr>
                  <td colSpan={cols} className="px-4 py-10 text-center text-danger">
                    Error al cargar.{" "}
                    <button onClick={() => refetch()} className="underline">
                      Reintentar
                    </button>
                  </td>
                </tr>
              )}
              {!isLoading && !isError && visible.length === 0 && (
                <TableStateRow colSpan={cols}>
                  {search ? (
                    <EmptyState
                      compact
                      icon={Search}
                      title="Sin resultados"
                      description="Probá con otro número de venta, ticket o cliente."
                    />
                  ) : (
                    <EmptyState
                      compact
                      icon={Receipt}
                      title="Todavía no hay ventas"
                      description="Cuando cobres desde el punto de venta, las vas a ver acá."
                    />
                  )}
                </TableStateRow>
              )}
              {visible.map((s) => (
                <tr key={s.id} className="transition hover:bg-muted/40">
                  <td className="px-4 py-3 font-mono">{formatSaleNumber(s.number, numFmt)}</td>
                  <td className="px-4 py-3 text-muted-foreground">
                    {new Date(s.created_at).toLocaleString("es-AR")}
                  </td>
                  <td className="px-4 py-3 text-muted-foreground">
                    {s.customers?.name ?? <NoData />}
                  </td>
                  {showBranchCol && (
                    <td className="px-4 py-3 text-muted-foreground">
                      <span className="inline-flex items-center gap-1.5">
                        <BranchDot branch={branch.all.find((b) => b.id === s.store_id) ?? null} className="h-2 w-2" />
                        {branch.branchName(s.store_id) ?? <NoData />}
                      </span>
                    </td>
                  )}
                  <td className="px-4 py-3 text-right font-semibold">
                    {formatCurrency(s.total)}
                  </td>
                  <td className="px-4 py-3">
                    <span className="inline-flex flex-wrap items-center gap-1.5">
                      {s.status === "voided" ? (
                        <Badge tone="danger">Anulada</Badge>
                      ) : (
                        <Badge tone="success">Completada</Badge>
                      )}
                      {saleAlertBadges(disputesBySale.get(s.id) ?? []).map((a) => (
                        <button
                          key={a.key}
                          type="button"
                          onClick={() => openTicket(s.id, "cobros")}
                          title={a.title}
                          className="rounded-full"
                        >
                          <Badge tone={a.tone}>{a.label}</Badge>
                        </button>
                      ))}
                      {s.receipt_emailed_at && (
                        <span title="Email enviado" className="inline-flex text-muted-foreground">
                          <Mail size={14} aria-label="Email enviado" />
                        </span>
                      )}
                    </span>
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
                          onClick={() =>
                            returnGate.run(() => {
                              setReturnId(s.id);
                              setReturnOpen(true);
                            })
                          }
                          title={
                            returnGate.locked
                              ? "Devoluciones: función no incluida en tu plan"
                              : "Devolución / cambio"
                          }
                          className={
                            returnGate.locked
                              ? "relative rounded-md p-2 text-muted-foreground/60 transition hover:bg-muted hover:text-muted-foreground"
                              : "rounded-md p-2 text-muted-foreground transition hover:bg-muted hover:text-ninja-flameSoft"
                          }
                        >
                          <RotateCcw size={16} />
                          {returnGate.locked && (
                            <Lock
                              size={9}
                              className="absolute right-0.5 top-0.5 text-ninja-flameSoft"
                            />
                          )}
                        </button>
                      )}
                      {s.status === "completed" && (
                        <button
                          onClick={() => setVoidTarget({ id: s.id, number: s.number })}
                          title="Anular"
                          className="rounded-md p-2 text-muted-foreground transition hover:bg-red-400/15 hover:text-danger"
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
        </TableWrap>

        <Pagination
          page={page}
          pageSize={pageSize}
          total={total}
          onPageChange={setPage}
          loading={isPlaceholderData}
        />
      </div>

      {returnGate.modal}
      <MountWhenOpened open={ticketOpen}>
        <TicketModal open={ticketOpen} onOpenChange={setTicketOpen} saleId={ticketId} initialTab={ticketTab} />
      </MountWhenOpened>
      <MountWhenOpened open={returnOpen}>
        <ReturnModal open={returnOpen} onOpenChange={setReturnOpen} saleId={returnId} />
      </MountWhenOpened>
      <MountWhenOpened open={qrOpen}>
        <QrIntentsModal open={qrOpen} onOpenChange={setQrOpen} numFmt={numFmt} />
      </MountWhenOpened>
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
