"use client";

import { useMemo, useState } from "react";
import Link from "next/link";
import { ChevronRight, Lock, Radar } from "lucide-react";
import { PageContainer, PageHeader } from "@/components/ui/PageHeader";
import { Button } from "@/components/ui/Button";
import { Segmented } from "@/components/ui/Segmented";
import { EmptyState } from "@/components/ui/EmptyState";
import { UpgradeModal } from "@/components/saas/UpgradeModal";
import { cn } from "@/lib/utils/cn";
import { formatCurrency, formatQty } from "@/lib/utils/format";
import {
  channelShares,
  cockpitAlerts,
  cockpitErrorMessage,
  cockpitHeadline,
  type CockpitAlertLevel,
} from "@/lib/commerce/cockpit";
import { useFeature } from "@/modules/saas/gating";
import { useMyTenant } from "@/modules/tenants/hooks";
import { useBranchContext } from "@/modules/branches/hooks";
import { useCommerceCockpit, type CockpitPeriod } from "@/modules/commerce/cockpit";

const DOT: Record<CockpitAlertLevel, string> = {
  danger: "bg-danger",
  warning: "bg-warning",
  info: "bg-info",
};

function Tile({ label, value, hint, tone }: { label: string; value: string; hint?: string; tone?: "danger" | "warning" }) {
  return (
    <div className="rounded-lg bg-muted/40 p-3">
      <p className="text-xs text-muted-foreground">{label}</p>
      <p
        className={cn(
          "mt-1 text-xl font-bold tabular-nums",
          tone === "danger" && "text-danger",
          tone === "warning" && "text-warning",
        )}
      >
        {value}
      </p>
      {hint && <p className="mt-0.5 text-xs text-muted-foreground">{hint}</p>}
    </div>
  );
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section className="mt-6 border-t-2 border-ninja-flame pt-4">
      <h2 className="text-base font-semibold">{title}</h2>
      <div className="mt-3">{children}</div>
    </section>
  );
}

// Cockpit de comercio unificado (F16 · H76, ADR-091): en una pantalla, qué
// canal vende, qué pedidos faltan surtir, qué pagos fallaron, qué stock está
// comprometido y las alertas con SLA. Respeta el chip de sucursal (H90).
export default function CockpitPage() {
  const enabled = useFeature("cockpit_comercio");
  const { data: me } = useMyTenant();
  const ctx = useBranchContext();
  const [period, setPeriod] = useState<CockpitPeriod>("hoy");
  const [upgradeOpen, setUpgradeOpen] = useState(false);
  const allowed = enabled === true && Boolean(me?.canManage);
  const { data, isLoading, error } = useCommerceCockpit(ctx.filterStoreId, period, allowed && ctx.ready);

  const alerts = useMemo(() => (data ? cockpitAlerts(data) : []), [data]);
  const shares = useMemo(() => (data ? channelShares(data.channels) : []), [data]);
  const salesTotal = shares.reduce((a, s) => a + s.total, 0);
  const salesCount = shares.reduce((a, s) => a + s.sales, 0);

  const header = (
    <PageHeader
      eyebrow="Gestión"
      title="Cockpit"
      icon={Radar}
      description={
        ctx.filterStore
          ? `Comercio unificado de ${ctx.filterStore.name}: canales, pedidos, pagos, facturación y stock.`
          : "Comercio unificado de todas tus sucursales: canales, pedidos, pagos, facturación y stock."
      }
    />
  );

  if (enabled === false) {
    return (
      <PageContainer>
        {header}
        <div className="mt-8 rounded-lg bg-muted/40 p-8 text-center">
          <Lock className="mx-auto text-ninja-flameSoft" size={28} />
          <p className="mt-3 font-semibold">El cockpit de comercio unificado no está incluido en tu plan</p>
          <p className="mx-auto mt-1 max-w-md text-sm text-muted-foreground">
            Mirá en una sola pantalla qué canal vende, qué pedidos faltan surtir, qué pagos fallaron y qué stock está
            comprometido en cada sucursal.
          </p>
          <Button className="mt-4" onClick={() => setUpgradeOpen(true)}>
            Ver planes
          </Button>
          <UpgradeModal
            open={upgradeOpen}
            onOpenChange={setUpgradeOpen}
            featureKey="cockpit_comercio"
            featureLabel="Cockpit de comercio unificado"
          />
        </div>
      </PageContainer>
    );
  }

  if (me && !me.canManage) {
    return (
      <PageContainer>
        {header}
        <EmptyState icon={Lock} title="Sólo el dueño o un encargado ven el cockpit" />
      </PageContainer>
    );
  }

  return (
    <PageContainer>
      {header}

      <div className="mt-6 flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <Segmented<CockpitPeriod>
          aria-label="Período"
          value={period}
          onChange={setPeriod}
          size="sm"
          options={[
            { value: "hoy", label: "Hoy" },
            { value: "7d", label: "7 días" },
            { value: "30d", label: "30 días" },
          ]}
        />
        {data && (
          <p className="flex items-center gap-2 text-sm font-semibold">
            <span
              aria-hidden
              className={cn(
                "h-2 w-2 rounded-full",
                alerts.some((a) => a.level === "danger")
                  ? "bg-danger"
                  : alerts.length > 0
                    ? "bg-warning"
                    : "bg-success",
              )}
            />
            {cockpitHeadline(alerts)}
          </p>
        )}
      </div>

      {error ? (
        <p className="mt-8 text-center text-sm text-danger">{cockpitErrorMessage(error)}</p>
      ) : isLoading || !data ? (
        <p className="mt-8 text-center text-sm text-muted-foreground">Cargando el cockpit…</p>
      ) : (
        <>
          <Section title="Alertas">
            {alerts.length === 0 ? (
              <p className="text-sm text-muted-foreground">Sin alertas: pedidos, pagos, facturas y stock en orden.</p>
            ) : (
              <ul className="divide-y divide-border">
                {alerts.map((a) => (
                  <li key={a.kind}>
                    <Link href={a.href as never} className="flex min-h-14 items-center gap-3 py-2 hover:bg-muted/30">
                      <span aria-hidden className={cn("h-2 w-2 shrink-0 rounded-full", DOT[a.level])} />
                      <span className="min-w-0 flex-1">
                        <span className="block text-sm font-semibold">
                          {a.title} <span className="tabular-nums text-muted-foreground">({a.count})</span>
                        </span>
                        <span className="block text-xs text-muted-foreground">{a.detail}</span>
                      </span>
                      <ChevronRight size={16} className="shrink-0 text-muted-foreground" aria-hidden />
                    </Link>
                  </li>
                ))}
              </ul>
            )}
          </Section>

          <Section title="Qué canal vende">
            <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
              <Tile label="Vendido" value={formatCurrency(salesTotal)} hint={`${salesCount} ventas`} />
              <Tile label="Canales con ventas" value={String(shares.length)} />
              <Tile label="Devoluciones" value={String(data.returns.count)} hint={formatCurrency(data.returns.total)} />
              <Tile
                label="Cajas abiertas"
                value={String(data.registers.open)}
                hint={data.registers.silent > 0 ? `${data.registers.silent} sin señal` : "Todas con señal"}
                tone={data.registers.silent > 0 ? "warning" : undefined}
              />
            </div>
            {shares.length === 0 ? (
              <p className="mt-3 text-sm text-muted-foreground">Sin ventas en el período.</p>
            ) : (
              <ul className="mt-4 space-y-3">
                {shares.map((s) => (
                  <li key={s.channel}>
                    <div className="flex items-baseline justify-between gap-2 text-sm">
                      <span className="font-medium">{s.label}</span>
                      <span className="tabular-nums text-muted-foreground">
                        {formatCurrency(s.total)} · {s.sales} · {Math.round(s.share * 100)}%
                      </span>
                    </div>
                    <div className="mt-1 h-2 rounded-sm bg-muted">
                      <div className="h-2 rounded-sm bg-ninja-flame" style={{ width: `${Math.max(s.share * 100, 1)}%` }} />
                    </div>
                  </li>
                ))}
              </ul>
            )}
            {data.stores.length > 1 && (
              <ul className="mt-4 divide-y divide-border text-sm">
                {data.stores.map((s) => (
                  <li key={s.store_id} className="flex items-center justify-between gap-2 py-2">
                    <span className="flex min-w-0 items-center gap-2">
                      <span aria-hidden className="h-2 w-2 shrink-0 rounded-full" style={{ background: s.color ?? "currentColor" }} />
                      <span className="truncate">{s.name}</span>
                    </span>
                    <span className="tabular-nums text-muted-foreground">
                      {formatCurrency(s.total)} · {s.sales}
                    </span>
                  </li>
                ))}
              </ul>
            )}
          </Section>

          <Section title="Qué falta surtir">
            <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
              <Tile
                label="Pedidos abiertos"
                value={data.orders.delivery_open == null ? "-" : String(data.orders.delivery_open)}
                hint={
                  data.orders.delivery_open == null
                    ? "Se ven con todas las sucursales"
                    : `${data.orders.delivery_late ?? 0} demorados`
                }
                tone={(data.orders.delivery_late ?? 0) > 0 ? "danger" : undefined}
              />
              <Tile
                label="Reservas por retirar"
                value={String(data.orders.reservations_open + data.orders.reservations_ready)}
                hint={`${data.orders.reservations_ready} listas`}
              />
              <Tile
                label="Traslados por despachar"
                value={String(data.orders.transfers_pending)}
                hint={`${data.orders.transfers_late} atrasados`}
                tone={data.orders.transfers_late > 0 ? "warning" : undefined}
              />
              <Tile label="Traslados en camino" value={String(data.orders.transfers_in_transit)} />
            </div>
          </Section>

          <Section title="Pagos y facturación">
            <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
              <Tile
                label="Cobros rechazados"
                value={String(data.payments.rejected)}
                tone={data.payments.rejected > 0 ? "warning" : undefined}
              />
              <Tile
                label="Pagos sin conciliar"
                value={String(data.payments.paid_not_completed)}
                hint={`${data.payments.waiting} esperando pago`}
                tone={data.payments.paid_not_completed > 0 ? "danger" : undefined}
              />
              <Tile label="Contracargos abiertos" value={String(data.payments.disputes_open)} />
              <Tile
                label="Facturas bloqueadas"
                value={String(data.fiscal.blocked)}
                hint={`${data.fiscal.pending_late} demoradas`}
                tone={data.fiscal.blocked > 0 ? "danger" : undefined}
              />
            </div>
          </Section>

          <Section title="Stock comprometido">
            <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
              <Tile label="Reservado" value={formatQty(data.stock.reserved_units)} hint="unidades" />
              <Tile label="En tránsito" value={formatQty(data.stock.in_transit_units)} hint="unidades" />
              <Tile
                label="Quiebre con ventas"
                value={String(data.stock.out_with_sales)}
                hint={`${data.stock.below_min} bajo el mínimo`}
                tone={data.stock.out_with_sales > 0 ? "warning" : undefined}
              />
              <Tile
                label="Stock negativo"
                value={String(data.stock.negative)}
                tone={data.stock.negative > 0 ? "danger" : undefined}
              />
            </div>
          </Section>
        </>
      )}
    </PageContainer>
  );
}
