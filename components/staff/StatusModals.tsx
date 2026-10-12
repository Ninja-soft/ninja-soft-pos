"use client";

import { useEffect, useMemo, useState } from "react";
import { CalendarClock, ShieldAlert, UserCheck, UserX, type LucideIcon } from "lucide-react";
import { Modal } from "@/components/ui/Modal";
import { Button } from "@/components/ui/Button";
import { Input } from "@/components/ui/Input";
import { Callout } from "@/components/ui/Callout";
import { Segmented } from "@/components/ui/Segmented";
import { useToast } from "@/components/ui/Toast";
import { SOLID_CTA } from "@/components/security/styles";
import { RolePicker, type AssignableRole } from "@/components/staff/staffForms";
import {
  LEAVE_LABEL,
  TERMINATION_LABEL,
  staffErrorMessage,
  statusDraftProblem,
  type LeaveType,
  type StatusEvent,
  type TerminationType,
} from "@/lib/staff/status";
import { todayAR } from "@/modules/branches/logic";
import { useBranchContext } from "@/modules/branches/hooks";
import { useStaffStatusMutations } from "@/modules/staff/hooks";
import type { StaffPersonRow } from "@/modules/staff/api";
import { cn } from "@/lib/utils/cn";

export type StatusFormKind = "suspension" | "leave" | "termination";

const COPY: Record<StatusFormKind, { title: string; cta: string; icon: LucideIcon; help: string }> = {
  suspension: {
    title: "Suspender",
    cta: "Suspender",
    icon: ShieldAlert,
    help: "No puede abrir caja ni vender mientras dure. Con fecha de vuelta, se reactiva solo ese día.",
  },
  leave: {
    title: "Licencia",
    cta: "Guardar licencia",
    icon: CalendarClock,
    help: "No opera durante la licencia. Podés programarla a futuro; vuelve sola al terminar.",
  },
  termination: {
    title: "Dar de baja",
    cta: "Dar de baja",
    icon: UserX,
    help: "Pierde el acceso al negocio (se cierran sus sesiones) y deja de ocupar un usuario del plan. Su historial y sus ventas quedan. Se revierte con un reingreso.",
  },
};

// Suspensión, licencia o baja de una persona (F17 · H113).
export function StaffStatusModal({
  person,
  kind,
  events,
  onClose,
}: {
  person: StaffPersonRow | null;
  kind: StatusFormKind;
  events: StatusEvent[];
  onClose: () => void;
}) {
  const { toast } = useToast();
  const m = useStaffStatusMutations();
  const today = todayAR();
  const [from, setFrom] = useState(today);
  const [until, setUntil] = useState("");
  const [reason, setReason] = useState("");
  const [leaveType, setLeaveType] = useState<LeaveType>("vacaciones");
  const [termType, setTermType] = useState<TerminationType>("renuncia");

  useEffect(() => {
    if (!person) return;
    setFrom(today);
    setUntil("");
    setReason("");
    setLeaveType("vacaciones");
    setTermType("renuncia");
  }, [person, kind, today]);

  const subtype = kind === "leave" ? leaveType : kind === "termination" ? termType : null;
  const problem = useMemo(
    () => statusDraftProblem({ kind, subtype, from, until: until || null, reason }, today, events),
    [kind, subtype, from, until, reason, today, events],
  );
  const c = COPY[kind];

  async function submit() {
    if (!person || problem) return;
    try {
      await m.setStatus.mutateAsync({
        userId: person.user_id,
        profileId: person.profile_id,
        kind,
        subtype,
        from,
        until: kind === "termination" ? null : until || null,
        reason: reason.trim() || null,
      });
      toast({
        variant: "success",
        title:
          kind === "termination"
            ? `${person.name} quedó de baja`
            : kind === "suspension"
              ? `${person.name} quedó suspendido`
              : "Licencia guardada",
      });
      onClose();
    } catch (e) {
      toast({ variant: "error", title: staffErrorMessage(e) });
    }
  }

  return (
    <Modal
      open={Boolean(person)}
      onOpenChange={(o) => !o && onClose()}
      title={person ? `${c.title}: ${person.name}` : c.title}
      footer={
        <>
          <Button variant="secondary" onClick={onClose}>
            Cancelar
          </Button>
          <Button
            className={cn(kind === "termination" ? "" : SOLID_CTA)}
            variant={kind === "termination" ? "destructive" : "primary"}
            disabled={Boolean(problem)}
            loading={m.setStatus.isPending}
            onClick={submit}
          >
            <c.icon size={16} /> {c.cta}
          </Button>
        </>
      }
    >
      <div className="space-y-5">
        <Callout tone={kind === "termination" ? "danger" : kind === "suspension" ? "warning" : "info"} icon={c.icon}>
          {c.help}
        </Callout>

        {kind === "leave" && (
          <div>
            <span className="mb-2 block text-sm font-medium text-muted-foreground">Tipo de licencia</span>
            <Segmented
              size="sm"
              value={leaveType}
              onChange={setLeaveType}
              aria-label="Tipo de licencia"
              options={(Object.keys(LEAVE_LABEL) as LeaveType[]).map((k) => ({ value: k, label: LEAVE_LABEL[k] }))}
            />
          </div>
        )}
        {kind === "termination" && (
          <div>
            <span className="mb-2 block text-sm font-medium text-muted-foreground">Tipo de baja</span>
            <Segmented
              size="sm"
              value={termType}
              onChange={setTermType}
              aria-label="Tipo de baja"
              options={(Object.keys(TERMINATION_LABEL) as TerminationType[]).map((k) => ({ value: k, label: TERMINATION_LABEL[k] }))}
            />
          </div>
        )}

        <div className="grid gap-4 sm:grid-cols-2">
          <Input
            label={kind === "termination" ? "Desde (último día: el anterior)" : "Desde"}
            type="date"
            min={today}
            value={from}
            onChange={(e) => setFrom(e.target.value)}
          />
          {kind !== "termination" && (
            <Input
              label={kind === "suspension" ? "Vuelve el (opcional)" : "Hasta (opcional)"}
              type="date"
              min={from}
              value={until}
              onChange={(e) => setUntil(e.target.value)}
              hint={until ? undefined : kind === "suspension" ? "Sin fecha: hasta que la levantes." : "Sin fecha: hasta que la cierres."}
            />
          )}
        </div>
        <Input
          label={kind === "leave" ? "Nota (opcional)" : "Motivo"}
          value={reason}
          onChange={(e) => setReason(e.target.value)}
          placeholder={kind === "termination" ? "Queda en su historial" : kind === "suspension" ? "Ej.: llegadas tarde reiteradas" : "Ej.: certificado médico"}
        />
        {problem && (reason || from !== today || until) && <p className="text-sm text-danger">{problem}</p>}
      </div>
    </Modal>
  );
}
StaffStatusModal.displayName = "StaffStatusModal";

// Reingreso de alguien dado de baja: rol y sucursal base opcionales.
export function RehireModal({
  person,
  onClose,
  isOwner,
}: {
  person: StaffPersonRow | null;
  onClose: () => void;
  isOwner: boolean;
}) {
  const { toast } = useToast();
  const m = useStaffStatusMutations();
  const ctx = useBranchContext();
  const [role, setRole] = useState<AssignableRole>("cashier");
  const [storeId, setStoreId] = useState<string>("");
  const [reason, setReason] = useState("");

  useEffect(() => {
    if (!person) return;
    setRole((["manager", "cashier", "viewer"].includes(person.role ?? "") ? person.role : "cashier") as AssignableRole);
    setStoreId(ctx.isMulti ? (ctx.filterStoreId ?? ctx.allowed[0]?.id ?? "") : "");
    setReason("");
  }, [person, ctx.isMulti, ctx.filterStoreId, ctx.allowed]);

  async function submit() {
    if (!person) return;
    try {
      await m.rehire.mutateAsync({
        userId: person.user_id,
        profileId: person.profile_id,
        role: person.kind === "user" ? role : null,
        storeId: storeId || null,
        reason: reason.trim() || null,
      });
      toast({ variant: "success", title: `${person.name} volvió al equipo` });
      onClose();
    } catch (e) {
      toast({ variant: "error", title: staffErrorMessage(e) });
    }
  }

  return (
    <Modal
      open={Boolean(person)}
      onOpenChange={(o) => !o && onClose()}
      title={person ? `Reingreso: ${person.name}` : "Reingreso"}
      footer={
        <>
          <Button variant="secondary" onClick={onClose}>
            Cancelar
          </Button>
          <Button className={SOLID_CTA} loading={m.rehire.isPending} onClick={submit}>
            <UserCheck size={16} /> Reincorporar
          </Button>
        </>
      }
    >
      <div className="space-y-5">
        <Callout tone="info" icon={UserCheck}>
          Vuelve a tener acceso desde hoy. Su historial anterior queda como estaba.
        </Callout>
        {person?.kind === "user" && (
          <div>
            <span className="mb-2 block text-sm font-medium text-muted-foreground">Rol</span>
            <RolePicker value={role} onChange={setRole} allowManager={isOwner} />
          </div>
        )}
        {ctx.isMulti && (
          <label className="block">
            <span className="mb-2 block text-sm font-medium text-muted-foreground">Sucursal base</span>
            <select
              value={storeId}
              onChange={(e) => setStoreId(e.target.value)}
              className="h-11 w-full rounded-lg border border-border bg-background px-3 text-sm"
            >
              {ctx.allowed.map((b) => (
                <option key={b.id} value={b.id}>
                  {b.name}
                </option>
              ))}
            </select>
          </label>
        )}
        <Input label="Nota (opcional)" value={reason} onChange={(e) => setReason(e.target.value)} placeholder="Ej.: vuelve para la temporada" />
      </div>
    </Modal>
  );
}
RehireModal.displayName = "RehireModal";
