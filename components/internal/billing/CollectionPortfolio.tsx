"use client";

// =============================================================================
// Cobranzas › Cartera (F20-11 · H136 · ADR-131, spec §14.3): lista de
// cobranza con filtros (antigüedad, monto, escalera, promesa, cobrador),
// cobrador asignado, export XLSX y la historia 360 de cada negocio.
// Excluye los negocios que no se cobran (prueba, staff, lifetime, exentos).
// =============================================================================

import { useMemo, useState } from "react";
import { CircleAlert, Download, Handshake, UserRoundCog, Users, Wallet } from "lucide-react";
import { Badge } from "@/components/ui/Badge";
import { Button } from "@/components/ui/Button";
import { Callout } from "@/components/ui/Callout";
import { Checkbox } from "@/components/ui/Checkbox";
import { EmptyState } from "@/components/ui/EmptyState";
import { Input } from "@/components/ui/Input";
import { NoData } from "@/components/ui/NoData";
import { SectionHeader } from "@/components/ui/PageHeader";
import { SearchField } from "@/components/ui/SearchField";
import { Segmented } from "@/components/ui/Segmented";
import { Select } from "@/components/ui/Select";
import { Skeleton } from "@/components/ui/Skeleton";
import { TableWrap } from "@/components/ui/Table";
import { KpiTile } from "@/components/internal/dashboard/KpiTile";
import { AssignCollectorDialog } from "@/components/internal/billing/AssignCollectorDialog";
import { Tenant360Drawer } from "@/components/internal/billing/Tenant360Drawer";
import { BILLING_MODE_LABELS, billingErrorMessage, formatCents, formatDay, parsePesosToCents, todayAR } from "@/lib/billing/ledger";
import { formatCompactArs } from "@/lib/internal/saasKpis";
import {
  AGING_LABELS,
  EMPTY_FILTERS,
  LADDER_LABELS,
  LADDER_TONES,
  filterPortfolio,
  ladderState,
  nextStepLabel,
  portfolioTotals,
  portfolioXlsxSheet,
  sortPortfolio,
  type AgingBucket,
  type LadderFilter,
  type PortfolioFilters,
  type PortfolioRow,
  type PortfolioSort,
} from "@/lib/billing/collection360";
import type { BillingAccess } from "@/modules/billing/ledger";
import { usePortfolio } from "@/modules/billing/cobranza360";

type AgingFilter = "all" | AgingBucket;

export function CollectionPortfolio({ access }: { access: BillingAccess | undefined }) {
  const canView = access ? access.can_view_360 ?? access.can_operate : undefined;
  const { data, isLoading, error } = usePortfolio(canView !== false);
  const [f, setF] = useState<PortfolioFilters>(EMPTY_FILTERS);
  const [minText, setMinText] = useState("");
  const [sort, setSort] = useState<PortfolioSort>("mora");
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [assigning, setAssigning] = useState(false);
  const [openRow, setOpenRow] = useState<PortfolioRow | null>(null);

  const canAssign = Boolean(data?.can_assign);
  const filters = useMemo(() => ({ ...f, me: data?.me ?? null, minCents: parsePesosToCents(minText) }), [f, data?.me, minText]);
  const rows = useMemo(() => sortPortfolio(filterPortfolio(data?.rows ?? [], filters), sort), [data, filters, sort]);
  const totals = useMemo(() => portfolioTotals(rows), [rows]);
  const allSelected = rows.length > 0 && rows.every((r) => selected.has(r.tenant_id));
  const set = <K extends keyof PortfolioFilters>(k: K, v: PortfolioFilters[K]) => setF((x) => ({ ...x, [k]: v }));

  function toggle(id: string, on: boolean) {
    setSelected((s) => {
      const n = new Set(s);
      if (on) n.add(id);
      else n.delete(id);
      return n;
    });
  }

  async function exportIt() {
    const { exportXlsx } = await import("@/lib/utils/xlsx");
    await exportXlsx(`cobranza-cartera-${todayAR()}`, [portfolioXlsxSheet(rows, data?.as_of)]);
  }

  if (canView === false) {
    return (
      <Callout tone="neutral" icon={CircleAlert} title="Sin acceso a la cartera" className="mt-6">
        La cartera de cobranza la ven Cobranzas (o Cobranzas: sólo ver), admin y super admin.
      </Callout>
    );
  }

  return (
    <section className="mt-6 space-y-5" aria-labelledby="cob-cartera">
      <SectionHeader
        title={<span id="cob-cartera">Cartera de cobranza</span>}
        icon={Users}
        description="Un renglón por negocio con deuda, promesa, gestiones o cobrador. Tocá uno para ver su historia completa."
        actions={
          <>
            {canAssign && (
              <Button size="sm" variant="secondary" disabled={selected.size === 0} onClick={() => setAssigning(true)}>
                <UserRoundCog size={15} aria-hidden />
                Asignar cobrador{selected.size > 0 ? ` (${selected.size})` : ""}
              </Button>
            )}
            <Button size="sm" variant="secondary" onClick={exportIt} disabled={rows.length === 0}>
              <Download size={15} aria-hidden />
              Exportar XLSX
            </Button>
          </>
        }
      />

      {error ? (
        <Callout tone="warning" icon={CircleAlert} title="No se pudo cargar la cartera">
          {billingErrorMessage(error)}
        </Callout>
      ) : isLoading || !data ? (
        <div className="space-y-3" aria-busy>
          <Skeleton className="h-24 rounded-xl" />
          <Skeleton className="h-64 rounded-xl" />
        </div>
      ) : (
        <>
          <div className="grid grid-cols-1 gap-3 min-[420px]:grid-cols-2 lg:grid-cols-4">
            <KpiTile
              label="Vencido en la lista"
              icon={CircleAlert}
              value={formatCompactArs(totals.overdue_cents / 100)}
              exact={formatCents(totals.overdue_cents)}
              definition="Deuda vencida de los negocios que quedan con los filtros aplicados."
              sub={`${totals.overdue_count} ${totals.overdue_count === 1 ? "negocio" : "negocios"} con deuda vencida`}
              tone={totals.overdue_cents > 0 ? "danger" : "default"}
            />
            <KpiTile
              label="Saldo en la lista"
              icon={Wallet}
              value={formatCompactArs(totals.balance_cents / 100)}
              exact={formatCents(totals.balance_cents)}
              definition="Vencido más a vencer menos saldo a favor de los negocios filtrados."
              sub={`${totals.count} ${totals.count === 1 ? "negocio" : "negocios"}`}
            />
            <KpiTile
              label="Con promesa"
              icon={Handshake}
              value={String(totals.with_promise)}
              definition="Negocios con una promesa de pago vigente: frena la restricción y la suspensión de la escalera."
              sub="Promesas vigentes"
            />
            <KpiTile
              label="Sin cobrador"
              icon={UserRoundCog}
              value={String(totals.unassigned)}
              definition="Negocios de la lista que no tienen una persona del staff asignada para gestionar la cobranza."
              sub="Para repartir"
            />
          </div>

          <div className="space-y-3">
            <SearchField value={f.q} onValueChange={(v) => set("q", v)} placeholder="Buscar negocio o cobrador" aria-label="Buscar en la cartera" />
            <Segmented<AgingFilter>
              aria-label="Antigüedad de la deuda"
              value={f.aging}
              onChange={(v) => set("aging", v)}
              scrollOnMobile
              size="sm"
              options={[
                { value: "all", label: "Todas" },
                ...(Object.keys(AGING_LABELS) as AgingBucket[]).map((k) => ({ value: k, label: AGING_LABELS[k] })),
              ]}
            />
            <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-5">
              <Select<"all" | LadderFilter>
                label="Escalera"
                value={f.ladder}
                onChange={(v) => set("ladder", v)}
                options={[{ value: "all", label: "Todos los estados" }, ...(Object.keys(LADDER_LABELS) as LadderFilter[]).map((k) => ({ value: k, label: LADDER_LABELS[k] }))]}
              />
              <Select<"all" | "con" | "sin">
                label="Promesa"
                value={f.promise}
                onChange={(v) => set("promise", v)}
                options={[
                  { value: "all", label: "Con y sin promesa" },
                  { value: "con", label: "Con promesa vigente" },
                  { value: "sin", label: "Sin promesa" },
                ]}
              />
              <Select<string>
                label="Cobrador"
                value={f.collector}
                onChange={(v) => set("collector", v)}
                options={[
                  { value: "all", label: "Todos" },
                  { value: "me", label: "Asignados a mí" },
                  { value: "none", label: "Sin asignar" },
                  ...data.collectors.map((c) => ({ value: c.id, label: c.name })),
                ]}
              />
              <Input label="Monto mínimo ($)" inputMode="decimal" value={minText} onChange={(e) => setMinText(e.target.value)} placeholder="0" />
              <Select<PortfolioSort>
                label="Orden"
                value={sort}
                onChange={setSort}
                options={[
                  { value: "mora", label: "Días de mora" },
                  { value: "vencido", label: "Monto vencido" },
                  { value: "saldo", label: "Saldo" },
                  { value: "proxima", label: "Próxima acción" },
                  { value: "nombre", label: "Nombre" },
                ]}
              />
            </div>
            <p className="text-xs text-muted-foreground">
              Al {formatDay(data.as_of)}. Importes con IVA incluido. El monto mínimo mira lo vencido (o el saldo si no hay mora).
              {data.excluded_count > 0
                ? ` Excluye ${data.excluded_count} ${data.excluded_count === 1 ? "negocio que no se cobra" : "negocios que no se cobran"} (prueba, del staff, lifetime o exentos).`
                : ""}
            </p>
          </div>

          {rows.length === 0 ? (
            <div className="rounded-xl border border-border bg-card">
              <EmptyState compact icon={Users} title="Nada para gestionar" description="Ningún negocio coincide con los filtros." />
            </div>
          ) : (
            <>
              <TableWrap className="hidden md:block">
                <table className="w-full min-w-[1080px] text-sm">
                  <thead className="text-left text-xs uppercase tracking-wide text-muted-foreground">
                    <tr className="border-b border-border">
                      {canAssign && (
                        <th className="w-10 px-3 py-3">
                          <Checkbox
                            checked={allSelected}
                            onCheckedChange={(on) => setSelected(on ? new Set(rows.map((r) => r.tenant_id)) : new Set())}
                            aria-label="Seleccionar todos"
                          />
                        </th>
                      )}
                      <th className="px-4 py-3 font-medium">Negocio</th>
                      <th className="px-4 py-3 text-right font-medium">Saldo</th>
                      <th className="px-4 py-3 text-right font-medium">Vencido</th>
                      <th className="px-4 py-3 text-right font-medium">Mora</th>
                      <th className="px-4 py-3 font-medium">Escalera</th>
                      <th className="px-4 py-3 font-medium">Promesa</th>
                      <th className="px-4 py-3 font-medium">Cobrador</th>
                      <th className="px-4 py-3 font-medium">Última gestión</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-border">
                    {rows.map((r) => {
                      const ladder = ladderState(r);
                      const next = nextStepLabel(r.collection);
                      return (
                        <tr key={r.tenant_id} className="cursor-pointer hover:bg-muted/40" onClick={() => setOpenRow(r)}>
                          {canAssign && (
                            <td className="px-3 py-3" onClick={(e) => e.stopPropagation()}>
                              <Checkbox checked={selected.has(r.tenant_id)} onCheckedChange={(on) => toggle(r.tenant_id, on)} aria-label={`Seleccionar ${r.name}`} />
                            </td>
                          )}
                          <td className="px-4 py-3">
                            <button type="button" className="text-left font-medium hover:underline" onClick={() => setOpenRow(r)}>
                              {r.name}
                            </button>
                            <span className="block text-xs text-muted-foreground">
                              {BILLING_MODE_LABELS[r.billing_mode] ?? r.billing_mode}
                              {r.plan_name ? ` · ${r.plan_name}` : ""}
                            </span>
                          </td>
                          <td className="whitespace-nowrap px-4 py-3 text-right font-semibold tabular-nums">{formatCents(r.balance_cents)}</td>
                          <td className="whitespace-nowrap px-4 py-3 text-right tabular-nums">
                            {r.overdue_cents > 0 ? <span className="text-danger">{formatCents(r.overdue_cents)}</span> : <NoData />}
                          </td>
                          <td className="whitespace-nowrap px-4 py-3 text-right tabular-nums">
                            {r.days_overdue > 0 ? <Badge tone={r.days_overdue > 30 ? "danger" : "warning"}>{r.days_overdue} d</Badge> : <NoData />}
                          </td>
                          <td className="px-4 py-3">
                            <Badge tone={LADDER_TONES[ladder]}>{LADDER_LABELS[ladder]}</Badge>
                            {next && <span className="mt-1 block text-xs text-muted-foreground">{next}</span>}
                          </td>
                          <td className="whitespace-nowrap px-4 py-3 text-sm">
                            {r.promise ? (
                              <span>
                                {formatCents(r.promise.amount_cents)}
                                <span className="block text-xs text-muted-foreground">el {formatDay(r.promise.promised_date)}</span>
                              </span>
                            ) : (
                              <NoData />
                            )}
                          </td>
                          <td className="px-4 py-3 text-sm">{r.collector?.name ?? <span className="text-muted-foreground">Sin asignar</span>}</td>
                          <td className="max-w-[260px] px-4 py-3 text-xs text-muted-foreground">
                            {r.last_note ? (
                              <>
                                <span className="text-foreground">{formatDay(r.last_note.at)}</span> {r.last_note.body}
                                {r.next_action_at && <span className="mt-0.5 block">Próxima acción: {formatDay(r.next_action_at)}</span>}
                              </>
                            ) : (
                              <NoData />
                            )}
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </TableWrap>

              <ul className="divide-y divide-border overflow-hidden rounded-xl border border-border bg-card md:hidden">
                {rows.map((r) => {
                  const ladder = ladderState(r);
                  return (
                    <li key={r.tenant_id} className="flex items-start gap-3 px-4 py-3">
                      {canAssign && (
                        <Checkbox
                          className="mt-1"
                          checked={selected.has(r.tenant_id)}
                          onCheckedChange={(on) => toggle(r.tenant_id, on)}
                          aria-label={`Seleccionar ${r.name}`}
                        />
                      )}
                      <button type="button" className="flex min-w-0 flex-1 items-start justify-between gap-3 text-left" onClick={() => setOpenRow(r)}>
                        <span className="min-w-0">
                          <span className="flex flex-wrap items-center gap-2">
                            <span className="truncate text-sm font-medium">{r.name}</span>
                            <Badge tone={LADDER_TONES[ladder]}>{LADDER_LABELS[ladder]}</Badge>
                          </span>
                          <span className="mt-0.5 block text-xs text-muted-foreground">
                            {r.overdue_cents > 0 ? `Vencido ${formatCents(r.overdue_cents)} · ${r.days_overdue} d` : "Sin deuda vencida"}
                            {r.promise ? ` · promete el ${formatDay(r.promise.promised_date)}` : ""}
                          </span>
                          <span className="mt-0.5 block text-xs text-muted-foreground">{r.collector?.name ?? "Sin cobrador"}</span>
                        </span>
                        <span className="shrink-0 text-right text-sm font-semibold tabular-nums">{formatCents(r.balance_cents)}</span>
                      </button>
                    </li>
                  );
                })}
              </ul>
            </>
          )}

          {canAssign && (
            <AssignCollectorDialog
              open={assigning}
              onOpenChange={setAssigning}
              tenantIds={[...selected]}
              collectors={data.collectors}
              onDone={() => setSelected(new Set())}
            />
          )}
        </>
      )}

      <Tenant360Drawer
        open={openRow !== null}
        onOpenChange={(o) => !o && setOpenRow(null)}
        tenantId={openRow?.tenant_id ?? null}
        row={openRow ? (data?.rows.find((x) => x.tenant_id === openRow.tenant_id) ?? openRow) : null}
      />
    </section>
  );
}
CollectionPortfolio.displayName = "CollectionPortfolio";
