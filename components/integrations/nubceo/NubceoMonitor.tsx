"use client";

import { useMemo, useState } from "react";
import { Ban, Eye, RotateCcw, Send, Trash2 } from "lucide-react";
import { Badge } from "@/components/ui/Badge";
import { Button } from "@/components/ui/Button";
import { ConfirmDialog } from "@/components/ui/ConfirmDialog";
import { Disclosure } from "@/components/ui/Disclosure";
import { Modal } from "@/components/ui/Modal";
import { Pagination } from "@/components/ui/Pagination";
import { SearchField } from "@/components/ui/SearchField";
import { Segmented } from "@/components/ui/Segmented";
import { Select } from "@/components/ui/Select";
import { SpinnerBlock } from "@/components/ui/Spinner";
import { TableStateRow, TableWrap } from "@/components/ui/Table";
import { useToast } from "@/components/ui/Toast";
import { SettingsCard } from "@/components/settings/Settings";
import { EYEBROW } from "@/components/security/styles";
import { useStores } from "@/modules/stock/hooks";
import {
  TAB_STATUSES,
  nubceoErrorMessage,
  type MonitorTab,
  type NubceoConfig,
  type SyncRow,
} from "@/modules/integrations/nubceo/api";
import {
  useNubceoCounts,
  useNubceoDaily,
  useNubceoMutations,
  useNubceoPreview,
  useNubceoRuns,
  useNubceoSync,
} from "@/modules/integrations/nubceo/hooks";
import { formatCurrency } from "@/lib/utils/format";
import { cn } from "@/lib/utils/cn";
import { NUBCEO_RECON_LABEL } from "@/lib/accounting/settlementSource";
import {
  ENV_LABEL,
  ERROR_KIND,
  JsonBlock,
  RUN_STATUS,
  SyncStatusBadge,
  arDay,
  arDayStartIso,
  fmtDateTime,
  fmtDay,
} from "./shared";

type Period = "1" | "7" | "30" | "90";
const PAGE_SIZE = 25;

export function NubceoMonitor({ config, canWrite }: { config: NubceoConfig; canWrite: boolean }) {
  const { toast } = useToast();
  const m = useNubceoMutations();
  const { data: stores = [] } = useStores();
  const [period, setPeriod] = useState<Period>("7");
  const [tab, setTab] = useState<MonitorTab>("synced");
  const [storeId, setStoreId] = useState<string>("");
  const [search, setSearch] = useState("");
  const [page, setPage] = useState(0);
  const [detail, setDetail] = useState<SyncRow | null>(null);
  const [excludeIds, setExcludeIds] = useState<string[] | null>(null);
  const [deleteIds, setDeleteIds] = useState<string[] | null>(null);

  const range = useMemo(() => {
    const today = arDay(Date.now());
    const fromDay = arDay(Date.now() - (Number(period) - 1) * 86_400_000);
    const toDay = arDay(Date.now() + 86_400_000);
    return { fromDay, today, from: arDayStartIso(fromDay), to: arDayStartIso(toDay) };
  }, [period]);

  const filters = { tab, from: range.from, to: range.to, storeId: storeId || null, search, page, pageSize: PAGE_SIZE };
  const list = useNubceoSync(filters);
  const counts = useNubceoCounts(range.from, range.to, storeId || null);
  const daily = useNubceoDaily(range.fromDay, range.today);
  const runs = useNubceoRuns();

  const c = counts.data ?? {};
  const tabCount = (t: MonitorTab) => TAB_STATUSES[t].reduce((a, s) => a + (c[s] ?? 0), 0);
  const simulatedCount = c.simulated ?? 0;
  const storeName = (id: string | null) => stores.find((s) => s.id === id)?.name ?? "";

  const s = config.settings;
  const lastRun = s?.last_run_status ? RUN_STATUS[s.last_run_status] : null;
  const paused = s?.paused_until && new Date(s.paused_until).getTime() > Date.now();

  const act = async (fn: () => Promise<number>, done: (n: number) => string) => {
    try {
      const n = await fn();
      toast({ title: done(n), variant: "success" });
    } catch (e) {
      toast({ title: "No se pudo", description: nubceoErrorMessage(e), variant: "error" });
    }
  };

  const runNow = async () => {
    try {
      const r = await m.runNow.mutateAsync();
      toast({ title: r.status === "error" ? "La vuelta tuvo problemas" : "Vuelta terminada.", description: r.message, variant: r.status === "error" ? "error" : "success" });
    } catch (e) {
      toast({ title: "No se pudo", description: nubceoErrorMessage(e), variant: "error" });
    }
  };

  return (
    <div className="space-y-5">
      {/* Estado del sincronizador */}
      <div className="grid gap-px overflow-hidden rounded-lg border border-border bg-border sm:grid-cols-2 lg:grid-cols-4">
        <StatCell label="Modo">
          {!s?.enabled ? (
            <Badge tone="neutral">Apagada</Badge>
          ) : s.simulate ? (
            <Badge tone="info">Solo simular</Badge>
          ) : (
            <Badge tone="success">Envío real</Badge>
          )}
          {s && <span className="text-sm text-muted-foreground">{ENV_LABEL[s.environment]}</span>}
        </StatCell>
        <StatCell label="Última vuelta">
          {lastRun ? <Badge tone={lastRun.tone}>{lastRun.label}</Badge> : <span className="text-sm text-muted-foreground">Todavía no corrió</span>}
          {s?.last_run_at && <span className="text-sm text-muted-foreground">{fmtDateTime(s.last_run_at)}</span>}
        </StatCell>
        <StatCell label="Próxima vuelta">
          <span className="text-sm">
            {paused ? (
              <span className="text-warning">En pausa hasta {fmtDateTime(s?.paused_until)}</span>
            ) : s?.enabled && s.next_run_at ? (
              fmtDateTime(s.next_run_at)
            ) : (
              "Sin programar"
            )}
          </span>
        </StatCell>
        <div className="flex items-center bg-card p-4">
          <Button className="w-full" onClick={runNow} disabled={!canWrite || !s?.enabled} loading={m.runNow.isPending}>
            <Send size={16} /> Enviar ahora
          </Button>
        </div>
      </div>
      {s?.last_run_message && (
        <p className="-mt-2 text-[13px] text-muted-foreground">
          <span className="font-medium text-foreground">Último resultado:</span> {s.last_run_message}
        </p>
      )}

      {/* Filtros */}
      <div className="flex flex-col gap-3 lg:flex-row lg:items-center">
        <Segmented
          size="sm"
          value={period}
          onChange={(v) => {
            setPeriod(v);
            setPage(0);
          }}
          aria-label="Período"
          options={[
            { value: "1", label: "Hoy" },
            { value: "7", label: "7 días" },
            { value: "30", label: "30 días" },
            { value: "90", label: "90 días" },
          ]}
        />
        {stores.length > 1 && (
          <Select
            value={storeId}
            onChange={(v) => {
              setStoreId(v);
              setPage(0);
            }}
            aria-label="Sucursal"
            options={[{ value: "", label: "Todas las sucursales" }, ...stores.map((st) => ({ value: st.id, label: st.name }))]}
            className="lg:max-w-[240px]"
          />
        )}
        <SearchField
          value={search}
          onValueChange={(v) => {
            setSearch(v);
            setPage(0);
          }}
          placeholder="N° de venta o id en NubCeo"
          className="lg:ml-auto lg:max-w-[300px]"
        />
      </div>

      <div className="flex flex-wrap items-center justify-between gap-3">
        <Segmented
          value={tab}
          onChange={(v) => {
            setTab(v);
            setPage(0);
          }}
          aria-label="Estado"
          options={[
            { value: "synced", label: `Enviadas · ${tabCount("synced")}` },
            { value: "pending", label: `Pendientes · ${tabCount("pending")}` },
            { value: "error", label: `Con error · ${tabCount("error")}` },
            { value: "excluded", label: `Excluidas · ${tabCount("excluded")}` },
          ]}
        />
        <div className="flex flex-wrap gap-2">
          {tab === "error" && tabCount("error") > 0 && (
            <Button
              size="sm"
              variant="secondary"
              disabled={!canWrite}
              loading={m.retryBulk.isPending}
              onClick={() =>
                act(() => m.retryBulk.mutateAsync({ status: "error", from: range.from, to: range.to }), (n) => `${n} ventas vuelven a la cola.`)
              }
            >
              <RotateCcw size={15} /> Reintentar todas
            </Button>
          )}
          {tab === "pending" && simulatedCount > 0 && !s?.simulate && (
            <Button
              size="sm"
              variant="secondary"
              disabled={!canWrite}
              loading={m.retryBulk.isPending}
              onClick={() =>
                act(() => m.retryBulk.mutateAsync({ status: "simulated", from: range.from, to: range.to }), (n) => `${n} simuladas pasan a la cola de envío.`)
              }
            >
              <Send size={15} /> Mandar las simuladas ({simulatedCount})
            </Button>
          )}
        </div>
      </div>

      <TableWrap>
        <table className="w-full min-w-[820px] text-sm">
          <thead className="sticky top-0 z-10 bg-popover text-left text-xs uppercase tracking-[0.12em] text-muted-foreground">
            <tr className="bg-muted">
              <th className="px-4 py-2.5">Fecha</th>
              <th className="px-4 py-2.5">Venta</th>
              <th className="px-4 py-2.5">Sucursal</th>
              <th className="px-4 py-2.5 text-right">Monto</th>
              <th className="px-4 py-2.5">Estado</th>
              <th className="px-4 py-2.5 text-right">Acciones</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-border">
            {list.isLoading ? (
              <TableStateRow colSpan={6} loading />
            ) : (list.data?.rows.length ?? 0) === 0 ? (
              <TableStateRow colSpan={6}>
                <p className="text-sm text-muted-foreground">No hay ventas en este estado para el período.</p>
              </TableStateRow>
            ) : (
              list.data!.rows.map((r) => (
                <tr key={r.id} className="align-top hover:bg-muted/30">
                  <td className="whitespace-nowrap px-4 py-3 tabular-nums text-muted-foreground">{fmtDateTime(r.sale_date)}</td>
                  <td className="px-4 py-3">
                    <p className="font-medium">
                      {r.kind === "return" ? "Devolución de la venta" : "Venta"} {r.sale_number ?? ""}
                    </p>
                    <p className="font-mono text-xs text-muted-foreground">{r.venta_id}</p>
                  </td>
                  <td className="px-4 py-3">{storeName(r.store_id)}</td>
                  <td className="whitespace-nowrap px-4 py-3 text-right tabular-nums">
                    {r.kind === "return" ? "−" : ""}
                    {formatCurrency(r.amount)}
                  </td>
                  <td className="px-4 py-3">
                    <div className="flex flex-wrap items-center gap-1.5">
                      <SyncStatusBadge status={r.status} />
                      {r.already_existed && <Badge tone="neutral">Ya estaba</Badge>}
                      {r.environment === "test" && r.status === "synced" && <Badge tone="info">Prueba</Badge>}
                      {r.reconciled_status && (
                        <Badge tone={NUBCEO_RECON_LABEL[r.reconciled_status].tone}>
                          {NUBCEO_RECON_LABEL[r.reconciled_status].label}
                        </Badge>
                      )}
                    </div>
                    <RowStatusNote r={r} />
                  </td>
                  <td className="px-4 py-3">
                    <div className="flex justify-end gap-1">
                      <IconAction label="Ver detalle" onClick={() => setDetail(r)}>
                        <Eye size={16} />
                      </IconAction>
                      {canWrite && ["error", "simulated", "excluded"].includes(r.status) && r.excluded_by !== "void" && (
                        <IconAction
                          label="Reintentar"
                          onClick={() => act(() => m.retry.mutateAsync([r.id]), () => "Vuelve a la cola.")}
                        >
                          <RotateCcw size={16} />
                        </IconAction>
                      )}
                      {canWrite && ["pending", "error", "simulated"].includes(r.status) && (
                        <IconAction label="Excluir" onClick={() => setExcludeIds([r.id])}>
                          <Ban size={16} />
                        </IconAction>
                      )}
                      {canWrite && r.status === "synced" && (
                        <IconAction label="Borrar de NubCeo" onClick={() => setDeleteIds([r.id])}>
                          <Trash2 size={16} />
                        </IconAction>
                      )}
                    </div>
                  </td>
                </tr>
              ))
            )}
          </tbody>
        </table>
      </TableWrap>
      <Pagination
        page={page + 1}
        pageSize={PAGE_SIZE}
        total={list.data?.total ?? 0}
        onPageChange={(p) => setPage(p - 1)}
        loading={list.isFetching}
      />

      <DailyTotals rows={daily.data ?? []} loading={daily.isLoading} />

      <Disclosure title="Últimas vueltas del sincronizador">
        {runs.isLoading ? (
          <SpinnerBlock className="py-6" />
        ) : (runs.data?.length ?? 0) === 0 ? (
          <p className="text-sm text-muted-foreground">Todavía no hubo vueltas.</p>
        ) : (
          <ul className="divide-y divide-border rounded-md border border-border">
            {runs.data!.map((run) => {
              const st = RUN_STATUS[run.status] ?? { label: run.status, tone: "neutral" as const };
              return (
                <li key={run.id} className="flex flex-wrap items-center gap-x-3 gap-y-1 px-3 py-2.5 text-sm">
                  <span className="w-[120px] tabular-nums text-muted-foreground">{fmtDateTime(run.started_at)}</span>
                  <Badge tone={st.tone}>{st.label}</Badge>
                  {run.trigger === "manual" && <Badge tone="neutral">Manual</Badge>}
                  <span className="min-w-0 flex-1 text-muted-foreground">{run.message}</span>
                </li>
              );
            })}
          </ul>
        )}
      </Disclosure>

      <DetailModal row={detail} onClose={() => setDetail(null)} storeName={storeName} />

      <ConfirmDialog
        open={Boolean(excludeIds)}
        onOpenChange={(o) => !o && setExcludeIds(null)}
        title="Excluir de NubCeo"
        description="La venta no se manda. Podés volver a ponerla en la cola con Reintentar."
        confirmLabel="Excluir"
        withReason
        reasonLabel="Motivo"
        reasonPlaceholder="Por ejemplo: venta de prueba"
        loading={m.exclude.isPending}
        onConfirm={async (reason) => {
          const ids = excludeIds ?? [];
          await act(() => m.exclude.mutateAsync({ ids, reason }), () => "Excluida.");
          setExcludeIds(null);
        }}
      />
      <ConfirmDialog
        open={Boolean(deleteIds)}
        onOpenChange={(o) => !o && setDeleteIds(null)}
        title="Borrar de NubCeo"
        description="Se pide el borrado en la próxima vuelta. NubCeo no deja borrar una venta que ya concilió."
        confirmLabel="Borrar"
        danger
        withReason
        reasonLabel="Motivo"
        reasonPlaceholder="Por ejemplo: se mandó con el código de sucursal equivocado"
        loading={m.requestDelete.isPending}
        onConfirm={async (reason) => {
          const ids = deleteIds ?? [];
          await act(() => m.requestDelete.mutateAsync({ ids, reason }), () => "Se borra en la próxima vuelta.");
          setDeleteIds(null);
        }}
      />
    </div>
  );
}
NubceoMonitor.displayName = "NubceoMonitor";

function StatCell({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex flex-col gap-1.5 bg-card p-4">
      <p className={EYEBROW}>{label}</p>
      <div className="flex flex-wrap items-center gap-2">{children}</div>
    </div>
  );
}

function IconAction({ label, onClick, children }: { label: string; onClick: () => void; children: React.ReactNode }) {
  return (
    <button
      type="button"
      title={label}
      aria-label={label}
      onClick={onClick}
      className="grid h-9 w-9 place-items-center rounded-md text-muted-foreground transition-colors hover:bg-muted hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
    >
      {children}
    </button>
  );
}

function RowStatusNote({ r }: { r: SyncRow }) {
  if (r.status === "synced") {
    return (
      <p className="mt-1 text-xs text-muted-foreground">
        {fmtDateTime(r.synced_at)}
        {r.last_error ? ` · ${r.last_error}` : ""}
      </p>
    );
  }
  if (r.status === "excluded") return <p className="mt-1 text-xs text-muted-foreground">{r.excluded_reason}</p>;
  if (r.status === "error") {
    return (
      <p className="mt-1 max-w-[320px] text-xs text-danger">
        {r.error_kind ? `${ERROR_KIND[r.error_kind] ?? r.error_kind}: ` : ""}
        {r.last_error}
        {r.attempts > 0 ? ` · ${r.attempts} intentos` : ""}
      </p>
    );
  }
  if ((r.status === "pending" || r.status === "delete_pending") && r.last_error) {
    return (
      <p className="mt-1 max-w-[320px] text-xs text-muted-foreground">
        {r.last_error} · reintenta {fmtDateTime(r.next_attempt_at)}
      </p>
    );
  }
  return null;
}

function DailyTotals({ rows, loading }: { rows: { day: string; synced: number; synced_amount: number; pending: number; errors: number; excluded: number }[]; loading: boolean }) {
  const total = rows.reduce(
    (a, r) => ({
      synced: a.synced + r.synced,
      amount: a.amount + r.synced_amount,
      pending: a.pending + r.pending,
      errors: a.errors + r.errors,
      excluded: a.excluded + r.excluded,
    }),
    { synced: 0, amount: 0, pending: 0, errors: 0, excluded: 0 },
  );
  return (
    <SettingsCard title="Totales por día" description="Lo enviado a NubCeo por día de venta (las notas de crédito restan).">
      <div className="slim-scrollbar overflow-x-auto">
        <table className="w-full min-w-[560px] text-sm">
          <thead className="text-left text-xs uppercase tracking-[0.12em] text-muted-foreground">
            <tr className="border-b border-border">
              <th className="px-5 py-2.5">Día</th>
              <th className="px-3 py-2.5 text-right">Enviadas</th>
              <th className="px-3 py-2.5 text-right">Monto enviado</th>
              <th className="px-3 py-2.5 text-right">Pendientes</th>
              <th className="px-3 py-2.5 text-right">Con error</th>
              <th className="px-5 py-2.5 text-right">Excluidas</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-border tabular-nums">
            {loading ? (
              <TableStateRow colSpan={6} loading />
            ) : rows.length === 0 ? (
              <TableStateRow colSpan={6}>
                <p className="text-sm text-muted-foreground">Sin movimiento en el período.</p>
              </TableStateRow>
            ) : (
              rows.map((r) => (
                <tr key={r.day}>
                  <td className="px-5 py-2.5 capitalize">{fmtDay(r.day)}</td>
                  <td className="px-3 py-2.5 text-right">{r.synced}</td>
                  <td className="px-3 py-2.5 text-right">{formatCurrency(r.synced_amount)}</td>
                  <td className="px-3 py-2.5 text-right">{r.pending || ""}</td>
                  <td className={cn("px-3 py-2.5 text-right", r.errors > 0 && "font-semibold text-danger")}>{r.errors || ""}</td>
                  <td className="px-5 py-2.5 text-right text-muted-foreground">{r.excluded || ""}</td>
                </tr>
              ))
            )}
          </tbody>
          {rows.length > 1 && (
            <tfoot className="border-t border-border font-semibold tabular-nums">
              <tr>
                <td className="px-5 py-2.5">Total</td>
                <td className="px-3 py-2.5 text-right">{total.synced}</td>
                <td className="px-3 py-2.5 text-right">{formatCurrency(total.amount)}</td>
                <td className="px-3 py-2.5 text-right">{total.pending || ""}</td>
                <td className="px-3 py-2.5 text-right">{total.errors || ""}</td>
                <td className="px-5 py-2.5 text-right">{total.excluded || ""}</td>
              </tr>
            </tfoot>
          )}
        </table>
      </div>
    </SettingsCard>
  );
}

function DetailModal({ row, onClose, storeName }: { row: SyncRow | null; onClose: () => void; storeName: (id: string | null) => string }) {
  const needsPreview = Boolean(row) && !row?.payload && ["pending", "error", "sending"].includes(row?.status ?? "");
  const preview = useNubceoPreview(needsPreview ? (row?.id ?? null) : null);
  const [view, setView] = useState<"payload" | "response">("payload");
  return (
    <Modal
      open={Boolean(row)}
      onOpenChange={(o) => !o && onClose()}
      title={row ? `${row.kind === "return" ? "Devolución de la venta" : "Venta"} ${row.sale_number ?? ""}` : ""}
      description={row ? `${row.venta_id} · ${storeName(row.store_id)}` : undefined}
      className="sm:max-w-3xl"
    >
      {row && (
        <div className="space-y-4">
          <dl className="grid grid-cols-2 gap-x-6 gap-y-3 text-sm sm:grid-cols-4">
            <Item label="Estado">
              <SyncStatusBadge status={row.status} />
            </Item>
            <Item label="Monto">{formatCurrency(row.amount)}</Item>
            <Item label="Intentos">{row.attempts}</Item>
            <Item label="Ambiente">{row.environment ? ENV_LABEL[row.environment] : "-"}</Item>
            <Item label="Fecha de la venta">{fmtDateTime(row.sale_date)}</Item>
            <Item label="Enviada">{fmtDateTime(row.sent_at) || "-"}</Item>
            <Item label="Confirmada">{fmtDateTime(row.synced_at) || "-"}</Item>
            <Item label="Respuesta HTTP">{row.last_http_status ?? "-"}</Item>
          </dl>
          {(row.last_error || row.excluded_reason) && (
            <p className={cn("rounded-md border px-3 py-2 text-sm", row.status === "error" ? "border-danger/30 text-danger" : "border-border text-muted-foreground")}>
              {row.excluded_reason ?? row.last_error}
            </p>
          )}
          <Segmented
            size="sm"
            value={view}
            onChange={setView}
            aria-label="Ver"
            options={[
              { value: "payload", label: "JSON enviado" },
              { value: "response", label: "Respuesta de NubCeo" },
            ]}
          />
          {view === "payload" ? (
            row.payload ? (
              <JsonBlock value={[row.payload]} />
            ) : needsPreview ? (
              preview.isLoading ? (
                <SpinnerBlock className="py-8" />
              ) : preview.data?.payload ? (
                <>
                  <p className="text-xs text-muted-foreground">Todavía no se mandó: así saldría con la configuración actual.</p>
                  <JsonBlock value={[preview.data.payload]} />
                </>
              ) : (
                <p className="text-sm text-muted-foreground">{preview.data?.reason ?? (preview.error ? nubceoErrorMessage(preview.error) : "Sin datos.")}</p>
              )
            ) : (
              <p className="text-sm text-muted-foreground">Esta venta no se armó.</p>
            )
          ) : row.last_response ? (
            <JsonBlock value={row.last_response} />
          ) : (
            <p className="text-sm text-muted-foreground">Sin respuesta guardada (sólo se guarda cuando NubCeo rechaza o falla).</p>
          )}
        </div>
      )}
    </Modal>
  );
}

function Item({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="min-w-0">
      <dt className={EYEBROW}>{label}</dt>
      <dd className="mt-1 truncate">{children}</dd>
    </div>
  );
}
