"use client";

// Cotización del dólar (ADR-135) en Participación › Gastos: venta del oficial
// de ArgentinaDatos (diaria, por cron), evolución en ECharts por rango, aviso
// si la última corrida falló o quedó vieja, y carga manual del día (manda
// sobre la de la API) con baja auditada.

import { useMemo, useState } from "react";
import { DollarSign, RefreshCw, Trash2, TriangleAlert } from "lucide-react";
import { EChart } from "@/components/charts/EChart";
import { Badge } from "@/components/ui/Badge";
import { Button } from "@/components/ui/Button";
import { Callout } from "@/components/ui/Callout";
import { ConfirmDialog } from "@/components/ui/ConfirmDialog";
import { Input } from "@/components/ui/Input";
import { NoData } from "@/components/ui/NoData";
import { Segmented } from "@/components/ui/Segmented";
import { Skeleton } from "@/components/ui/Skeleton";
import { useToast } from "@/components/ui/Toast";
import { todayAR } from "@/lib/billing/ledger";
import { staffErrorMessage } from "@/lib/staffPayouts/format";
import { toDaily, useFxDaily, useFxLastRun, useFxMutations } from "@/modules/fx/api";
import {
  FX_RANGES,
  FX_SOURCE_LABEL,
  daysBetween,
  effectiveDaily,
  rangeStart,
  rateOn,
  type FxRange,
} from "@/supabase/functions/_shared/fx/rates";
import { Card } from "@/components/internal/staff-payouts/parts";
import { formatFx, fxChartOption, fxDayLabel } from "./fxChartOption";

/** Más de estos días sin cotización nueva: se avisa. */
const STALE_WARN_DAYS = 4;

const parseRate = (s: string) => Number(s.trim().replace(/\./g, "").replace(",", "."));

export function FxRateCard({ legacy }: { legacy?: { period: string; rate: number; source: string | null }[] }) {
  const { toast } = useToast();
  const today = todayAR();
  const [range, setRange] = useState<FxRange>("3M");
  const from = useMemo(() => rangeStart(today, "2A"), [today]);
  const daily = useFxDaily(from);
  const lastRun = useFxLastRun();
  const mut = useFxMutations();

  const rows = useMemo(() => effectiveDaily((daily.data ?? []).map(toDaily)), [daily.data]);
  const current = useMemo(() => rateOn(rows, today), [rows, today]);
  const points = useMemo(() => {
    const start = rangeStart(today, range);
    return rows.filter((r) => r.date >= start);
  }, [rows, range, today]);
  const option = useMemo(() => fxChartOption(points), [points]);
  const manual = useMemo(() => (daily.data ?? []).filter((r) => r.source === "manual").slice(-6).reverse(), [daily.data]);

  const [date, setDate] = useState(today);
  const [venta, setVenta] = useState("");
  const [compra, setCompra] = useState("");
  const [note, setNote] = useState("");
  const [clearing, setClearing] = useState<string | null>(null);
  const ventaN = parseRate(venta);
  const compraN = compra.trim() ? parseRate(compra) : null;

  const run = lastRun.data;
  const stale = current ? daysBetween(current.date, today) : null;
  const first = points[0];
  const last = points[points.length - 1];
  const delta = first && last && first.rate > 0 ? ((last.rate - first.rate) / first.rate) * 100 : null;

  return (
    <Card>
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <h3 className="flex items-center gap-2 font-semibold">
            <DollarSign size={16} className="text-ninja-flameSoft" aria-hidden /> Cotización del dólar
          </h3>
          <p className="mt-1 text-xs text-muted-foreground">
            Venta del dólar oficial (ArgentinaDatos), se actualiza sola de lunes a viernes, cada hora de 10 a 15. Cada gasto en dólares usa la del día en que ocurre o la última anterior.
          </p>
        </div>
        <Button
          variant="secondary"
          size="sm"
          loading={mut.syncNow.isPending}
          onClick={() =>
            mut.syncNow.mutate(undefined, {
              onSuccess: (r) => toast({ title: r.status === "ok" ? "Cotización actualizada" : r.message, variant: r.status === "ok" ? "success" : "error" }),
              onError: (e) => toast({ title: staffErrorMessage(e), variant: "error" }),
            })
          }
        >
          <RefreshCw size={14} aria-hidden /> Actualizar ahora
        </Button>
      </div>

      <div className="mt-4 flex flex-wrap items-end justify-between gap-3">
        <div>
          {daily.isLoading ? (
            <Skeleton className="h-8 w-36" />
          ) : current ? (
            <>
              <p className="text-2xl font-semibold tabular-nums">{formatFx(current.rate)}</p>
              <p className="mt-0.5 flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
                Oficial venta · {fxDayLabel(current.date)}
                <Badge tone={current.source === "manual" ? "info" : "neutral"}>{FX_SOURCE_LABEL[current.source]}</Badge>
                {current.source === "manual" && current.note ? <span>{current.note}</span> : null}
              </p>
            </>
          ) : (
            <p className="flex items-center gap-2 text-sm text-muted-foreground">
              <NoData /> Todavía no hay cotización cargada.
            </p>
          )}
        </div>
        {delta !== null && (
          <p className="text-xs text-muted-foreground">
            En el rango:{" "}
            <span className="font-semibold tabular-nums text-foreground">
              {delta > 0 ? "+" : ""}
              {delta.toLocaleString("es-AR", { maximumFractionDigits: 1 })} %
            </span>
          </p>
        )}
      </div>

      {(run?.status === "error" || (stale !== null && stale > STALE_WARN_DAYS) || daily.error) && (
        <Callout tone="warning" icon={TriangleAlert} className="mt-3">
          {daily.error
            ? "No se pudo leer la cotización. Probá de nuevo en un rato."
            : run?.status === "error"
              ? `${run.message ?? "La última actualización falló."} Podés cargarla a mano abajo.`
              : `La última cotización es del ${fxDayLabel(current!.date)}. Si hace falta, cargala a mano abajo.`}
        </Callout>
      )}

      <div className="mt-4">
        <Segmented
          value={range}
          onChange={setRange}
          size="sm"
          scrollOnMobile
          aria-label="Rango del gráfico"
          options={FX_RANGES.map((r) => ({ value: r.value, label: r.label }))}
        />
      </div>
      <div className="mt-3">
        {daily.isLoading ? (
          <Skeleton className="h-[220px] w-full" />
        ) : points.length === 0 ? (
          <div className="flex h-[160px] items-center justify-center gap-2 rounded-lg bg-muted/40 text-sm text-muted-foreground">
            <NoData /> Sin cotizaciones en este rango.
          </div>
        ) : (
          <EChart
            option={option}
            height={260}
            compactHeight={220}
            ariaLabel="Evolución de la venta del dólar oficial"
            summary={{ columns: ["Fecha", "Venta"], rows: points.slice(-31).map((p) => [fxDayLabel(p.date), formatFx(p.rate)]) }}
          />
        )}
      </div>

      <div className="mt-5 border-t border-border/60 pt-4">
        <p className="text-sm font-medium">Cargar a mano</p>
        <p className="mt-0.5 text-xs text-muted-foreground">Para un día puntual. Manda sobre la de ArgentinaDatos ese día.</p>
        <div className="mt-3 grid gap-3 sm:grid-cols-2 lg:grid-cols-[1fr_1fr_1fr_1.4fr_auto] lg:items-end">
          <Input label="Fecha" type="date" value={date} max={today} onChange={(e) => setDate(e.target.value)} />
          <Input label="Venta ($ por USD)" inputMode="decimal" value={venta} onChange={(e) => setVenta(e.target.value)} placeholder="Ej. 1.450,50" />
          <Input label="Compra (opcional)" inputMode="decimal" value={compra} onChange={(e) => setCompra(e.target.value)} />
          <Input label="Nota (opcional)" value={note} onChange={(e) => setNote(e.target.value)} placeholder="Ej. BNA venta" />
          <Button
            onClick={() =>
              mut.setManual.mutate(
                { date, venta: ventaN, compra: compraN, note: note.trim() || null },
                {
                  onSuccess: () => {
                    toast({ title: "Cotización guardada", variant: "success" });
                    setVenta("");
                    setCompra("");
                  },
                  onError: (e) => toast({ title: staffErrorMessage(e), variant: "error" }),
                },
              )
            }
            loading={mut.setManual.isPending}
            disabled={!date || !(ventaN > 0) || (compraN !== null && !(compraN > 0))}
          >
            Guardar
          </Button>
        </div>
        {manual.length > 0 && (
          <ul className="mt-3 divide-y divide-border/60 text-sm">
            {manual.map((m) => (
              <li key={m.rate_date} className="flex items-center justify-between gap-3 py-1.5">
                <span className="min-w-0 text-muted-foreground">
                  {fxDayLabel(m.rate_date)}
                  {m.note ? ` · ${m.note}` : ""}
                </span>
                <span className="flex items-center gap-1">
                  <span className="tabular-nums">{formatFx(m.venta)}</span>
                  <Button variant="ghost" size="icon" aria-label={`Quitar la carga manual del ${fxDayLabel(m.rate_date)}`} onClick={() => setClearing(m.rate_date)}>
                    <Trash2 size={15} />
                  </Button>
                </span>
              </li>
            ))}
          </ul>
        )}
        {legacy && legacy.length > 0 && (
          <p className="mt-3 text-xs text-muted-foreground">
            Las cotizaciones mensuales que se cargaban antes quedan de respaldo para los días sin cotización diaria.
          </p>
        )}
      </div>

      <ConfirmDialog
        open={clearing !== null}
        onOpenChange={(o) => !o && setClearing(null)}
        title="Quitar la carga manual"
        description="Ese día vuelve a usarse la cotización de ArgentinaDatos (o la última anterior). Lo ya liquidado no cambia."
        confirmLabel="Quitar"
        danger
        withReason
        loading={mut.clearManual.isPending}
        onConfirm={(reason) =>
          clearing &&
          mut.clearManual.mutate(
            { date: clearing, reason },
            {
              onSuccess: () => {
                toast({ title: "Carga manual quitada", variant: "success" });
                setClearing(null);
              },
              onError: (e) => toast({ title: staffErrorMessage(e), variant: "error" }),
            },
          )
        }
      />
    </Card>
  );
}
