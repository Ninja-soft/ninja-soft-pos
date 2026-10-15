"use client";

// =============================================================================
// Cobranzas (F20-1 · ADR-115, spec docs/40 §14.1 y §14.3): deuda de toda la
// plataforma por antigüedad, negocios con saldo y próximos vencimientos.
// Excluye los negocios que no se cobran (prueba, del staff, lifetime, exentos).
//
// F20-8 (ADR-120): vista "Pagos a verificar" (transferencias informadas con
// Ya transferí) y "Cuentas y avisos" (cuentas de cobro de NinjaSoft, email y
// WhatsApp de comprobantes, avisos de cobro). ?vista=pagos | config.
// =============================================================================

import Link from "next/link";
import type { Route } from "next";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { CalendarClock, ChartColumnStacked, ChevronRight, CircleAlert, Inbox, Landmark, LayoutGrid, PiggyBank, Settings2, Users, Wallet } from "lucide-react";
import { Segmented } from "@/components/ui/Segmented";
import { TransferInbox } from "@/components/internal/billing/TransferInbox";
import { BillingKpisView } from "@/components/internal/billing/BillingKpisView";
import {
  CollectionConfigSkeleton,
  CollectionSettingsCard,
  PlatformBankAccountsCard,
} from "@/components/internal/billing/CollectionConfig";
import { useCollection } from "@/modules/billing/collection";
import { PageHeader, SectionHeader } from "@/components/ui/PageHeader";
import { Badge } from "@/components/ui/Badge";
import { Callout } from "@/components/ui/Callout";
import { EmptyState } from "@/components/ui/EmptyState";
import { NoData } from "@/components/ui/NoData";
import { Skeleton } from "@/components/ui/Skeleton";
import { KpiTile } from "@/components/internal/dashboard/KpiTile";
import { AgingBar } from "@/components/billing/StatementParts";
import { BillingCapsCard } from "@/components/internal/billing/BillingCapsCard";
import { BILLING_MODE_LABELS, billingErrorMessage, daysOverdue, formatCents, formatDay } from "@/lib/billing/ledger";
import { formatCompactArs } from "@/lib/internal/saasKpis";
import { useBillingAccess, useBillingOverview } from "@/modules/billing/ledger";

const tenantHref = (id: string) => `/internal/tenants/${id}?tab=cuenta` as Route;

type Vista = "resumen" | "metricas" | "pagos" | "config";
const isVista = (v: string | null): v is Vista => v === "resumen" || v === "metricas" || v === "pagos" || v === "config";

export default function InternalCobranzaPage() {
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const raw = searchParams.get("vista");
  const vista: Vista = isVista(raw) ? raw : "resumen";
  const setVista = (v: Vista) => {
    const sp = new URLSearchParams(searchParams.toString());
    if (v === "resumen") sp.delete("vista");
    else sp.set("vista", v);
    const qs = sp.toString();
    router.replace((qs ? `${pathname}?${qs}` : pathname) as Route, { scroll: false });
  };
  const { data: ov, isLoading, error } = useBillingOverview();
  const { data: access, isError: accessError } = useBillingAccess();
  const { data: coll, isLoading: collLoading, error: collError } = useCollection(null);
  const pendingCount = coll?.pending_reports.length ?? 0;
  const rows = (ov?.tenants ?? []).filter((t) => !t.exclusion && (t.balance_cents !== 0 || t.upcoming_cents > 0));
  const t = ov?.totals;

  return (
    <>
      <PageHeader
        eyebrow="Panel interno"
        title="Cobranzas"
        icon={Landmark}
        description="Lo que los negocios le deben a NinjaSoft: deuda vencida por antigüedad, saldos y próximos vencimientos. Cada negocio tiene su cuenta corriente en su ficha."
      />

      <div className="slim-scrollbar -mx-4 mt-6 overflow-x-auto px-4 sm:mx-0 sm:px-0">
        <Segmented<Vista>
          aria-label="Vista de cobranzas"
          value={vista}
          onChange={setVista}
          className="max-w-none flex-nowrap"
          options={[
            { value: "resumen", label: "Resumen", icon: <LayoutGrid size={15} /> },
            { value: "metricas", label: "Métricas", icon: <ChartColumnStacked size={15} /> },
            {
              value: "pagos",
              label: pendingCount > 0 ? `Pagos a verificar (${pendingCount})` : "Pagos a verificar",
              icon: <Inbox size={15} />,
            },
            { value: "config", label: "Cuentas y avisos", icon: <Settings2 size={15} /> },
          ]}
        />
      </div>

      {vista === "metricas" && <BillingKpisView canView={access ? Boolean(access.can_operate) : accessError ? false : undefined} />}

      {vista === "pagos" && (
        <section className="mt-6" aria-labelledby="cob-pagos">
          <SectionHeader
            title={<span id="cob-pagos">Pagos a verificar</span>}
            icon={Inbox}
            description="Transferencias que los negocios informaron con su comprobante. Cotejalas con el banco: acreditar imputa el pago a la deuda más vieja."
          />
          <div className="mt-3">
            {collError ? (
              <Callout tone="warning" icon={CircleAlert} title="No se pudo cargar la bandeja">
                {billingErrorMessage(collError)}
              </Callout>
            ) : collLoading || !coll ? (
              <Skeleton className="h-40 rounded-xl" />
            ) : (
              <TransferInbox reports={coll.pending_reports} accounts={coll.bank_accounts} canOperate={Boolean(access?.can_operate)} />
            )}
          </div>
        </section>
      )}

      {vista === "config" && (
        <div className="mt-6 space-y-10">
          {collError ? (
            <Callout tone="warning" icon={CircleAlert} title="No se pudo cargar la configuración">
              {billingErrorMessage(collError)}
            </Callout>
          ) : collLoading || !coll ? (
            <CollectionConfigSkeleton />
          ) : (
            <>
              <PlatformBankAccountsCard view={coll} canEdit={Boolean(access?.can_configure)} />
              <CollectionSettingsCard key={JSON.stringify(coll.settings)} view={coll} canEdit={Boolean(access?.can_configure)} />
            </>
          )}
        </div>
      )}

      {vista === "resumen" && (
      <>

      {error && (
        <Callout tone="warning" icon={CircleAlert} title="No se pudo cargar la cobranza" className="mt-6">
          {billingErrorMessage(error)}
        </Callout>
      )}

      {isLoading && (
        <div className="mt-8 grid grid-cols-1 gap-3 min-[420px]:grid-cols-2 lg:grid-cols-4" aria-busy>
          {[0, 1, 2, 3].map((i) => (
            <Skeleton key={i} className="h-[120px] rounded-lg" />
          ))}
        </div>
      )}

      {ov && t && (
        <>
          <p className="mt-4 text-xs text-muted-foreground">
            Al {formatDay(ov.as_of)}. Importes con IVA incluido.{" "}
            {ov.excluded_count > 0
              ? `Excluye ${ov.excluded_count} ${ov.excluded_count === 1 ? "negocio que no se cobra" : "negocios que no se cobran"} (prueba, del staff, lifetime o exentos).`
              : ""}
          </p>

          <section className="mt-6" aria-labelledby="cob-resumen">
            <SectionHeader title={<span id="cob-resumen">Resumen</span>} icon={Wallet} />
            <div className="mt-3 grid grid-cols-1 gap-3 min-[420px]:grid-cols-2 lg:grid-cols-4">
              <KpiTile
                label="Deuda vencida"
                icon={CircleAlert}
                value={formatCompactArs(t.overdue_cents / 100)}
                exact={formatCents(t.overdue_cents)}
                definition="Suma de lo que quedó sin pagar de los cargos cuyo vencimiento ya pasó, en todos los negocios que se cobran."
                sub={`${t.tenants_overdue} ${t.tenants_overdue === 1 ? "negocio" : "negocios"} con deuda vencida`}
                tone={t.overdue_cents > 0 ? "danger" : "default"}
              />
              <KpiTile
                label="A vencer"
                icon={CalendarClock}
                value={formatCompactArs(t.upcoming_cents / 100)}
                exact={formatCents(t.upcoming_cents)}
                definition="Cargos generados que todavía no vencieron, incluido el prorrateo de upgrades que vence con el próximo cobro."
                sub="Cargos emitidos sin vencer"
              />
              <KpiTile
                label="Saldo a favor"
                icon={PiggyBank}
                value={formatCompactArs(t.credit_cents / 100)}
                exact={formatCents(t.credit_cents)}
                definition="Pagos y bonificaciones que todavía no se imputaron a ningún cargo. Se aplican solos al próximo cargo de cada negocio."
                sub="Se aplica al próximo cargo"
              />
              <KpiTile
                label="Saldo total"
                icon={Users}
                value={formatCompactArs(t.balance_cents / 100)}
                exact={formatCents(t.balance_cents)}
                definition="Vencido más a vencer menos saldo a favor, de toda la plataforma."
                sub="Lo que falta cobrar en neto"
              />
            </div>
            <AgingBar className="mt-3" aging={t} />
          </section>

          <div className="mt-10 grid gap-8 xl:grid-cols-[minmax(0,1fr)_380px]">
            <section className="min-w-0" aria-labelledby="cob-negocios">
              <SectionHeader
                title={<span id="cob-negocios">Negocios con saldo</span>}
                icon={Users}
                description="Ordenados por deuda vencida. Tocá uno para ver su cuenta corriente."
              />
              {rows.length === 0 ? (
                <div className="mt-3 rounded-xl border border-border bg-card">
                  <EmptyState compact icon={Wallet} title="Nadie debe nada" description="Cuando se generen cargos sin pagar, aparecen acá." />
                </div>
              ) : (
                <div className="mt-3 overflow-hidden rounded-xl border border-border bg-card">
                  <table className="hidden w-full text-sm md:table">
                    <thead>
                      <tr className="border-b border-border text-left text-xs text-muted-foreground">
                        <th className="px-4 py-3 font-medium">Negocio</th>
                        <th className="px-4 py-3 font-medium">Modalidad</th>
                        <th className="px-4 py-3 text-right font-medium">Saldo</th>
                        <th className="px-4 py-3 text-right font-medium">Vencido</th>
                        <th className="px-4 py-3 text-right font-medium">Mora</th>
                        <th className="px-4 py-3 font-medium">Próximo vencimiento</th>
                        <th className="w-8 px-2 py-3" aria-hidden />
                      </tr>
                    </thead>
                    <tbody>
                      {rows.map((r) => {
                        const mora = daysOverdue(r.oldest_due_date, ov.as_of);
                        return (
                          <tr key={r.tenant_id} className="border-b border-border/60 last:border-0 hover:bg-muted/40">
                            <td className="px-4 py-3">
                              <Link href={tenantHref(r.tenant_id)} className="font-medium hover:underline">
                                {r.name}
                              </Link>
                            </td>
                            <td className="px-4 py-3 text-muted-foreground">{BILLING_MODE_LABELS[r.billing_mode] ?? r.billing_mode}</td>
                            <td className="whitespace-nowrap px-4 py-3 text-right font-semibold tabular-nums">{formatCents(r.balance_cents)}</td>
                            <td className="whitespace-nowrap px-4 py-3 text-right tabular-nums">
                              {r.overdue_cents > 0 ? <span className="text-danger">{formatCents(r.overdue_cents)}</span> : <NoData />}
                            </td>
                            <td className="whitespace-nowrap px-4 py-3 text-right tabular-nums">
                              {mora > 0 ? <Badge tone={mora > 30 ? "danger" : "warning"}>{mora} d</Badge> : <NoData />}
                            </td>
                            <td className="whitespace-nowrap px-4 py-3 tabular-nums text-muted-foreground">
                              {r.next_due_date ? formatDay(r.next_due_date) : <NoData />}
                            </td>
                            <td className="px-2 py-3">
                              <Link href={tenantHref(r.tenant_id)} aria-label={`Ver cuenta de ${r.name}`} className="text-muted-foreground hover:text-foreground">
                                <ChevronRight size={16} />
                              </Link>
                            </td>
                          </tr>
                        );
                      })}
                    </tbody>
                  </table>
                  <ul className="divide-y divide-border md:hidden">
                    {rows.map((r) => {
                      const mora = daysOverdue(r.oldest_due_date, ov.as_of);
                      return (
                        <li key={r.tenant_id}>
                          <Link href={tenantHref(r.tenant_id)} className="flex items-center justify-between gap-3 px-4 py-3">
                            <span className="min-w-0">
                              <span className="block truncate text-sm font-medium">{r.name}</span>
                              <span className="mt-0.5 block text-xs text-muted-foreground">
                                {r.overdue_cents > 0 ? `Vencido ${formatCents(r.overdue_cents)} · ${mora} d de mora` : "Sin deuda vencida"}
                              </span>
                            </span>
                            <span className="shrink-0 text-right text-sm font-semibold tabular-nums">{formatCents(r.balance_cents)}</span>
                          </Link>
                        </li>
                      );
                    })}
                  </ul>
                </div>
              )}
            </section>

            <section className="min-w-0" aria-labelledby="cob-proximos">
              <SectionHeader
                title={<span id="cob-proximos">Próximos vencimientos</span>}
                icon={CalendarClock}
                description="Los próximos 45 días."
              />
              {ov.upcoming.length === 0 ? (
                <div className="mt-3 rounded-xl border border-border bg-card">
                  <EmptyState compact icon={CalendarClock} title="Sin vencimientos próximos" />
                </div>
              ) : (
                <ul className="mt-3 divide-y divide-border overflow-hidden rounded-xl border border-border bg-card">
                  {ov.upcoming.map((u, i) => (
                    <li key={`${u.charge_id ?? u.tenant_id}-${i}`}>
                      <Link href={tenantHref(u.tenant_id)} className="flex items-center gap-3 px-4 py-3 hover:bg-muted/40">
                        <span className="grid h-11 w-11 shrink-0 place-items-center rounded-lg bg-muted text-center leading-none">
                          <span className="text-sm font-bold tabular-nums">{u.due_date.slice(8, 10)}</span>
                          <span className="text-[10px] uppercase text-muted-foreground">
                            {new Date(`${u.due_date}T12:00:00Z`).toLocaleDateString("es-AR", { month: "short" }).replace(".", "")}
                          </span>
                        </span>
                        <span className="min-w-0 flex-1">
                          <span className="block truncate text-sm font-medium">{u.name}</span>
                          <span className="block truncate text-xs text-muted-foreground">{u.description}</span>
                        </span>
                        <span className="shrink-0 text-sm font-semibold tabular-nums">{formatCents(u.open_cents)}</span>
                      </Link>
                    </li>
                  ))}
                </ul>
              )}
            </section>
          </div>

          <div className="mt-10">
            <BillingCapsCard access={access} />
          </div>
        </>
      )}
      </>
      )}
    </>
  );
}
