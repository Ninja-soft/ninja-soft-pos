"use client";

// =============================================================================
// Cobranzas › Mora y punitorios (F20-9 · ADR-128, spec docs/40 §14.3):
// negocios en mora con su próximo paso, condonaciones que superaron el tope y
// esperan a un super admin, y las notas de débito y crédito que quedaron
// pendientes hasta que exista la factura con CAE (H130).
// =============================================================================

import Link from "next/link";
import type { Route } from "next";
import { useState } from "react";
import { ChevronRight, FileClock, Gavel, ShieldCheck } from "lucide-react";
import { Badge } from "@/components/ui/Badge";
import { Button } from "@/components/ui/Button";
import { Callout } from "@/components/ui/Callout";
import { EmptyState } from "@/components/ui/EmptyState";
import { NoData } from "@/components/ui/NoData";
import { SectionHeader } from "@/components/ui/PageHeader";
import { Segmented } from "@/components/ui/Segmented";
import { Skeleton } from "@/components/ui/Skeleton";
import { useToast } from "@/components/ui/Toast";
import { ReasonDialog } from "@/components/internal/ReasonDialog";
import { MoraConfigView } from "@/components/internal/billing/MoraConfig";
import { formatCents, formatDay } from "@/lib/billing/ledger";
import { COLLECTION_STATE_LABELS, COLLECTION_STATE_TONES, DUNNING_ACTION_LABELS } from "@/lib/billing/mora";
import { moraErrorMessage, useMoraConfigMutations, useMoraOverview, type WaiverRow } from "@/modules/billing/mora";
import type { BillingAccess } from "@/modules/billing/ledger";

const tenantHref = (id: string) => `/internal/tenants/${id}?tab=cuenta` as Route;

type Sub = "negocios" | "configuracion";

function Approvals({ waivers, canDecide }: { waivers: WaiverRow[]; canDecide: boolean }) {
  const { toast } = useToast();
  const m = useMoraConfigMutations();
  const [deciding, setDeciding] = useState<{ w: WaiverRow; approve: boolean } | null>(null);
  if (waivers.length === 0) return null;
  return (
    <section aria-labelledby="mora-aprobar">
      <SectionHeader
        title={<span id="mora-aprobar">Condonaciones para aprobar</span>}
        icon={ShieldCheck}
        description="Superaron el tope del nivel de quien las pidió. Las aprueba o rechaza un super admin."
      />
      <ul className="mt-3 divide-y divide-border overflow-hidden rounded-xl border border-border bg-card">
        {waivers.map((w) => (
          <li key={w.id} className="flex flex-col gap-2 px-4 py-3 sm:flex-row sm:items-center sm:justify-between">
            <div className="min-w-0">
              <p className="text-sm font-medium">
                {w.tenant_name ?? "Negocio"} · <span className="tabular-nums">{formatCents(w.amount_cents)}</span>
              </p>
              <p className="mt-0.5 text-xs text-muted-foreground">
                {w.requested_by_name ?? "Staff"} · {formatDay(w.created_at)} · {w.reason}
              </p>
            </div>
            {canDecide && (
              <div className="flex shrink-0 gap-2">
                <Button size="sm" onClick={() => setDeciding({ w, approve: true })}>
                  Aprobar
                </Button>
                <Button size="sm" variant="secondary" onClick={() => setDeciding({ w, approve: false })}>
                  Rechazar
                </Button>
              </div>
            )}
          </li>
        ))}
      </ul>
      <ReasonDialog
        open={deciding !== null}
        onOpenChange={(o) => !o && setDeciding(null)}
        title={deciding?.approve ? "Aprobar condonación" : "Rechazar condonación"}
        description={
          deciding
            ? `${deciding.w.tenant_name ?? "Negocio"}: ${formatCents(deciding.w.amount_cents)} de punitorios. ${
                deciding.approve ? "Se condona hasta lo que siga pendiente." : "No cambia el saldo."
              }`
            : undefined
        }
        confirmLabel={deciding?.approve ? "Aprobar" : "Rechazar"}
        danger={deciding ? !deciding.approve : false}
        loading={m.decideWaiver.isPending}
        onConfirm={async (reason) => {
          if (!deciding) return;
          try {
            await m.decideWaiver.mutateAsync({ id: deciding.w.id, approve: deciding.approve, reason });
            toast({ title: deciding.approve ? "Condonación aprobada" : "Condonación rechazada", variant: "success" });
            setDeciding(null);
          } catch (e) {
            toast({ title: "No se pudo resolver", description: moraErrorMessage(e), variant: "error" });
          }
        }}
      />
    </section>
  );
}

export function MoraOverview({ access }: { access: BillingAccess | undefined }) {
  const [sub, setSub] = useState<Sub>("negocios");
  const { data: ov, isLoading, error } = useMoraOverview(sub === "negocios");

  return (
    <div className="mt-6 space-y-8">
      <Segmented<Sub>
        value={sub}
        onChange={setSub}
        scrollOnMobile
        aria-label="Mora y punitorios"
        options={[
          { value: "negocios", label: "Negocios en mora" },
          { value: "configuracion", label: "Punitorios, escalera y feriados" },
        ]}
      />

      {sub === "configuracion" && <MoraConfigView />}

      {sub === "negocios" &&
        (isLoading ? (
          <div className="space-y-3" aria-busy>
            <Skeleton className="h-24 rounded-xl" />
            <Skeleton className="h-64 rounded-xl" />
          </div>
        ) : error || !ov ? (
          <Callout tone="warning" icon={Gavel} title="No se pudo cargar la mora">
            {moraErrorMessage(error)}
          </Callout>
        ) : (
          <>
            <div className="flex flex-wrap gap-2 text-sm">
              <Badge tone={ov.interest_enabled ? "success" : "neutral"}>Punitorios {ov.interest_enabled ? "prendidos" : "apagados"}</Badge>
              <Badge tone={ov.dunning_enabled ? "success" : "warning"}>Escalera {ov.dunning_enabled ? "activa" : "apagada"}</Badge>
              {!ov.business_day && <Badge tone="info">Hoy no es día hábil: la escalera no avanza</Badge>}
            </div>

            {(ov.fiscal_pending.debit_notes > 0 || ov.fiscal_pending.credit_notes > 0) && (
              <Callout tone="neutral" icon={FileClock} title="Comprobantes pendientes de la factura con CAE (H130)">
                {ov.fiscal_pending.debit_notes} nota{ov.fiscal_pending.debit_notes === 1 ? "" : "s"} de débito por{" "}
                {formatCents(ov.fiscal_pending.debit_cents)} y {ov.fiscal_pending.credit_notes} nota
                {ov.fiscal_pending.credit_notes === 1 ? "" : "s"} de crédito por {formatCents(ov.fiscal_pending.credit_cents)}. Quedan
                registradas como documentos internos: se emiten cuando NinjaSoft tenga CUIT y punto de venta.
              </Callout>
            )}

            <Approvals waivers={ov.pending_waivers} canDecide={access?.role === "super_admin"} />

            <section aria-labelledby="mora-negocios">
              <SectionHeader
                title={<span id="mora-negocios">Negocios en mora</span>}
                icon={Gavel}
                description="Con deuda vencida, promesa vigente o restricciones de la escalera. Ordenados por días de atraso."
              />
              {ov.tenants.length === 0 ? (
                <div className="mt-3 rounded-xl border border-border bg-card">
                  <EmptyState compact icon={Gavel} title="Nadie en mora" description="Cuando un negocio tenga deuda vencida aparece acá con su próximo paso." />
                </div>
              ) : (
                <div className="mt-3 overflow-hidden rounded-xl border border-border bg-card">
                  <table className="hidden w-full text-sm md:table">
                    <thead className="text-left text-xs uppercase tracking-wide text-muted-foreground">
                      <tr className="border-b border-border">
                        <th className="px-4 py-3 font-medium">Negocio</th>
                        <th className="px-4 py-3 font-medium">Estado</th>
                        <th className="px-4 py-3 text-right font-medium">Días</th>
                        <th className="px-4 py-3 text-right font-medium">Vencido</th>
                        <th className="px-4 py-3 text-right font-medium">Punitorios</th>
                        <th className="px-4 py-3 font-medium">Próximo paso</th>
                        <th className="px-2 py-3" />
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-border">
                      {ov.tenants.map((t) => (
                        <tr key={t.tenant_id}>
                          <td className="px-4 py-3 font-medium">
                            {t.name}
                            {t.soft_restricted && (
                              <Badge tone="warning" className="ml-2">
                                Restringido
                              </Badge>
                            )}
                            {t.subscription_status === "suspended" && (
                              <Badge tone="danger" className="ml-2">
                                Suspendido
                              </Badge>
                            )}
                          </td>
                          <td className="px-4 py-3">
                            <Badge tone={COLLECTION_STATE_TONES[t.state]}>{COLLECTION_STATE_LABELS[t.state]}</Badge>
                            {t.promise_date && (
                              <span className="ml-2 text-xs text-muted-foreground">
                                promete {formatCents(t.promise_cents ?? 0)} el {formatDay(t.promise_date)}
                              </span>
                            )}
                          </td>
                          <td className="px-4 py-3 text-right tabular-nums">{t.days_overdue}</td>
                          <td className="px-4 py-3 text-right font-semibold tabular-nums">{formatCents(t.overdue_cents)}</td>
                          <td className="px-4 py-3 text-right tabular-nums">
                            {t.interest_open_cents > 0 ? formatCents(t.interest_open_cents) : <NoData />}
                          </td>
                          <td className="px-4 py-3">
                            {t.next_step_action ? (
                              <span>
                                {DUNNING_ACTION_LABELS[t.next_step_action]}
                                <span className="text-muted-foreground"> · {formatDay(t.next_step_date)}</span>
                              </span>
                            ) : (
                              <NoData />
                            )}
                          </td>
                          <td className="px-2 py-3">
                            <Link href={tenantHref(t.tenant_id)} aria-label={`Ver cuenta de ${t.name}`} className="text-muted-foreground hover:text-foreground">
                              <ChevronRight size={16} />
                            </Link>
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                  <ul className="divide-y divide-border md:hidden">
                    {ov.tenants.map((t) => (
                      <li key={t.tenant_id}>
                        <Link href={tenantHref(t.tenant_id)} className="flex items-center justify-between gap-3 px-4 py-3">
                          <span className="min-w-0">
                            <span className="flex items-center gap-2">
                              <span className="truncate text-sm font-medium">{t.name}</span>
                              <Badge tone={COLLECTION_STATE_TONES[t.state]}>{COLLECTION_STATE_LABELS[t.state]}</Badge>
                            </span>
                            <span className="mt-0.5 block text-xs text-muted-foreground">
                              {t.days_overdue} d de mora
                              {t.next_step_action ? ` · ${DUNNING_ACTION_LABELS[t.next_step_action]} el ${formatDay(t.next_step_date)}` : ""}
                            </span>
                          </span>
                          <span className="shrink-0 text-right text-sm font-semibold tabular-nums">{formatCents(t.overdue_cents)}</span>
                        </Link>
                      </li>
                    ))}
                  </ul>
                </div>
              )}
            </section>
          </>
        ))}
    </div>
  );
}
MoraOverview.displayName = "MoraOverview";
