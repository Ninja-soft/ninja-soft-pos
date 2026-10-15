"use client";

import { useMemo, useState } from "react";
import { Award, Gauge, RefreshCw } from "lucide-react";
import type { EChartsCoreOption } from "echarts/core";
import { Badge } from "@/components/ui/Badge";
import { Button } from "@/components/ui/Button";
import { EmptyState } from "@/components/ui/EmptyState";
import { Segmented } from "@/components/ui/Segmented";
import { SpinnerBlock } from "@/components/ui/Spinner";
import { useToast } from "@/components/ui/Toast";
import { EChart, type ChartContext } from "@/components/charts/EChart";
import { multiSeriesOption } from "@/components/charts/builders";
import { cn } from "@/lib/utils/cn";
import { mlErrorMessage } from "@/lib/mercadolibre/labels";
import {
  CLAIM_KIND_LABELS,
  CLAIM_KIND_TONE,
  EXCLUSION_LABELS,
  caseGroup,
  type CaseFilter,
} from "@/lib/mercadolibre/postsale";
import {
  DEFAULT_THRESHOLDS,
  LEVELS,
  METRIC_LABEL,
  POWER_SELLER,
  barFill,
  cleanThresholds,
  levelIndex,
  levelLabel,
  margin,
  marginText,
  metricLevel,
  periodLabel,
  type MetricKey,
  type ReputationSnap,
} from "@/supabase/functions/_shared/mercadolibre/reputation";
import { useEnsureClaimReasons, useMlClaimReasons } from "@/modules/mercadolibre/reasonHooks";
import { MlReasonLabel } from "@/components/mercadolibre/gestor/MlReasonPicker";
import type { ReasonIndex } from "@/lib/mercadolibre/claimReasons";
import { useMlClaims, useMlGestorMutations, useMlGestorSettings, useMlSnapshots, type MlClaimRow } from "@/modules/mercadolibre/gestorHooks";
import type { MlAccount } from "@/modules/mercadolibre/hooks";

// Métricas y reputación (H141 · ADR-132, como la vista de ANDESMAR): nivel con
// la barra de colores de Mercado Libre, MercadoLíder, ventas, calificaciones,
// concretadas y canceladas, reclamos / cancelaciones / demoras contra el
// umbral verde con el margen que queda, evolución diaria y los casos que
// afectan la reputación en 60 días.

const LEVEL_TONE = { ok: "success", ambar: "warning", rojo: "danger" } as const;
const LEVEL_TEXT = { ok: "En verde", ambar: "Cerca del límite", rojo: "Pasado del límite" } as const;
const KEYS: MetricKey[] = ["claims", "cancellations", "delayed"];
const pct = (rate: number) => `${(rate * 100).toLocaleString("es-AR", { maximumFractionDigits: 2 })} %`;

function Thermometer({ levelId }: { levelId: string | null }) {
  const idx = levelIndex(levelId);
  return (
    <div className="space-y-1">
      <div className="flex gap-1" role="img" aria-label={`Nivel de reputación: ${levelLabel(levelId)}`}>
        {LEVELS.map((l, i) => (
          <span
            key={l.id}
            className={cn("h-3 flex-1 rounded-sm", i === idx ? "" : "opacity-30")}
            style={{ backgroundColor: l.color }}
          />
        ))}
      </div>
      <div className="flex justify-between text-[11px] text-muted-foreground">
        <span>Rojo</span>
        <span>Verde</span>
      </div>
    </div>
  );
}

function StackBar({ parts }: { parts: Array<{ label: string; value: number; className: string }> }) {
  const total = parts.reduce((s, p) => s + p.value, 0);
  return (
    <div className="space-y-1">
      <div className="flex h-2 overflow-hidden rounded-sm bg-muted">
        {total > 0 && parts.map((p) => <span key={p.label} className={p.className} style={{ width: `${(p.value / total) * 100}%` }} />)}
      </div>
      <div className="flex flex-wrap gap-x-3 text-xs text-muted-foreground">
        {parts.map((p) => (
          <span key={p.label}>
            {p.label} {total > 0 ? `${Math.round((p.value / total) * 100)} %` : "0 %"}
          </span>
        ))}
      </div>
    </div>
  );
}

function MetricCard({ k, snap, threshold }: { k: MetricKey; snap: ReputationSnap; threshold: number }) {
  const m = snap[k];
  const level = metricLevel(m.rate, threshold);
  const mg = margin(snap.sales_completed, m.value, threshold);
  const fill = barFill(m.rate, threshold);
  return (
    <div className="space-y-2 rounded-xl bg-card p-4">
      <div className="flex items-start justify-between gap-2">
        <div>
          <p className="text-sm font-medium">{METRIC_LABEL[k]}</p>
          <p className="text-2xl font-semibold tabular-nums">{pct(m.rate)}</p>
          <p className="text-xs text-muted-foreground">
            {m.value} en {periodLabel(m.period) || "el período"} · para seguir en verde: menos de {threshold.toLocaleString("es-AR")} %
          </p>
        </div>
        <Badge tone={LEVEL_TONE[level]}>{LEVEL_TEXT[level]}</Badge>
      </div>
      <div className="relative h-2 rounded-sm bg-muted" aria-hidden>
        <span
          className={cn("absolute inset-y-0 left-0 rounded-sm", level === "rojo" ? "bg-danger" : level === "ambar" ? "bg-warning" : "bg-success")}
          style={{ width: `${fill}%` }}
        />
        <span className="absolute inset-y-[-3px] w-px bg-foreground/50" style={{ left: "80%" }} title="80 % del límite" />
      </div>
      <p className="text-xs">{marginText(k, mg, threshold)}</p>
      {m.real_value != null && (
        <p className="text-xs text-muted-foreground">
          Sin excluir: {m.real_value}
          {m.real_rate != null ? ` (${pct(m.real_rate)})` : ""}
        </p>
      )}
    </div>
  );
}

export function MlMetricsTab({ account, canManage }: { account: MlAccount; canManage: boolean }) {
  const { toast } = useToast();
  const [days, setDays] = useState<"30" | "60" | "90">("30");
  const [filter, setFilter] = useState<CaseFilter>("all");
  const [showAll, setShowAll] = useState(false);
  const { data: snaps = [], isLoading } = useMlSnapshots(account.id, Number(days));
  const { data: settings } = useMlGestorSettings(account.id);
  const { data: claims = [] } = useMlClaims(account.id, 60);
  const { index: reasons } = useMlClaimReasons();
  useEnsureClaimReasons(reasons, claims.filter((c) => c.affects_reputation).map((c) => c.reason_id));
  const { refreshReputation } = useMlGestorMutations();
  const th = cleanThresholds(settings?.thresholds ?? DEFAULT_THRESHOLDS);
  const last = snaps[snaps.length - 1] ?? null;
  const snap = last?.data ?? null;

  const affecting = useMemo(() => {
    const since = Date.now() - 60 * 86400_000;
    return claims.filter((c) => c.affects_reputation && Date.parse(c.date_created ?? "") >= since);
  }, [claims]);
  const counts = useMemo(() => {
    const c: Record<CaseFilter, number> = { all: affecting.length, claims: 0, mediations: 0, returns: 0, others: 0 };
    for (const x of affecting) c[caseGroup(x.kind)]++;
    return c;
  }, [affecting]);
  const listed = affecting.filter((c) => filter === "all" || caseGroup(c.kind) === filter);

  const refresh = () =>
    refreshReputation.mutate(account.id, {
      onSuccess: () => toast({ title: "Reputación actualizada", variant: "success" }),
      onError: (e) => toast({ title: "No se pudo leer la reputación", description: mlErrorMessage(e), variant: "error" }),
    });

  const chart = useMemo(() => {
    const cats = snaps.map((s) => s.snap_date.slice(8, 10) + "/" + s.snap_date.slice(5, 7));
    const base = multiSeriesOption({
      categories: cats,
      series: [
        { name: "Reclamos", values: snaps.map((s) => s.claims_rate * 100) },
        { name: "Cancelaciones", values: snaps.map((s) => s.cancellations_rate * 100) },
        { name: "Demoras", values: snaps.map((s) => s.delayed_rate * 100) },
      ],
      format: "number",
      kind: "line",
      percent: true,
    });
    return (ctx: ChartContext): EChartsCoreOption => {
      const o = base(ctx) as EChartsCoreOption & { series: Array<Record<string, unknown>> };
      const limits = [th.claims, th.cancellations, th.delayed];
      o.series = o.series.map((s, i) => ({
        ...s,
        markLine: {
          silent: true,
          symbol: "none",
          label: { show: !ctx.compact, formatter: `límite ${limits[i]} %`, color: ctx.theme.muted, fontSize: 10 },
          lineStyle: { type: "dashed", width: 1, color: (s.lineStyle as { color?: string } | undefined)?.color ?? ctx.theme.muted, opacity: 0.6 },
          data: [{ yAxis: limits[i] }],
        },
      }));
      return o;
    };
  }, [snaps, th.claims, th.cancellations, th.delayed]);

  if (isLoading) return <SpinnerBlock className="py-16" />;

  if (!snap) {
    return (
      <EmptyState
        icon={Gauge}
        title="Todavía no hay una foto de tu reputación"
        description="Se toma sola todos los días a la mañana. Podés leerla ahora para ver tu nivel, cuánto margen te queda en reclamos, cancelaciones y demoras, y qué casos la afectan."
        action={
          <Button size="sm" onClick={refresh} loading={refreshReputation.isPending}>
            <RefreshCw size={15} /> Leer mi reputación ahora
          </Button>
        }
      />
    );
  }

  const power = snap.power_seller_status ? POWER_SELLER[snap.power_seller_status] : null;
  const t = snap.transactions;

  return (
    <div className="space-y-5">
      <section className="space-y-3 rounded-xl bg-card p-4 sm:p-5">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div>
            <p className="text-xs text-muted-foreground">Reputación</p>
            <p className="text-xl font-semibold">{levelLabel(snap.level_id)}</p>
            <p className="text-xs text-muted-foreground">
              Leída el {new Date(last!.taken_at).toLocaleString("es-AR", { dateStyle: "short", timeStyle: "short" })}
            </p>
          </div>
          <div className="flex flex-wrap items-center gap-2">
            {power && (
              <Badge tone="gold">
                <Award size={12} /> {power}
              </Badge>
            )}
            <Button variant="secondary" size="sm" onClick={refresh} loading={refreshReputation.isPending}>
              <RefreshCw size={15} /> Actualizar
            </Button>
          </div>
        </div>
        <Thermometer levelId={snap.level_id} />
      </section>

      <div className="grid gap-3 sm:grid-cols-3">
        <div className="space-y-1 rounded-xl bg-card p-4">
          <p className="text-sm font-medium">Ventas del período</p>
          <p className="text-2xl font-semibold tabular-nums">{snap.sales_completed}</p>
          <p className="text-xs text-muted-foreground">Concretadas en {periodLabel(snap.sales_period) || "el período de ML"}</p>
        </div>
        <div className="space-y-2 rounded-xl bg-card p-4">
          <p className="text-sm font-medium">Calificaciones</p>
          <StackBar
            parts={[
              { label: "Positivas", value: snap.ratings.positive, className: "bg-success" },
              { label: "Neutras", value: snap.ratings.neutral, className: "bg-muted-foreground/50" },
              { label: "Negativas", value: snap.ratings.negative, className: "bg-danger" },
            ]}
          />
        </div>
        <div className="space-y-2 rounded-xl bg-card p-4">
          <p className="text-sm font-medium">Concretadas y canceladas</p>
          <StackBar
            parts={[
              { label: `Concretadas ${t.completed}`, value: t.completed, className: "bg-success" },
              { label: `Canceladas ${t.canceled}`, value: t.canceled, className: "bg-danger" },
            ]}
          />
          <p className="text-xs text-muted-foreground">
            {t.total} en total ({periodLabel(t.period)})
          </p>
        </div>
      </div>

      <div className="grid gap-3 lg:grid-cols-3">
        {KEYS.map((k) => (
          <MetricCard key={k} k={k} snap={snap} threshold={th[k]} />
        ))}
      </div>

      <section className="space-y-3 rounded-xl bg-card p-4 sm:p-5">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <h3 className="text-sm font-semibold">Evolución diaria</h3>
          <Segmented
            size="sm"
            value={days}
            onChange={setDays}
            aria-label="Período"
            options={[
              { value: "30", label: "30 días" },
              { value: "60", label: "60 días" },
              { value: "90", label: "90 días" },
            ]}
          />
        </div>
        <EChart
          option={chart}
          height={260}
          ariaLabel="Evolución diaria de reclamos, cancelaciones y demoras"
          empty={snaps.length < 2}
          emptyTitle="Hace falta más de un día"
          emptyHint="La foto se toma una vez por día: en unos días vas a ver la evolución."
          summary={{
            columns: ["Día", "Reclamos %", "Cancelaciones %", "Demoras %"],
            rows: snaps.map((s) => [s.snap_date, s.claims_rate * 100, s.cancellations_rate * 100, s.delayed_rate * 100]),
          }}
        />
      </section>

      <section className="space-y-3 rounded-xl bg-card p-4 sm:p-5">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <h3 className="text-sm font-semibold">Casos que afectan tu reputación (60 días)</h3>
          <Segmented
            size="sm"
            scrollOnMobile
            value={filter}
            onChange={setFilter}
            aria-label="Tipo de caso"
            options={[
              { value: "all", label: `Todos ${counts.all}` },
              { value: "claims", label: `Reclamos ${counts.claims}` },
              { value: "mediations", label: `Mediaciones ${counts.mediations}` },
              { value: "returns", label: `Devoluciones ${counts.returns}` },
              ...(counts.others > 0 ? [{ value: "others" as const, label: `Otros ${counts.others}` }] : []),
            ]}
          />
        </div>
        {listed.length === 0 ? (
          <p className="py-6 text-center text-sm text-muted-foreground">
            {affecting.length === 0 ? "Ningún caso afecta tu reputación en los últimos 60 días." : "No hay casos de ese tipo."}
          </p>
        ) : (
          <ul className="divide-y divide-border">
            {(showAll ? listed : listed.slice(0, 10)).map((c) => (
              <CaseRow key={c.id} c={c} canManage={canManage} reasons={reasons} />
            ))}
          </ul>
        )}
        {!showAll && listed.length > 10 && (
          <Button variant="ghost" size="sm" onClick={() => setShowAll(true)}>
            Ver {listed.length - 10} más
          </Button>
        )}
      </section>
    </div>
  );
}

function CaseRow({ c, reasons }: { c: MlClaimRow; canManage: boolean; reasons: ReasonIndex | undefined }) {
  const state =
    c.status === "closed" ? "Cerrado" : c.action_responsible === "respondent" || !c.action_responsible ? "Te toca responder" : c.action_responsible === "mediator" ? "En manos de Mercado Libre" : "Esperando al comprador";
  return (
    <li className="flex flex-wrap items-center gap-x-3 gap-y-1 py-2 text-sm">
      <span className="w-20 shrink-0 text-xs text-muted-foreground">
        {c.date_created ? new Date(c.date_created).toLocaleDateString("es-AR", { timeZone: "America/Argentina/Buenos_Aires" }) : ""}
      </span>
      <Badge tone={CLAIM_KIND_TONE[c.kind]}>{CLAIM_KIND_LABELS[c.kind]}</Badge>
      <span className="min-w-0 flex-1 truncate">
        <MlReasonLabel id={c.reason_id} index={reasons} />
        {c.resource_id ? <span className="text-muted-foreground"> · venta {c.resource_id}</span> : null}
      </span>
      <span className="text-xs text-muted-foreground">{state}</span>
      {c.exclusion_status && <Badge tone={c.exclusion_status === "aceptada" ? "success" : c.exclusion_status === "candidato" ? "brand" : "neutral"}>{EXCLUSION_LABELS[c.exclusion_status]}</Badge>}
    </li>
  );
}
