"use client";

import { useEffect, useMemo, useState } from "react";
import Link from "next/link";
import {
  Activity,
  ArrowDownCircle,
  ArrowUpCircle,
  Clock,
  Eye,
  LockKeyhole,
  MonitorDot,
  Receipt,
  Wallet,
} from "lucide-react";
import { Avatar } from "@/components/ui/Avatar";
import { Badge } from "@/components/ui/Badge";
import { Button, buttonVariants } from "@/components/ui/Button";
import { Callout } from "@/components/ui/Callout";
import { EmptyState } from "@/components/ui/EmptyState";
import { Input } from "@/components/ui/Input";
import { Modal } from "@/components/ui/Modal";
import { Spinner } from "@/components/ui/Spinner";
import { useToast } from "@/components/ui/Toast";
import { BranchDot } from "@/components/branches/BranchSwitcher";
import { EYEBROW, FLAT_PANEL, KPI, SOLID_CTA } from "@/components/security/styles";
import { useCashMonitor, useForceClose, useShiftMovements } from "@/modules/cash/hooks";
import { summarize, type MonitorShift } from "@/modules/cash/api";
import { useBranchContext, useBranches, useBranchScope } from "@/modules/branches/hooks";
import { SupervisorCancelled } from "@/modules/security/supervisor";
import { cashErrorMessage, elapsedLabel, shiftAgeTone } from "@/lib/cash/ownership";
import { capitalizeName, formatCurrency, formatRelative } from "@/lib/utils/format";
import { PAYMENT_METHOD_LABELS as METHOD_LABELS } from "@/lib/utils/paymentMethods";
import { cn } from "@/lib/utils/cn";

const ROLE: Record<string, string> = { owner: "Dueño", manager: "Encargado", cashier: "Cajero", viewer: "Solo lectura" };

function useNow(intervalMs = 1000): Date {
  const [now, setNow] = useState(() => new Date());
  useEffect(() => {
    const t = setInterval(() => setNow(new Date()), intervalMs);
    return () => clearInterval(t);
  }, [intervalMs]);
  return now;
}

// Monitor de cajas abiertas (F17 · H115). `compact` = widget del Panel del
// dueño (sin acciones, con link a la pantalla completa).
export function CashMonitor({ storeId, compact = false }: { storeId?: string | null; compact?: boolean }) {
  const ctx = useBranchContext();
  const filter = storeId !== undefined ? storeId : ctx.filterStoreId;
  const { data: shifts, isLoading, error } = useCashMonitor(filter ?? null);
  const { data: branches = [] } = useBranches();
  const now = useNow(compact ? 30_000 : 1000);
  const [detail, setDetail] = useState<MonitorShift | null>(null);
  const [closing, setClosing] = useState<MonitorShift | null>(null);

  const groups = useMemo(() => {
    const live = branches.filter((b) => !b.deleted_at && (!filter || b.id === filter));
    const byStore = new Map<string, MonitorShift[]>();
    for (const s of shifts ?? []) byStore.set(s.store_id, [...(byStore.get(s.store_id) ?? []), s]);
    return live
      .map((b) => ({
        branch: b,
        shifts: byStore.get(b.id) ?? [],
        idle: b.registers.filter(
          (r) => !r.deleted_at && !(byStore.get(b.id) ?? []).some((s) => s.register_id === r.id),
        ),
      }))
      .filter((g) => !compact || g.shifts.length > 0);
  }, [branches, shifts, filter, compact]);

  const totals = useMemo(() => {
    const list = shifts ?? [];
    return {
      open: list.length,
      sales: list.reduce((a, s) => a + s.sales_total, 0),
      count: list.reduce((a, s) => a + s.sales_count, 0),
      cash: list.reduce((a, s) => a + s.cash_expected, 0),
    };
  }, [shifts]);

  if (isLoading) return <div className="grid place-items-center py-10"><Spinner /></div>;
  if (error) {
    return (
      <Callout tone="danger" title="No pudimos cargar las cajas">
        {error instanceof Error && /feature_not_in_plan/.test(error.message)
          ? "El monitor de cajas no está incluido en tu plan."
          : "Probá de nuevo en unos segundos."}
      </Callout>
    );
  }

  return (
    <div className="space-y-5">
      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        <Kpi icon={MonitorDot} label="Cajas abiertas" value={String(totals.open)} />
        <Kpi icon={Receipt} label="Ventas de los turnos" value={String(totals.count)} />
        <Kpi icon={Activity} label="Vendido en los turnos" value={formatCurrency(totals.sales)} />
        <Kpi icon={Wallet} label="Efectivo esperado" value={formatCurrency(totals.cash)} />
      </div>

      {totals.open === 0 && compact ? (
        <div className={cn(FLAT_PANEL)}>
          <EmptyState compact icon={MonitorDot} title="No hay cajas abiertas" description="Cuando alguien abra su caja la vas a ver acá." />
        </div>
      ) : (
        groups.map((g) => (
          <section key={g.branch.id} aria-label={g.branch.name} className="space-y-2.5">
            <div className="flex flex-wrap items-center gap-2">
              <BranchDot branch={g.branch} className="h-3 w-3" />
              <h3 className="font-display text-base font-semibold">{g.branch.name}</h3>
              <span className="text-xs text-muted-foreground">
                {g.shifts.length} {g.shifts.length === 1 ? "abierta" : "abiertas"}
                {!compact && g.idle.length > 0 ? ` · ${g.idle.length} ${g.idle.length === 1 ? "libre" : "libres"}` : ""}
              </span>
            </div>
            <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-3">
              {g.shifts.map((s) => (
                <ShiftCard
                  key={s.shift_id}
                  s={s}
                  now={now}
                  compact={compact}
                  onDetail={() => setDetail(s)}
                  onForceClose={() => setClosing(s)}
                />
              ))}
              {!compact &&
                g.idle.map((r) => (
                  <div
                    key={r.id}
                    className={cn(FLAT_PANEL, "flex items-center gap-3 border-dashed bg-transparent p-4 text-sm text-muted-foreground")}
                  >
                    <span className="grid h-9 w-9 place-items-center rounded-md bg-muted">
                      <LockKeyhole size={16} aria-hidden />
                    </span>
                    <span className="min-w-0">
                      <span className="block font-medium text-foreground">{r.name}</span>
                      <span className="block text-xs">{r.is_active ? "Libre, sin turno" : "Pausada"}</span>
                    </span>
                  </div>
                ))}
            </div>
          </section>
        ))
      )}

      {compact && (
        <Link href="/caja/monitor" className={buttonVariants({ size: "sm", variant: "secondary" })}>
          <MonitorDot size={16} /> Ver todas las cajas
        </Link>
      )}

      <ShiftDetailModal shift={detail} onClose={() => setDetail(null)} />
      <ForceCloseModal shift={closing} onClose={() => setClosing(null)} />
    </div>
  );
}
CashMonitor.displayName = "CashMonitor";

function Kpi({ icon: Icon, label, value }: { icon: React.ElementType; label: string; value: string }) {
  return (
    <div className={cn(FLAT_PANEL, "p-4")}>
      <div className={cn(EYEBROW, "flex items-center gap-1.5")}>
        <Icon size={13} aria-hidden /> {label}
      </div>
      <p className={cn(KPI, "mt-2 text-xl sm:text-2xl")}>{value}</p>
    </div>
  );
}

function ShiftCard({
  s,
  now,
  compact,
  onDetail,
  onForceClose,
}: {
  s: MonitorShift;
  now: Date;
  compact: boolean;
  onDetail: () => void;
  onForceClose: () => void;
}) {
  const me = useBranchScope().data?.userId ?? null;
  const tone = shiftAgeTone(s.opened_at, now);
  const opened = new Date(s.opened_at).toLocaleTimeString("es-AR", { hour: "2-digit", minute: "2-digit" });
  return (
    <article className={cn(FLAT_PANEL, "flex flex-col p-4")}>
      <div className="flex items-start gap-3">
        <Avatar name={s.opened_by_name} avatar={s.opened_by_avatar} size={40} />
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-1.5">
            <span className="truncate font-semibold">{capitalizeName(s.opened_by_name)}</span>
            {s.opened_by === me && <Badge tone="neutral">Vos</Badge>}
          </div>
          <p className="text-xs text-muted-foreground">
            {ROLE[s.opened_by_role ?? ""] ?? "Usuario"} · {s.register_name}
            {s.register_code ? ` (${s.register_code})` : ""}
          </p>
        </div>
        <span className="inline-flex items-center gap-1.5 rounded-md bg-success/15 px-2 py-1 text-[11px] font-semibold text-success">
          <span className="h-1.5 w-1.5 rounded-full bg-success" aria-hidden /> Abierta
        </span>
      </div>

      <div className="mt-4 flex items-baseline gap-2">
        <Clock size={14} className="shrink-0 self-center text-muted-foreground" aria-hidden />
        <span
          className={cn(
            "font-display text-xl font-bold tabular-nums",
            tone === "stale" ? "text-danger" : tone === "long" ? "text-warning" : "text-foreground",
          )}
        >
          {elapsedLabel(s.opened_at, now)}
        </span>
        <span className="text-xs text-muted-foreground">desde las {opened}</span>
      </div>
      {tone !== "ok" && (
        <p className={cn("mt-1 text-xs", tone === "stale" ? "text-danger" : "text-warning")}>
          {tone === "stale" ? "Abierta hace más de 16 horas: ¿quedó sin cerrar?" : "Turno largo: más de 10 horas."}
        </p>
      )}

      <dl className="mt-4 grid grid-cols-2 gap-x-4 gap-y-2.5 text-sm">
        <Stat label="Ventas" value={`${s.sales_count}${s.voids_count ? ` (${s.voids_count} anul.)` : ""}`} />
        <Stat label="Total vendido" value={formatCurrency(s.sales_total)} />
        <Stat label="Efectivo esperado" value={formatCurrency(s.cash_expected)} strong />
        <Stat label="Última actividad" value={formatRelative(s.last_activity_at)} />
        {!compact && (
          <>
            <Stat label="Ingresos" value={formatCurrency(s.cash_in)} icon={ArrowDownCircle} />
            <Stat label="Retiros" value={formatCurrency(s.cash_out)} icon={ArrowUpCircle} />
          </>
        )}
      </dl>

      {!compact && (
        <div className="mt-4 flex flex-wrap gap-2 border-t border-border pt-3">
          <Button size="sm" variant="secondary" onClick={onDetail}>
            <Eye size={15} /> Ver detalle
          </Button>
          {s.opened_by !== me && (
            <Button size="sm" variant="ghost" onClick={onForceClose}>
              <LockKeyhole size={15} /> Cierre forzado
            </Button>
          )}
        </div>
      )}
    </article>
  );
}

function Stat({
  label,
  value,
  strong,
  icon: Icon,
}: {
  label: string;
  value: string;
  strong?: boolean;
  icon?: React.ElementType;
}) {
  return (
    <div className="min-w-0">
      <dt className="flex items-center gap-1 text-xs text-muted-foreground">
        {Icon && <Icon size={12} aria-hidden />} {label}
      </dt>
      <dd className={cn("truncate tabular-nums", strong ? "font-semibold text-foreground" : "text-foreground/90")}>{value}</dd>
    </div>
  );
}

function ShiftDetailModal({ shift, onClose }: { shift: MonitorShift | null; onClose: () => void }) {
  const { data: movements, isLoading } = useShiftMovements(shift?.shift_id ?? null);
  const summary = shift ? summarize(shift.opening_amount, movements ?? []) : null;
  return (
    <Modal
      open={Boolean(shift)}
      onOpenChange={(o) => !o && onClose()}
      title={shift ? `${shift.register_name} · ${capitalizeName(shift.opened_by_name)}` : "Turno"}
      description={shift ? `${shift.store_name} · abierta ${new Date(shift.opened_at).toLocaleString("es-AR")}` : undefined}
    >
      {isLoading || !summary ? (
        <div className="grid place-items-center py-8"><Spinner /></div>
      ) : (
        <div className="space-y-5">
          <div className="grid grid-cols-2 gap-2">
            {[
              ["Apertura", summary.opening],
              ["Ventas netas", summary.salesTotal],
              ["Ingresos", summary.income],
              ["Retiros", summary.expense],
            ].map(([k, v]) => (
              <div key={k as string} className="rounded-md bg-muted px-3 py-2">
                <p className="text-xs text-muted-foreground">{k}</p>
                <p className="font-semibold tabular-nums">{formatCurrency(v as number)}</p>
              </div>
            ))}
            <div className="col-span-2 rounded-md bg-muted px-3 py-2">
              <p className="text-xs text-muted-foreground">Efectivo esperado</p>
              <p className="text-lg font-bold tabular-nums">{formatCurrency(summary.cashExpected)}</p>
            </div>
          </div>
          {Object.keys(summary.byMethod).length > 0 && (
            <div>
              <p className={EYEBROW}>Por medio de pago</p>
              <ul className="mt-2 divide-y divide-border text-sm">
                {Object.entries(summary.byMethod).map(([k, v]) => (
                  <li key={k} className="flex justify-between py-1.5">
                    <span>{METHOD_LABELS[k] ?? k}</span>
                    <span className="tabular-nums">{formatCurrency(v)}</span>
                  </li>
                ))}
              </ul>
            </div>
          )}
          <div>
            <p className={EYEBROW}>Últimos movimientos</p>
            <ul className="mt-2 divide-y divide-border text-sm">
              {(movements ?? []).slice(0, 12).map((m) => (
                <li key={m.id} className="flex justify-between gap-3 py-1.5">
                  <span className="min-w-0 truncate">
                    {m.type === "sale" ? "Venta" : m.type === "sale_void" ? "Anulación" : m.type === "income" ? "Ingreso" : m.type === "expense" ? "Retiro" : m.type}
                    {m.reason ? <span className="text-muted-foreground"> · {m.reason}</span> : null}
                  </span>
                  <span className="shrink-0 tabular-nums text-muted-foreground">
                    {new Date(m.created_at).toLocaleTimeString("es-AR", { hour: "2-digit", minute: "2-digit" })} · {formatCurrency(m.amount)}
                  </span>
                </li>
              ))}
              {(movements ?? []).length === 0 && <li className="py-2 text-muted-foreground">Sin movimientos todavía.</li>}
            </ul>
          </div>
        </div>
      )}
    </Modal>
  );
}

function ForceCloseModal({ shift, onClose }: { shift: MonitorShift | null; onClose: () => void }) {
  const { toast } = useToast();
  const m = useForceClose();
  const [amount, setAmount] = useState("");
  const [reason, setReason] = useState("");
  useEffect(() => {
    if (shift) {
      setAmount("");
      setReason("");
    }
  }, [shift]);
  const counted = Number(amount.replace(",", "."));
  const valid = amount.trim() !== "" && Number.isFinite(counted) && counted >= 0 && reason.trim().length >= 3;

  async function submit() {
    if (!shift || !valid) return;
    try {
      const r = await m.mutateAsync({ shiftId: shift.shift_id, closing: counted, reason: reason.trim() });
      toast({
        title: "Caja cerrada",
        description: `Diferencia: ${formatCurrency(r.difference)}. Quedó en la auditoría.`,
        variant: r.difference === 0 ? "success" : "info",
      });
      onClose();
    } catch (e) {
      if (e instanceof SupervisorCancelled) return;
      toast({ title: cashErrorMessage(e) ?? "No se pudo cerrar la caja", variant: "error" });
    }
  }

  return (
    <Modal
      open={Boolean(shift)}
      onOpenChange={(o) => !o && onClose()}
      title="Cierre forzado"
      description={shift ? `${shift.register_name} de ${capitalizeName(shift.opened_by_name)} · ${shift.store_name}` : undefined}
      footer={
        <>
          <Button variant="secondary" onClick={onClose}>
            Cancelar
          </Button>
          <Button className={SOLID_CTA} disabled={!valid} loading={m.isPending} onClick={submit}>
            <LockKeyhole size={16} /> Cerrar la caja
          </Button>
        </>
      }
    >
      {shift && (
        <div className="space-y-4">
          <Callout tone="warning" title="Cerrás la caja de otra persona">
            Se genera el cierre Z con el efectivo que cuentes ahora. Pide supervisor (tu sesión si sos dueño o encargado, o
            un PIN) y queda en la auditoría con el motivo.
          </Callout>
          <div className="rounded-md bg-muted px-3 py-2 text-sm">
            <span className="text-muted-foreground">Efectivo esperado: </span>
            <span className="font-semibold tabular-nums">{formatCurrency(shift.cash_expected)}</span>
          </div>
          <Input
            label="Efectivo contado"
            inputMode="decimal"
            value={amount}
            onChange={(e) => setAmount(e.target.value)}
            placeholder={String(Math.round(shift.cash_expected))}
          />
          <Input
            label="Motivo"
            value={reason}
            onChange={(e) => setReason(e.target.value)}
            placeholder="Ej.: se fue sin cerrar la caja"
          />
        </div>
      )}
    </Modal>
  );
}
