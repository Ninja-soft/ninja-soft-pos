"use client";

import { useMemo, useState } from "react";
import {
  Armchair,
  CalendarDays,
  ChevronLeft,
  ChevronRight,
  ListOrdered,
  Plus,
  Sparkles,
  UserCog,
  Zap,
} from "lucide-react";
import { Button } from "@/components/ui/Button";
import { Card, CardContent } from "@/components/ui/Card";
import { Segmented } from "@/components/ui/Segmented";
import { useToast } from "@/components/ui/Toast";
import {
  useProfessionals,
  useAppointments,
  useAgendaResources,
  useWaitlist,
  useAgendaDemo,
  useAgendaDemoMutations,
} from "@/modules/agenda/hooks";
import { useFeature } from "@/modules/saas/gating";
import { useBranchScope } from "@/modules/branches/hooks";
import { agendaErrorMessage } from "@/modules/agenda/overlap";
import { ResourcesManager } from "@/components/agenda/ResourcesManager";
import { WaitlistPanel } from "@/components/agenda/WaitlistPanel";
import type { Appointment } from "@/modules/agenda/api";
import {
  addDays,
  startOfDay,
  startOfWeek,
  weekDays as weekDaysOf,
  formatDayLong,
  formatDayShort,
} from "@/modules/agenda/dates";
import { AgendaBoard } from "@/components/agenda/AgendaBoard";
import { AppointmentModal } from "@/components/agenda/AppointmentModal";
import { AppointmentDetailModal } from "@/components/agenda/AppointmentDetailModal";
import { ProfessionalsManager } from "@/components/agenda/ProfessionalsManager";
import { WalkInModal } from "@/components/agenda/WalkInModal";
import { PageHeader } from "@/components/ui/PageHeader";

type ViewMode = "day" | "week";

export default function AgendaPage() {
  const { toast } = useToast();
  const [mode, setMode] = useState<ViewMode>("day");
  // Ancla de la fecha visible (día o semana según el modo).
  const [anchor, setAnchor] = useState<Date>(() => startOfDay(new Date()));
  const [profFilter, setProfFilter] = useState<string | null>(null);
  const [showProfessionals, setShowProfessionals] = useState(false);

  const [newOpen, setNewOpen] = useState(false);
  const [newInitial, setNewInitial] = useState<{
    startsAt?: Date;
    professionalId?: string | null;
    resourceId?: string | null;
  }>({});
  const [showResources, setShowResources] = useState(false);
  const [showWaitlist, setShowWaitlist] = useState(false);
  const [groupBy, setGroupBy] = useState<"professional" | "resource">("professional");
  const [editing, setEditing] = useState<Appointment | null>(null);
  const [detail, setDetail] = useState<Appointment | null>(null);
  const [walkInOpen, setWalkInOpen] = useState(false);

  const { data: professionals } = useProfessionals(true);

  // Recursos y lista de espera (ADR-082): gating por plan + rol.
  const resourcesOn = useFeature("agenda_recursos") === true;
  const waitlistOn = useFeature("lista_espera") === true;
  const role = useBranchScope().data?.role ?? null;
  const canManage = role === "owner" || role === "manager";
  const canFrontDesk = canManage || role === "cashier";
  const { data: resources } = useAgendaResources(true, resourcesOn);
  const { data: waitlist } = useWaitlist(waitlistOn);
  const { data: hasDemo } = useAgendaDemo(canManage);
  const demo = useAgendaDemoMutations();
  const byResource = resourcesOn && groupBy === "resource" && (resources ?? []).length > 0;

  // Rango [from, to) de la consulta según el modo.
  const { from, to, weekList } = useMemo(() => {
    if (mode === "day") {
      const f = startOfDay(anchor);
      return { from: f, to: addDays(f, 1), weekList: [] as Date[] };
    }
    const monday = startOfWeek(anchor);
    return { from: monday, to: addDays(monday, 7), weekList: weekDaysOf(anchor) };
  }, [mode, anchor]);

  const { data: appointments } = useAppointments(from, to);

  function shift(delta: number) {
    setAnchor((d) => addDays(d, mode === "day" ? delta : delta * 7));
  }
  function goToday() {
    setAnchor(startOfDay(new Date()));
  }

  // Etiqueta del período visible.
  const periodLabel =
    mode === "day"
      ? formatDayLong(anchor)
      : `${formatDayShort(startOfWeek(anchor))} – ${formatDayShort(addDays(startOfWeek(anchor), 6))}`;

  // Detalle: nombre del profesional del turno (para el modal).
  const detailProfName =
    detail?.professional_id
      ? (professionals ?? []).find((p) => p.id === detail.professional_id)?.name ?? null
      : null;

  function openNewAt(startsAt: Date, professionalId: string | null, resourceId?: string | null) {
    setNewInitial({ startsAt, professionalId, resourceId: resourceId ?? null });
    setEditing(null);
    setNewOpen(true);
  }
  function openNewBlank() {
    setNewInitial({ startsAt: undefined, professionalId: profFilter });
    setEditing(null);
    setNewOpen(true);
  }
  function openEdit(a: Appointment) {
    setDetail(null);
    setEditing(a);
    setNewOpen(true);
  }

  const hasProfessionals = (professionals ?? []).length > 0;

  async function seedDemo() {
    try {
      const r = await demo.seed.mutateAsync();
      toast({
        title: r.already ? "Ya tenés datos de ejemplo cargados" : "Datos de ejemplo cargados",
        description: r.already ? undefined : "Profesionales, clientes y turnos de hoy para probar la agenda.",
        variant: "success",
      });
      goToday();
    } catch (e) {
      toast({
        title: "No se pudieron cargar",
        description: agendaErrorMessage(e instanceof Error ? e.message : null),
        variant: "error",
      });
    }
  }
  async function clearDemo() {
    try {
      const r = await demo.clear.mutateAsync();
      toast({
        title: "Datos de ejemplo quitados",
        description:
          r.appointments_kept > 0 ? `${r.appointments_kept} turnos de ejemplo ya cobrados se conservan.` : undefined,
        variant: "success",
      });
    } catch (e) {
      toast({
        title: "No se pudieron quitar",
        description: agendaErrorMessage(e instanceof Error ? e.message : null),
        variant: "error",
      });
    }
  }

  return (
    <div className="mx-auto w-full max-w-7xl px-4 pb-[calc(2.5rem+env(safe-area-inset-bottom))] pt-6 sm:px-6 sm:pt-8">
      <PageHeader
        className="mb-6"
        eyebrow="Servicios y turnos"
        title="Agenda"
        icon={CalendarDays}
        actions={
          <>
          <Button variant="secondary" size="sm" onClick={() => setShowProfessionals((s) => !s)}>
            <UserCog size={16} /> Profesionales
          </Button>
          {resourcesOn && (
            <Button variant="secondary" size="sm" onClick={() => setShowResources((s) => !s)}>
              <Armchair size={16} /> Recursos
            </Button>
          )}
          {waitlistOn && (
            <Button variant="secondary" size="sm" onClick={() => setShowWaitlist((s) => !s)}>
              <ListOrdered size={16} /> Espera
              {(waitlist ?? []).length > 0 && (
                <span className="rounded bg-ninja-flame/15 px-1.5 text-xs font-semibold text-ninja-flameSoft">
                  {(waitlist ?? []).length}
                </span>
              )}
            </Button>
          )}
          <Button variant="secondary" size="sm" onClick={() => setWalkInOpen(true)}>
            <Zap size={16} /> Walk-in
          </Button>
          <Button size="sm" onClick={openNewBlank}>
            <Plus size={16} /> Nuevo turno
          </Button>
          </>
        }
      />

      {/* Gestión de profesionales (panel plegable) */}
      {showProfessionals && (
        <Card className="mb-5">
          <CardContent className="p-5">
            <ProfessionalsManager />
          </CardContent>
        </Card>
      )}

      {showResources && resourcesOn && (
        <Card className="mb-5">
          <CardContent className="p-5">
            <ResourcesManager canEdit={canManage} />
          </CardContent>
        </Card>
      )}

      {showWaitlist && waitlistOn && (
        <Card className="mb-5">
          <CardContent className="p-5">
            <WaitlistPanel canWrite={canFrontDesk} resources={resourcesOn ? resources ?? [] : []} />
          </CardContent>
        </Card>
      )}

      {/* Datos de ejemplo (H42): la agenda funcionando en minutos para una demo */}
      {canManage && hasDemo && (
        <div className="mb-4 flex flex-wrap items-center justify-between gap-3 rounded-lg border border-border border-t-2 border-t-ninja-flame bg-card p-3">
          <p className="text-sm text-muted-foreground">
            Estás viendo datos de ejemplo (profesionales, clientes y turnos marcados como ejemplo).
          </p>
          <Button size="sm" variant="secondary" onClick={clearDemo} loading={demo.clear.isPending}>
            Quitar datos de ejemplo
          </Button>
        </div>
      )}

      {/* Barra de control: navegación + vista + filtro de profesional */}
      <div className="mb-4 flex flex-wrap items-center justify-between gap-3">
        <div className="flex items-center gap-2">
          <button
            type="button"
            onClick={() => shift(-1)}
            className="grid h-9 w-9 place-items-center rounded-lg border border-border text-muted-foreground transition hover:bg-muted hover:text-foreground"
            aria-label="Anterior"
          >
            <ChevronLeft size={18} />
          </button>
          <button
            type="button"
            onClick={goToday}
            className="h-9 rounded-lg border border-border px-3 text-sm font-medium text-muted-foreground transition hover:bg-muted hover:text-foreground"
          >
            Hoy
          </button>
          <button
            type="button"
            onClick={() => shift(1)}
            className="grid h-9 w-9 place-items-center rounded-lg border border-border text-muted-foreground transition hover:bg-muted hover:text-foreground"
            aria-label="Siguiente"
          >
            <ChevronRight size={18} />
          </button>
          <span className="ml-1 inline-block text-sm font-semibold text-foreground first-letter:uppercase">
            {periodLabel}
          </span>
        </div>

        <div className="flex items-center gap-2">
          {/* En la vista semana, filtro por profesional (las columnas son días) */}
          {mode === "week" && hasProfessionals && (
            <select
              value={profFilter ?? ""}
              onChange={(e) => setProfFilter(e.target.value || null)}
              className="h-9 rounded-lg border border-input bg-background px-2 text-sm text-foreground outline-none focus:border-ninja-flameSoft"
            >
              <option value="">Todos los profesionales</option>
              {(professionals ?? []).map((p) => (
                <option key={p.id} value={p.id} className="bg-popover text-popover-foreground">
                  {p.name}
                </option>
              ))}
            </select>
          )}
          {mode === "day" && resourcesOn && (resources ?? []).length > 0 && (
            <Segmented
              value={groupBy}
              onChange={(v) => setGroupBy(v as "professional" | "resource")}
              options={[
                { value: "professional", label: "Profesional" },
                { value: "resource", label: "Recurso" },
              ]}
            />
          )}
          <Segmented
            value={mode}
            onChange={(v) => setMode(v as ViewMode)}
            options={[
              { value: "day", label: "Día" },
              { value: "week", label: "Semana" },
            ]}
          />
        </div>
      </div>

      {/* Aviso si no hay profesionales todavía */}
      {!hasProfessionals && (
        <div className="mb-4 flex flex-wrap items-center justify-between gap-3 rounded-xl bg-ninja-flame/[0.08] p-4">
          <p className="text-sm text-muted-foreground">
            Agregá a tus profesionales (quienes prestan los servicios) para
            organizar la agenda por columnas y calcular comisiones.
          </p>
          <div className="flex flex-wrap gap-2">
            <Button size="sm" variant="secondary" onClick={() => setShowProfessionals(true)}>
              <UserCog size={15} /> Agregar profesionales
            </Button>
            {canManage && hasDemo === false && (
              <Button size="sm" variant="ghost" onClick={seedDemo} loading={demo.seed.isPending}>
                <Sparkles size={15} /> Cargar datos de ejemplo
              </Button>
            )}
          </div>
        </div>
      )}

      {/* Board del calendario */}
      <AgendaBoard
        mode={mode}
        day={anchor}
        weekDaysList={weekList}
        professionals={professionals ?? []}
        selectedProfessionalId={profFilter}
        appointments={appointments ?? []}
        onPick={setDetail}
        onNewAt={openNewAt}
        groupBy={byResource ? "resource" : "professional"}
        resources={resources ?? []}
      />

      <p className="mt-3 text-center text-xs text-muted-foreground">
        Tocá un hueco para agendar en ese horario · tocá un turno para ver
        detalle, cambiar estado o cobrar.
      </p>

      {/* Modales */}
      <AppointmentModal
        open={newOpen}
        onOpenChange={(o) => {
          setNewOpen(o);
          if (!o) setEditing(null);
        }}
        appointment={editing}
        initial={newInitial}
        resourcesEnabled={resourcesOn}
      />
      <AppointmentDetailModal
        appointment={detail}
        professionalName={detailProfName}
        onClose={() => setDetail(null)}
        onEdit={openEdit}
      />
      <WalkInModal
        open={walkInOpen}
        onOpenChange={setWalkInOpen}
        onCreated={() => {
          setWalkInOpen(false);
          toast({ title: "Walk-in agregado a la agenda", variant: "success" });
        }}
      />
    </div>
  );
}
