"use client";

// Conciliación de procesadores (ADR-061): vista "Procesadores" de
// /reportes/conciliacion. Mercado Pago entra solo por API (todos los días y
// con "Actualizar ahora"); Payway y cualquier adquirente por archivo. El
// cruce con las ventas es automático y esta pantalla muestra el resumen en
// lenguaje simple, los gráficos y las excepciones para resolver.

import { useMemo, useState } from "react";
import Link from "next/link";
import type { Route } from "next";
import {
  AlertTriangle,
  CheckCircle2,
  ChevronDown,
  ChevronRight,
  Download,
  FileUp,
  Info,
  Link2,
  Lock,
  MoreHorizontal,
  Plug,
  Receipt,
  RefreshCw,
} from "lucide-react";
import { startOfDay, startOfMonth, subDays } from "date-fns";
import { Button } from "@/components/ui/Button";
import { Badge, type BadgeTone } from "@/components/ui/Badge";
import { Callout } from "@/components/ui/Callout";
import { DateRangePicker, type DateRange } from "@/components/ui/DateRangePicker";
import { EmptyState } from "@/components/ui/EmptyState";
import { Segmented } from "@/components/ui/Segmented";
import { Switch } from "@/components/ui/Switch";
import { Spinner } from "@/components/ui/Spinner";
import { NoData } from "@/components/ui/NoData";
import { TableStateRow, TableWrap } from "@/components/ui/Table";
import { ThemedLogo, CardBrandLogo } from "@/components/ui/ThemedLogo";
import { Dropdown, DropdownContent, DropdownItem, DropdownTrigger } from "@/components/ui/Dropdown";
import { useToast } from "@/components/ui/Toast";
import { EChart } from "@/components/charts/EChart";
import { doughnutOption, stackedBarOption } from "@/components/charts/builders";
import { GatedButton } from "@/components/saas/GatedAction";
import { UpgradeModal } from "@/components/saas/UpgradeModal";
import { cn } from "@/lib/utils/cn";
import { formatCurrency } from "@/lib/utils/format";
import { formatSaleNumber } from "@/lib/utils/saleNumber";
import { exportXlsx } from "@/lib/utils/xlsx";
import { paymentIcon } from "@/lib/payments/logos";
import { normalizeCardBrand } from "@/lib/payments/terminal/normalize";
import {
  MATCH_LABEL,
  MONEY_LABEL,
  SETTLEMENT_PROVIDERS,
  XLSX_LINE_COLUMNS,
  dailySeries,
  feeBreakdown,
  filterLines,
  matchMethodLabel,
  moneyState,
  providerLabel,
  summarize,
  summarySentences,
  xlsxLineRows,
  type LineFilter,
  type MatchTone,
  type SettlementLineRow,
  type UnmatchedPayment,
} from "@/lib/reports/processorReconciliation";
import {
  settlementErrorMessage,
  useResolveLine,
  useSaleNumbers,
  useSetAutoSync,
  useSettlementLines,
  useSettlementMatch,
  useSettlementSync,
  useSettlementSyncState,
} from "@/modules/reports/processorReconciliation";
import { useFeature } from "@/modules/saas/gating";
import { useMyTenant } from "@/modules/tenants/hooks";
import { useSaleNumberFormat } from "@/modules/sales/hooks";
import { usePaymentMethodsStatus } from "@/modules/pos/layoutHooks";
import { ImportSettlementModal } from "./ImportSettlementModal";
import { MpConnectModal } from "./MpConnectModal";
import { CreateSaleFromLineModal, IgnoreLineModal, LinkLineModal } from "./LineActionModals";

const FEATURE = "conciliacion_procesadores";

const TONE: Record<MatchTone, BadgeTone> = { success: "success", warning: "warning", danger: "danger", neutral: "neutral" };

const fmtDate = (iso: string) => new Date(iso).toLocaleDateString("es-AR", { day: "2-digit", month: "2-digit" });
const fmtLongDate = (iso: string) =>
  new Date(iso).toLocaleDateString("es-AR", { weekday: "long", day: "numeric", month: "long" });

function ago(iso: string | null | undefined): string {
  if (!iso) return "nunca";
  const min = Math.round((Date.now() - Date.parse(iso)) / 60_000);
  if (min < 1) return "recién";
  if (min < 60) return `hace ${min} min`;
  const h = Math.round(min / 60);
  if (h < 24) return `hace ${h} h`;
  return new Date(iso).toLocaleString("es-AR", { dateStyle: "short", timeStyle: "short" });
}

function localISODate(d: Date): string {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

function Kpi({ label, value, sub, tone }: { label: string; value: string; sub?: string; tone?: "success" | "warning" | "danger" }) {
  return (
    <div className="min-w-0 rounded-lg border border-border bg-card px-4 py-3.5">
      <div className="text-xs font-medium text-muted-foreground">{label}</div>
      <div
        className={cn(
          "mt-1 truncate font-price text-xl font-bold tabular-nums",
          tone === "success" && "text-success",
          tone === "warning" && "text-warning",
          tone === "danger" && "text-danger",
        )}
      >
        {value}
      </div>
      {sub && <div className="mt-0.5 truncate text-xs text-muted-foreground">{sub}</div>}
    </div>
  );
}

function Locked() {
  const [open, setOpen] = useState(false);
  return (
    <div className="mt-8 rounded-xl bg-muted/40 p-8 text-center">
      <Lock className="mx-auto text-ninja-flameSoft" size={28} />
      <p className="mt-3 font-semibold">La conciliación de procesadores no está incluida en tu plan</p>
      <p className="mx-auto mt-1 max-w-md text-sm text-muted-foreground">
        Traé solos los cobros de Mercado Pago todos los días, importá la liquidación de Payway u otros adquirentes y
        mirá cuánto te cobraron de comisiones, cuánto te acreditaron y qué ventas no cierran.
      </p>
      <Button className="mt-4" onClick={() => setOpen(true)}>
        Ver planes
      </Button>
      <UpgradeModal open={open} onOpenChange={setOpen} featureKey={FEATURE} featureLabel="Conciliación de procesadores" />
    </div>
  );
}

function ProviderLogo({ provider, size = 18 }: { provider: string; size?: number }) {
  const src = paymentIcon(provider);
  return src ? (
    <ThemedLogo src={src} alt="" className="h-[18px] w-[18px] shrink-0" />
  ) : (
    <span className="grid shrink-0 place-items-center rounded bg-muted text-muted-foreground" style={{ width: size, height: size }}>
      <Receipt size={size - 6} aria-hidden />
    </span>
  );
}

function MatchBadge({ status }: { status: keyof typeof MATCH_LABEL }) {
  const m = MATCH_LABEL[status];
  return (
    <Badge tone={TONE[m.tone]} title={m.help}>
      {m.label}
    </Badge>
  );
}

function MoneyCell({ line }: { line: SettlementLineRow }) {
  const st = moneyState(line);
  return (
    <div className="flex flex-col items-start gap-0.5">
      <span className={cn("text-xs font-medium", st === "released" ? "text-success" : st === "pending" ? "text-warning" : "text-muted-foreground")}>
        {MONEY_LABEL[st]}
      </span>
      {line.release_date && <span className="text-xs tabular-nums text-muted-foreground">{fmtDate(line.release_date)}</span>}
    </div>
  );
}

const FILTERS: { value: LineFilter; label: string }[] = [
  { value: "exceptions", label: "Para revisar" },
  { value: "all", label: "Todos" },
  { value: "matched", label: "Conciliados" },
  { value: "pending_money", label: "Por acreditar" },
  { value: "pos_only", label: "Venta sin cobro" },
  { value: "ignored", label: "Revisados" },
];

export function ProcessorReconciliation() {
  const { toast } = useToast();
  const enabled = useFeature(FEATURE);
  const { data: me } = useMyTenant();
  const canManage = Boolean(me?.canManage);
  const { data: numFmt } = useSaleNumberFormat();
  const { data: methods } = usePaymentMethodsStatus();

  const [provider, setProvider] = useState<string>("mercadopago");
  const providerDef = SETTLEMENT_PROVIDERS.find((p) => p.key === provider)!;
  const [range, setRange] = useState<DateRange | undefined>(() => ({
    from: startOfDay(subDays(new Date(), 29)),
    to: startOfDay(new Date()),
  }));
  const { fromISO, toISO } = useMemo(() => {
    const f = startOfDay(range?.from ?? new Date());
    const t = startOfDay(range?.to ?? range?.from ?? new Date());
    t.setDate(t.getDate() + 1);
    return { fromISO: f.toISOString(), toISO: t.toISOString() };
  }, [range]);
  const [filter, setFilter] = useState<LineFilter>("exceptions");
  const [open, setOpen] = useState<string | null>(null);
  const [importOpen, setImportOpen] = useState(false);
  const [connectOpen, setConnectOpen] = useState(false);
  const [linking, setLinking] = useState<SettlementLineRow | null>(null);
  const [ignoring, setIgnoring] = useState<SettlementLineRow | null>(null);
  const [creating, setCreating] = useState<SettlementLineRow | null>(null);

  const active = enabled === true && canManage;
  const mpConnected = Boolean(methods?.find((m) => m.provider_key === "mercadopago")?.connected);
  const lines = useSettlementLines(provider, fromISO, toISO, active);
  const match = useSettlementMatch(provider, fromISO, toISO, active && (provider !== "mercadopago" || mpConnected));
  const syncState = useSettlementSyncState(provider, active);
  const sync = useSettlementSync();
  const autoSync = useSetAutoSync();
  const resolve = useResolveLine();

  const all = useMemo(() => lines.data ?? [], [lines.data]);
  const unmatched: UnmatchedPayment[] = useMemo(() => match.data?.unmatched_payments ?? [], [match.data]);
  const summary = useMemo(() => summarize(all, unmatched), [all, unmatched]);
  const sentences = summarySentences(summary, provider, formatCurrency, fmtLongDate);
  const visible = useMemo(() => filterLines(all, filter), [all, filter]);
  const series = useMemo(() => dailySeries(all), [all]);
  const fees = useMemo(() => feeBreakdown(all), [all]);
  const saleIds = useMemo(
    () => [...all.map((l) => l.sale_id), ...unmatched.map((u) => u.sale_id)].filter((x): x is string => Boolean(x)),
    [all, unmatched],
  );
  const { data: sales } = useSaleNumbers(saleIds);
  const ticket = (saleId: string | null) => {
    const s = saleId ? sales?.[saleId] : null;
    return s ? formatSaleNumber(s.number, numFmt) : null;
  };
  const mainState = (syncState.data ?? []).find((s) => s.scope_store_id == null) ?? syncState.data?.[0];
  const lastSync = (syncState.data ?? []).reduce<string | null>(
    (a, s) => (s.last_sync_at && (!a || s.last_sync_at > a) ? s.last_sync_at : a),
    null,
  );
  const autoOn = mainState ? mainState.auto_sync : true;
  const showPosOnly = filter === "pos_only" || filter === "exceptions";

  async function runSync() {
    try {
      const r = await sync.mutateAsync({ provider, fromISO, toISO });
      const fetched = (r.scopes ?? []).reduce((a, s) => a + s.saved, 0);
      toast({
        title: `Listo: ${fetched} ${fetched === 1 ? "cobro" : "cobros"} de Mercado Pago`,
        description:
          r.reconciled > 0
            ? `${r.reconciled} ${r.reconciled === 1 ? "cobro quedó conciliado" : "cobros quedaron conciliados"}.`
            : undefined,
        variant: "success",
      });
      void match.refetch();
    } catch (e) {
      toast({ title: "No se pudo actualizar", description: settlementErrorMessage(e), variant: "error" });
    }
  }

  async function act(line: SettlementLineRow, action: "unlink" | "unignore") {
    try {
      await resolve.mutateAsync({ lineId: line.id, action });
      void match.refetch();
    } catch (e) {
      toast({ title: "No se pudo guardar", description: settlementErrorMessage(e), variant: "error" });
    }
  }

  async function exportAll() {
    const tag = localISODate(range?.from ?? new Date());
    await exportXlsx(`conciliacion-${provider}_${tag}`, [
      {
        name: "Resumen",
        title: `Conciliación de ${providerLabel(provider)} • NinjaPos`,
        columns: [
          { header: "Concepto", key: "k", width: 36 },
          { header: "Monto", key: "v", type: "money", width: 16 },
          { header: "Cobros", key: "n", type: "number", width: 10 },
        ],
        rows: [
          { k: "Vendido (bruto menos devoluciones)", v: summary.sold, n: summary.count },
          { k: "Comisiones", v: summary.fees },
          { k: "Impuestos y retenciones", v: summary.taxes },
          { k: "Neto", v: summary.net },
          { k: "Acreditado", v: summary.released },
          { k: "Falta acreditar", v: summary.pending },
          { k: "Conciliado", v: summary.amounts.matched, n: summary.counts.matched },
          { k: "Diferencia de monto", v: summary.amounts.amount_diff, n: summary.counts.amount_diff },
          { k: "Cobro sin venta", v: summary.amounts.missing_in_pos, n: summary.counts.missing_in_pos },
          { k: "Venta sin cobro", v: summary.amounts.pos_only, n: summary.counts.pos_only },
          { k: "Revisados", v: summary.amounts.ignored, n: summary.counts.ignored },
        ],
      },
      {
        name: "Cobros",
        title: `Cobros de ${providerLabel(provider)}`,
        columns: XLSX_LINE_COLUMNS,
        rows: xlsxLineRows(all, (id) => ticket(id) ?? ""),
        totals: {
          bruto: summary.sold + summary.refunded,
          devuelto: summary.refunded,
          comisiones: summary.fees,
          impuestos: summary.taxes,
          neto: summary.net,
        },
      },
      {
        name: "Venta sin cobro",
        title: "Ventas sin cobro en el procesador",
        columns: [
          { header: "Fecha", key: "fecha", width: 18 },
          { header: "Venta", key: "venta", width: 12 },
          { header: "Monto", key: "monto", type: "money", width: 14 },
          { header: "Referencia", key: "ref", width: 40 },
        ],
        rows: unmatched.map((u) => ({
          fecha: new Date(u.created_at).toLocaleString("es-AR", { dateStyle: "short", timeStyle: "short" }),
          venta: ticket(u.sale_id) ?? "",
          monto: u.amount,
          ref: u.provider_payment_id ?? u.intent_id ?? [u.lote, u.cupon].filter(Boolean).join("/"),
        })),
        totals: { monto: summary.amounts.pos_only },
      },
    ]);
  }

  if (enabled === false) return <Locked />;
  if (me && !canManage) {
    return (
      <Callout tone="neutral" icon={Info} className="mt-6">
        La conciliación de procesadores la ven el dueño y los encargados: tiene comisiones, impuestos y acreditaciones.
      </Callout>
    );
  }

  const needsConnect = provider === "mercadopago" && methods !== undefined && !mpConnected;

  return (
    <div className="mt-6 space-y-6">
      {/* Proveedor y período */}
      <div className="grid grid-cols-1 gap-3 sm:flex sm:flex-wrap sm:items-end">
        <div className="flex min-w-0 flex-col gap-1">
          <span className="text-xs text-muted-foreground">Procesador</span>
          <select
            value={provider}
            onChange={(e) => {
              setProvider(e.target.value);
              setOpen(null);
            }}
            className="h-9 w-full min-w-0 rounded-lg border border-input bg-background px-3 text-sm text-foreground outline-none focus:border-ninja-flameSoft sm:w-52"
            aria-label="Procesador"
          >
            {SETTLEMENT_PROVIDERS.map((p) => (
              <option key={p.key} value={p.key}>
                {p.label}
                {p.api ? " (automático)" : " (archivo)"}
              </option>
            ))}
          </select>
        </div>
        <div className="flex min-w-0 flex-col gap-1">
          <span className="text-xs text-muted-foreground">Período</span>
          <DateRangePicker value={range} onChange={setRange} />
        </div>
        <div className="flex min-w-0 flex-col gap-1">
          <span className="text-xs text-muted-foreground">Rápido</span>
          <div className="flex flex-wrap gap-1">
            {(
              [
                { label: "7 días", days: 6 },
                { label: "30 días", days: 29 },
                { label: "Mes", month: true },
              ] as const
            ).map((p) => (
              <button
                key={p.label}
                type="button"
                onClick={() => {
                  const today = startOfDay(new Date());
                  if ("month" in p) setRange({ from: startOfMonth(today), to: today });
                  else setRange({ from: subDays(today, p.days), to: today });
                }}
                className="rounded-md border border-input bg-background px-2.5 py-2 text-xs text-muted-foreground transition hover:border-foreground/30 hover:text-foreground"
              >
                {p.label}
              </button>
            ))}
          </div>
        </div>
        <div className="flex flex-wrap gap-2 sm:ml-auto">
          {providerDef.api ? (
            <Button onClick={runSync} disabled={sync.isPending || needsConnect}>
              <RefreshCw size={15} className={cn(sync.isPending && "animate-spin")} /> Actualizar ahora
            </Button>
          ) : (
            <Button onClick={() => setImportOpen(true)}>
              <FileUp size={15} /> Importar liquidación
            </Button>
          )}
          <GatedButton
            feature="export_xlsx"
            featureLabel="Exportar a Excel"
            variant="secondary"
            onClick={exportAll}
            disabled={all.length === 0 && unmatched.length === 0}
          >
            <Download size={15} /> XLSX
          </GatedButton>
        </div>
      </div>

      {needsConnect ? (
        <Callout
          tone="brand"
          icon={Plug}
          title="Conectá Mercado Pago para conciliar solo"
          actions={
            <Button size="sm" onClick={() => setConnectOpen(true)}>
              Conectar Mercado Pago
            </Button>
          }
        >
          Con la cuenta conectada traemos tus cobros todos los días: comisiones, impuestos, lo que ya te acreditaron y lo
          que falta, y los cruzamos con tus ventas. No hace falta ningún otro sistema.
        </Callout>
      ) : providerDef.api ? (
        <div className="flex flex-wrap items-center gap-x-4 gap-y-2 rounded-lg border border-border bg-card px-4 py-3 text-sm">
          <span className="inline-flex items-center gap-2">
            <ProviderLogo provider={provider} />
            <span>
              Última actualización: <span className="font-medium">{ago(lastSync)}</span>
            </span>
          </span>
          {mainState?.last_error && mainState.last_status !== "ok" && (
            <span className="inline-flex items-center gap-1 text-xs text-warning">
              <AlertTriangle size={13} /> {settlementErrorMessage(new Error(mainState.last_error))}
            </span>
          )}
          <span className="ml-auto inline-flex items-center gap-2">
            <Switch
              checked={autoOn}
              disabled={autoSync.isPending}
              onCheckedChange={(v) => autoSync.mutate({ provider, auto: v })}
              label="Actualizar solo todos los días"
            />
            <span className="text-xs text-muted-foreground">Todos los días a la mañana</span>
          </span>
        </div>
      ) : (
        <Callout tone="neutral" icon={Info}>
          {provider === "payway"
            ? "Payway no ofrece la liquidación por API: descargá el archivo de liquidaciones desde el portal de Payway e importalo acá. El cruce con tus ventas es automático, por lote, cupón y n° de comercio."
            : `Importá el archivo de liquidación de ${providerLabel(provider)} (Excel o CSV). El cruce con tus ventas es automático, por lote, cupón, autorización o monto.`}
        </Callout>
      )}

      {/* Resumen en lenguaje simple */}
      <section className="rounded-lg border border-border bg-card p-4 sm:p-5">
        {lines.isLoading ? (
          <Spinner />
        ) : (
          <div className="space-y-1 text-[15px] leading-relaxed">
            {sentences.map((s, i) => (
              <p key={i} className={cn(i === 0 && "font-semibold")}>
                {s}
              </p>
            ))}
          </div>
        )}
        <div className="mt-4 grid grid-cols-2 gap-3 lg:grid-cols-4">
          <Kpi label="Vendiste" value={formatCurrency(summary.sold)} sub={`${summary.count} ${summary.count === 1 ? "cobro" : "cobros"}`} />
          <Kpi label="Comisiones e impuestos" value={formatCurrency(summary.charged)} sub={`${summary.costPct.toLocaleString("es-AR")} % de lo vendido`} />
          <Kpi label="Te acreditó" tone="success" value={formatCurrency(summary.released)} />
          <Kpi
            label="Falta acreditar"
            tone={summary.pending > 0 ? "warning" : undefined}
            value={formatCurrency(summary.pending)}
            sub={summary.nextRelease ? `Lo próximo: ${fmtDate(summary.nextRelease)}` : undefined}
          />
        </div>
      </section>

      {/* Gráficos */}
      {all.length > 0 && (
        <div className="grid grid-cols-1 gap-4 lg:grid-cols-5">
          <section className="min-w-0 rounded-lg border border-border bg-card p-4 lg:col-span-3">
            <h3 className="text-sm font-semibold">Por día: neto y lo que se llevó el procesador</h3>
            <EChart
              className="mt-2"
              height={260}
              ariaLabel="Neto, comisiones e impuestos por día"
              option={stackedBarOption({
                categories: series.labels,
                series: [
                  { name: "Neto", values: series.net },
                  { name: "Comisiones", values: series.fees },
                  { name: "Impuestos", values: series.taxes },
                ],
                format: "currency",
              })}
              summary={{
                columns: ["Día", "Neto", "Comisiones", "Impuestos"],
                rows: series.labels.map((l, i) => [l, series.net[i]!, series.fees[i]!, series.taxes[i]!]),
              }}
            />
          </section>
          <section className="min-w-0 rounded-lg border border-border bg-card p-4 lg:col-span-2">
            <h3 className="text-sm font-semibold">En qué se fue la comisión</h3>
            <EChart
              className="mt-2"
              height={260}
              ariaLabel="Comisiones e impuestos por concepto"
              empty={fees.length === 0}
              emptyTitle="Sin comisiones en el período"
              option={doughnutOption({
                items: fees.map((f) => ({ label: f.label, value: f.value })),
                name: "Comisiones e impuestos",
                format: "currency",
                centerLabel: "Total",
              })}
              summary={{ columns: ["Concepto", "Monto"], rows: fees.map((f) => [f.label, f.value]) }}
            />
          </section>
        </div>
      )}

      {/* Excepciones y detalle */}
      <section className="space-y-3">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <Segmented<LineFilter>
            aria-label="Filtro de cobros"
            size="sm"
            value={filter}
            onChange={setFilter}
            options={FILTERS.map((f) => ({
              value: f.value,
              label:
                f.value === "exceptions"
                  ? `${f.label} (${summary.counts.missing_in_pos + summary.counts.amount_diff + summary.counts.pos_only})`
                  : f.value === "pos_only"
                    ? `${f.label} (${summary.counts.pos_only})`
                    : f.label,
            }))}
          />
          {match.isFetching && (
            <span className="inline-flex items-center gap-2 text-xs text-muted-foreground">
              <Spinner size={14} /> Cruzando con tus ventas
            </span>
          )}
          {match.isError && (
            <span className="text-xs text-warning">{settlementErrorMessage(match.error)}</span>
          )}
        </div>

        {!lines.isLoading && all.length === 0 && unmatched.length === 0 ? (
          <div className="rounded-xl border border-border bg-card">
            <EmptyState
              icon={CheckCircle2}
              title={`No hay cobros de ${providerLabel(provider)} en este período`}
              description={
                providerDef.api
                  ? "Tocá \"Actualizar ahora\" para traerlos de Mercado Pago, o elegí otro período."
                  : "Importá el archivo de la liquidación para empezar."
              }
            />
          </div>
        ) : (
          <>
            {filter !== "pos_only" && (
              <LinesTable
                lines={visible}
                loading={lines.isLoading}
                open={open}
                onToggle={(id) => setOpen((o) => (o === id ? null : id))}
                ticket={ticket}
                busy={resolve.isPending}
                onLink={setLinking}
                onIgnore={setIgnoring}
                onCreate={provider === "mercadopago" ? setCreating : undefined}
                onUnlink={(l) => act(l, "unlink")}
                onUnignore={(l) => act(l, "unignore")}
                emptyText={filter === "exceptions" ? "No hay cobros para revisar. Todo cierra." : "No hay cobros con este filtro."}
              />
            )}
            {showPosOnly && unmatched.length > 0 && (
              <PosOnlyList items={unmatched} ticket={ticket} provider={provider} />
            )}
          </>
        )}
      </section>

      <ImportSettlementModal open={importOpen} onOpenChange={setImportOpen} provider={provider} fromISO={fromISO} toISO={toISO} />
      <MpConnectModal open={connectOpen} onOpenChange={setConnectOpen} />
      {linking && <LinkLineModal line={linking} onClose={() => setLinking(null)} onDone={() => void match.refetch()} />}
      {ignoring && <IgnoreLineModal line={ignoring} onClose={() => setIgnoring(null)} />}
      {creating && <CreateSaleFromLineModal line={creating} onClose={() => setCreating(null)} onDone={() => void match.refetch()} />}
    </div>
  );
}

// ── Tabla de líneas ──────────────────────────────────────────────────────────

interface LinesTableProps {
  lines: SettlementLineRow[];
  loading: boolean;
  open: string | null;
  onToggle: (id: string) => void;
  ticket: (saleId: string | null) => string | null;
  busy: boolean;
  onLink: (l: SettlementLineRow) => void;
  onIgnore: (l: SettlementLineRow) => void;
  onCreate?: (l: SettlementLineRow) => void;
  onUnlink: (l: SettlementLineRow) => void;
  onUnignore: (l: SettlementLineRow) => void;
  emptyText: string;
}

function MediumCell({ l }: { l: SettlementLineRow }) {
  const brandKey = normalizeCardBrand(l.card_brand);
  return (
    <span className="inline-flex min-w-0 items-center gap-1.5">
      {brandKey ? <CardBrandLogo brand={brandKey} height={18} /> : null}
      <span className="truncate">
        {l.card_brand ?? "Sin dato"}
        {l.last4 ? ` **** ${l.last4}` : ""}
        {l.installments && l.installments > 1 ? ` · ${l.installments} cuotas` : ""}
      </span>
    </span>
  );
}

function LineActions({ l, ...p }: Omit<LinesTableProps, "lines" | "loading" | "open" | "onToggle" | "ticket" | "emptyText"> & { l: SettlementLineRow }) {
  return (
    <Dropdown>
      <DropdownTrigger asChild>
        <button
          type="button"
          disabled={p.busy}
          aria-label="Acciones"
          className="grid h-8 w-8 place-items-center rounded-md text-muted-foreground hover:bg-muted hover:text-foreground"
        >
          <MoreHorizontal size={16} />
        </button>
      </DropdownTrigger>
      <DropdownContent>
        {l.match_status === "missing_in_pos" && p.onCreate && (
          <DropdownItem onSelect={() => p.onCreate?.(l)}>
            <Receipt size={14} /> Crear venta
          </DropdownItem>
        )}
        {(l.match_status === "missing_in_pos" || l.match_status === "amount_diff") && (
          <DropdownItem onSelect={() => p.onLink(l)}>
            <Link2 size={14} /> Vincular a una venta
          </DropdownItem>
        )}
        {l.match_status !== "ignored" && l.match_status !== "matched" && (
          <DropdownItem onSelect={() => p.onIgnore(l)}>
            <CheckCircle2 size={14} /> Marcar revisado
          </DropdownItem>
        )}
        {l.payment_id && l.match_status !== "ignored" && (
          <DropdownItem onSelect={() => p.onUnlink(l)}>Desvincular de la venta</DropdownItem>
        )}
        {l.match_status === "ignored" && <DropdownItem onSelect={() => p.onUnignore(l)}>Volver a revisar</DropdownItem>}
      </DropdownContent>
    </Dropdown>
  );
}

function LineDetail({ l }: { l: SettlementLineRow }) {
  const ids: [string, string | null][] = [
    ["Id del pago", l.external_id],
    ["Orden", l.order_id],
    ["Referencia", l.external_reference],
    ["Autorización", l.autorizacion],
    ["Lote", l.lote],
    ["Cupón", l.cupon],
    ["N° de comercio", l.comercio],
    ["Terminal", l.terminal],
    ["Pagador", l.payer],
  ];
  return (
    <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
      <div>
        <div className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">Comisiones e impuestos</div>
        {l.fee_detail.length === 0 && Number(l.fee) + Number(l.taxes) === 0 ? (
          <p className="mt-1 text-sm text-muted-foreground">Sin comisiones informadas.</p>
        ) : (
          <dl className="mt-1 space-y-1 text-sm">
            {(l.fee_detail.length > 0
              ? l.fee_detail
              : [
                  { label: "Comisiones", amount: l.fee },
                  { label: "Impuestos", amount: l.taxes },
                ]
            ).map((f, i) => (
              <div key={i} className="flex justify-between gap-3">
                <dt className="text-muted-foreground">{f.label}</dt>
                <dd className="tabular-nums">{formatCurrency(Number(f.amount))}</dd>
              </div>
            ))}
            <div className="flex justify-between gap-3 border-t border-border pt-1 font-medium">
              <dt>Neto</dt>
              <dd className="tabular-nums">{formatCurrency(l.net)}</dd>
            </div>
          </dl>
        )}
        {l.match_status === "amount_diff" && (
          <p className="mt-2 text-sm text-warning">
            Diferencia con la venta: {formatCurrency(l.diff_amount)}
            {Number(l.refunded) > 0 ? ` (devuelto ${formatCurrency(l.refunded)})` : ""}.
          </p>
        )}
        {l.match_method && <p className="mt-2 text-xs text-muted-foreground">Cruzado {matchMethodLabel(l.match_method)}.</p>}
        {l.review_note && <p className="mt-2 text-xs text-muted-foreground">Nota: {l.review_note}</p>}
      </div>
      <dl className="grid grid-cols-2 gap-x-4 gap-y-1.5 text-sm">
        {ids
          .filter(([, v]) => v)
          .map(([k, v]) => (
            <div key={k} className="min-w-0">
              <dt className="text-xs text-muted-foreground">{k}</dt>
              <dd className="truncate font-mono text-xs" title={v ?? undefined}>
                {v}
              </dd>
            </div>
          ))}
      </dl>
    </div>
  );
}

function LinesTable(p: LinesTableProps) {
  const { lines, loading, open, onToggle, ticket, emptyText } = p;
  return (
    <>
      {/* Desktop */}
      <TableWrap className="hidden md:block">
        <table className="w-full min-w-[920px] text-sm">
          <thead className="sticky top-0 z-10 bg-popover text-left text-xs text-muted-foreground">
            <tr className="border-b border-border">
              <th className="w-8 px-2 py-2.5" />
              <th className="whitespace-nowrap px-2.5 py-2.5 font-medium">Fecha</th>
              <th className="whitespace-nowrap px-2.5 py-2.5 font-medium">Medio</th>
              <th className="whitespace-nowrap px-2.5 py-2.5 text-right font-medium">Bruto</th>
              <th className="whitespace-nowrap px-2.5 py-2.5 text-right font-medium" title="Comisiones e impuestos">
                Comis. e imp.
              </th>
              <th className="whitespace-nowrap px-2.5 py-2.5 text-right font-medium">Neto</th>
              <th className="whitespace-nowrap px-2.5 py-2.5 font-medium">Plata</th>
              <th className="whitespace-nowrap px-2.5 py-2.5 font-medium">Venta</th>
              <th className="whitespace-nowrap px-2.5 py-2.5 font-medium">Estado</th>
              <th className="w-10 px-2 py-2.5" />
            </tr>
          </thead>
          <tbody className="divide-y divide-border">
            {loading && <TableStateRow colSpan={10} loading />}
            {!loading && lines.length === 0 && (
              <TableStateRow colSpan={10}>
                <span className="text-sm text-muted-foreground">{emptyText}</span>
              </TableStateRow>
            )}
            {lines.map((l) => (
              <LineRowDesktop key={l.id} l={l} open={open === l.id} onToggle={() => onToggle(l.id)} ticket={ticket} p={p} />
            ))}
          </tbody>
        </table>
      </TableWrap>

      {/* Mobile */}
      <div className="space-y-2 md:hidden">
        {loading && <Spinner />}
        {!loading && lines.length === 0 && <p className="py-6 text-center text-sm text-muted-foreground">{emptyText}</p>}
        {lines.map((l) => (
          <div key={l.id} className="rounded-lg border border-border bg-card p-3">
            <div className="flex items-start justify-between gap-2">
              <button type="button" onClick={() => onToggle(l.id)} className="min-w-0 text-left">
                <div className="font-price text-base font-semibold tabular-nums">{formatCurrency(l.gross - l.refunded)}</div>
                <div className="mt-0.5 text-xs text-muted-foreground">
                  {new Date(l.operation_at).toLocaleString("es-AR", { dateStyle: "short", timeStyle: "short" })}
                  {ticket(l.sale_id) ? ` · Venta ${ticket(l.sale_id)}` : ""}
                </div>
              </button>
              <div className="flex items-center gap-1">
                <MatchBadge status={l.match_status} />
                <LineActions l={l} {...p} />
              </div>
            </div>
            <div className="mt-2 flex flex-wrap items-center justify-between gap-2 text-xs">
              <MediumCell l={l} />
              <span className="tabular-nums text-muted-foreground">
                Neto {formatCurrency(l.net)} · {MONEY_LABEL[moneyState(l)]}
                {l.release_date ? ` ${fmtDate(l.release_date)}` : ""}
              </span>
            </div>
            {open === l.id && (
              <div className="mt-3 border-t border-border pt-3">
                <LineDetail l={l} />
              </div>
            )}
          </div>
        ))}
      </div>
    </>
  );
}

function LineRowDesktop({
  l,
  open,
  onToggle,
  ticket,
  p,
}: {
  l: SettlementLineRow;
  open: boolean;
  onToggle: () => void;
  ticket: (id: string | null) => string | null;
  p: LinesTableProps;
}) {
  const t = ticket(l.sale_id);
  return (
    <>
      <tr className={cn("transition hover:bg-muted/40", open && "bg-muted/30")}>
        <td className="px-2 py-2.5">
          <button type="button" onClick={onToggle} aria-label={open ? "Ocultar detalle" : "Ver detalle"} className="text-muted-foreground hover:text-foreground">
            {open ? <ChevronDown size={16} /> : <ChevronRight size={16} />}
          </button>
        </td>
        <td className="whitespace-nowrap px-2.5 py-2.5 tabular-nums text-muted-foreground">
          {new Date(l.operation_at).toLocaleString("es-AR", { dateStyle: "short", timeStyle: "short" })}
        </td>
        <td className="max-w-[220px] px-2.5 py-2.5">
          <MediumCell l={l} />
        </td>
        <td className="whitespace-nowrap px-2.5 py-2.5 text-right tabular-nums">
          {formatCurrency(l.gross)}
          {Number(l.refunded) > 0 && <div className="text-xs text-danger">-{formatCurrency(l.refunded)}</div>}
        </td>
        <td className="whitespace-nowrap px-2.5 py-2.5 text-right tabular-nums text-muted-foreground">
          {Number(l.fee) + Number(l.taxes) > 0 ? formatCurrency(Number(l.fee) + Number(l.taxes)) : <NoData />}
        </td>
        <td className="whitespace-nowrap px-2.5 py-2.5 text-right font-medium tabular-nums">{formatCurrency(l.net)}</td>
        <td className="whitespace-nowrap px-2.5 py-2.5">
          <MoneyCell line={l} />
        </td>
        <td className="whitespace-nowrap px-2.5 py-2.5 font-mono text-xs">{t ?? <NoData />}</td>
        <td className="whitespace-nowrap px-2.5 py-2.5">
          <MatchBadge status={l.match_status} />
        </td>
        <td className="px-2 py-2.5">
          <LineActions l={l} {...p} />
        </td>
      </tr>
      {open && (
        <tr className="bg-muted/20">
          <td />
          <td colSpan={9} className="px-2.5 pb-4 pt-2">
            <LineDetail l={l} />
          </td>
        </tr>
      )}
    </>
  );
}

// ── Venta sin cobro ──────────────────────────────────────────────────────────

function PosOnlyList({
  items,
  ticket,
  provider,
}: {
  items: UnmatchedPayment[];
  ticket: (saleId: string | null) => string | null;
  provider: string;
}) {
  return (
    <div className="rounded-lg border border-border bg-card">
      <div className="flex flex-wrap items-center justify-between gap-2 border-b border-border px-4 py-3">
        <div>
          <h3 className="text-sm font-semibold">Venta sin cobro</h3>
          <p className="text-xs text-muted-foreground">
            Ventas registradas con {providerLabel(provider)} que el procesador no informa en el período. Puede ser un
            cobro rechazado después, una venta cargada con el medio equivocado o un período sin actualizar.
          </p>
        </div>
        <MatchBadge status="pos_only" />
      </div>
      <ul className="divide-y divide-border">
        {items.map((u) => (
          <li key={u.payment_id} className="flex flex-wrap items-center justify-between gap-2 px-4 py-2.5 text-sm">
            <span className="tabular-nums text-muted-foreground">
              {new Date(u.created_at).toLocaleString("es-AR", { dateStyle: "short", timeStyle: "short" })}
            </span>
            <span className="font-mono text-xs">
              {ticket(u.sale_id) ? (
                <Link href={"/ventas" as Route} className="underline underline-offset-2">
                  Venta {ticket(u.sale_id)}
                </Link>
              ) : (
                "Venta"
              )}
              {u.sale_voided ? " (anulada)" : ""}
            </span>
            <span className="truncate font-mono text-xs text-muted-foreground">
              {u.provider_payment_id ?? ([u.lote, u.cupon].filter(Boolean).join(" / ") || null)}
            </span>
            <span className="font-medium tabular-nums">{formatCurrency(u.amount)}</span>
          </li>
        ))}
      </ul>
    </div>
  );
}
