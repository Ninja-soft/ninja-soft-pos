"use client";

import { useMemo, useState } from "react";
import Link from "next/link";
import { ArrowLeft, Download, HandCoins, Mail, Percent, Search, CalendarCheck } from "lucide-react";
import { Button, buttonVariants } from "@/components/ui/Button";
import { Eyebrow, Display } from "@/components/ui/Typography";
import { headerActionsRow } from "@/components/ui/PageHeader";
import { Segmented } from "@/components/ui/Segmented";
import { SpinnerBlock } from "@/components/ui/Spinner";
import { NoData } from "@/components/ui/NoData";
import { useToast } from "@/components/ui/Toast";
import { cn } from "@/lib/utils/cn";
import { formatCurrency } from "@/lib/utils/format";
import { exportXlsx } from "@/lib/utils/xlsx";
import { AGING_BUCKETS, type AgingBucket } from "@/lib/account/aging";
import { useFeature } from "@/modules/saas/gating";
import { useMyTenant } from "@/modules/tenants/hooks";
import { useAccountAging, useAccountMutations } from "@/modules/customers/hooks";
import { accountErrorMessage, type AgingRow } from "@/modules/customers/account";
import { EChart, themeColors } from "@/components/account/EChart";
import { CollectModal } from "@/components/account/CollectModal";
import { CollectionItemModal } from "@/components/account/CollectionItemModal";
import { AccountLocked } from "@/components/account/AccountLocked";
import {
  CreditStatusPill,
  WhatsAppLogo,
  fmtDate,
  waLink,
  whatsappDebtMessage,
} from "@/components/account/shared";

type Filter = "all" | "overdue" | "promises";

const BUCKET_COLORS: Record<AgingBucket, string> = {
  current: "#22c55e",
  d1_30: "#f59e0b",
  d31_60: "#f97316",
  d61_90: "#ef4444",
  d90_plus: "#b91c1c",
};

function Kpi({ label, value, tone }: { label: string; value: string; tone?: "danger" | "warning" }) {
  return (
    <div className="rounded-lg bg-card p-4 ring-1 ring-border">
      <div className="text-xs text-muted-foreground">{label}</div>
      <div
        className={cn(
          "mt-1 font-price text-xl font-black tabular-nums",
          tone === "danger" && "text-danger",
          tone === "warning" && "text-warning",
        )}
      >
        {value}
      </div>
    </div>
  );
}

// Tablero de cobranza (Cuenta corriente v2): KPIs, aging por vencimiento
// (server-side, ECharts) y lista priorizada por mora con acciones rápidas.
export default function CuentasPage() {
  const { toast } = useToast();
  const enabled = useFeature("cuenta_corriente");
  const cobranza = useFeature("cc_cobranza");
  const punitorios = useFeature("cc_punitorios");
  const { data: me } = useMyTenant();
  const { data, isLoading, isError, refetch } = useAccountAging(null, enabled !== false);
  const m = useAccountMutations();
  const [search, setSearch] = useState("");
  const [filter, setFilter] = useState<Filter>("all");
  const [bucket, setBucket] = useState<AgingBucket | null>(null);
  const [collectFor, setCollectFor] = useState<AgingRow | null>(null);
  const [promiseFor, setPromiseFor] = useState<AgingRow | null>(null);
  const [sendingId, setSendingId] = useState<string | null>(null);

  const totals = data?.totals;
  const rows = useMemo(() => {
    const s = search.trim().toLowerCase();
    return (data?.customers ?? []).filter((r) => {
      if (s && !r.name.toLowerCase().includes(s)) return false;
      if (filter === "overdue" && !(r.overdue > 0)) return false;
      if (filter === "promises" && !r.promise) return false;
      if (bucket && !(Number(r[bucket]) > 0)) return false;
      return true;
    });
  }, [data, search, filter, bucket]);

  const chartOption = useMemo(() => {
    const c = themeColors();
    return {
      grid: { left: 8, right: 8, top: 16, bottom: 4, containLabel: true },
      tooltip: {
        trigger: "item",
        valueFormatter: (v: number) => formatCurrency(v),
      },
      xAxis: {
        type: "category",
        data: AGING_BUCKETS.map((b) => b.label),
        // Todas las etiquetas visibles y partidas en dos líneas si no entran
        // (a 390 px "Más de 90 días" se cortaba contra el borde).
        axisLabel: { color: c.muted, fontSize: 11, interval: 0, width: 56, overflow: "break", lineHeight: 13 },
        axisLine: { lineStyle: { color: c.border } },
      },
      yAxis: {
        type: "value",
        axisLabel: { color: c.muted, fontSize: 11 },
        splitLine: { lineStyle: { color: c.border } },
      },
      series: [
        {
          type: "bar",
          barMaxWidth: 48,
          data: AGING_BUCKETS.map((b) => ({
            value: Number(totals?.[b.key] ?? 0),
            itemStyle: { color: BUCKET_COLORS[b.key], borderRadius: [6, 6, 0, 0] },
          })),
        },
      ],
    };
  }, [totals]);

  async function sendStatement(r: AgingRow) {
    setSendingId(r.customer_id);
    try {
      await m.sendStatement.mutateAsync({ customerId: r.customer_id });
      toast({ title: `Estado de cuenta enviado a ${r.email}`, variant: "success" });
    } catch (e) {
      toast({ title: "No se pudo enviar", description: accountErrorMessage(e), variant: "error" });
    } finally {
      setSendingId(null);
    }
  }

  async function accrue() {
    try {
      const r = await m.accrue.mutateAsync();
      toast({
        title: r.movements > 0 ? `Se liquidaron ${r.movements} punitorios` : "No había punitorios para liquidar",
        variant: "success",
      });
    } catch (e) {
      toast({ title: "No se pudo calcular", description: accountErrorMessage(e), variant: "error" });
    }
  }

  function logWhatsApp(r: AgingRow) {
    if (cobranza) {
      m.addItem.mutate({ customerId: r.customer_id, type: "reminder_log", channel: "whatsapp", body: "Recordatorio por WhatsApp" });
    }
  }

  async function exportList() {
    await exportXlsx("cuentas-corrientes", [
      {
        name: "Cuentas corrientes",
        title: `Cuentas corrientes al ${fmtDate(data?.as_of)} • NinjaPos`,
        columns: [
          { header: "Cliente", key: "name" },
          { header: "No vencido", key: "current", type: "money" },
          { header: "1 a 30", key: "d1_30", type: "money" },
          { header: "31 a 60", key: "d31_60", type: "money" },
          { header: "61 a 90", key: "d61_90", type: "money" },
          { header: "Más de 90", key: "d90_plus", type: "money" },
          { header: "Vencido", key: "overdue", type: "money" },
          { header: "Total", key: "total", type: "money" },
          { header: "Días de mora", key: "max_days_overdue", type: "number" },
        ],
        rows: rows.map((r) => ({ ...r })),
      },
    ]);
  }

  return (
    <>
      <div className="mx-auto max-w-6xl px-4 py-8 sm:px-6">
        <Link href="/clientes" className="inline-flex items-center gap-1 text-sm text-muted-foreground hover:text-foreground">
          <ArrowLeft size={14} /> Clientes
        </Link>
        <div className="mt-2 flex flex-col gap-4">
          <div className="min-w-0">
            <Eyebrow>Cobranza</Eyebrow>
            <Display className="mt-3 break-words text-3xl md:text-4xl">Cuentas corrientes</Display>
          </div>
          {enabled !== false && (
            <div className={headerActionsRow}>
              {me?.canManage && punitorios && (
                <Button variant="secondary" loading={m.accrue.isPending} onClick={accrue}>
                  <Percent size={16} /> Calcular punitorios
                </Button>
              )}
              <Button variant="secondary" onClick={exportList} disabled={rows.length === 0}>
                <Download size={16} /> Exportar XLSX
              </Button>
            </div>
          )}
        </div>

        {enabled === false ? (
          <AccountLocked />
        ) : isLoading ? (
          <SpinnerBlock className="py-20" />
        ) : isError || !data ? (
          <div className="mt-8 rounded-xl bg-red-400/10 p-6 text-center text-sm text-danger">
            No se pudo cargar la cobranza.{" "}
            <button onClick={() => refetch()} className="underline">
              Reintentar
            </button>
          </div>
        ) : (
          <>
            <div className="mt-6 grid grid-cols-2 gap-3 lg:grid-cols-4">
              <Kpi label="Total a cobrar" value={formatCurrency(totals?.total)} />
              <Kpi label="Vencido" value={formatCurrency(totals?.overdue)} tone="danger" />
              <Kpi label="Vence en 7 días" value={formatCurrency(totals?.due_next_7)} tone="warning" />
              <Kpi label="Punitorios del mes" value={formatCurrency(totals?.interest_month)} />
            </div>

            <div className="mt-4 rounded-lg bg-card p-4 ring-1 ring-border">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <h2 className="text-sm font-semibold">Antigüedad de la deuda (por vencimiento)</h2>
                {bucket && (
                  <button
                    onClick={() => setBucket(null)}
                    className="rounded-md bg-ninja-flame/15 px-2.5 py-1 text-xs font-medium"
                  >
                    {AGING_BUCKETS.find((b) => b.key === bucket)?.label} · quitar filtro
                  </button>
                )}
              </div>
              <EChart
                option={chartOption}
                height={220}
                className="mt-2"
                onClickName={(name) => setBucket(AGING_BUCKETS.find((b) => b.label === name)?.key ?? null)}
              />
              <p className="mt-1 text-xs text-muted-foreground">
                {totals?.customers_overdue ?? 0} de {totals?.customers ?? 0} clientes con deuda vencida · cobrado
                este mes {formatCurrency(totals?.collected_month)}
              </p>
            </div>

            <div className="mt-6 flex flex-wrap items-center gap-2">
              <div className="relative min-w-0 basis-full sm:max-w-xs sm:flex-1 sm:basis-auto">
                <Search size={16} className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-muted-foreground" />
                <input
                  value={search}
                  onChange={(e) => setSearch(e.target.value)}
                  placeholder="Buscar cliente"
                  className="h-11 w-full rounded-lg border border-input bg-background pl-9 pr-4 text-sm outline-none focus:border-ninja-flameSoft"
                />
              </div>
              <Segmented
                value={filter}
                onChange={setFilter}
                options={[
                  { value: "all", label: "Todos" },
                  { value: "overdue", label: "Vencidos" },
                  { value: "promises", label: "Con promesa" },
                ]}
              />
            </div>

            <ul className="mt-3 space-y-2">
              {rows.length === 0 && (
                <li className="rounded-xl bg-muted/30 px-4 py-10 text-center text-sm text-muted-foreground">
                  {data.customers.length === 0 ? "No hay clientes con deuda." : "Sin resultados para el filtro."}
                </li>
              )}
              {rows.map((r) => (
                <li key={r.customer_id} className="rounded-lg bg-card p-4 ring-1 ring-border">
                  <div className="flex flex-wrap items-start justify-between gap-3">
                    <div className="min-w-0">
                      <Link
                        href={`/clientes/cuentas/${r.customer_id}`}
                        className="font-semibold text-foreground hover:text-ninja-flameSoft"
                      >
                        {r.name}
                      </Link>
                      <div className="mt-1 flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
                        <CreditStatusPill status={r.credit_status} />
                        {r.max_days_overdue > 0 ? (
                          <span className="font-medium text-danger">{r.max_days_overdue} días de mora</span>
                        ) : r.next_due ? (
                          <span>Próximo vencimiento {fmtDate(r.next_due)}</span>
                        ) : null}
                        {r.promise && (
                          <span
                            className={cn(
                              "inline-flex items-center gap-1 rounded-md px-2 py-0.5",
                              r.promise.broken ? "bg-red-400/15 text-danger" : "bg-sky-400/15 text-foreground",
                            )}
                          >
                            <CalendarCheck size={12} />
                            {r.promise.broken ? "Promesa incumplida" : "Promete"} {formatCurrency(r.promise.amount)} el{" "}
                            {fmtDate(r.promise.date)}
                          </span>
                        )}
                      </div>
                    </div>
                    <div className="text-right">
                      <div className="font-price text-lg font-black tabular-nums">{formatCurrency(r.total)}</div>
                      {r.overdue > 0 ? (
                        <div className="text-xs font-medium text-danger">Vencido {formatCurrency(r.overdue)}</div>
                      ) : (
                        <div className="text-xs text-muted-foreground">Sin vencido</div>
                      )}
                    </div>
                  </div>
                  <div className="mt-3 flex flex-wrap gap-2">
                    <Button size="sm" onClick={() => setCollectFor(r)}>
                      <HandCoins size={15} /> Cobrar
                    </Button>
                    {r.email ? (
                      <Button
                        size="sm"
                        variant="secondary"
                        loading={sendingId === r.customer_id}
                        onClick={() => sendStatement(r)}
                      >
                        <Mail size={15} /> Recordar
                      </Button>
                    ) : null}
                    {r.phone ? (
                      <a
                        href={waLink(
                          r.phone,
                          whatsappDebtMessage({
                            name: r.name,
                            balance: formatCurrency(r.total),
                            overdue: r.overdue > 0 ? formatCurrency(r.overdue) : null,
                            oldestDue: r.oldest_due ? fmtDate(r.oldest_due) : null,
                          }),
                        )}
                        target="_blank"
                        rel="noopener noreferrer"
                        onClick={() => logWhatsApp(r)}
                        className={buttonVariants({ variant: "secondary", size: "sm" })}
                      >
                        <WhatsAppLogo size={15} /> WhatsApp
                      </a>
                    ) : null}
                    {cobranza && (
                      <Button size="sm" variant="ghost" onClick={() => setPromiseFor(r)}>
                        <CalendarCheck size={15} /> Promesa
                      </Button>
                    )}
                    {!r.email && !r.phone && (
                      <span className="self-center text-xs text-muted-foreground">
                        Sin email ni teléfono <NoData />
                      </span>
                    )}
                  </div>
                </li>
              ))}
            </ul>
          </>
        )}
      </div>

      <CollectModal
        open={collectFor !== null}
        onOpenChange={(o) => !o && setCollectFor(null)}
        customerId={collectFor?.customer_id ?? null}
        customerName={collectFor?.name ?? ""}
      />
      <CollectionItemModal
        type={promiseFor ? "promise" : null}
        customerId={promiseFor?.customer_id ?? null}
        customerName={promiseFor?.name ?? ""}
        suggestedAmount={promiseFor?.overdue || promiseFor?.total}
        onOpenChange={(o) => !o && setPromiseFor(null)}
      />
    </>
  );
}
