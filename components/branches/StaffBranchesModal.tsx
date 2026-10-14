"use client";

import { useEffect, useMemo, useState } from "react";
import { ArrowRightLeft, CalendarClock, History, Plus, Store } from "lucide-react";
import { Modal } from "@/components/ui/Modal";
import { Button } from "@/components/ui/Button";
import { Input } from "@/components/ui/Input";
import { Badge, type BadgeTone } from "@/components/ui/Badge";
import { Callout } from "@/components/ui/Callout";
import { ConfirmDialog } from "@/components/ui/ConfirmDialog";
import { useToast } from "@/components/ui/Toast";
import { BranchDot } from "@/components/branches/BranchSwitcher";
import {
  useBranches,
  useStaffAssignments,
  useStaffMutations,
  type StaffPerson,
} from "@/modules/branches/hooks";
import {
  addDays,
  allowedStoreIds,
  assignmentsOf,
  assignmentStatus,
  branchErrorMessage,
  KIND_LABEL,
  periodLabel,
  ROLE_LABEL,
  STATUS_LABEL,
  todayAR,
  type AssignmentKind,
  type AssignmentStatus,
  type StaffAssignment,
} from "@/modules/branches/logic";
import { cn } from "@/lib/utils/cn";

const STATUS_TONE: Record<AssignmentStatus, BadgeTone> = {
  scheduled: "info",
  active: "success",
  ended: "neutral",
  cancelled: "neutral",
};

const KIND_HELP: Record<AssignmentKind, string> = {
  home: "Cambia su sucursal base desde la fecha elegida (hoy o más adelante). La base anterior termina el día antes.",
  cover: "Cubre otra sucursal por unos días. Mientras dura, sólo opera ahí; al terminar vuelve sola a su base.",
  extra: "Suma una sucursal más a las que ya tiene (con o sin fecha de fin).",
};

type RoleChoice = "" | "manager" | "cashier" | "viewer";

// Personal por sucursal de UNA persona (F17 · H91): dónde trabaja hoy,
// traslados y coberturas programadas e historial completo.
export function StaffBranchesModal({
  open,
  onOpenChange,
  person,
}: {
  open: boolean;
  onOpenChange: (o: boolean) => void;
  person: StaffPerson | null;
}) {
  const { toast } = useToast();
  const { data: branches = [] } = useBranches();
  const { data: all = [] } = useStaffAssignments();
  const m = useStaffMutations();
  const today = todayAR();

  const live = branches.filter((b) => !b.deleted_at);
  const byId = useMemo(() => new Map(branches.map((b) => [b.id, b])), [branches]);
  const mine = useMemo(
    () => (person ? assignmentsOf(all, { userId: person.userId, profileId: person.profileId }) : []),
    [all, person],
  );

  const [kind, setKind] = useState<AssignmentKind>("home");
  const [storeId, setStoreId] = useState("");
  const [from, setFrom] = useState(today);
  const [until, setUntil] = useState("");
  const [role, setRole] = useState<RoleChoice>("");
  const [reason, setReason] = useState("");
  const [cancelTarget, setCancelTarget] = useState<StaffAssignment | null>(null);

  useEffect(() => {
    if (!open) return;
    setKind("home");
    setStoreId("");
    setFrom(today);
    setUntil("");
    setRole("");
    setReason("");
  }, [open, today]);

  if (!person) return null;

  const effectiveRole = person.role ?? "cashier";
  const todayIds = allowedStoreIds({
    role: effectiveRole,
    stores: branches,
    assignments: mine,
    today,
  });
  const liveToday = todayIds.filter((id) => byId.get(id) && !byId.get(id)!.deleted_at);
  const isOwner = person.role === "owner";

  async function submit() {
    if (!storeId) {
      toast({ title: "Elegí la sucursal", variant: "error" });
      return;
    }
    if (kind === "cover" && !until) {
      toast({ title: "La cobertura temporal necesita fecha de fin", variant: "error" });
      return;
    }
    try {
      await m.schedule.mutateAsync({
        storeId,
        kind,
        userId: person!.userId,
        cashierProfileId: person!.profileId,
        from,
        until: kind === "home" ? null : until || null,
        role: role || null,
        reason: reason.trim() || null,
      });
      toast({
        title:
          from > today
            ? `Programado para el ${from.split("-").reverse().join("/")}`
            : kind === "home"
              ? "Traslado hecho"
              : "Asignación guardada",
        variant: "success",
      });
      setStoreId("");
      setReason("");
      setUntil("");
    } catch (e) {
      toast({ title: branchErrorMessage(e), variant: "error" });
    }
  }

  async function confirmCancel(why: string) {
    if (!cancelTarget) return;
    try {
      const r = await m.cancel.mutateAsync({ id: cancelTarget.id, reason: why || null });
      toast({ title: r === "cancelled" ? "Cancelado" : "Finalizado desde hoy", variant: "success" });
      setCancelTarget(null);
    } catch (e) {
      toast({ title: branchErrorMessage(e), variant: "error" });
    }
  }

  const fieldCls = "h-11 w-full rounded-lg border border-input bg-background px-3 text-sm";

  return (
    <>
      <Modal
        open={open}
        onOpenChange={onOpenChange}
        title={`Sucursales de ${person.name}`}
        description={person.role ? ROLE_LABEL[person.role] : "Perfil sin cuenta"}
        className="sm:max-w-2xl"
      >
        <div className="space-y-6">
          <section>
            <h3 className="flex items-center gap-2 text-sm font-semibold">
              <Store size={15} aria-hidden /> Hoy trabaja en
            </h3>
            <div className="mt-2 flex flex-wrap gap-1.5">
              {liveToday.length === 0 ? (
                <span className="text-sm text-muted-foreground">Ninguna sucursal</span>
              ) : (
                liveToday.map((id) => (
                  <span key={id} className="inline-flex items-center gap-1.5 rounded-md bg-muted px-2.5 py-1 text-xs font-medium">
                    <BranchDot branch={byId.get(id) ?? null} className="h-2 w-2" />
                    {byId.get(id)?.name}
                  </span>
                ))
              )}
            </div>
            {!isOwner && mine.filter((a) => !a.deleted_at).length === 0 && (
              <p className="mt-2 text-xs text-muted-foreground">
                Sin asignaciones: {effectiveRole === "manager" ? "como encargado ve todas las sucursales." : "opera en la sucursal principal."}
              </p>
            )}
          </section>

          {isOwner ? (
            <Callout tone="info" icon={Store}>
              El dueño ve y opera todas las sucursales siempre.
            </Callout>
          ) : (
            <section className="rounded-xl border border-border p-4">
              <h3 className="flex items-center gap-2 text-sm font-semibold">
                <ArrowRightLeft size={15} aria-hidden /> Mover o asignar
              </h3>
              <div className="mt-3 grid gap-2 sm:grid-cols-3" role="radiogroup" aria-label="Tipo de movimiento">
                {(["home", "cover", "extra"] as AssignmentKind[]).map((k) => (
                  <button
                    key={k}
                    type="button"
                    role="radio"
                    aria-checked={kind === k}
                    onClick={() => setKind(k)}
                    className={cn(
                      "rounded-lg border px-3 py-2 text-left text-sm font-semibold transition",
                      kind === k ? "border-ninja-flame/50 bg-ninja-flame/10" : "border-border hover:bg-muted",
                    )}
                  >
                    {k === "home" ? "Traslado definitivo" : KIND_LABEL[k]}
                  </button>
                ))}
              </div>
              <p className="mt-2 text-xs text-muted-foreground">{KIND_HELP[kind]}</p>

              <div className="mt-4 grid gap-3 sm:grid-cols-2">
                <label className="block">
                  <span className="mb-2 block text-sm font-medium text-muted-foreground">Sucursal</span>
                  <select value={storeId} onChange={(e) => setStoreId(e.target.value)} className={fieldCls}>
                    <option value="">Elegí una sucursal</option>
                    {live.map((b) => (
                      <option key={b.id} value={b.id}>
                        {b.name}
                        {!b.is_active ? " (pausada)" : ""}
                      </option>
                    ))}
                  </select>
                </label>
                <label className="block">
                  <span className="mb-2 block text-sm font-medium text-muted-foreground">Rol en esa sucursal</span>
                  <select value={role} onChange={(e) => setRole(e.target.value as RoleChoice)} className={fieldCls}>
                    <option value="">Igual que en el negocio</option>
                    <option value="manager">Encargado</option>
                    <option value="cashier">Cajero</option>
                    <option value="viewer">Solo lectura</option>
                  </select>
                </label>
                <Input
                  label="Desde"
                  type="date"
                  min={today}
                  value={from}
                  onChange={(e) => {
                    setFrom(e.target.value);
                    if (until && until < e.target.value) setUntil(e.target.value);
                  }}
                />
                {kind !== "home" && (
                  <Input
                    label={kind === "cover" ? "Hasta (inclusive)" : "Hasta (opcional)"}
                    type="date"
                    min={from}
                    value={until}
                    onChange={(e) => setUntil(e.target.value)}
                  />
                )}
              </div>
              {kind === "cover" && (
                <div className="mt-2 flex flex-wrap gap-1.5">
                  {[1, 3, 7, 15].map((n) => (
                    <button
                      key={n}
                      type="button"
                      onClick={() => setUntil(addDays(from, n - 1))}
                      className="h-8 rounded-md border border-border px-3 text-xs font-medium text-muted-foreground hover:bg-muted hover:text-foreground"
                    >
                      {n === 1 ? "1 día" : `${n} días`}
                    </button>
                  ))}
                </div>
              )}
              <div className="mt-3">
                <Input
                  label="Motivo"
                  value={reason}
                  onChange={(e) => setReason(e.target.value)}
                  placeholder={kind === "cover" ? "Ej.: cubre vacaciones de Ana" : "Ej.: apertura de Sucursal Norte"}
                />
              </div>
              <div className="mt-4 flex justify-end">
                <Button onClick={submit} loading={m.schedule.isPending}>
                  {from > today ? <CalendarClock size={16} /> : <Plus size={16} />}
                  {from > today ? "Programar" : kind === "home" ? "Trasladar ahora" : "Asignar"}
                </Button>
              </div>
            </section>
          )}

          <section>
            <h3 className="flex items-center gap-2 text-sm font-semibold">
              <History size={15} aria-hidden /> Historial
            </h3>
            {mine.length === 0 ? (
              <p className="mt-2 text-sm text-muted-foreground">Todavía no tiene movimientos.</p>
            ) : (
              <ul className="mt-2 divide-y divide-border rounded-xl border border-border">
                {mine.map((a) => {
                  const st = assignmentStatus(a, today);
                  const b = byId.get(a.store_id);
                  return (
                    <li key={a.id} className="flex flex-wrap items-center gap-3 px-3 py-2.5">
                      <BranchDot branch={b ?? null} />
                      <div className="min-w-0 flex-1">
                        <div className="flex flex-wrap items-center gap-2 text-sm">
                          <span className="font-medium">{b?.name ?? "Sucursal"}</span>
                          <span className="text-xs text-muted-foreground">{KIND_LABEL[a.kind]}</span>
                          {a.role && <span className="text-xs text-muted-foreground">· {ROLE_LABEL[a.role]}</span>}
                        </div>
                        <div className="text-xs text-muted-foreground">
                          {periodLabel(a.valid_from, a.valid_until)}
                          {a.reason ? ` · ${a.reason}` : ""}
                          {a.cancel_reason ? ` · ${a.cancel_reason}` : ""}
                        </div>
                      </div>
                      <Badge tone={STATUS_TONE[st]}>{STATUS_LABEL[st]}</Badge>
                      {(st === "scheduled" || st === "active") && (
                        <button
                          type="button"
                          onClick={() => setCancelTarget(a)}
                          className="h-8 rounded-md px-2 text-xs font-medium text-muted-foreground hover:bg-muted hover:text-foreground"
                        >
                          {a.valid_from >= today ? "Cancelar" : "Finalizar"}
                        </button>
                      )}
                    </li>
                  );
                })}
              </ul>
            )}
          </section>
        </div>
      </Modal>

      <ConfirmDialog
        open={Boolean(cancelTarget)}
        onOpenChange={(o) => !o && setCancelTarget(null)}
        title={cancelTarget && cancelTarget.valid_from >= today ? "Cancelar el movimiento" : "Finalizar la asignación"}
        description={
          cancelTarget && cancelTarget.valid_from >= today
            ? "Se deshace lo programado y vuelve a como estaba antes."
            : "Deja de aplicar desde hoy. Queda en el historial."
        }
        confirmLabel={cancelTarget && cancelTarget.valid_from >= today ? "Cancelar movimiento" : "Finalizar"}
        cancelLabel="Volver"
        danger
        withReason
        reasonLabel="Motivo"
        loading={m.cancel.isPending}
        onConfirm={confirmCancel}
      />
    </>
  );
}
