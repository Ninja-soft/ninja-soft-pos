import Link from "next/link";
import {
  AlertTriangle,
  Banknote,
  Building2,
  ChevronRight,
  CircleDollarSign,
  Gauge,
  Hourglass,
  LayoutDashboard,
  Percent,
  Repeat,
  ShieldAlert,
  TrendingDown,
  Users,
  Wallet,
} from "lucide-react";
import { createClient } from "@/lib/supabase/server";
import { PageHeader, SectionHeader } from "@/components/ui/PageHeader";
import { Badge } from "@/components/ui/Badge";
import { Callout } from "@/components/ui/Callout";
import { EmptyState } from "@/components/ui/EmptyState";
import { TableWrap } from "@/components/ui/Table";
import { KpiTile } from "@/components/internal/dashboard/KpiTile";
import { PeriodSwitch } from "@/components/internal/dashboard/PeriodSwitch";
import { tenantHealthScore, HEALTH_LEVEL_DOT } from "@/lib/internal/tenantHealth";
import {
  KPI_DEFINITIONS,
  applyExclusions,
  collected,
  collectionRisk,
  exclusionReason,
  formatCompactArs,
  formatExactArs,
  formatPct,
  logoChurn,
  mrrSummary,
  newTenants,
  parsePeriodKey,
  periodsFor,
  stockAt,
  trend,
  trialConversion,
  trialsSummary,
  usageRisk,
  type KpiAccount,
  type PaymentRow,
  type Ratio,
  type StatusChange,
} from "@/lib/internal/saasKpis";

type PlanRel = {
  key: string;
  name: string;
  monthly_price_ars: number | null;
  yearly_price_ars: number | null;
} | null;
type SubRow = {
  status: string;
  billing_cycle: string | null;
  is_lifetime: boolean | null;
  past_due_since: string | null;
  plans: PlanRel;
};
type TenantRaw = {
  id: string;
  name: string;
  status: string;
  created_at: string;
  trial_ends_at: string | null;
  subscriptions: SubRow | SubRow[] | null;
};
type HealthRow = {
  tenant_id: string;
  active_users: number;
  last_login_at: string | null;
  last_sale_at: string | null;
  sales_7d_count: number;
};
type KpiEvents = {
  status_changes: StatusChange[];
  rejected_debits: { tenant_id: string; at: string }[];
};

const PERIOD_LABEL = { mes: "este mes", anterior: "el mes anterior", "12m": "los últimos 12 meses" } as const;

function ratioValue(r: Ratio): string | null {
  return r.pct === null ? null : formatPct(r.pct);
}
function ratioSub(r: Ratio, what: string): string {
  if (r.den === 0) return `Sin ${what} en el período`;
  return `${r.num} de ${r.den}${r.pct === null ? " · muestra chica" : ""}`;
}

export default async function InternalHomePage({
  searchParams,
}: {
  searchParams?: { periodo?: string | string[] };
}) {
  const periodKey = parsePeriodKey(searchParams?.periodo);
  const now = new Date();
  const { current, previous } = periodsFor(periodKey, now);
  const supabase = createClient({ scope: "internal" });

  const looseRpc = supabase as unknown as {
    rpc: (fn: string, args?: Record<string, unknown>) => Promise<{ data: unknown; error: unknown }>;
  };
  const looseFrom = supabase as unknown as {
    from: (t: string) => {
      select: (c: string) => {
        in: (col: string, v: string[]) => PromiseLike<{ data: unknown; error: unknown }>;
      };
    };
  };
  const [tenantsRes, addonsRes, catalogRes, discountsRes, paymentsRes, healthRes, eventsRes, exclusionsRes, reversalsRes, legacyRes] = await Promise.all([
    supabase
      .from("tenants")
      .select(
        "id, name, status, created_at, trial_ends_at, subscriptions(status, billing_cycle, is_lifetime, past_due_since, plans(key, name, monthly_price_ars, yearly_price_ars))",
      )
      .is("deleted_at", null)
      .order("created_at", { ascending: false }),
    supabase
      .from("subscription_addons")
      .select("tenant_id, addon_key, status, source, monthly_price_ars, cancel_at_period_end, current_period_end"),
    supabase.from("plan_addons").select("key, monthly_price_ars"),
    supabase
      .from("tenant_discounts")
      .select("tenant_id, kind, value, valid_from, valid_until, deleted_at")
      .is("deleted_at", null),
    // F20-1/F20-2: pagos del ledger (incluye los billing_records migrados) y sus reversas.
    looseFrom
      .from("platform_payments")
      .select("tenant_id, amount_cents, paid_at, status")
      .in("status", ["approved", "refunded", "partially_refunded", "charged_back", "in_dispute"]),
    supabase.rpc("internal_tenant_health"),
    // F20-0a: cambios de estado desde la auditoría (migración 20261111200000).
    looseRpc.rpc("internal_saas_kpi_events", { p_since: previous.start.toISOString() }),
    // F20-1: negocios de prueba, del staff, lifetime y exentos (migración 20261113100100).
    looseRpc.rpc("internal_billing_exclusions"),
    looseFrom.from("platform_ledger").select("tenant_id, amount_cents, effective_date").in("kind", ["refund", "payment_reversal"]),
    supabase.from("billing_records").select("tenant_id, amount, created_at"),
  ]);

  const tenants = (tenantsRes.data ?? []) as unknown as TenantRaw[];
  const catalog = new Map(
    ((catalogRes.data ?? []) as { key: string; monthly_price_ars: number | null }[]).map((p) => [
      p.key,
      p.monthly_price_ars,
    ]),
  );
  type AddonRow = {
    tenant_id: string;
    addon_key: string;
    status: string;
    source: string;
    monthly_price_ars: number | null;
    cancel_at_period_end: boolean | null;
    current_period_end: string | null;
  };
  const addonsBy = new Map<string, AddonRow[]>();
  for (const a of (addonsRes.data ?? []) as unknown as AddonRow[]) {
    addonsBy.set(a.tenant_id, [...(addonsBy.get(a.tenant_id) ?? []), a]);
  }
  type DiscountRow = {
    tenant_id: string;
    kind: string;
    value: number;
    valid_from: string | null;
    valid_until: string | null;
    deleted_at: string | null;
  };
  const discountsBy = new Map<string, DiscountRow[]>();
  for (const d of (discountsRes.data ?? []) as unknown as DiscountRow[]) {
    discountsBy.set(d.tenant_id, [...(discountsBy.get(d.tenant_id) ?? []), d]);
  }
  // Pagos del ledger; sin la migración de cobranza, los billing_records de antes.
  const ledgerOk = !paymentsRes.error && !reversalsRes.error;
  const payments: PaymentRow[] = ledgerOk
    ? ((paymentsRes.data ?? []) as { tenant_id: string; amount_cents: number; paid_at: string }[]).map((p) => ({
        tenant_id: p.tenant_id,
        amount: Number(p.amount_cents) / 100,
        at: p.paid_at,
      }))
    : ((legacyRes.data ?? []) as { tenant_id: string; amount: number; created_at: string }[]).map((p) => ({
        tenant_id: p.tenant_id,
        amount: Number(p.amount),
        at: p.created_at,
      }));
  // Reintegros y contracargos: restan en el cobrado del período (no afectan la conversión).
  const reversals: PaymentRow[] = ledgerOk
    ? ((reversalsRes.data ?? []) as { tenant_id: string; amount_cents: number; effective_date: string }[]).map((r) => ({
        tenant_id: r.tenant_id,
        amount: -Number(r.amount_cents) / 100,
        at: `${r.effective_date}T15:00:00Z`,
      }))
    : [];
  const events = eventsRes.error ? null : ((eventsRes.data ?? null) as KpiEvents | null);
  const changes = events?.status_changes ?? [];
  const rejected = events?.rejected_debits ?? [];

  const sub = (t: TenantRaw): SubRow | null =>
    !t.subscriptions ? null : Array.isArray(t.subscriptions) ? t.subscriptions[0] ?? null : t.subscriptions;

  const exclusions = exclusionsRes.error ? null : ((exclusionsRes.data ?? []) as { tenant_id: string; reason: string }[]);
  const rawAccounts: KpiAccount[] = tenants.map((t) => {
    const s = sub(t);
    return {
      tenantId: t.id,
      name: t.name,
      createdAt: t.created_at,
      trialEndsAt: t.trial_ends_at,
      isTest: false,
      status: s?.status ?? t.status,
      billingCycle: s?.billing_cycle ?? null,
      isLifetime: Boolean(s?.is_lifetime),
      plan: s?.plans ?? null,
      planKey: s?.plans?.key ?? null,
      planName: s?.plans?.name ?? null,
      addons: (addonsBy.get(t.id) ?? []).map((a) => ({ ...a, catalog_price_ars: catalog.get(a.addon_key) ?? null })),
      discounts: discountsBy.get(t.id) ?? [],
    };
  });

  const accounts = applyExclusions(rawAccounts, exclusions);
  const excludedBy = (r: string) => accounts.filter((a) => exclusionReason(a) === r).length;
  const excludedSummary = [
    [excludedBy("lifetime"), "lifetime"],
    [excludedBy("staff"), "del staff"],
    [excludedBy("test"), "de prueba"],
    [excludedBy("exempt"), "exentas"],
  ]
    .filter(([n]) => Number(n) > 0)
    .map(([n, label]) => `${n} ${label}`)
    .join(", ");
  const excludedIds = new Set(accounts.filter((a) => exclusionReason(a)).map((a) => a.tenantId));

  // ── Plata ────────────────────────────────────────────────────────────────
  const rejectedRecent = new Set(
    rejected.filter((r) => now.getTime() - new Date(r.at).getTime() <= 30 * 86_400_000).map((r) => r.tenant_id),
  );
  const summary = mrrSummary(accounts, rejectedRecent, now);
  const stockEnd = periodKey === "anterior" ? stockAt(accounts, changes, current.end) : { mrr: summary.mrr, paidAccounts: summary.paidAccounts };
  const stockStart = stockAt(accounts, changes, current.start);
  const mrrTrend = events ? trend(stockEnd.mrr, stockStart.mrr) : null;
  const paidTrend = events ? trend(stockEnd.paidAccounts, stockStart.paidAccounts) : null;
  const arpaEnd = stockEnd.paidAccounts > 0 ? stockEnd.mrr / stockEnd.paidAccounts : null;
  const arpaStart = stockStart.paidAccounts > 0 ? stockStart.mrr / stockStart.paidAccounts : null;
  const cobrado = collected([...payments, ...reversals], current, excludedIds);
  const cobradoPrev = collected([...payments, ...reversals], previous, excludedIds);

  // ── Clientes ─────────────────────────────────────────────────────────────
  const trials = trialsSummary(accounts, now);
  const conv = trialConversion(accounts, payments, current);
  const convPrev = trialConversion(accounts, payments, previous);
  const churn = events ? logoChurn(accounts, changes, current) : null;
  const churnPrev = events ? logoChurn(accounts, changes, previous) : null;
  const nuevos = newTenants(accounts, current);
  const nuevosPrev = newTenants(accounts, previous);

  // ── Riesgo: dos ejes ─────────────────────────────────────────────────────
  const pastDueSince = new Map(tenants.map((t) => [t.id, sub(t)?.past_due_since ?? null]));
  const cobroRisk = collectionRisk(accounts, pastDueSince, rejected, now);
  const healthBy = new Map(((healthRes.data ?? []) as unknown as HealthRow[]).map((h) => [h.tenant_id, h]));
  const usoRisk = usageRisk(
    accounts.map((a) => {
      const h = healthBy.get(a.tenantId);
      const health = tenantHealthScore(
        {
          status: a.status,
          createdAt: a.createdAt,
          trialEndsAt: a.trialEndsAt,
          lastLoginAt: h?.last_login_at ?? null,
          lastSaleAt: h?.last_sale_at ?? null,
          sales7dCount: Number(h?.sales_7d_count ?? 0),
          activeUsers: Number(h?.active_users ?? 0),
        },
        now,
      );
      return { account: a, score: health.score, reasons: health.reasons, hasSales: Boolean(h?.last_sale_at) };
    }),
    now,
  );

  const vsLabel = periodKey === "12m" ? "vs. los 12 meses anteriores" : "vs. el mes anterior";
  const stockLabel = periodKey === "anterior" ? "al cierre del mes anterior" : "hoy";

  return (
    <>
      <PageHeader
        eyebrow="Panel interno"
        title="Inicio"
        icon={LayoutDashboard}
        description="Cómo viene el negocio de NinjaSoft: ingresos recurrentes, clientes y riesgo. Cada número tiene su definición en el ícono de información."
        actions={<PeriodSwitch value={periodKey} />}
      />

      <p className="mt-4 text-xs text-muted-foreground">
        Período: {PERIOD_LABEL[periodKey]}. Los stocks (MRR, cuentas pagas) se miden {stockLabel}; los flujos (cobrado, nuevos,
        churn, conversión) suman el período.{" "}
        {excludedSummary ? `Excluye ${excludedIds.size} ${excludedIds.size === 1 ? "cuenta" : "cuentas"} que no se cobran (${excludedSummary}).` : "Sin cuentas excluidas."}
      </p>

      <div className="mt-3 space-y-2">
        {!exclusions && (
          <Callout tone="warning" icon={AlertTriangle} title="Negocios de prueba y del staff sin excluir">
            Falta aplicar la migración <code className="break-all font-mono text-xs">20261113100100_cobranza_ledger_rpc</code>. Hasta
            entonces sólo se excluyen las cuentas lifetime: un negocio de prueba o del staff con plan activo suma al MRR.
          </Callout>
        )}
        {!events && (
          <Callout tone="warning" icon={AlertTriangle} title="Churn y tendencias sin datos">
            Falta aplicar la migración <code className="break-all font-mono text-xs">20261111300000_internal_saas_kpi_events</code>, que lee
            los cambios de estado desde la auditoría.
          </Callout>
        )}
      </div>

      {/* ── Fila 1: plata ── */}
      <section className="mt-8" aria-labelledby="kpi-plata">
        <SectionHeader title={<span id="kpi-plata">Ingresos</span>} icon={CircleDollarSign} />
        <div className="mt-3 grid grid-cols-1 gap-3 min-[420px]:grid-cols-2 lg:grid-cols-4">
          <KpiTile
            label="MRR"
            icon={Repeat}
            value={formatCompactArs(stockEnd.mrr)}
            exact={formatExactArs(stockEnd.mrr)}
            definition={KPI_DEFINITIONS.mrr}
            sub={`${stockEnd.paidAccounts} ${stockEnd.paidAccounts === 1 ? "cuenta paga" : "cuentas pagas"}`}
            trendPct={mrrTrend}
            trendLabel={`vs. el inicio del período`}
            href="/internal/tenants"
          />
          <KpiTile
            label="ARR (MRR × 12)"
            icon={Banknote}
            value={formatCompactArs(stockEnd.mrr * 12)}
            exact={formatExactArs(stockEnd.mrr * 12)}
            definition={KPI_DEFINITIONS.arr}
            sub="Run-rate anual"
            trendPct={mrrTrend}
            trendLabel="vs. el inicio del período"
          />
          <KpiTile
            label="Cobrado en el período"
            icon={Wallet}
            value={formatCompactArs(cobrado)}
            exact={formatExactArs(cobrado)}
            definition={KPI_DEFINITIONS.collected}
            sub={ledgerOk ? "Sin reintegros ni contracargos" : "Bruto, según pagos registrados"}
            href="/internal/cobranza?vista=metricas"
            trendPct={trend(cobrado, cobradoPrev)}
            trendLabel={vsLabel}
          />
          <KpiTile
            label="MRR en riesgo"
            icon={ShieldAlert}
            value={formatCompactArs(summary.mrrAtRisk)}
            exact={formatExactArs(summary.mrrAtRisk)}
            definition={KPI_DEFINITIONS.mrrAtRisk}
            sub={
              summary.mrr > 0
                ? `${formatPct(Math.round((summary.mrrAtRisk / summary.mrr) * 1000) / 10)} del MRR`
                : "Sin MRR"
            }
            tone={summary.mrrAtRisk > 0 ? "warning" : "default"}
            goodWhen="down"
          />
        </div>
      </section>

      {/* ── Fila 2: clientes ── */}
      <section className="mt-8" aria-labelledby="kpi-clientes">
        <SectionHeader title={<span id="kpi-clientes">Clientes</span>} icon={Users} />
        <div className="mt-3 grid grid-cols-1 gap-3 min-[420px]:grid-cols-2 lg:grid-cols-3 2xl:grid-cols-5">
          <KpiTile
            label="Cuentas pagas"
            icon={Users}
            value={String(stockEnd.paidAccounts)}
            definition={KPI_DEFINITIONS.paidAccounts}
            trendPct={paidTrend}
            trendLabel="vs. el inicio del período"
          />
          <KpiTile
            label="ARPA"
            icon={Gauge}
            value={arpaEnd === null ? null : formatCompactArs(arpaEnd)}
            exact={arpaEnd === null ? undefined : formatExactArs(arpaEnd)}
            definition={KPI_DEFINITIONS.arpa}
            sub="Ingreso promedio por cuenta"
            trendPct={events && arpaEnd !== null && arpaStart !== null ? trend(arpaEnd, arpaStart) : null}
            trendLabel="vs. el inicio del período"
          />
          <KpiTile
            label="Trials activos"
            icon={Hourglass}
            value={String(trials.active)}
            definition={KPI_DEFINITIONS.trials}
            sub={`${trials.endingIn7d} vencen en 7 días`}
            tone={trials.endingIn7d > 0 ? "warning" : "default"}
          />
          <KpiTile
            label="Conversión trial → pago"
            icon={Percent}
            value={ratioValue(conv)}
            definition={KPI_DEFINITIONS.conversion}
            sub={ratioSub(conv, "trials que terminaran")}
            trendPct={conv.pct !== null && convPrev.pct !== null ? trend(conv.pct, convPrev.pct) : null}
            trendLabel={vsLabel}
          />
          <KpiTile
            label="Churn de clientes"
            icon={TrendingDown}
            value={churn ? ratioValue(churn) : null}
            definition={KPI_DEFINITIONS.churn}
            sub={churn ? ratioSub(churn, "cuentas pagas al inicio") : "Falta la migración de eventos"}
            trendPct={churn?.pct != null && churnPrev?.pct != null ? trend(churn.pct, churnPrev.pct) : null}
            goodWhen="down"
            trendLabel={vsLabel}
            tone={churn && churn.num > 0 ? "danger" : "default"}
          />
        </div>
      </section>

      {/* ── Fila 3: operación ── */}
      <section className="mt-8" aria-labelledby="kpi-operacion">
        <SectionHeader title={<span id="kpi-operacion">Operación</span>} icon={Building2} />
        <div className="mt-3 grid grid-cols-1 gap-3 min-[420px]:grid-cols-2 lg:grid-cols-3">
          <KpiTile
            label="Negocios nuevos"
            icon={Building2}
            value={String(nuevos)}
            definition={KPI_DEFINITIONS.newTenants}
            sub={`Creados en ${PERIOD_LABEL[periodKey]}`}
            trendPct={trend(nuevos, nuevosPrev)}
            trendLabel={vsLabel}
            href="/internal/tenants"
          />
          <KpiTile
            label="Riesgo de cobro"
            icon={ShieldAlert}
            value={String(cobroRisk.length)}
            definition={KPI_DEFINITIONS.collectionRisk}
            sub={cobroRisk.length === 1 ? "negocio" : "negocios"}
            tone={cobroRisk.length > 0 ? "warning" : "default"}
            href="#riesgo-cobro"
          />
          <KpiTile
            label="Riesgo de uso"
            icon={AlertTriangle}
            value={String(usoRisk.length)}
            definition={KPI_DEFINITIONS.usageRisk}
            sub={`${usoRisk.filter((r) => r.kind === "conversion").length} de conversión`}
            tone={usoRisk.length > 0 ? "warning" : "default"}
            href="#riesgo-uso"
          />
        </div>
      </section>

      {/* ── Listas de riesgo ── */}
      <div className="mt-10 grid gap-6 lg:grid-cols-2">
        <section id="riesgo-cobro" className="min-w-0 scroll-mt-6">
          <SectionHeader
            title="Riesgo de cobro"
            icon={ShieldAlert}
            description="Pago vencido, suspendidos por falta de pago o débito rechazado."
          />
          <RiskList
            empty="Nadie debe ni tiene débitos rechazados."
            rows={cobroRisk.slice(0, 10).map((r) => ({
              id: r.tenantId,
              name: r.name,
              detail: r.reasons.join(" · "),
              right: r.mrr > 0 ? formatCompactArs(r.mrr) : null,
              dot: r.daysOverdue > 3 ? "bg-danger" : "bg-warning",
            }))}
          />
        </section>
        <section id="riesgo-uso" className="min-w-0 scroll-mt-6">
          <SectionHeader
            title="Riesgo de uso"
            icon={AlertTriangle}
            description="Salud menor a 60 en cuentas pagas o trials, y trials sin ventas."
          />
          <RiskList
            empty="Todas las cuentas pagas y los trials vienen usando el sistema."
            rows={usoRisk.slice(0, 10).map((r) => ({
              id: r.tenantId,
              name: r.name,
              detail: r.reasons.join(" · ") || "Sin actividad registrada",
              right: `${r.score}/100`,
              badge: r.kind === "conversion" ? "Conversión" : undefined,
              dot: r.score < 40 ? HEALTH_LEVEL_DOT.risk : HEALTH_LEVEL_DOT.attention,
            }))}
          />
        </section>
      </div>

      {/* ── Desglose por plan ── */}
      <section className="mt-10" aria-labelledby="por-plan">
        <SectionHeader
          title={<span id="por-plan">MRR por plan</span>}
          icon={Repeat}
          description="Sólo cuentas pagas (sin lifetime). Precio normalizado a mes con addons y descuentos."
        />
        <TableWrap className="mt-3">
          <table className="w-full min-w-[420px] text-sm">
            <thead>
              <tr className="border-b border-border text-left text-xs font-semibold uppercase tracking-wide text-muted-foreground">
                <th className="px-4 py-2.5">Plan</th>
                <th className="px-4 py-2.5 text-right">Cuentas</th>
                <th className="px-4 py-2.5 text-right">MRR</th>
                <th className="px-4 py-2.5 text-right">% del MRR</th>
              </tr>
            </thead>
            <tbody>
              {summary.byPlan.length === 0 ? (
                <tr>
                  <td colSpan={4}>
                    <EmptyState
                      compact
                      icon={Repeat}
                      title="Todavía no hay cuentas pagas"
                      description="Acá vas a ver cuánto aporta cada plan cuando haya suscripciones cobradas."
                    />
                  </td>
                </tr>
              ) : (
                summary.byPlan.map((p) => (
                  <tr key={p.key} className="border-b border-border last:border-0">
                    <td className="px-4 py-2.5 font-medium">{p.name}</td>
                    <td className="px-4 py-2.5 text-right tabular-nums">{p.accounts}</td>
                    <td className="px-4 py-2.5 text-right tabular-nums" title={formatExactArs(p.mrr)}>
                      {formatCompactArs(p.mrr)}
                    </td>
                    <td className="px-4 py-2.5 text-right tabular-nums text-muted-foreground">
                      {summary.mrr > 0 ? formatPct(Math.round((p.mrr / summary.mrr) * 1000) / 10) : "0 %"}
                    </td>
                  </tr>
                ))
              )}
            </tbody>
          </table>
        </TableWrap>
      </section>

      <div className="mt-8">
        <Link
          href="/internal/tenants"
          className="inline-flex items-center gap-1.5 rounded-lg border border-border bg-card px-3 py-2 text-sm font-medium transition hover:bg-muted"
        >
          <Building2 size={15} aria-hidden /> Ver todos los negocios ({tenants.length})
          <ChevronRight size={15} aria-hidden />
        </Link>
      </div>
    </>
  );
}

function RiskList({
  rows,
  empty,
}: {
  rows: { id: string; name: string; detail: string; right: string | null; dot: string; badge?: string }[];
  empty: string;
}) {
  if (rows.length === 0) {
    return (
      <div className="mt-3 rounded-lg border border-border bg-card">
        <EmptyState compact icon={ShieldAlert} title="Sin negocios en esta lista" description={empty} />
      </div>
    );
  }
  return (
    <ul className="mt-3 divide-y divide-border rounded-lg border border-border bg-card">
      {rows.map((r) => (
        <li key={r.id}>
          <Link
            href={`/internal/tenants/${r.id}`}
            className="flex min-w-0 items-start gap-3 px-4 py-3 text-sm transition hover:bg-muted"
          >
            <span aria-hidden className={`mt-1.5 h-2 w-2 shrink-0 rounded-full ${r.dot}`} />
            <span className="min-w-0 flex-1">
              <span className="flex min-w-0 items-center gap-2">
                <span className="truncate font-medium text-foreground">{r.name}</span>
                {r.badge && <Badge tone="info">{r.badge}</Badge>}
              </span>
              <span className="mt-0.5 block text-xs text-muted-foreground">{r.detail}</span>
            </span>
            {r.right && <span className="shrink-0 tabular-nums text-xs text-muted-foreground">{r.right}</span>}
          </Link>
        </li>
      ))}
    </ul>
  );
}
