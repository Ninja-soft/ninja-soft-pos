"use client";

import { useMemo, useState } from "react";
import {
  CalendarDays,
  ChevronLeft,
  ChevronRight,
  Plus,
  UserCog,
  Zap,
} from "lucide-react";
import { Button } from "@/components/ui/Button";
import { Card, CardContent } from "@/components/ui/Card";
import { Eyebrow, Display } from "@/components/ui/Typography";
import { Segmented } from "@/components/ui/Segmented";
import { useToast } from "@/components/ui/Toast";
import { useProfessionals, useAppointments } from "@/modules/agenda/hooks";
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
  }>({});
  const [editing, setEditing] = useState<Appointment | null>(null);
  const [detail, setDetail] = useState<Appointment | null>(null);
  const [walkInOpen, setWalkInOpen] = useState(false);

  const { data: professionals } = useProfessionals(true);

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

  function openNewAt(startsAt: Date, professionalId: string | null) {
    setNewInitial({ startsAt, professionalId });
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

  return (
    <div className="mx-auto max-w-7xl px-4 py-6 sm:px-6">
      <div className="mb-5 flex flex-wrap items-center justify-between gap-3">
        <div>
          <Eyebrow>Servicios y turnos</Eyebrow>
          <Display className="mt-2 flex items-center gap-2">
            <CalendarDays size={26} className="text-ninja-flameSoft" /> Agenda
          </Display>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <Button variant="secondary" size="sm" onClick={() => setShowProfessionals((s) => !s)}>
            <UserCog size={16} /> Profesionales
          </Button>
          <Button variant="secondary" size="sm" onClick={() => setWalkInOpen(true)}>
            <Zap size={16} /> Walk-in
          </Button>
          <Button size="sm" onClick={openNewBlank}>
            <Plus size={16} /> Nuevo turno
          </Button>
        </div>
      </div>

      {/* Gestión de profesionales (panel plegable) */}
      {showProfessionals && (
        <Card className="mb-5">
          <CardContent className="p-5">
            <ProfessionalsManager />
          </CardContent>
        </Card>
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
          <span className="ml-1 text-sm font-semibold capitalize text-foreground">
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
        <div className="mb-4 flex flex-wrap items-center justify-between gap-3 rounded-lg border border-ninja-flame/25 bg-ninja-flame/[0.06] p-4">
          <p className="text-sm text-muted-foreground">
            Agregá a tus profesionales (quienes prestan los servicios) para
            organizar la agenda por columnas y calcular comisiones.
          </p>
          <Button size="sm" variant="secondary" onClick={() => setShowProfessionals(true)}>
            <UserCog size={15} /> Agregar profesionales
          </Button>
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
