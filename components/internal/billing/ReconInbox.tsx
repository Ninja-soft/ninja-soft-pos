"use client";

// =============================================================================
// Cobranzas › Conciliación (F20-10 · H136 · ADR-131, spec docs/40 §9.5, §17.2 y
// §17.3). La conciliación diaria (04:00 ART) compara los pagos de la cuenta de
// Mercado Pago de NinjaSoft con platform_payments; acá se ven la última corrida
// y la bandeja de diferencias con su acción (imputar, dejar a cuenta, registrar
// reintegro o contracargo, aceptar, ignorar), siempre con motivo.
// Sin credenciales de MP la corrida queda "degradada" y lo dice.
// =============================================================================

import Link from "next/link";
import { useMemo, useState } from "react";
import type { Route } from "next";
import { ChevronDown, CircleAlert, History, RefreshCw, Scale, Settings2 } from "lucide-react";
import { Badge, type BadgeTone } from "@/components/ui/Badge";
import { Button } from "@/components/ui/Button";
import { Callout } from "@/components/ui/Callout";
import { EmptyState } from "@/components/ui/EmptyState";
import { Input } from "@/components/ui/Input";
import { NoData } from "@/components/ui/NoData";
import { SectionHeader, headerActionsRow } from "@/components/ui/PageHeader";
import { Segmented } from "@/components/ui/Segmented";
import { Select } from "@/components/ui/Select";
import { Skeleton } from "@/components/ui/Skeleton";
import { useToast } from "@/components/ui/Toast";
import { ReasonDialog } from "@/components/internal/ReasonDialog";
import { formatCents, formatDay, parsePesosToCents } from "@/lib/billing/ledger";
import {
  RECON_ACTION_LABELS,
  RECON_KIND_HELP,
  RECON_KIND_LABELS,
  RECON_RESOLUTION_LABELS,
  reconActionsFor,
  type ReconAction,
  type ReconResolution,
} from "@/lib/billing/reconcile";
import {
  reconErrorMessage,
  useReconOverview,
  useReconResolve,
  useReconSettings,
  useRunReconcile,
  type ReconDiff,
  type ReconDiffKind,
  type ReconRun,
  type ReconStatusFilter,
} from "@/modules/billing/reconcile";
import { cn } from "@/lib/utils/cn";

const KIND_TONES: Record<ReconDiffKind, BadgeTone> = {
  missing_local: "danger",
  missing_mp: "warning",
  duplicate: "warning",
  amount_mismatch: "warning",
  chargeback: "danger",
  refund: "info",
  status_mismatch: "danger",
};

const RUN_STATUS: Record<ReconRun["status"], { label: string; tone: BadgeTone }> = {
  running: { label: "Corriendo", tone: "info" },
  ok: { label: "OK", tone: "success" },
  degraded: { label: "Degradada", tone: "warning" },
  error: { label: "Error", tone: "danger" },
};

const MP_STATUS_LABELS: Record<string, string> = {
  approved: "Aprobado",
  refunded: "Devuelto",
  charged_back: "Contracargo",
  in_mediation: "En mediación",
  rejected: "Rechazado",
  cancelled: "Cancelado",
  pending: "Pendiente",
  in_process: "En proceso",
  authorized: "Autorizado",
  partially_refunded: "Devuelto en parte",
  in_dispute: "En disputa",
};
const statusLabel = (s: string | null | undefined) => (s ? MP_STATUS_LABELS[s] ?? s : null);

const formatDateTime = (iso: string | null | undefined) =>
  iso
    ? new Date(iso).toLocaleString("es-AR", {
        timeZone: "America/Argentina/Buenos_Aires",
        day: "2-digit",
        month: "2-digit",
        year: "numeric",
        hour: "2-digit",
        minute: "2-digit",
      })
    : null;

const money = (c: number | null | undefined) => (c === null || c === undefined ? <NoData /> : formatCents(c));

type Pending = { diff: ReconDiff; action: ReconAction } | null;

function DiffActions({
  diff,
  canManage,
  onPick,
}: {
  diff: ReconDiff;
  canManage: boolean;
  onPick: (a: ReconAction) => void;
}) {
  if (diff.status !== "open") {
    return (
      <span className="text-xs text-muted-foreground">
        {diff.resolution ? RECON_RESOLUTION_LABELS[diff.resolution as ReconResolution] ?? diff.resolution : ""}
        {diff.resolved_by_name ? ` · ${diff.resolved_by_name}` : ""}
      </span>
    );
  }
  if (!canManage) return <span className="text-xs text-muted-foreground">Sólo lectura</span>;
  return (
    <div className="flex flex-wrap gap-1.5">
      {reconActionsFor(diff.kind).map((a) => (
        <Button key={a} size="sm" variant={a === "ignore" ? "ghost" : "secondary"} onClick={() => onPick(a)}>
          {RECON_ACTION_LABELS[a]}
        </Button>
      ))}
    </div>
  );
}

function StatePair({ diff }: { diff: ReconDiff }) {
  const mp = statusLabel(diff.mp?.status);
  const local = statusLabel(diff.payment?.status);
  return (
    <span className="text-xs">
      <span className="text-muted-foreground">MP:</span> {mp ?? "sin dato"}{" "}
      <span className="text-muted-foreground">· Acá:</span> {local ?? "sin pago"}
    </span>
  );
}

export function ReconInbox({ access }: { access?: { can_configure?: boolean } | null }) {
  const { toast } = useToast();
  const [status, setStatus] = useState<ReconStatusFilter>("open");
  const [kind, setKind] = useState<ReconDiffKind | "all">("all");
  const [pending, setPending] = useState<Pending>(null);
  const [tenantPick, setTenantPick] = useState<string | null>(null);
  const [showRuns, setShowRuns] = useState(false);
  const { data, isLoading, error } = useReconOverview(status);
  const resolve = useReconResolve();
  const run = useRunReconcile();

  const canManage = Boolean(data?.can_manage);
  const canConfigure = Boolean(data?.can_configure ?? access?.can_configure);
  const last = data?.runs[0] ?? null;

  const diffs = useMemo(
    () => (data?.diffs ?? []).filter((d) => kind === "all" || d.kind === kind),
    [data, kind],
  );
  const kindsWithCount = useMemo(() => {
    const counts = new Map<ReconDiffKind, number>();
    for (const d of data?.diffs ?? []) counts.set(d.kind, (counts.get(d.kind) ?? 0) + 1);
    return [...counts.entries()];
  }, [data]);

  const runNow = async () => {
    try {
      const r = await run.mutateAsync(undefined);
      if (r.status === "degraded") {
        toast({ title: "Conciliación degradada", description: r.message ?? "Sin credenciales de Mercado Pago.", variant: "warning" });
      } else if (r.status === "error") {
        toast({ title: "La conciliación falló", description: r.message ?? undefined, variant: "error" });
      } else {
        toast({
          title: "Conciliación lista",
          description: `${r.mp_count ?? 0} pagos de MP revisados · ${r.diffs_new ?? 0} diferencias nuevas · ${r.diffs_closed ?? 0} resueltas solas.`,
          variant: "success",
        });
      }
    } catch (e) {
      toast({ title: "No se pudo conciliar", description: reconErrorMessage(e), variant: "error" });
    }
  };

  const openAction = (diff: ReconDiff, action: ReconAction) => {
    setTenantPick(diff.tenant_id);
    setPending({ diff, action });
  };

  const confirm = async (reason: string) => {
    if (!pending) return;
    if (pending.action === "impute" && !tenantPick) {
      toast({ title: "Falta el negocio", description: "Elegí a qué negocio corresponde el pago.", variant: "warning" });
      return;
    }
    try {
      await resolve.mutateAsync({
        diffId: pending.diff.id,
        action: pending.action,
        tenantId: pending.action === "impute" ? tenantPick : null,
        reason,
      });
      toast({ title: RECON_ACTION_LABELS[pending.action], description: "La diferencia quedó resuelta.", variant: "success" });
      setPending(null);
    } catch (e) {
      toast({ title: "No se pudo resolver", description: reconErrorMessage(e), variant: "error" });
    }
  };

  return (
    <section className="mt-6 space-y-8" aria-labelledby="recon-title">
      <div>
        <SectionHeader
          title={<span id="recon-title">Conciliación con Mercado Pago</span>}
          icon={Scale}
          description="Todos los días a las 04:00 se cruzan los pagos de la cuenta de NinjaSoft con la cuenta corriente: faltantes, duplicados, montos distintos, contracargos y reintegros."
          actions={
            canManage ? (
              <Button size="sm" onClick={runNow} loading={run.isPending}>
                <RefreshCw size={15} aria-hidden />
                Conciliar ahora
              </Button>
            ) : undefined
          }
        />

        {error ? (
          <Callout tone="warning" icon={CircleAlert} title="No se pudo cargar la conciliación" className="mt-3">
            {reconErrorMessage(error)}
          </Callout>
        ) : isLoading || !data ? (
          <Skeleton className="mt-3 h-24 rounded-xl" />
        ) : (
          <div className="mt-3 space-y-3">
            {!data.credentials && (
              <Callout tone="warning" icon={CircleAlert} title="No hay credenciales de Mercado Pago cargadas">
                La conciliación corre igual, pero sin leer Mercado Pago sólo detecta duplicados de la cuenta corriente.
                Cargá el Access Token de la cuenta que cobra en{" "}
                <Link href={"/internal/pagos" as Route} className="font-medium underline">
                  Pagos de plataforma
                </Link>
                .
              </Callout>
            )}
            <div className="rounded-xl border border-border bg-card px-4 py-3">
              {last ? (
                <div className="flex flex-wrap items-center gap-x-4 gap-y-1.5 text-sm">
                  <span className="flex items-center gap-2">
                    Última corrida
                    <Badge tone={RUN_STATUS[last.status].tone} className="rounded-md">
                      {RUN_STATUS[last.status].label}
                    </Badge>
                  </span>
                  <span className="tabular-nums text-muted-foreground">{formatDateTime(last.started_at)}</span>
                  <span className="text-muted-foreground">
                    {last.mp_count} pagos de MP · {last.matched} cruzados · {last.diffs_new} nuevas · {last.diffs_closed} resueltas solas
                  </span>
                  {last.message && <span className="w-full text-xs text-muted-foreground">{last.message}</span>}
                </div>
              ) : (
                <p className="text-sm text-muted-foreground">Todavía no corrió ninguna conciliación.</p>
              )}
            </div>
          </div>
        )}
      </div>

      {data && (
        <div>
          <SectionHeader title="Diferencias" icon={CircleAlert} description="Ordenadas por gravedad. Cada acción pide motivo y queda en la auditoría." />
          <div className="mt-3 space-y-3">
            <div className="slim-scrollbar -mx-4 overflow-x-auto px-4 sm:mx-0 sm:px-0">
              <Segmented<ReconStatusFilter>
                aria-label="Estado de las diferencias"
                value={status}
                onChange={(v) => {
                  setStatus(v);
                  setKind("all");
                }}
                scrollOnMobile
                options={[
                  { value: "open", label: "Abiertas" },
                  { value: "closed", label: "Resueltas" },
                  { value: "all", label: "Todas" },
                ]}
              />
            </div>
            {kindsWithCount.length > 0 && (
              <div className={headerActionsRow} role="group" aria-label="Tipo de diferencia">
                <button
                  type="button"
                  onClick={() => setKind("all")}
                  className={cn(
                    "rounded-md px-2.5 py-1 text-xs font-medium transition-colors",
                    kind === "all" ? "bg-foreground text-background" : "bg-muted text-muted-foreground hover:text-foreground",
                  )}
                >
                  Todas ({data.diffs.length})
                </button>
                {kindsWithCount.map(([k, n]) => (
                  <button
                    key={k}
                    type="button"
                    onClick={() => setKind(k)}
                    className={cn(
                      "rounded-md px-2.5 py-1 text-xs font-medium transition-colors",
                      kind === k ? "bg-foreground text-background" : "bg-muted text-muted-foreground hover:text-foreground",
                    )}
                  >
                    {RECON_KIND_LABELS[k]} ({n})
                  </button>
                ))}
              </div>
            )}

            {diffs.length === 0 ? (
              <div className="rounded-xl border border-border bg-card">
                <EmptyState
                  compact
                  icon={Scale}
                  title={status === "open" ? "Sin diferencias abiertas" : "Sin diferencias"}
                  description={status === "open" ? "Mercado Pago y la cuenta corriente coinciden." : undefined}
                />
              </div>
            ) : (
              <div className="overflow-hidden rounded-xl border border-border bg-card">
                <div className="slim-scrollbar hidden overflow-x-auto md:block">
                  <table className="w-full min-w-[960px] text-sm">
                    <thead>
                      <tr className="border-b border-border text-left text-xs text-muted-foreground">
                        <th className="px-4 py-3 font-medium">Tipo</th>
                        <th className="px-4 py-3 font-medium">Negocio</th>
                        <th className="px-4 py-3 font-medium">Pago de MP</th>
                        <th className="px-4 py-3 text-right font-medium">Esperado</th>
                        <th className="px-4 py-3 text-right font-medium">Real</th>
                        <th className="px-4 py-3 font-medium">Estado</th>
                        <th className="px-4 py-3 font-medium">Fecha</th>
                        <th className="px-4 py-3 font-medium">Acción</th>
                      </tr>
                    </thead>
                    <tbody>
                      {diffs.map((d) => (
                        <tr key={d.id} className="border-b border-border/60 align-top last:border-0">
                          <td className="px-4 py-3">
                            <Badge tone={KIND_TONES[d.kind]} className="rounded-md" title={RECON_KIND_HELP[d.kind]}>
                              {RECON_KIND_LABELS[d.kind]}
                            </Badge>
                          </td>
                          <td className="px-4 py-3">
                            {d.tenant_name ?? <span className="text-muted-foreground">Sin identificar</span>}
                            {d.excluded && <span className="block text-xs text-muted-foreground">No se cobra ({d.excluded})</span>}
                          </td>
                          <td className="whitespace-nowrap px-4 py-3 font-mono text-xs">{d.mp_payment_id ?? <NoData />}</td>
                          <td className="whitespace-nowrap px-4 py-3 text-right tabular-nums">{money(d.expected_cents)}</td>
                          <td className="whitespace-nowrap px-4 py-3 text-right tabular-nums">{money(d.actual_cents)}</td>
                          <td className="px-4 py-3">
                            <StatePair diff={d} />
                          </td>
                          <td className="whitespace-nowrap px-4 py-3 tabular-nums text-muted-foreground">{formatDay(d.created_at.slice(0, 10))}</td>
                          <td className="px-4 py-3">
                            <DiffActions diff={d} canManage={canManage} onPick={(a) => openAction(d, a)} />
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
                <ul className="divide-y divide-border md:hidden">
                  {diffs.map((d) => (
                    <li key={d.id} className="space-y-2 px-4 py-3">
                      <div className="flex flex-wrap items-center justify-between gap-2">
                        <Badge tone={KIND_TONES[d.kind]} className="rounded-md">
                          {RECON_KIND_LABELS[d.kind]}
                        </Badge>
                        <span className="text-xs tabular-nums text-muted-foreground">{formatDay(d.created_at.slice(0, 10))}</span>
                      </div>
                      <p className="text-sm font-medium">{d.tenant_name ?? "Negocio sin identificar"}</p>
                      <p className="text-xs text-muted-foreground">
                        {d.mp_payment_id ? `MP ${d.mp_payment_id} · ` : ""}
                        Esperado {d.expected_cents === null ? "sin dato" : formatCents(d.expected_cents)} · Real{" "}
                        {d.actual_cents === null ? "sin dato" : formatCents(d.actual_cents)}
                      </p>
                      <StatePair diff={d} />
                      <DiffActions diff={d} canManage={canManage} onPick={(a) => openAction(d, a)} />
                    </li>
                  ))}
                </ul>
              </div>
            )}
          </div>
        </div>
      )}

      {data && data.runs.length > 0 && (
        <div>
          <button
            type="button"
            onClick={() => setShowRuns((s) => !s)}
            className="flex items-center gap-2 text-sm font-medium"
            aria-expanded={showRuns}
          >
            <History size={16} aria-hidden />
            Corridas anteriores ({data.runs.length})
            <ChevronDown size={15} className={cn("transition-transform", showRuns && "rotate-180")} aria-hidden />
          </button>
          {showRuns && (
            <div className="slim-scrollbar mt-3 overflow-x-auto rounded-xl border border-border bg-card">
              <table className="w-full min-w-[720px] text-sm">
                <thead>
                  <tr className="border-b border-border text-left text-xs text-muted-foreground">
                    <th className="px-4 py-2.5 font-medium">Inicio</th>
                    <th className="px-4 py-2.5 font-medium">Origen</th>
                    <th className="px-4 py-2.5 font-medium">Estado</th>
                    <th className="px-4 py-2.5 text-right font-medium">MP</th>
                    <th className="px-4 py-2.5 text-right font-medium">Cruzados</th>
                    <th className="px-4 py-2.5 text-right font-medium">Nuevas</th>
                    <th className="px-4 py-2.5 font-medium">Detalle</th>
                  </tr>
                </thead>
                <tbody>
                  {data.runs.map((r) => (
                    <tr key={r.id} className="border-b border-border/60 last:border-0">
                      <td className="whitespace-nowrap px-4 py-2.5 tabular-nums">{formatDateTime(r.started_at)}</td>
                      <td className="px-4 py-2.5 text-muted-foreground">
                        {r.source === "cron" ? "Automática" : `Manual${r.started_by_name ? ` · ${r.started_by_name}` : ""}`}
                      </td>
                      <td className="px-4 py-2.5">
                        <Badge tone={RUN_STATUS[r.status].tone} className="rounded-md">
                          {RUN_STATUS[r.status].label}
                        </Badge>
                      </td>
                      <td className="px-4 py-2.5 text-right tabular-nums">{r.mp_count}</td>
                      <td className="px-4 py-2.5 text-right tabular-nums">{r.matched}</td>
                      <td className="px-4 py-2.5 text-right tabular-nums">{r.diffs_new}</td>
                      <td className="px-4 py-2.5 text-xs text-muted-foreground">{r.message ?? ""}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>
      )}

      {data && canConfigure && <ReconSettingsCard windowHours={data.settings.window_hours} toleranceCents={data.settings.tolerance_cents} />}

      <ReasonDialog
        open={pending !== null}
        onOpenChange={(o) => !o && setPending(null)}
        title={pending ? RECON_ACTION_LABELS[pending.action] : ""}
        description={pending ? actionDescription(pending.diff, pending.action) : undefined}
        confirmLabel={pending ? RECON_ACTION_LABELS[pending.action] : "Confirmar"}
        danger={pending?.action === "chargeback" || pending?.action === "refund"}
        loading={resolve.isPending}
        extra={
          pending?.action === "impute" ? (
            <Select<string>
              label="Negocio"
              value={tenantPick}
              onChange={setTenantPick}
              placeholder="Elegí el negocio"
              options={(data?.tenants ?? []).map((t) => ({ value: t.id, label: t.name }))}
            />
          ) : undefined
        }
        onConfirm={confirm}
      />
    </section>
  );
}

function actionDescription(d: ReconDiff, a: ReconAction): string {
  const amount = d.actual_cents ?? d.expected_cents;
  const amt = amount === null ? "" : ` por ${formatCents(amount)}`;
  switch (a) {
    case "impute":
      return `El pago de Mercado Pago${amt} entra a la cuenta corriente del negocio y se imputa a la deuda más vieja.`;
    case "keep_credit":
      return "El pago duplicado queda como saldo a favor y se aplica solo al próximo cargo.";
    case "refund":
      return `Registra el reintegro que ya se hizo en Mercado Pago${amt}. El negocio vuelve a deber esa parte. No se devuelve plata desde acá.`;
    case "chargeback":
      return "Registra el contracargo: el pago se revierte, los cargos vuelven a deberse y la escalera de mora corre otra vez.";
    case "accept":
      return "La diferencia queda aceptada sin mover la cuenta corriente.";
    default:
      return "La diferencia se descarta sin mover la cuenta corriente.";
  }
}

function ReconSettingsCard({ windowHours, toleranceCents }: { windowHours: number; toleranceCents: number }) {
  const { toast } = useToast();
  const save = useReconSettings();
  const [hours, setHours] = useState(String(windowHours));
  const [tolerance, setTolerance] = useState(String(toleranceCents / 100));
  const [open, setOpen] = useState(false);
  const h = Number(hours);
  const tol = parsePesosToCents(tolerance);
  const valid = Number.isInteger(h) && h >= 24 && h <= 720 && tol !== null && tol >= 0 && tol <= 1000000;
  const dirty = h !== windowHours || tol !== toleranceCents;

  return (
    <div>
      <SectionHeader title="Configuración" icon={Settings2} description="Cuántas horas hacia atrás revisa cada corrida y la diferencia de monto que se tolera." />
      <div className="mt-3 grid gap-3 rounded-xl border border-border bg-card p-4 sm:grid-cols-[1fr_1fr_auto] sm:items-end">
        <Input label="Ventana (horas)" inputMode="numeric" value={hours} onChange={(e) => setHours(e.target.value)} hint="Entre 24 y 720." />
        <Input label="Tolerancia ($)" inputMode="decimal" value={tolerance} onChange={(e) => setTolerance(e.target.value)} />
        <Button variant="secondary" disabled={!valid || !dirty} onClick={() => setOpen(true)}>
          Guardar
        </Button>
      </div>
      <ReasonDialog
        open={open}
        onOpenChange={setOpen}
        title="Guardar la configuración de la conciliación"
        confirmLabel="Guardar"
        loading={save.isPending}
        onConfirm={async (reason) => {
          try {
            await save.mutateAsync({ windowHours: h, toleranceCents: tol ?? 0, reason });
            toast({ title: "Configuración guardada", variant: "success" });
            setOpen(false);
          } catch (e) {
            toast({ title: "No se pudo guardar", description: reconErrorMessage(e), variant: "error" });
          }
        }}
      />
    </div>
  );
}
