"use client";

// "Pendientes de revisar": la bandeja de acción de la conciliación. Junta los
// cobros sin venta, las ventas sin cobro, las diferencias, los contracargos y
// reclamos, y los lotes de tarjeta viejos sin conciliar. Selección por grupo o
// por ítem y acciones en lote con las RPC de siempre.

import { useCallback, useEffect, useMemo, useState } from "react";
import Link from "next/link";
import type { Route } from "next";
import {
  CheckCheck,
  CheckCircle2,
  ChevronDown,
  ChevronRight,
  CreditCard,
  Download,
  Eye,
  Link2,
  MoreHorizontal,
  PartyPopper,
  Receipt,
} from "lucide-react";
import { Checkbox } from "@/components/ui/Checkbox";
import { EmptyState } from "@/components/ui/EmptyState";
import { Segmented } from "@/components/ui/Segmented";
import { Dropdown, DropdownContent, DropdownItem, DropdownTrigger } from "@/components/ui/Dropdown";
import { useToast } from "@/components/ui/Toast";
import { DisputeCard } from "@/components/disputes/DisputeCard";
import { CreateSaleFromLineModal, IgnoreLineModal, LinkLineModal } from "@/components/reports/processors/LineActionModals";
import { cn } from "@/lib/utils/cn";
import { formatCurrency } from "@/lib/utils/format";
import { MATCH_LABEL, providerLabel, type SettlementLineRow } from "@/lib/reports/processorReconciliation";
import { INBOX_KIND, bulkPlan, inboxGroups, type InboxItem, type InboxKind } from "@/lib/reports/reconciliationHub";
import {
  batchResultText,
  pruneSelection,
  selectionState,
  selectionTotals,
  toggleGroup,
  type SelectionState,
} from "@/lib/reports/selection";
import { settlementErrorMessage } from "@/modules/reports/processorReconciliation";
import { reconcileErrorMessage } from "@/modules/reports/cardReconciliation";
import { useBulkAckDisputes, useBulkReconcile, useBulkReviewLines } from "@/modules/reports/reconciliationHub";
import { BulkBar, useBulkRunner } from "./BulkBar";
import { ProviderTile, StatusChip, ToneDot } from "./ui";

type KindFilter = "all" | InboxKind;

const cbState = (s: SelectionState) => (s === "all" ? true : s === "some" ? ("indeterminate" as const) : false);
const when = (iso: string) =>
  new Date(iso).toLocaleString("es-AR", { day: "2-digit", month: "2-digit", hour: "2-digit", minute: "2-digit" });

export function PendingInbox({
  items,
  loading,
  ticket,
  canExport,
  onExportSelection,
  onOpenCards,
  onRefetch,
}: {
  items: InboxItem[];
  loading: boolean;
  ticket: (saleId: string | null) => string | null;
  canExport: boolean;
  onExportSelection: (items: InboxItem[]) => void;
  onOpenCards: () => void;
  onRefetch: () => void;
}) {
  const { toast } = useToast();
  const runner = useBulkRunner();
  const reconcile = useBulkReconcile();
  const review = useBulkReviewLines();
  const ack = useBulkAckDisputes();

  const [kind, setKind] = useState<KindFilter>(() => {
    if (typeof window === "undefined") return "all";
    return new URLSearchParams(window.location.search).get("filtro") === "disputas" ? "dispute" : "all";
  });
  const [selected, setSelected] = useState<Set<string>>(() => new Set());
  const [open, setOpen] = useState<string | null>(null);
  const [linking, setLinking] = useState<SettlementLineRow | null>(null);
  const [ignoring, setIgnoring] = useState<SettlementLineRow | null>(null);
  const [creating, setCreating] = useState<SettlementLineRow | null>(null);

  const groups = useMemo(() => inboxGroups(items), [items]);
  const visible = useMemo(() => (kind === "all" ? items : items.filter((i) => i.kind === kind)), [items, kind]);
  const visibleGroups = useMemo(() => inboxGroups(visible), [visible]);
  const selectable = useMemo(() => visible.filter((i) => i.canReconcile || i.canReview || canExport).map((i) => i.id), [visible, canExport]);

  useEffect(() => {
    setSelected((s) => pruneSelection(s, selectable));
  }, [selectable]);

  const clear = useCallback(() => setSelected(new Set()), []);
  const plan = bulkPlan(visible, selected);
  const totals = selectionTotals(visible, selected, (i) => i.id, (i) => i.amount);

  function askReconcile() {
    runner.ask({
      title: "Conciliar lotes seleccionados",
      confirmLabel: `Conciliar ${plan.paymentIds.length} ${plan.paymentIds.length === 1 ? "cobro" : "cobros"}`,
      rows: [
        ["Lotes", String(plan.reconcile.length)],
        ["Cobros", String(plan.paymentIds.length)],
        ["Monto", formatCurrency(plan.reconcileAmount)],
      ],
      note: "Marcalos sólo si ya controlaste que el adquirente te los acreditó.",
      run: async (onProgress) => {
        const r = await reconcile.mutateAsync({ ids: plan.paymentIds, reconciled: true, onProgress });
        toast({
          title: batchResultText(r, { one: "cobro", many: "cobros" }, { done: "Conciliados", partial: "Se conciliaron" }),
          description: r.failed[0] ? reconcileErrorMessage(r.failed[0].error) : undefined,
          variant: r.failedCount ? "error" : "success",
        });
        if (r.failedCount === 0) clear();
      },
    });
  }

  function askReview() {
    const nL = plan.reviewLines.length;
    const nD = plan.ackDisputes.length;
    runner.ask({
      title: "Marcar revisados",
      confirmLabel: `Marcar ${nL + nD} revisados`,
      rows: [
        ...(nL ? ([["Cobros del procesador", String(nL)]] as [string, string][]) : []),
        ...(nD ? ([["Avisos de disputas", String(nD)]] as [string, string][]) : []),
        ["Monto", formatCurrency(plan.reviewAmount)],
      ],
      note:
        "Los cobros quedan como Revisado (salen de esta bandeja y se pueden volver a revisar desde el detalle del procesador). Las disputas quedan vistas: siguen abiertas hasta que Mercado Pago las resuelva.",
      run: async (onProgress) => {
        const total = nL + nD;
        let base = 0;
        const step = (d: number) => onProgress(base + d, total);
        const r1 = nL ? await review.mutateAsync({ lineIds: plan.reviewLines.map((i) => i.line!.id), onProgress: step }) : null;
        base = nL;
        const r2 = nD ? await ack.mutateAsync({ ids: plan.ackDisputes.map((i) => i.dispute!.id), onProgress: step }) : null;
        const done = (r1?.done ?? 0) + (r2?.done ?? 0);
        const failedCount = (r1?.failedCount ?? 0) + (r2?.failedCount ?? 0);
        const firstErr = r1?.failed[0]?.error ?? r2?.failed[0]?.error;
        toast({
          title: batchResultText({ total, done, failedCount }, { one: "ítem", many: "ítems" }, { done: "Revisados", partial: "Se revisaron" }),
          description: firstErr ? settlementErrorMessage(firstErr) : undefined,
          variant: failedCount ? "error" : "success",
        });
        if (failedCount === 0) clear();
      },
    });
  }

  if (!loading && items.length === 0) {
    return (
      <div className="mt-5 rounded-lg border border-border bg-card">
        <EmptyState
          icon={PartyPopper}
          title="No hay nada pendiente"
          description="Todo cierra con tus ventas: no hay cobros sin venta, diferencias, disputas abiertas ni lotes viejos sin conciliar."
        />
      </div>
    );
  }

  return (
    <div className="mt-5">
      <Segmented<KindFilter>
        aria-label="Tipo de pendiente"
        size="sm"
        value={kind}
        onChange={setKind}
        options={[
          { value: "all", label: `Todo (${items.length})` },
          ...groups.map((g) => ({ value: g.kind, label: `${INBOX_KIND[g.kind].label} (${g.items.length})` })),
        ]}
      />

      <div className="mt-4 space-y-4">
        {visibleGroups.map((g) => {
          const ids = g.items.filter((i) => selectable.includes(i.id)).map((i) => i.id);
          const meta = INBOX_KIND[g.kind];
          return (
            <section key={g.kind} className="overflow-hidden rounded-lg border border-border bg-card" aria-label={meta.label}>
              <header className="flex flex-wrap items-center gap-3 border-b border-border bg-muted/40 px-3 py-2.5 sm:px-4">
                {ids.length > 0 && (
                  <Checkbox
                    checked={cbState(selectionState(selected, ids))}
                    onCheckedChange={() => setSelected((s) => toggleGroup(s, ids))}
                    aria-label={`Seleccionar ${meta.label.toLowerCase()}`}
                  />
                )}
                <ToneDot tone={meta.tone} />
                <div className="min-w-0 flex-1">
                  <h3 className="text-sm font-semibold">
                    {meta.label} <span className="font-normal tabular-nums text-muted-foreground">· {g.items.length}</span>
                  </h3>
                  <p className="text-xs text-muted-foreground">{meta.todo}</p>
                </div>
                <span className="shrink-0 text-sm font-semibold tabular-nums">{formatCurrency(g.amount)}</span>
              </header>
              <ul className="divide-y divide-border">
                {g.items.map((it) => (
                  <InboxRow
                    key={it.id}
                    it={it}
                    ticket={ticket}
                    selectable={selectable.includes(it.id)}
                    selected={selected.has(it.id)}
                    open={open === it.id}
                    onSelect={() => setSelected((s) => toggleGroup(s, [it.id]))}
                    onToggleOpen={() => setOpen((o) => (o === it.id ? null : it.id))}
                    onLink={setLinking}
                    onIgnore={setIgnoring}
                    onCreate={setCreating}
                    onOpenCards={onOpenCards}
                  />
                ))}
              </ul>
            </section>
          );
        })}
      </div>

      <BulkBar
        count={totals.count}
        amount={totals.amount}
        onClear={clear}
        actions={[
          ...(plan.reconcile.length
            ? [
                {
                  key: "rec",
                  label: `Conciliar ${plan.reconcile.length}`,
                  variant: "primary" as const,
                  icon: <CheckCheck size={15} aria-hidden />,
                  disabled: runner.running,
                  onClick: askReconcile,
                },
              ]
            : []),
          ...(plan.reviewLines.length + plan.ackDisputes.length
            ? [
                {
                  key: "rev",
                  label: `Marcar revisados ${plan.reviewLines.length + plan.ackDisputes.length}`,
                  variant: plan.reconcile.length ? ("secondary" as const) : ("primary" as const),
                  icon: <CheckCircle2 size={15} aria-hidden />,
                  disabled: runner.running,
                  onClick: askReview,
                },
              ]
            : []),
          ...(canExport
            ? [
                {
                  key: "xlsx",
                  label: "Exportar selección",
                  icon: <Download size={15} aria-hidden />,
                  onClick: () => onExportSelection(plan.chosen),
                },
              ]
            : []),
        ]}
      />
      {runner.dialog}

      {linking && <LinkLineModal line={linking} onClose={() => setLinking(null)} onDone={onRefetch} />}
      {ignoring && <IgnoreLineModal line={ignoring} onClose={() => setIgnoring(null)} />}
      {creating && <CreateSaleFromLineModal line={creating} onClose={() => setCreating(null)} onDone={onRefetch} />}
    </div>
  );
}

function InboxRow({
  it,
  ticket,
  selectable,
  selected,
  open,
  onSelect,
  onToggleOpen,
  onLink,
  onIgnore,
  onCreate,
  onOpenCards,
}: {
  it: InboxItem;
  ticket: (saleId: string | null) => string | null;
  selectable: boolean;
  selected: boolean;
  open: boolean;
  onSelect: () => void;
  onToggleOpen: () => void;
  onLink: (l: SettlementLineRow) => void;
  onIgnore: (l: SettlementLineRow) => void;
  onCreate: (l: SettlementLineRow) => void;
  onOpenCards: () => void;
}) {
  const t = ticket(it.saleId);
  const l = it.line;
  const chip = it.dispute ? (
    <StatusChip label={it.urgent ? "Plazo urgente" : it.dispute.acknowledged_at ? "Visto" : "Sin ver"} tone={it.urgent ? "danger" : "warning"} icon={it.urgent ? "risk" : it.dispute.acknowledged_at ? "seen" : "alert"} />
  ) : it.kind === "card_batch" ? (
    <StatusChip label="Pendiente" tone="warning" />
  ) : (
    <StatusChip
      label={MATCH_LABEL[it.kind as "missing_in_pos" | "amount_diff" | "pos_only"].label}
      tone={INBOX_KIND[it.kind].tone}
    />
  );
  return (
    <li className={cn("px-3 py-3 sm:px-4", selected && "bg-muted/50")}>
      <div className="flex items-start gap-3">
        <span className="pt-1">
          {selectable ? (
            <Checkbox checked={selected} onCheckedChange={onSelect} aria-label={`Seleccionar ${it.title}`} />
          ) : (
            <span className="block h-4 w-4" />
          )}
        </span>
        {it.provider ? (
          <ProviderTile logo={it.provider === "otro" ? null : it.provider} label={providerLabel(it.provider)} size={32} />
        ) : (
          <span className="grid h-8 w-8 shrink-0 place-items-center rounded-md border border-border bg-card text-muted-foreground">
            <CreditCard size={15} aria-hidden />
          </span>
        )}
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-start justify-between gap-x-3 gap-y-1">
            <div className="min-w-0">
              <p className="truncate text-sm font-medium">{it.title}</p>
              <p className="mt-0.5 text-xs text-muted-foreground">
                <span className="tabular-nums">{when(it.date)}</span>
                {t ? ` · Venta ${t}` : ""}
                {it.ref ? (
                  <>
                    {" · "}
                    <span className="font-mono">{it.ref}</span>
                  </>
                ) : null}
              </p>
              {it.detail && <p className="mt-0.5 text-xs text-muted-foreground">{it.detail}</p>}
            </div>
            <div className="flex shrink-0 items-center gap-2">
              <span className="text-sm font-semibold tabular-nums">{formatCurrency(it.amount)}</span>
            </div>
          </div>
          <div className="mt-2 flex flex-wrap items-center justify-between gap-2">
            {chip}
            <div className="flex items-center gap-1">
              {it.dispute && (
                <button
                  type="button"
                  onClick={onToggleOpen}
                  className="inline-flex h-8 items-center gap-1 rounded-md px-2 text-xs font-medium text-muted-foreground hover:bg-muted hover:text-foreground"
                >
                  {open ? <ChevronDown size={14} /> : <ChevronRight size={14} />} Detalle
                </button>
              )}
              {it.kind === "card_batch" && (
                <button
                  type="button"
                  onClick={onOpenCards}
                  className="inline-flex h-8 items-center gap-1 rounded-md px-2 text-xs font-medium text-muted-foreground hover:bg-muted hover:text-foreground"
                >
                  Ver lote <ChevronRight size={14} />
                </button>
              )}
              {it.kind === "pos_only" && it.saleId && (
                <Link
                  href={`/ventas?venta=${it.saleId}&tab=cobros` as Route}
                  className="inline-flex h-8 items-center gap-1 rounded-md px-2 text-xs font-medium text-muted-foreground hover:bg-muted hover:text-foreground"
                >
                  <Eye size={14} /> Ver venta
                </Link>
              )}
              {l && (
                <Dropdown>
                  <DropdownTrigger asChild>
                    <button
                      type="button"
                      aria-label="Acciones"
                      className="grid h-8 w-8 place-items-center rounded-md text-muted-foreground hover:bg-muted hover:text-foreground"
                    >
                      <MoreHorizontal size={16} />
                    </button>
                  </DropdownTrigger>
                  <DropdownContent align="end">
                    {l.match_status === "missing_in_pos" && l.provider_key === "mercadopago" && (
                      <DropdownItem onSelect={() => onCreate(l)}>
                        <Receipt size={14} /> Crear venta
                      </DropdownItem>
                    )}
                    <DropdownItem onSelect={() => onLink(l)}>
                      <Link2 size={14} /> Vincular a una venta
                    </DropdownItem>
                    <DropdownItem onSelect={() => onIgnore(l)}>
                      <CheckCircle2 size={14} /> Marcar revisado con nota
                    </DropdownItem>
                  </DropdownContent>
                </Dropdown>
              )}
            </div>
          </div>
          {open && it.dispute && (
            <div className="mt-3 rounded-md border border-border p-3">
              <DisputeCard d={it.dispute} />
            </div>
          )}
        </div>
      </div>
    </li>
  );
}
