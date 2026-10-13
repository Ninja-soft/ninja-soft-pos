"use client";

// Vista "Por procesador": gráficos del período, calendario de acreditaciones y
// una tarjeta por procesador (logo, plata y barra de estados).

import { ArrowRight, CalendarDays, FileUp, Plug, RefreshCw } from "lucide-react";
import { Button } from "@/components/ui/Button";
import { NoData } from "@/components/ui/NoData";
import { Spinner } from "@/components/ui/Spinner";
import { EChart } from "@/components/charts/EChart";
import { doughnutOption, stackedBarOption } from "@/components/charts/builders";
import { cn } from "@/lib/utils/cn";
import { formatCurrency } from "@/lib/utils/format";
import { dayLabel } from "@/lib/reports/cardReconciliation";
import { localDay, providerLabel } from "@/lib/reports/processorReconciliation";
import {
  soldByProvider,
  type CalendarDay,
  type MoneySeries,
  type ProviderCard,
  type releaseCalendar,
} from "@/lib/reports/reconciliationHub";
import { BankTile, ProviderTile, StatusBar, StatusChip, ToneDot } from "./ui";

const WD = ["Dom", "Lun", "Mar", "Mié", "Jue", "Vie", "Sáb"];
const shortDate = (iso: string) => dayLabel(localDay(iso)).slice(0, 5);

export interface ProvidersViewProps {
  cards: ProviderCard[];
  series: MoneySeries;
  calendar: ReturnType<typeof releaseCalendar>;
  loading: boolean;
  mpConnected: boolean;
  transferBanks: string[];
  syncing: boolean;
  onOpen: (provider: string) => void;
  onConnectMp: () => void;
  onImport: (provider: string) => void;
  onSync: () => void;
}

export function ProvidersView(p: ProvidersViewProps) {
  const withData = p.cards.filter((c) => c.hasData);
  const without = p.cards.filter((c) => !c.hasData && c.key !== "otro");
  const donut = soldByProvider(p.cards);
  const anyRelease = p.calendar.days.some((d) => d.amount !== 0) || p.calendar.later !== 0;

  if (p.loading) {
    return (
      <div className="mt-6 flex justify-center rounded-lg border border-border bg-card py-16">
        <Spinner size={22} />
      </div>
    );
  }

  return (
    <div className="mt-5 space-y-5">
      {withData.length === 0 ? (
        <GettingStarted mpConnected={p.mpConnected} onConnectMp={p.onConnectMp} onImport={p.onImport} />
      ) : (
        <>
          {/* Gráficos */}
          <div className="grid grid-cols-1 gap-4 lg:grid-cols-5">
            <section className="min-w-0 rounded-lg border border-border bg-card p-4 lg:col-span-3">
              <h3 className="text-sm font-semibold">Por día: qué pasó con lo que vendiste</h3>
              <p className="text-xs text-muted-foreground">Lo acreditado, lo que falta y lo que se llevaron comisiones e impuestos.</p>
              <EChart
                className="mt-2"
                height={270}
                ariaLabel="Acreditado, por acreditar y comisiones por día"
                option={stackedBarOption({
                  categories: p.series.labels,
                  series: [
                    { name: "Acreditado", values: p.series.released },
                    { name: "Por acreditar", values: p.series.pending },
                    { name: "Comisiones e impuestos", values: p.series.charged },
                  ],
                  format: "currency",
                })}
                summary={{
                  columns: ["Día", "Acreditado", "Por acreditar", "Comisiones e impuestos"],
                  rows: p.series.labels.map((l, i) => [l, p.series.released[i]!, p.series.pending[i]!, p.series.charged[i]!]),
                }}
              />
            </section>
            <section className="min-w-0 rounded-lg border border-border bg-card p-4 lg:col-span-2">
              <h3 className="text-sm font-semibold">Cuánto vendiste con cada uno</h3>
              <p className="text-xs text-muted-foreground">Bruto menos devoluciones, por procesador.</p>
              <EChart
                className="mt-2"
                height={270}
                ariaLabel="Vendido por procesador"
                empty={donut.length === 0}
                emptyTitle="Sin ventas en el período"
                option={doughnutOption({
                  items: donut.map((d) => ({ label: d.label, value: d.value })),
                  name: "Vendido",
                  format: "currency",
                  centerLabel: "Vendido",
                })}
                summary={{ columns: ["Procesador", "Vendido"], rows: donut.map((d) => [d.label, d.value]) }}
              />
            </section>
          </div>

          {/* Calendario de acreditaciones */}
          <ReleaseCalendar calendar={p.calendar} empty={!anyRelease} />

          {/* Una tarjeta por procesador */}
          <section aria-label="Procesadores con cobros">
            <div className="grid grid-cols-1 gap-3 md:grid-cols-2 xl:grid-cols-3">
              {withData.map((c) => (
                <ProviderCardView
                  key={c.key}
                  card={c}
                  banks={c.key === "transfer" ? p.transferBanks : []}
                  syncing={p.syncing}
                  onOpen={() => p.onOpen(c.key)}
                  onImport={() => p.onImport(c.key)}
                  onSync={p.onSync}
                />
              ))}
            </div>
          </section>
        </>
      )}

      {without.length > 0 && (
        <section aria-label="Sumá más procesadores" className="rounded-lg border border-border bg-card p-4">
          <h3 className="text-sm font-semibold">{withData.length ? "Sumá otros procesadores" : "Procesadores disponibles"}</h3>
          <p className="text-xs text-muted-foreground">
            Mercado Pago entra solo. El resto, con el archivo de liquidación que bajás del portal de cada uno.
          </p>
          <ul className="mt-3 grid grid-cols-1 gap-2 sm:grid-cols-2 lg:grid-cols-4">
            {without.map((c) => (
              <li key={c.key} className="flex items-center gap-3 rounded-md border border-border px-3 py-2.5">
                <ProviderTile logo={c.logo} label={c.label} size={32} />
                <div className="min-w-0 flex-1">
                  <p className="truncate text-sm font-medium">{c.label}</p>
                  {c.key === "transfer" && p.transferBanks.length > 0 ? (
                    <span className="mt-0.5 flex items-center gap-1">
                      {p.transferBanks.slice(0, 4).map((b) => (
                        <BankTile key={b} slug={b} size={16} />
                      ))}
                    </span>
                  ) : (
                    <p className="text-xs text-muted-foreground">{c.api ? "Automático" : "Por archivo"}</p>
                  )}
                </div>
                {c.key === "mercadopago" && !p.mpConnected ? (
                  <Button size="sm" variant="secondary" onClick={p.onConnectMp}>
                    Conectar
                  </Button>
                ) : c.api ? (
                  <Button size="sm" variant="ghost" onClick={() => p.onOpen(c.key)} aria-label={`Abrir ${c.label}`}>
                    <ArrowRight size={15} />
                  </Button>
                ) : (
                  <Button size="sm" variant="ghost" onClick={() => p.onImport(c.key)} aria-label={`Importar liquidación de ${c.label}`}>
                    <FileUp size={15} />
                  </Button>
                )}
              </li>
            ))}
          </ul>
        </section>
      )}
    </div>
  );
}

function GettingStarted({
  mpConnected,
  onConnectMp,
  onImport,
}: {
  mpConnected: boolean;
  onConnectMp: () => void;
  onImport: (provider: string) => void;
}) {
  const steps = [
    {
      logo: "mercadopago",
      title: mpConnected ? "Traé tus cobros de Mercado Pago" : "Conectá Mercado Pago",
      text: mpConnected
        ? "Ya está conectado: los traemos solos todos los días. Si recién lo conectaste, tocá Actualizar en su detalle."
        : "Traemos solos tus cobros, comisiones, impuestos y fechas de acreditación, y los cruzamos con tus ventas.",
      cta: mpConnected ? null : (
        <Button size="sm" onClick={onConnectMp}>
          <Plug size={15} /> Conectar Mercado Pago
        </Button>
      ),
    },
    {
      logo: "payway",
      title: "Importá la liquidación de Payway, Getnet o tu adquirente",
      text: "Bajá el Excel o CSV de liquidaciones del portal e importalo. Detectamos las columnas solas.",
      cta: (
        <Button size="sm" variant="secondary" onClick={() => onImport("payway")}>
          <FileUp size={15} /> Importar liquidación
        </Button>
      ),
    },
  ];
  return (
    <section className="rounded-lg border border-border bg-card p-5">
      <h3 className="font-semibold">Empezá a conciliar en dos pasos</h3>
      <p className="mt-1 text-sm text-muted-foreground">
        Cuando entren los cobros vas a ver cuánto vendiste, cuánto te cobraron, cuándo te acreditan y qué no cierra con tus ventas.
      </p>
      <ol className="mt-4 grid grid-cols-1 gap-3 md:grid-cols-2">
        {steps.map((s, i) => (
          <li key={s.title} className="flex gap-3 rounded-md border border-border p-4">
            <span className="grid h-6 w-6 shrink-0 place-items-center rounded-md bg-muted text-xs font-semibold tabular-nums">
              {i + 1}
            </span>
            <div className="min-w-0 flex-1">
              <div className="flex items-center gap-2">
                <ProviderTile logo={s.logo} label={providerLabel(s.logo)} size={28} />
                <p className="text-sm font-semibold">{s.title}</p>
              </div>
              <p className="mt-2 text-sm text-muted-foreground">{s.text}</p>
              {s.cta && <div className="mt-3">{s.cta}</div>}
            </div>
          </li>
        ))}
      </ol>
    </section>
  );
}

function ProviderCardView({
  card: c,
  banks,
  syncing,
  onOpen,
  onImport,
  onSync,
}: {
  card: ProviderCard;
  banks: string[];
  syncing: boolean;
  onOpen: () => void;
  onImport: () => void;
  onSync: () => void;
}) {
  const s = c.summary;
  const alert = c.toReview > 0 || s.disputes.atRisk > 0;
  return (
    <article
      className={cn(
        "flex min-w-0 flex-col rounded-lg border border-border bg-card",
        alert && "rounded-t-none border-t-2 border-t-warning",
      )}
    >
      <header className="flex items-center gap-3 px-4 pt-4">
        <ProviderTile logo={c.logo} label={c.label} size={40} />
        <div className="min-w-0 flex-1">
          <h3 className="truncate font-semibold">{c.label}</h3>
          <div className="mt-0.5 flex flex-wrap items-center gap-1.5">
            <StatusChip label={c.api ? "Automático" : "Por archivo"} tone="neutral" icon={c.api ? "ok" : "none"} />
            {banks.slice(0, 4).map((b) => (
              <BankTile key={b} slug={b} size={18} />
            ))}
          </div>
        </div>
        <div className="text-right">
          <p className="text-[11px] text-muted-foreground">Conciliado</p>
          <p className="font-semibold tabular-nums">{c.pct}%</p>
        </div>
      </header>

      <div className="px-4 pt-4">
        <p className="text-xs text-muted-foreground">Vendiste</p>
        <p className="font-price text-2xl font-bold tabular-nums">{formatCurrency(s.sold)}</p>
        <p className="text-xs text-muted-foreground">
          {s.count} {s.count === 1 ? "cobro" : "cobros"}
        </p>
      </div>

      <dl className="mt-3 grid grid-cols-3 gap-2 border-y border-border px-4 py-3 text-sm">
        <div className="min-w-0">
          <dt className="truncate text-[11px] text-muted-foreground">Te cobraron</dt>
          <dd className="truncate font-medium tabular-nums">{formatCurrency(s.charged)}</dd>
          <dd className="text-[11px] tabular-nums text-muted-foreground">{s.costPct.toLocaleString("es-AR")} %</dd>
        </div>
        <div className="min-w-0">
          <dt className="truncate text-[11px] text-muted-foreground">Acreditado</dt>
          <dd className="truncate font-medium tabular-nums">{formatCurrency(s.released)}</dd>
        </div>
        <div className="min-w-0">
          <dt className="truncate text-[11px] text-muted-foreground">Falta acreditar</dt>
          <dd className="truncate font-medium tabular-nums">{formatCurrency(s.pending)}</dd>
          <dd className="text-[11px] tabular-nums text-muted-foreground">
            {s.nextRelease ? `Lo próximo ${shortDate(s.nextRelease)}` : <NoData />}
          </dd>
        </div>
      </dl>

      <div className="px-4 py-3">
        <StatusBar segments={c.segments} />
        <ul className="mt-2 flex flex-wrap gap-x-3 gap-y-1 text-[11px] text-muted-foreground">
          {c.segments.map((seg) => (
            <li key={seg.key} className="inline-flex items-center gap-1.5">
              <ToneDot tone={seg.tone} />
              {seg.label} <span className="font-medium tabular-nums text-foreground">{seg.count}</span>
            </li>
          ))}
          {s.disputes.total > 0 && (
            <li className="inline-flex items-center gap-1.5">
              <ToneDot tone="danger" />
              Disputas <span className="font-medium tabular-nums text-foreground">{s.disputes.total}</span>
            </li>
          )}
        </ul>
      </div>

      <footer className="mt-auto flex flex-wrap items-center gap-2 border-t border-border px-4 py-3">
        {c.toReview > 0 && (
          <span className="mr-auto text-xs font-medium text-warning">
            {c.toReview} para revisar
          </span>
        )}
        <div className="ml-auto flex gap-2">
          {c.api ? (
            <Button size="sm" variant="ghost" onClick={onSync} disabled={syncing} aria-label="Actualizar ahora">
              <RefreshCw size={14} className={cn(syncing && "animate-spin")} />
            </Button>
          ) : (
            <Button size="sm" variant="ghost" onClick={onImport} aria-label="Importar liquidación">
              <FileUp size={14} />
            </Button>
          )}
          <Button size="sm" variant="secondary" onClick={onOpen}>
            Ver detalle <ArrowRight size={14} />
          </Button>
        </div>
      </footer>
    </article>
  );
}

function ReleaseCalendar({ calendar, empty }: { calendar: ReturnType<typeof releaseCalendar>; empty: boolean }) {
  return (
    <section className="rounded-lg border border-border bg-card p-4">
      <div className="flex flex-wrap items-end justify-between gap-2">
        <div>
          <h3 className="flex items-center gap-2 text-sm font-semibold">
            <CalendarDays size={15} className="text-muted-foreground" aria-hidden /> Cuándo te acreditan
          </h3>
          <p className="text-xs text-muted-foreground">Lo que falta acreditar, día por día, en las próximas dos semanas.</p>
        </div>
        <div className="flex flex-wrap gap-x-4 gap-y-1 text-xs text-muted-foreground">
          {calendar.later !== 0 && (
            <span>
              Más adelante: <span className="font-medium tabular-nums text-foreground">{formatCurrency(calendar.later)}</span>
            </span>
          )}
          {calendar.undated !== 0 && (
            <span>
              Sin fecha: <span className="font-medium tabular-nums text-foreground">{formatCurrency(calendar.undated)}</span>
            </span>
          )}
        </div>
      </div>
      {empty ? (
        <p className="mt-4 rounded-md bg-muted/50 px-3 py-4 text-center text-sm text-muted-foreground">
          No hay acreditaciones pendientes: todo lo cobrado ya está en tu cuenta.
        </p>
      ) : (
        <div className="-mx-4 mt-3 overflow-x-auto px-4 pb-1">
          <ol className="grid min-w-[640px] grid-cols-7 gap-1.5">
            {calendar.days.map((d) => (
              <CalendarCell key={d.day} d={d} />
            ))}
          </ol>
        </div>
      )}
    </section>
  );
}

function CalendarCell({ d }: { d: CalendarDay }) {
  const [y, m, dd] = d.day.split("-").map(Number);
  const wd = WD[new Date(y!, (m ?? 1) - 1, dd ?? 1).getDay()];
  const has = d.amount !== 0;
  return (
    <li
      className={cn(
        "flex min-h-[84px] flex-col rounded-md border px-2 py-1.5",
        has ? "border-border bg-card" : "border-transparent bg-muted/40",
        d.isToday && "choice-on",
      )}
      title={has ? `${d.count} ${d.count === 1 ? "cobro" : "cobros"}: ${d.providers.map((p) => `${providerLabel(p.key)} ${formatCurrency(p.amount)}`).join(", ")}` : undefined}
    >
      <span className={cn("text-[11px] text-muted-foreground", d.weekend && "opacity-70")}>
        {d.isToday ? "Hoy" : wd} {String(dd).padStart(2, "0")}/{String(m).padStart(2, "0")}
      </span>
      {has ? (
        <>
          <span className="mt-1 truncate text-sm font-semibold tabular-nums">{formatCurrency(d.amount)}</span>
          <span className="mt-auto flex items-center gap-1 pt-1">
            {d.providers.slice(0, 3).map((p) => (
              <ProviderTile key={p.key} logo={p.key} label={providerLabel(p.key)} size={16} className="rounded-[4px]" />
            ))}
          </span>
        </>
      ) : null}
    </li>
  );
}
