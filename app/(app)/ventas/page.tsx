"use client";

import { useEffect, useMemo, useState } from "react";
import dynamic from "next/dynamic";
import { Download, QrCode, Receipt, Search, X } from "lucide-react";
import { Button } from "@/components/ui/Button";
import { InfoHint } from "@/components/ui/InfoHint";
import { useToast } from "@/components/ui/Toast";
import { MountWhenOpened } from "@/components/ui/MountWhenOpened";
import { ConfirmDialog } from "@/components/ui/ConfirmDialog";
import { Pagination } from "@/components/ui/Pagination";
import { Select, type SelectOption } from "@/components/ui/Select";
import { GatedButton, useFeatureGate } from "@/components/saas/GatedAction";
import { useSalesPaged, useVoidSale, useSaleNumberFormat } from "@/modules/sales/hooks";
import { salesApi } from "@/modules/sales/api";
import { useSalesExtras } from "@/modules/sales/listExtras";
import { usePageSize } from "@/hooks/usePageSize";
import { useDebouncedValue } from "@/hooks/useDebouncedValue";
import { formatSaleNumber } from "@/lib/utils/saleNumber";
import { exportXlsx } from "@/lib/utils/xlsx";
import { DateRangePicker, type DateRange } from "@/components/ui/DateRangePicker";
import { PageHeader } from "@/components/ui/PageHeader";
import { EmptyState } from "@/components/ui/EmptyState";
import { useBranchContext } from "@/modules/branches/hooks";
import { ALL_BRANCHES } from "@/modules/branches/logic";
import { saleAlertBadges, type PaymentDisputeRow } from "@/lib/reports/paymentDisputes";
import { useSaleDisputes } from "@/modules/reports/paymentDisputes";
import { errorDescription } from "@/lib/permissions/errors";
import { useRolePermissions } from "@/lib/permissions/useRole";
import { methodLabel } from "@/lib/sales/paymentDetail";
import { CHANNEL_LABEL, filterByChannel, presentChannels, type SaleChannel } from "@/lib/sales/salesList";
import { SaleCard, SaleCardSkeleton } from "@/components/sales/SaleCard";
import { SalesSummary } from "@/components/sales/SalesSummary";
import { PaymentLogo } from "@/components/sales/SalePaymentLogo";

// Modales en chunks aparte, montados recién al abrirlos (detalle, ticket,
// devolución / cambio y cobros QR son pesados y no hacen falta para listar).
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
const SaleDetailModal = dynamic(
  () => import("@/components/sales/SaleDetailModal").then((m) => m.SaleDetailModal),
  { ssr: false },
);

const SALE_STATUS: Record<string, string> = {
  completed: "Completada",
  voided: "Anulada",
};

type StatusFilter = "all" | "completed" | "voided" | "alerts";
const STATUS_OPTIONS: SelectOption<StatusFilter>[] = [
  { value: "all", label: "Todos los estados" },
  { value: "completed", label: "Completadas" },
  { value: "voided", label: "Anuladas" },
  { value: "alerts", label: "Con alertas", description: "Contracargos, reclamos y devoluciones de Mercado Pago" },
];

// Medios que registra el POS (payments.method).
const METHODS = ["cash", "debit", "credit", "transfer", "qr", "account", "store_credit", "directo", "ualabis", "other"] as const;

export default function VentasPage() {
  const { toast } = useToast();
  const pageSize = usePageSize();
  const [range, setRange] = useState<DateRange | undefined>(undefined);
  const [search, setSearch] = useState("");
  const [statusFilter, setStatusFilter] = useState<StatusFilter>("all");
  const [methodFilter, setMethodFilter] = useState<string>("all");
  const [channelFilter, setChannelFilter] = useState<SaleChannel | "all">("all");
  const [page, setPage] = useState(1);
  const debouncedSearch = useDebouncedValue(search, 350);
  // F17 · H90: filtro global de sucursal (chip del panel). Con "todas" cada
  // venta muestra su sucursal.
  const branch = useBranchContext();
  const storeId = branch.filterStoreId;
  const showBranch = branch.isMulti && !storeId;
  const status = statusFilter === "all" ? "" : statusFilter;
  const method = methodFilter === "all" ? null : methodFilter;

  // Reloj para los tiempos relativos ("hace 5 min"): se refresca cada minuto.
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 60_000);
    return () => clearInterval(t);
  }, []);

  const saleRange = range?.from
    ? { from: range.from, to: range.to ?? range.from }
    : undefined;

  // Volver a la página 1 cuando cambian los filtros.
  useEffect(() => {
    setPage(1);
  }, [debouncedSearch, statusFilter, methodFilter, range?.from, range?.to, pageSize, storeId]);

  const { data, isLoading, isPlaceholderData, isError, refetch } = useSalesPaged({
    page,
    pageSize,
    search: debouncedSearch,
    status,
    range: saleRange,
    storeId,
    method,
  });
  const rows = useMemo(() => data?.rows ?? [], [data?.rows]);
  const total = data?.total ?? 0;

  // Ítems con foto, cobros, factura, canal, caja y cajero de la página (lote).
  const extrasQ = useSalesExtras(rows);
  const extrasMap = extrasQ.data?.bySale;
  const providerOf = (ref: string | null) => (ref ? (extrasQ.data?.intentProvider.get(ref) ?? null) : null);
  // Canal: no hay columna en sales (sale de lo enlazado), así que el filtro
  // corre sobre la página cargada. Documentado en ADR / CHANGELOG.
  const visible = filterByChannel(
    rows,
    (id) => extrasMap?.get(id)?.channel ?? null,
    channelFilter === "all" ? null : channelFilter,
  );
  const channels = presentChannels(rows.map((r) => extrasMap?.get(r.id)?.channel ?? null));

  const { data: numFmt } = useSaleNumberFormat();
  const voidSale = useVoidSale();
  const [detailId, setDetailId] = useState<string | null>(null);
  const [detailOpen, setDetailOpen] = useState(false);
  const [ticketId, setTicketId] = useState<string | null>(null);
  const [ticketOpen, setTicketOpen] = useState(false);
  const [ticketTab, setTicketTab] = useState<"ticket" | "cobros">("ticket");
  const [returnId, setReturnId] = useState<string | null>(null);
  const [returnOpen, setReturnOpen] = useState(false);
  const [voidTarget, setVoidTarget] = useState<{ id: string; number: number } | null>(null);
  const [qrOpen, setQrOpen] = useState(false);
  const [exporting, setExporting] = useState(false);
  // Devoluciones/cambios es feature de plan (Pro).
  const returnGate = useFeatureGate("devoluciones", "Devoluciones");
  // Permisos por rol (ADR-071): solo lectura no anula ni devuelve; el cajero
  // anula sólo ventas del día (hora de Argentina). La base lo rechaza igual.
  const perms = useRolePermissions();
  const deniedReturn = perms.denied("sales:return");

  function openTicket(id: string, tab: "ticket" | "cobros" = "ticket") {
    setTicketId(id);
    setTicketTab(tab);
    setTicketOpen(true);
  }
  function openDetail(id: string) {
    setDetailId(id);
    setDetailOpen(true);
  }
  function startReturn(id: string) {
    returnGate.run(() => {
      setReturnId(id);
      setReturnOpen(true);
    });
  }

  // Links de los avisos (ADR-064): /ventas?venta=<id>&tab=cobros abre el
  // detalle; /ventas?alertas=1 filtra las ventas con alertas.
  useEffect(() => {
    const q = new URLSearchParams(window.location.search);
    const venta = q.get("venta");
    if (venta && /^[0-9a-f-]{36}$/i.test(venta)) {
      if (q.get("tab") === "cobros") {
        setTicketId(venta);
        setTicketTab("cobros");
        setTicketOpen(true);
      } else {
        setDetailId(venta);
        setDetailOpen(true);
      }
    }
    if (q.get("alertas") === "1") setStatusFilter("alerts");
  }, []);

  // Marcas de contracargos y devoluciones de MP (sólo dueño o encargado: RLS).
  const disputesQ = useSaleDisputes(
    rows.map((s) => s.id),
    rows.length > 0,
  );
  const disputesBySale = new Map<string, PaymentDisputeRow[]>();
  for (const d of disputesQ.data ?? []) {
    if (!d.sale_id) continue;
    disputesBySale.set(d.sale_id, [...(disputesBySale.get(d.sale_id) ?? []), d]);
  }

  async function exportVentas() {
    setExporting(true);
    try {
      // Exporta TODO lo que matchea los filtros server-side (no sólo la página).
      const all = await salesApi.exportRows({
        search: debouncedSearch,
        status,
        range: saleRange,
        storeId,
        method,
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
          rows: all.map((s) => ({
            number: s.number,
            fecha: new Date(s.created_at).toLocaleString("es-AR"),
            cliente: s.customers?.name ?? "Consumidor final",
            sucursal: branch.branchName(s.store_id) ?? "",
            total: s.total,
            estado: SALE_STATUS[s.status] ?? s.status,
          })),
          totals: {
            total: all
              .filter((s) => s.status === "completed")
              .reduce((a, s) => a + s.total, 0),
          },
        },
      ]);
    } catch (e) {
      toast({
        title: "No se pudo exportar",
        description: errorDescription(e),
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
      toast({ title: `Venta ${formatSaleNumber(number, numFmt)} anulada`, variant: "success" });
    } catch (e) {
      toast({
        title: "No se pudo anular",
        description: errorDescription(e),
        variant: "error",
      });
    }
  }

  const methodOptions: SelectOption<string>[] = [
    { value: "all", label: "Todos los medios" },
    ...METHODS.map((m) => ({
      value: m,
      label: methodLabel(m),
      icon: <PaymentLogo method={m} label={methodLabel(m)} size={20} />,
    })),
  ];
  const branchOptions: SelectOption<string>[] = [
    { value: ALL_BRANCHES, label: "Todas las sucursales" },
    ...branch.allowed.map((b) => ({ value: b.id, label: b.short_name || b.name })),
  ];
  const channelOptions: SelectOption<SaleChannel | "all">[] = [
    { value: "all", label: "Todos los canales" },
    ...channels.map((c) => ({ value: c, label: CHANNEL_LABEL[c] })),
  ];
  const filtersActive =
    statusFilter !== "all" || methodFilter !== "all" || channelFilter !== "all" || Boolean(range?.from);
  function clearFilters() {
    setStatusFilter("all");
    setMethodFilter("all");
    setChannelFilter("all");
    setRange(undefined);
  }

  const loadingList = isLoading;

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

        <SalesSummary range={saleRange} storeId={storeId} method={method} />

        {/* Filtros */}
        <div className="mt-5 grid grid-cols-2 gap-2 sm:flex sm:flex-wrap">
          <div className="relative col-span-2 min-w-0 sm:max-w-xs sm:flex-1">
            <Search
              size={16}
              className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-muted-foreground"
            />
            <input
              type="search"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder="N°, ticket o cliente"
              aria-label="Buscar ventas por número, ticket o cliente"
              className="h-11 w-full rounded-lg border border-input bg-background pl-9 pr-3 text-sm text-foreground outline-none focus:border-ninja-flameSoft"
            />
          </div>
          <div className="col-span-2 flex gap-2 sm:col-span-1">
            <DateRangePicker value={range} onChange={setRange} className="h-11 flex-1" />
            {range?.from && (
              <button
                onClick={() => setRange(undefined)}
                className="inline-flex h-11 shrink-0 items-center gap-1.5 rounded-lg border border-border px-3 text-sm text-muted-foreground transition hover:bg-muted hover:text-foreground"
                title="Quitar filtro de fechas"
                aria-label="Quitar filtro de fechas"
              >
                <X size={14} /> Fechas
              </button>
            )}
          </div>
          <Select
            value={statusFilter}
            options={STATUS_OPTIONS}
            onChange={setStatusFilter}
            aria-label="Estado"
            className="sm:w-48"
          />
          <Select
            value={methodFilter}
            options={methodOptions}
            onChange={setMethodFilter}
            aria-label="Medio de pago"
            className="sm:w-52"
          />
          {branch.isMulti && branch.allowed.length > 1 && (
            <Select
              value={storeId ?? ALL_BRANCHES}
              options={branchOptions}
              onChange={(v) => branch.setSelection(v)}
              aria-label="Sucursal"
              className="sm:w-52"
            />
          )}
          {channels.length > 1 || channelFilter !== "all" ? (
            <Select
              value={channelFilter}
              options={channelOptions}
              onChange={setChannelFilter}
              aria-label="Canal (en esta página)"
              className="sm:w-48"
            />
          ) : null}
        </div>

        {/* Listado */}
        <div className="mt-4 overflow-hidden rounded-lg border border-border bg-card">
          {isError && !isLoading ? (
            <div className="px-4 py-10 text-center text-sm text-danger">
              No pudimos cargar las ventas.{" "}
              <button onClick={() => refetch()} className="underline">
                Reintentar
              </button>
            </div>
          ) : loadingList ? (
            <ul className="divide-y divide-border" aria-busy aria-label="Cargando ventas">
              {Array.from({ length: 5 }, (_, i) => (
                <SaleCardSkeleton key={i} />
              ))}
            </ul>
          ) : visible.length === 0 ? (
            <div className="px-4 py-10">
              {search ? (
                <EmptyState
                  compact
                  icon={Search}
                  title="Sin resultados"
                  description="Probá con otro número de venta, ticket o cliente."
                />
              ) : filtersActive ? (
                <EmptyState
                  compact
                  icon={Search}
                  title={
                    statusFilter === "alerts"
                      ? "No hay ventas con alertas en este período"
                      : "Ningún resultado con estos filtros"
                  }
                  description={
                    statusFilter === "alerts"
                      ? "Acá aparecen las ventas con contracargos, reclamos o devoluciones de Mercado Pago."
                      : channelFilter !== "all"
                        ? "El filtro de canal mira sólo esta página. Probá con otra página o quitá el filtro."
                        : "Probá con otro estado, medio de pago o con otras fechas."
                  }
                  action={
                    <Button size="sm" variant="secondary" onClick={clearFilters}>
                      Limpiar filtros
                    </Button>
                  }
                />
              ) : (
                <EmptyState
                  compact
                  icon={Receipt}
                  title="Todavía no hay ventas"
                  description="Cuando cobres desde el punto de venta, las vas a ver acá."
                />
              )}
            </div>
          ) : (
            <ul className="divide-y divide-border" aria-label="Ventas">
              {visible.map((s) => {
                const voidDenied = perms.denied("sales:void", { saleDate: s.created_at });
                return (
                  <SaleCard
                    key={s.id}
                    sale={s}
                    numberLabel={formatSaleNumber(s.number, numFmt)}
                    extras={extrasMap?.get(s.id)}
                    extrasLoading={extrasQ.isLoading || extrasQ.isFetching}
                    providerOf={providerOf}
                    branch={branch.all.find((b) => b.id === s.store_id) ?? null}
                    branchName={branch.branchName(s.store_id)}
                    showBranch={showBranch}
                    alerts={saleAlertBadges(disputesBySale.get(s.id) ?? [])}
                    now={now}
                    returnDenied={deniedReturn}
                    returnLocked={returnGate.locked}
                    voidDenied={voidDenied}
                    onOpen={() => openDetail(s.id)}
                    onTicket={() => openTicket(s.id)}
                    onCobros={() => openTicket(s.id, "cobros")}
                    onReturn={() => startReturn(s.id)}
                    onVoid={() => !voidDenied && setVoidTarget({ id: s.id, number: s.number })}
                  />
                );
              })}
            </ul>
          )}
        </div>

        <Pagination
          page={page}
          pageSize={pageSize}
          total={total}
          onPageChange={setPage}
          loading={isPlaceholderData}
        />
      </div>

      {returnGate.modal}
      <MountWhenOpened open={detailOpen}>
        <SaleDetailModal
          open={detailOpen}
          onOpenChange={setDetailOpen}
          saleId={detailId}
          numberLabel={(n) => formatSaleNumber(n, numFmt)}
          branchName={(id) => (branch.isMulti ? branch.branchName(id) : null)}
          returnDenied={deniedReturn}
          returnLocked={returnGate.locked}
          voidDenied={(d) => perms.denied("sales:void", { saleDate: d })}
          onTicket={() => detailId && openTicket(detailId)}
          onCobros={() => detailId && openTicket(detailId, "cobros")}
          onReturn={() => detailId && startReturn(detailId)}
          onVoid={(t) => setVoidTarget(t)}
        />
      </MountWhenOpened>
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
        title={`Anular venta ${voidTarget ? formatSaleNumber(voidTarget.number, numFmt) : ""}`}
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
