"use client";

// /reportes/conciliacion: un solo lugar para controlar que lo vendido llegue a
// la cuenta. Resumen del período arriba, tres vistas (Por procesador, Tarjetas
// por lote, Pendientes de revisar), selección múltiple con acciones en lote y
// Excel con todas las hojas. Lee y escribe con las RPC de ADR-044, ADR-061 y
// ADR-064; los permisos los valida el servidor.

import { useCallback, useMemo, useState } from "react";
import Link from "next/link";
import type { Route } from "next";
import { useRouter, useSearchParams } from "next/navigation";
import {
  ArrowLeft,
  Banknote,
  CalendarClock,
  CheckCircle2,
  CreditCard,
  Download,
  Lock,
  Percent,
  ShieldAlert,
  ShoppingBag,
  Wallet,
} from "lucide-react";
import { startOfDay, startOfMonth, subDays, subMonths, endOfMonth } from "date-fns";
import { Button } from "@/components/ui/Button";
import { PageContainer, PageHeader } from "@/components/ui/PageHeader";
import { Segmented } from "@/components/ui/Segmented";
import { DateRangePicker, type DateRange } from "@/components/ui/DateRangePicker";
import { useToast } from "@/components/ui/Toast";
import { GatedButton } from "@/components/saas/GatedAction";
import { UpgradeModal } from "@/components/saas/UpgradeModal";
import { BranchSwitcher } from "@/components/branches/BranchSwitcher";
import { NubceoPromo } from "@/components/integrations/NubceoPromo";
import { ProcessorReconciliation } from "@/components/reports/processors/ProcessorReconciliation";
import { ImportSettlementModal } from "@/components/reports/processors/ImportSettlementModal";
import { MpConnectModal } from "@/components/reports/processors/MpConnectModal";
import { formatCurrency } from "@/lib/utils/format";
import { formatSaleNumber } from "@/lib/utils/saleNumber";
import { exportXlsx } from "@/lib/utils/xlsx";
import { reportScopeLabel } from "@/lib/reports/branchScope";
import {
  dayLabel,
  groupCardRows,
  normalizeCardPayments,
  summarizeCardRows,
  type CardRecRow,
} from "@/lib/reports/cardReconciliation";
import { groupVoucherEdits, voucherEditAccess, type VoucherEditAccess } from "@/lib/reports/voucherEdit";
import { localDay } from "@/lib/reports/processorReconciliation";
import { indexDisputes, type PaymentDisputeRow } from "@/lib/reports/paymentDisputes";
import {
  buildConciliacionSheets,
  buildInbox,
  conciliacionFileName,
  filterLinesByStore,
  hubKpis,
  moneyByDay,
  providerCards,
  releaseCalendar,
  type InboxItem,
} from "@/lib/reports/reconciliationHub";
import { useFeature } from "@/modules/saas/gating";
import { useMyTenant } from "@/modules/tenants/hooks";
import { useSaleNumberFormat } from "@/modules/sales/hooks";
import { useBranchContext } from "@/modules/branches/hooks";
import { useCurrentUserId } from "@/modules/stock/hooks";
import { usePaymentMethodsStatus } from "@/modules/pos/layoutHooks";
import { useTransferAccounts } from "@/modules/payments/transfer";
import { useCardPayments, useVoucherEdits } from "@/modules/reports/cardReconciliation";
import { settlementErrorMessage, useSettlementSync } from "@/modules/reports/processorReconciliation";
import { useDisputesForPayments, useOpenDisputes } from "@/modules/reports/paymentDisputes";
import { useAllSettlementLines, useHubMatches, useSaleInfo } from "@/modules/reports/reconciliationHub";
import { CardBatches } from "./CardBatches";
import { PendingInbox } from "./PendingInbox";
import { ProvidersView } from "./ProvidersView";
import { KpiTile } from "./ui";

type View = "procesadores" | "tarjetas" | "pendientes";

const BASE = "/reportes/conciliacion";

function localISODate(d: Date): string {
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

const shortDay = (iso: string) => {
  const d = new Date(iso);
  return `${d.toLocaleDateString("es-AR", { weekday: "short" }).replace(".", "")} ${dayLabel(localDay(iso)).slice(0, 5)}`;
};

function Locked() {
  const [open, setOpen] = useState(false);
  return (
    <div className="mt-8 rounded-lg bg-muted/40 p-8 text-center">
      <Lock className="mx-auto text-ninja-flameSoft" size={28} />
      <p className="mt-3 font-semibold">La conciliación no está incluida en tu plan</p>
      <p className="mx-auto mt-1 max-w-md text-sm text-muted-foreground">
        Controlá los cobros con tarjeta por lote, traé solos los de Mercado Pago, importá las liquidaciones de tu
        adquirente y mirá cuánto te cobraron y cuándo te acreditan.
      </p>
      <Button className="mt-4" onClick={() => setOpen(true)}>
        Ver planes
      </Button>
      <UpgradeModal open={open} onOpenChange={setOpen} featureKey="conciliacion_tarjetas" featureLabel="Conciliación" />
    </div>
  );
}

export function ConciliacionHub() {
  const router = useRouter();
  const params = useSearchParams();
  const { toast } = useToast();

  const cardsEnabled = useFeature("conciliacion_tarjetas");
  const procEnabled = useFeature("conciliacion_procesadores");
  const exportEnabled = useFeature("export_xlsx");
  const { data: me } = useMyTenant();
  const { data: userId } = useCurrentUserId();
  const { data: numFmt } = useSaleNumberFormat();
  const canManage = Boolean(me?.canManage);
  const procActive = procEnabled === true && canManage;
  const cardsActive = cardsEnabled === true;
  const branch = useBranchContext();
  const scopeLabel = reportScopeLabel(branch.isMulti, branch.filterStore);

  // ── Período ────────────────────────────────────────────────────────────────
  const [range, setRange] = useState<DateRange | undefined>(() => ({
    from: startOfDay(subDays(new Date(), 29)),
    to: startOfDay(new Date()),
  }));
  const { fromISO, toISO, fromDay, toDay } = useMemo(() => {
    const f = startOfDay(range?.from ?? new Date());
    const t = startOfDay(range?.to ?? range?.from ?? new Date());
    const toDay = localISODate(t);
    const end = new Date(t);
    end.setDate(end.getDate() + 1); // inclusivo del día "hasta"
    return { fromISO: f.toISOString(), toISO: end.toISOString(), fromDay: localISODate(f), toDay };
  }, [range]);
  const periodLabel = fromDay === toDay ? dayLabel(fromDay) : `${dayLabel(fromDay)} al ${dayLabel(toDay)}`;

  // ── Vista (URL) ────────────────────────────────────────────────────────────
  const tabs: { value: View; label: string }[] = [];
  if (procActive) tabs.push({ value: "procesadores", label: "Por procesador" });
  tabs.push({ value: "tarjetas", label: "Tarjetas por lote" });
  if (canManage) tabs.push({ value: "pendientes", label: "Pendientes de revisar" });
  const wanted = params.get("vista") as View | null;
  const fromAlert = params.get("filtro") === "disputas";
  const view: View =
    fromAlert && canManage
      ? "pendientes"
      : wanted && tabs.some((t) => t.value === wanted)
        ? wanted
        : procActive
          ? "procesadores"
          : "tarjetas";
  const detailProvider = view === "procesadores" ? params.get("p") : null;
  const go = useCallback(
    (v: View, provider?: string | null) => {
      const q = new URLSearchParams({ vista: v });
      if (provider) q.set("p", provider);
      router.replace(`${BASE}?${q.toString()}` as Route, { scroll: false });
    },
    [router],
  );

  // ── Tarjetas (ADR-044) ─────────────────────────────────────────────────────
  const cardsQ = useCardPayments(fromISO, toISO, cardsActive, branch.filterStoreId);
  const editsQ = useVoucherEdits(fromISO, toISO, cardsActive);
  const cardRows = useMemo(() => normalizeCardPayments(cardsQ.data ?? []), [cardsQ.data]);
  const cardGroups = useMemo(() => groupCardRows(cardRows), [cardRows]);
  const cardSummary = useMemo(() => summarizeCardRows(cardRows), [cardRows]);
  const edits = useMemo(() => groupVoucherEdits(editsQ.data ?? []), [editsQ.data]);
  const access = useCallback(
    (r: CardRecRow): VoucherEditAccess =>
      voucherEditAccess({ role: me?.role, userId, shiftOpenedBy: r.shiftOpenedBy, reconciled: Boolean(r.reconciledAt) }),
    [me?.role, userId],
  );
  const cardTicket = useCallback((n: number | null) => (n == null ? null : formatSaleNumber(n, numFmt)), [numFmt]);

  // ── Procesadores (ADR-061) y disputas (ADR-064) ────────────────────────────
  const { data: methods } = usePaymentMethodsStatus();
  const mpConnected = Boolean(methods?.find((m) => m.provider_key === "mercadopago")?.connected);
  const { data: transferAccounts } = useTransferAccounts();
  const transferBanks = useMemo(
    () => [...new Set((transferAccounts ?? []).filter((a) => a.is_active && !a.deleted_at && a.bank_slug).map((a) => a.bank_slug!))],
    [transferAccounts],
  );
  const linesQ = useAllSettlementLines(fromISO, toISO, procActive);
  const allLines = useMemo(() => linesQ.data ?? [], [linesQ.data]);
  const providerKeys = useMemo(() => {
    const keys = new Set(allLines.map((l) => l.provider_key));
    if (mpConnected) keys.add("mercadopago");
    return [...keys].sort();
  }, [allLines, mpConnected]);
  const matches = useHubMatches(providerKeys, fromISO, toISO, procActive && !detailProvider);
  const openQ = useOpenDisputes(procActive);
  const saleIds = useMemo(
    () => [
      ...allLines.map((l) => l.sale_id),
      ...matches.unmatched.map((u) => u.sale_id),
      ...(openQ.data ?? []).map((d) => d.sale_id),
    ].filter((x): x is string => Boolean(x)),
    [allLines, matches.unmatched, openQ.data],
  );
  const { data: sales } = useSaleInfo(saleIds);
  const saleStore = useCallback((id: string | null) => (id ? (sales?.[id]?.store_id ?? null) : null), [sales]);
  const lines = useMemo(() => filterLinesByStore(allLines, branch.filterStoreId, saleStore), [allLines, branch.filterStoreId, saleStore]);
  const unmatched = useMemo(
    () => (branch.filterStoreId ? matches.unmatched.filter((u) => saleStore(u.sale_id) === branch.filterStoreId) : matches.unmatched),
    [matches.unmatched, branch.filterStoreId, saleStore],
  );
  const mpIds = useMemo(() => lines.filter((l) => l.provider_key === "mercadopago").map((l) => l.external_id ?? ""), [lines]);
  const periodDisputesQ = useDisputesForPayments(mpIds, procActive);
  const dIndex = useMemo(() => indexDisputes(periodDisputesQ.data ?? []), [periodDisputesQ.data]);
  const openDisputes = useMemo(() => openQ.data ?? [], [openQ.data]);
  const cards = useMemo(() => providerCards(lines, unmatched, dIndex), [lines, unmatched, dIndex]);
  const kpis = useMemo(() => hubKpis(cards, openDisputes), [cards, openDisputes]);
  const series = useMemo(() => moneyByDay(lines, dIndex), [lines, dIndex]);
  const calendar = useMemo(() => releaseCalendar(lines, dIndex), [lines, dIndex]);
  const allDisputes = useMemo(() => {
    const m = new Map<string, PaymentDisputeRow>();
    for (const d of [...(periodDisputesQ.data ?? []), ...openDisputes]) m.set(d.id, d);
    return [...m.values()].sort((a, b) => b.occurred_at.localeCompare(a.occurred_at));
  }, [periodDisputesQ.data, openDisputes]);
  const ticket = useCallback(
    (saleId: string | null) => {
      const s = saleId ? sales?.[saleId] : null;
      return s ? formatSaleNumber(s.number, numFmt) : null;
    },
    [sales, numFmt],
  );

  const inbox = useMemo(
    () =>
      canManage
        ? buildInbox({
            lines: procActive ? lines : [],
            unmatched: procActive ? unmatched : [],
            disputes: procActive ? openDisputes : [],
            cardGroups: cardsActive ? cardGroups : [],
            canReconcileCards: cardsActive,
            canResolveLines: procActive,
          })
        : [],
    [canManage, procActive, cardsActive, lines, unmatched, openDisputes, cardGroups],
  );

  // ── Acciones ───────────────────────────────────────────────────────────────
  const sync = useSettlementSync();
  const [importProvider, setImportProvider] = useState<string | null>(null);
  const [connectOpen, setConnectOpen] = useState(false);

  async function runSync() {
    try {
      const r = await sync.mutateAsync({ provider: "mercadopago", fromISO, toISO });
      const fetched = (r.scopes ?? []).reduce((a, s) => a + s.saved, 0);
      toast({ title: `Listo: ${fetched} ${fetched === 1 ? "cobro" : "cobros"} de Mercado Pago`, variant: "success" });
    } catch (e) {
      toast({ title: "No se pudo actualizar", description: settlementErrorMessage(e), variant: "error" });
    }
  }

  const fileBase = { negocio: me?.name ?? null, from: fromDay, to: toDay, branch: branch.filterStore?.name ?? null };
  const ticketText = (id: string | null) => ticket(id) ?? "";

  async function exportAll() {
    const sheets = buildConciliacionSheets({
      negocio: me?.name ?? null,
      periodLabel,
      scopeLabel,
      processors: procActive ? { cards, kpis, lines, index: dIndex, calendar, ticket: ticketText } : null,
      cards: cardsActive ? { groups: cardGroups, summary: cardSummary } : null,
      inbox,
      disputes: procActive ? allDisputes : [],
      ticket: ticketText,
    });
    await exportXlsx(conciliacionFileName(fileBase), sheets);
  }

  async function exportCardSelection(rows: CardRecRow[]) {
    const sheets = buildConciliacionSheets({
      negocio: me?.name ?? null,
      periodLabel: `${periodLabel} · ${rows.length} ${rows.length === 1 ? "cobro elegido" : "cobros elegidos"}`,
      scopeLabel,
      processors: null,
      cards: { groups: groupCardRows(rows), summary: summarizeCardRows(rows) },
      inbox: [],
      disputes: [],
      ticket: ticketText,
    });
    await exportXlsx(conciliacionFileName(fileBase).replace(/\.xlsx$/, "_seleccion.xlsx"), sheets);
  }

  async function exportInboxSelection(items: InboxItem[]) {
    const sheets = buildConciliacionSheets({
      negocio: me?.name ?? null,
      periodLabel: `${periodLabel} · ${items.length} pendientes elegidos`,
      scopeLabel,
      processors: null,
      cards: null,
      inbox: items,
      disputes: items.flatMap((i) => (i.dispute ? [i.dispute] : [])),
      ticket: ticketText,
    });
    await exportXlsx(conciliacionFileName(fileBase).replace(/\.xlsx$/, "_pendientes.xlsx"), sheets);
  }

  // ── Render ─────────────────────────────────────────────────────────────────
  const locked = cardsEnabled === false && procEnabled === false;
  const loadingProc = procActive && linesQ.isLoading;
  const inboxCount = inbox.length;
  const tabOptions = tabs.map((t) => ({
    value: t.value,
    label: t.value === "pendientes" && inboxCount > 0 ? `${t.label} (${inboxCount})` : t.label,
  }));

  return (
    <PageContainer>
      <Link href="/reportes" className="inline-flex items-center gap-1 text-sm text-muted-foreground hover:text-foreground">
        <ArrowLeft size={14} /> Reportes
      </Link>
      <PageHeader
        className="mt-2"
        eyebrow="Reportes"
        title="Conciliación"
        description={
          <>
            Controlá que lo que vendiste con tarjetas, billeteras y transferencias te llegue a la cuenta: cuánto te
            cobraron, cuándo te acreditan y qué no cierra con tus ventas.
            {scopeLabel && (
              <span className="mt-1 block">
                Mirando <span className="font-medium text-foreground">{scopeLabel}</span>.
              </span>
            )}
          </>
        }
        actions={
          !locked ? (
            <GatedButton
              feature="export_xlsx"
              featureLabel="Exportar a Excel"
              variant="secondary"
              onClick={exportAll}
              disabled={cardRows.length === 0 && lines.length === 0 && inbox.length === 0}
            >
              <Download size={16} /> Exportar Excel
            </GatedButton>
          ) : undefined
        }
      />

      {locked ? (
        <Locked />
      ) : (
        <>
          {/* Período y sucursal */}
          <div className="mt-5 flex flex-col gap-3 sm:flex-row sm:flex-wrap sm:items-end">
            <div className="flex min-w-0 flex-col gap-1">
              <span className="text-xs text-muted-foreground">Período</span>
              <DateRangePicker value={range} onChange={setRange} />
            </div>
            <div className="flex min-w-0 flex-col gap-1">
              <span className="text-xs text-muted-foreground">Rápido</span>
              <div className="flex flex-wrap gap-1">
                {(
                  [
                    { label: "Hoy", from: 0 },
                    { label: "7 días", from: 6 },
                    { label: "30 días", from: 29 },
                    { label: "Este mes", month: 0 },
                    { label: "Mes pasado", month: 1 },
                  ] as const
                ).map((p) => (
                  <button
                    key={p.label}
                    type="button"
                    onClick={() => {
                      const today = startOfDay(new Date());
                      if ("month" in p) {
                        const m = subMonths(today, p.month);
                        setRange({ from: startOfMonth(m), to: p.month === 0 ? today : startOfDay(endOfMonth(m)) });
                      } else setRange({ from: subDays(today, p.from), to: today });
                    }}
                    className="rounded-md border border-input bg-background px-2.5 py-2 text-xs text-muted-foreground transition hover:border-foreground/30 hover:text-foreground"
                  >
                    {p.label}
                  </button>
                ))}
              </div>
            </div>
            {branch.isMulti && (
              <div className="flex min-w-0 flex-col gap-1 sm:w-56">
                <span className="text-xs text-muted-foreground">Sucursal</span>
                <BranchSwitcher />
              </div>
            )}
          </div>

          {/* Resumen del período */}
          {!detailProvider &&
            (procActive ? (
              <div className="mt-5 grid grid-cols-2 gap-3 lg:grid-cols-5">
                <KpiTile
                  icon={ShoppingBag}
                  label="Vendiste"
                  value={formatCurrency(kpis.sold)}
                  sub={`${kpis.count} ${kpis.count === 1 ? "cobro" : "cobros"} · ${kpis.providers} ${kpis.providers === 1 ? "procesador" : "procesadores"}`}
                />
                <KpiTile
                  icon={Percent}
                  label="Te cobraron comisiones e impuestos"
                  value={formatCurrency(kpis.charged)}
                  sub={`${kpis.costPct.toLocaleString("es-AR")} % de lo vendido`}
                />
                <KpiTile icon={Wallet} label="Te acreditaron" value={formatCurrency(kpis.released)} tone="success" sub="Ya está en tu cuenta" />
                <KpiTile
                  icon={CalendarClock}
                  label="Falta acreditar"
                  value={formatCurrency(kpis.pending)}
                  tone={kpis.pending > 0 ? "warning" : undefined}
                  sub={kpis.nextRelease ? `Lo próximo: ${shortDay(kpis.nextRelease)}` : "Sin acreditaciones pendientes"}
                />
                <KpiTile
                  icon={ShieldAlert}
                  label="En riesgo"
                  value={formatCurrency(kpis.atRisk)}
                  tone={kpis.atRisk > 0 ? "danger" : undefined}
                  strip={kpis.atRisk > 0}
                  className="col-span-2 lg:col-span-1"
                  sub={kpis.riskCount ? `${kpis.riskCount} ${kpis.riskCount === 1 ? "contracargo o reclamo" : "contracargos y reclamos"}` : "Sin contracargos ni reclamos"}
                />
              </div>
            ) : cardsActive ? (
              <div className="mt-5 grid grid-cols-1 gap-3 sm:grid-cols-3">
                <KpiTile
                  icon={CreditCard}
                  label="Cobraste con tarjeta"
                  value={formatCurrency(cardSummary.total.amount)}
                  sub={`${cardSummary.total.count} ${cardSummary.total.count === 1 ? "cobro" : "cobros"}`}
                />
                <KpiTile
                  icon={CheckCircle2}
                  label="Conciliado"
                  tone="success"
                  value={formatCurrency(cardSummary.reconciled.amount)}
                  sub={`${cardSummary.reconciled.count} ${cardSummary.reconciled.count === 1 ? "cobro" : "cobros"}`}
                />
                <KpiTile
                  icon={Banknote}
                  label="Pendiente"
                  tone={cardSummary.pending.count > 0 ? "warning" : undefined}
                  value={formatCurrency(cardSummary.pending.amount)}
                  sub={`${cardSummary.pending.count} ${cardSummary.pending.count === 1 ? "cobro" : "cobros"}`}
                />
              </div>
            ) : null)}

          {tabs.length > 1 && (
            <Segmented<View> scrollOnMobile
              aria-label="Vista de la conciliación"
              className="mt-5"
              value={view}
              onChange={(v) => go(v)}
              options={tabOptions}
            />
          )}

          {view === "procesadores" && procActive && (
            detailProvider ? (
              <ProcessorReconciliation
                provider={detailProvider}
                fromISO={fromISO}
                toISO={toISO}
                onBack={() => go("procesadores")}
              />
            ) : (
              <>
                <ProvidersView
                  cards={cards}
                  series={series}
                  calendar={calendar}
                  loading={loadingProc}
                  mpConnected={mpConnected}
                  transferBanks={transferBanks}
                  syncing={sync.isPending}
                  onOpen={(p) => go("procesadores", p)}
                  onConnectMp={() => setConnectOpen(true)}
                  onImport={setImportProvider}
                  onSync={runSync}
                />
                {matches.errors > 0 && (
                  <p className="mt-3 text-xs text-warning">
                    No se pudo cruzar con las ventas en {matches.errors === 1 ? "un procesador" : `${matches.errors} procesadores`}. Probá un período de hasta 93 días.
                  </p>
                )}
                <NubceoPromo className="mt-5" />
              </>
            )
          )}

          {view === "tarjetas" &&
            (cardsEnabled === false ? (
              <Locked />
            ) : (
              <CardBatches
                all={cardRows}
                isLoading={cardsQ.isLoading}
                isError={cardsQ.isError}
                refetch={() => void cardsQ.refetch()}
                edits={edits}
                canManage={canManage}
                role={me?.role}
                access={access}
                ticket={cardTicket}
                canExport={exportEnabled === true}
                onExportSelection={(rows) => void exportCardSelection(rows)}
              />
            ))}

          {view === "pendientes" && canManage && (
            <PendingInbox
              items={inbox}
              loading={cardsQ.isLoading || loadingProc}
              ticket={ticket}
              canExport={exportEnabled === true}
              onExportSelection={(items) => void exportInboxSelection(items)}
              onOpenCards={() => go("tarjetas")}
              onRefetch={() => void linesQ.refetch()}
            />
          )}

          <ImportSettlementModal
            open={importProvider !== null}
            onOpenChange={(o) => {
              if (!o) setImportProvider(null);
            }}
            provider={importProvider ?? "payway"}
            fromISO={fromISO}
            toISO={toISO}
          />
          <MpConnectModal open={connectOpen} onOpenChange={setConnectOpen} />
        </>
      )}
    </PageContainer>
  );
}
