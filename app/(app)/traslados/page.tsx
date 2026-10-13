"use client";

import { useMemo, useState } from "react";
import {
  ArrowLeftRight,
  ArrowRight,
  Download,
  Lightbulb,
  Lock,
  Plus,
  Search,
  Settings2,
  Store,
  Truck,
} from "lucide-react";
import { PageContainer, PageHeader } from "@/components/ui/PageHeader";
import { Button } from "@/components/ui/Button";
import { Segmented } from "@/components/ui/Segmented";
import { EmptyState } from "@/components/ui/EmptyState";
import { TableStateRow, TableWrap } from "@/components/ui/Table";
import { UpgradeModal } from "@/components/saas/UpgradeModal";
import { cn } from "@/lib/utils/cn";
import { formatQty } from "@/lib/utils/format";
import { exportXlsx } from "@/lib/utils/xlsx";
import {
  OPEN_STATUSES,
  TRANSFER_STATUS_LABEL,
  dueState,
  formatRemitoNumber,
  localDate,
  type TransferStatus,
} from "@/lib/stock/transfers";
import { useFeature } from "@/modules/saas/gating";
import { useMyTenant } from "@/modules/tenants/hooks";
import {
  useCurrentStoreId,
  useStores,
  useTransfers,
} from "@/modules/stock/hooks";
import type { TransferDetail } from "@/modules/stock/api";
import {
  DueChip,
  TransferStatusBadge,
  fmtDate,
  selectCls,
  storeName,
} from "@/components/stock/transfers/shared";
import {
  TransferWizardModal,
  linesFromDetail,
  type WizardInitial,
} from "@/components/stock/transfers/TransferWizardModal";
import { TransferDetailModal } from "@/components/stock/transfers/TransferDetailModal";
import { TransferSuggestModal } from "@/components/stock/transfers/TransferSuggestModal";
import { TransferSettingsModal } from "@/components/stock/transfers/TransferSettingsModal";
import { InTransitReportModal } from "@/components/stock/transfers/InTransitReportModal";

type Tab = "open" | "dispatch" | "transit" | "history" | "all";

const TAB_STATUSES: Record<Tab, TransferStatus[] | null> = {
  open: OPEN_STATUSES,
  dispatch: ["scheduled"],
  transit: ["in_transit", "partially_received"],
  history: ["received", "cancelled"],
  all: null,
};

function Kpi({
  label,
  value,
  tone,
  onClick,
}: {
  label: string;
  value: number;
  tone?: "warning" | "brand" | "gold";
  onClick?: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className="rounded-lg bg-card p-4 text-left ring-1 ring-border transition hover:ring-ninja-flameSoft/40"
    >
      <div className="text-xs text-muted-foreground">{label}</div>
      <div
        className={cn(
          "mt-1 font-price text-2xl font-black tabular-nums",
          tone === "warning" && value > 0 && "text-warning",
          tone === "brand" && value > 0 && "text-ninja-flameSoft",
          tone === "gold" && value > 0 && "text-warning",
        )}
      >
        {value}
      </div>
    </button>
  );
}

// Traslados entre sucursales (F17 · H95, ADR-046).
export default function TrasladosPage() {
  const enabled = useFeature("traslados");
  const { data: me } = useMyTenant();
  const { data: stores = [], isLoading: storesLoading } = useStores();
  const currentStoreId = useCurrentStoreId();
  const [tab, setTab] = useState<Tab>("open");
  const [storeFilter, setStoreFilter] = useState("");
  const [search, setSearch] = useState("");
  const [detailId, setDetailId] = useState<string | null>(null);
  const [wizard, setWizard] = useState<{
    open: boolean;
    initial: WizardInitial | null;
  }>({
    open: false,
    initial: null,
  });
  const [suggestOpen, setSuggestOpen] = useState(false);
  // F17 · H95: reporte de artículos en tránsito.
  const [transitOpen, setTransitOpen] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [upgradeOpen, setUpgradeOpen] = useState(false);

  const ready = enabled === true && stores.length > 1;
  const { data: all = [] } = useTransfers({ statuses: OPEN_STATUSES }, ready);
  const {
    data: rows = [],
    isLoading,
    isError,
    refetch,
  } = useTransfers(
    { statuses: TAB_STATUSES[tab], storeId: storeFilter || null, search },
    ready,
  );

  const today = localDate();
  const kpis = useMemo(
    () => ({
      due: all.filter(
        (t) =>
          ["today", "overdue"].includes(
            dueState(t.scheduled_for, t.status, today),
          ) && t.status === "scheduled",
      ).length,
      transit: all.filter(
        (t) => t.status === "in_transit" || t.status === "partially_received",
      ).length,
      approval: all.filter((t) => t.status === "pending_approval").length,
    }),
    [all, today],
  );

  // En "Para despachar" primero lo atrasado y lo de hoy.
  const sorted = useMemo(() => {
    if (tab !== "dispatch") return rows;
    return [...rows].sort((a, b) =>
      (a.scheduled_for ?? "").localeCompare(b.scheduled_for ?? ""),
    );
  }, [rows, tab]);

  const canManage = Boolean(me?.canManage);

  function exportList() {
    void exportXlsx("traslados", [
      {
        name: "Traslados",
        title: "Traslados entre sucursales",
        columns: [
          { header: "Remito", key: "numero", width: 12 },
          { header: "Origen", key: "origen", width: 20 },
          { header: "Destino", key: "destino", width: 20 },
          { header: "Estado", key: "estado", width: 22 },
          { header: "Programado", key: "programado", width: 12 },
          { header: "Despachado", key: "despachado", type: "date" },
          { header: "Recibido", key: "recibido", type: "date" },
          { header: "Unidades", key: "unidades", type: "number" },
          { header: "Valor a costo", key: "valor", type: "money" },
        ],
        rows: sorted.map((t) => ({
          numero: formatRemitoNumber(t.number),
          origen: storeName(stores, t.origin_store_id),
          destino: storeName(stores, t.dest_store_id),
          estado: TRANSFER_STATUS_LABEL[t.status],
          programado: t.scheduled_for ? fmtDate(t.scheduled_for) : "",
          despachado: t.dispatched_at ? new Date(t.dispatched_at) : null,
          recibido: t.received_at ? new Date(t.received_at) : null,
          unidades: t.total_units,
          valor: t.total_value,
        })),
      },
    ]);
  }

  const header = (
    <PageHeader
      eyebrow="Catálogo"
      title="Traslados"
      icon={ArrowLeftRight}
      description="Mové mercadería entre sucursales: programala, seguila en camino y recibila con control de diferencias."
      actions={
        ready ? (
          <>
            {canManage && (
              <Button onClick={() => setWizard({ open: true, initial: null })}>
                <Plus size={16} /> Nuevo traslado
              </Button>
            )}
            {canManage && (
              <Button variant="secondary" onClick={() => setSuggestOpen(true)}>
                <Lightbulb size={16} /> Sugerir traslados
              </Button>
            )}
            <Button variant="secondary" onClick={() => setTransitOpen(true)}>
              <Truck size={16} /> En tránsito
            </Button>
            <Button
              variant="secondary"
              onClick={exportList}
              disabled={sorted.length === 0}
            >
              <Download size={16} /> XLSX
            </Button>
            {canManage && (
              <Button variant="ghost" onClick={() => setSettingsOpen(true)}>
                <Settings2 size={16} /> Configuración
              </Button>
            )}
          </>
        ) : undefined
      }
    />
  );

  if (enabled === false) {
    return (
      <PageContainer>
        {header}
        <div className="mt-8 rounded-xl bg-muted/40 p-8 text-center">
          <Lock className="mx-auto text-ninja-flameSoft" size={28} />
          <p className="mt-3 font-semibold">
            Los traslados no están incluidos en tu plan
          </p>
          <p className="mx-auto mt-1 max-w-md text-sm text-muted-foreground">
            Programá envíos entre sucursales, seguí la mercadería en camino,
            recibila con diferencias y motivo, e imprimí el remito.
          </p>
          <Button className="mt-4" onClick={() => setUpgradeOpen(true)}>
            Ver planes
          </Button>
          <UpgradeModal
            open={upgradeOpen}
            onOpenChange={setUpgradeOpen}
            featureKey="traslados"
            featureLabel="Traslados"
          />
        </div>
      </PageContainer>
    );
  }

  if (!storesLoading && enabled === true && stores.length < 2) {
    return (
      <PageContainer>
        {header}
        <EmptyState
          className="mt-8"
          icon={Store}
          title="Necesitás al menos dos sucursales"
          description="Cuando tengas otra sucursal activa vas a poder trasladar stock entre ellas desde acá."
        />
      </PageContainer>
    );
  }

  return (
    <PageContainer>
      {header}

      <div className="mt-6 grid grid-cols-3 gap-3">
        <Kpi
          label="Para despachar hoy"
          value={kpis.due}
          tone="warning"
          onClick={() => setTab("dispatch")}
        />
        <Kpi
          label="En camino"
          value={kpis.transit}
          tone="brand"
          onClick={() => setTab("transit")}
        />
        <Kpi
          label="Por aprobar"
          value={kpis.approval}
          tone="gold"
          onClick={() => setTab("open")}
        />
      </div>

      <div className="mt-6 flex flex-col gap-3 lg:flex-row lg:items-center">
        <Segmented<Tab>
          aria-label="Estado"
          value={tab}
          onChange={setTab}
          size="sm"
          options={[
            { value: "open", label: "Activos" },
            { value: "dispatch", label: "Para despachar" },
            { value: "transit", label: "En camino" },
            { value: "history", label: "Historial" },
            { value: "all", label: "Todos" },
          ]}
        />
        <div className="flex flex-1 gap-2">
          <select
            aria-label="Sucursal"
            className={cn(selectCls, "h-10 lg:max-w-[14rem]")}
            value={storeFilter}
            onChange={(e) => setStoreFilter(e.target.value)}
          >
            <option value="" className="bg-popover text-popover-foreground">
              Todas las sucursales
            </option>
            {stores.map((s) => (
              <option
                key={s.id}
                value={s.id}
                className="bg-popover text-popover-foreground"
              >
                {s.name}
              </option>
            ))}
          </select>
          <div className="relative flex-1 lg:max-w-[12rem]">
            <Search
              size={15}
              className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-muted-foreground"
            />
            <input
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder="N° de remito"
              inputMode="numeric"
              className="h-10 w-full rounded-lg border border-input bg-background pl-9 pr-3 text-sm outline-none focus:border-ninja-flameSoft"
            />
          </div>
        </div>
      </div>

      <div className="mt-4">
        <TableWrap>
          <table className="w-full text-sm">
            <thead className="bg-muted/60 text-left text-xs uppercase tracking-wide text-muted-foreground">
              <tr>
                <th className="px-4 py-3">Remito</th>
                <th className="px-4 py-3">Ruta</th>
                <th className="px-4 py-3">Estado</th>
                <th className="hidden px-4 py-3 md:table-cell">Fecha</th>
                <th className="px-4 py-3 text-right">Unidades</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-border">
              {(isLoading || enabled === undefined) && (
                <TableStateRow colSpan={5} loading />
              )}
              {isError && (
                <tr>
                  <td
                    colSpan={5}
                    className="px-4 py-10 text-center text-danger"
                  >
                    Error al cargar.{" "}
                    <button onClick={() => refetch()} className="underline">
                      Reintentar
                    </button>
                  </td>
                </tr>
              )}
              {!isLoading &&
                !isError &&
                sorted.length === 0 &&
                enabled === true && (
                  <TableStateRow colSpan={5}>
                    <EmptyState
                      compact
                      icon={ArrowLeftRight}
                      title="Sin traslados en esta vista"
                      description="Creá uno nuevo o pedile al sistema que sugiera traslados por stock bajo."
                    />
                  </TableStateRow>
                )}
              {sorted.map((t) => (
                <tr
                  key={t.id}
                  onClick={() => setDetailId(t.id)}
                  className="cursor-pointer transition hover:bg-muted/40"
                >
                  <td className="px-4 py-3 font-mono font-semibold">
                    {formatRemitoNumber(t.number)}
                  </td>
                  <td className="px-4 py-3">
                    <span className="inline-flex flex-wrap items-center gap-1.5">
                      <span
                        className={cn(
                          t.origin_store_id === currentStoreId &&
                            "font-semibold",
                        )}
                      >
                        {storeName(stores, t.origin_store_id)}
                      </span>
                      <ArrowRight size={13} className="text-muted-foreground" />
                      <span
                        className={cn(
                          t.dest_store_id === currentStoreId && "font-semibold",
                        )}
                      >
                        {storeName(stores, t.dest_store_id)}
                      </span>
                    </span>
                  </td>
                  <td className="px-4 py-3">
                    <div className="flex flex-wrap items-center gap-1.5">
                      <TransferStatusBadge status={t.status} />
                      <DueChip
                        scheduledFor={t.scheduled_for}
                        status={t.status}
                      />
                    </div>
                  </td>
                  <td className="hidden px-4 py-3 text-muted-foreground md:table-cell">
                    {fmtDate(
                      t.received_at ??
                        t.dispatched_at ??
                        t.scheduled_for ??
                        t.created_at,
                    )}
                  </td>
                  <td className="px-4 py-3 text-right font-mono tabular-nums">
                    {formatQty(t.total_units)}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </TableWrap>
      </div>

      <TransferDetailModal
        transferId={detailId}
        onOpenChange={(o) => !o && setDetailId(null)}
        stores={stores}
        onEdit={(t: TransferDetail) => {
          setDetailId(null);
          setWizard({
            open: true,
            initial: {
              id: t.id,
              origin_store_id: t.origin_store_id,
              dest_store_id: t.dest_store_id,
              scheduled_for: t.scheduled_for,
              notes: t.notes,
              carrier: t.carrier,
              lines: linesFromDetail(t),
            },
          });
        }}
      />
      <TransferWizardModal
        open={wizard.open}
        onOpenChange={(o) => setWizard((w) => ({ ...w, open: o }))}
        stores={stores}
        currentStoreId={currentStoreId}
        initial={wizard.initial}
        onSaved={(id) => setDetailId(id)}
      />
      <TransferSuggestModal
        open={suggestOpen}
        onOpenChange={setSuggestOpen}
        stores={stores}
      />
      <InTransitReportModal
        open={transitOpen}
        onOpenChange={setTransitOpen}
        stores={stores}
        currentStoreId={currentStoreId}
      />
      <TransferSettingsModal
        open={settingsOpen}
        onOpenChange={setSettingsOpen}
      />
    </PageContainer>
  );
}
