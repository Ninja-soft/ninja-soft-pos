"use client";

import { useMemo } from "react";
import { Plus } from "lucide-react";
import type { Appointment, Professional } from "@/modules/agenda/api";
import { STATUS_LABELS } from "@/modules/agenda/api";
import {
  atTime,
  hhmm,
  minutesIntoDay,
  startOfDay,
  formatDayShort,
} from "@/modules/agenda/dates";
import { formatCurrency } from "@/lib/utils/format";

// Rango horario visible de la agenda (8:00–21:00) y alto por hora (px).
const START_HOUR = 8;
const END_HOUR = 21;
const HOUR_PX = 56;
const TOTAL_MIN = (END_HOUR - START_HOUR) * 60;

// Una columna del board: un profesional (vista día) o un día (vista semana).
interface Column {
  key: string;
  label: string;
  sublabel?: string;
  color?: string;
  // Fecha base de la columna (para ubicar slots) y filtro de turnos.
  day: Date;
  filter: (a: Appointment) => boolean;
}

// Bloque de un turno posicionado en el grid por su hora/duración.
function AppointmentBlock({
  a,
  color,
  onClick,
}: {
  a: Appointment;
  color: string;
  onClick: () => void;
}) {
  const startMin = minutesIntoDay(a.starts_at) - START_HOUR * 60;
  const top = (Math.max(0, startMin) / 60) * HOUR_PX;
  const height = Math.max(22, (a.duration_min / 60) * HOUR_PX - 2);
  const cancelled = a.status === "cancelado" || a.status === "no_show";
  const done = a.status === "realizado";

  return (
    <button
      type="button"
      onClick={onClick}
      style={{ top, height, borderLeftColor: color }}
      className={`absolute left-0.5 right-0.5 overflow-hidden rounded-md border border-l-[3px] px-1.5 py-1 text-left text-[11px] leading-tight transition hover:z-10 hover:brightness-110 ${
        cancelled
          ? "border-border bg-muted/50 text-muted-foreground line-through opacity-70"
          : done
            ? "border-emerald-400/30 bg-emerald-400/10 text-emerald-100"
            : "border-border bg-card text-foreground"
      }`}
      title={`${hhmm(a.starts_at)} · ${a.service_name} · ${STATUS_LABELS[a.status]}`}
    >
      <span className="block truncate font-semibold">{a.service_name}</span>
      <span className="block truncate text-[10px] opacity-80">
        {hhmm(a.starts_at)}
        {a.customers?.name ? ` · ${a.customers.name}` : ""}
      </span>
      {height > 42 && (
        <span className="block truncate text-[10px] font-medium opacity-90">
          {formatCurrency(a.service_price)}
        </span>
      )}
    </button>
  );
}

// Board de la agenda: grid de horas + columnas. Click en un hueco crea un turno
// en ese día/hora (y profesional si la columna es un profesional). Click en un
// bloque abre el detalle.
export function AgendaBoard({
  mode,
  day,
  weekDaysList,
  professionals,
  selectedProfessionalId,
  appointments,
  onPick,
  onNewAt,
}: {
  mode: "day" | "week";
  day: Date;
  weekDaysList: Date[];
  professionals: Professional[];
  selectedProfessionalId: string | null; // week view: filtra por profesional
  appointments: Appointment[];
  onPick: (a: Appointment) => void;
  onNewAt: (startsAt: Date, professionalId: string | null) => void;
}) {
  // Horas del eje (8..20 → etiquetas, 21 es el borde inferior).
  const hours = useMemo(
    () => Array.from({ length: END_HOUR - START_HOUR }, (_, i) => START_HOUR + i),
    [],
  );

  // Columnas según el modo.
  const columns: Column[] = useMemo(() => {
    if (mode === "day") {
      // Una columna por profesional activo + una "Sin asignar".
      const profCols: Column[] = professionals.map((p) => ({
        key: p.id,
        label: p.name,
        color: p.color,
        day,
        filter: (a) => a.professional_id === p.id,
      }));
      profCols.push({
        key: "__none__",
        label: "Sin asignar",
        color: "#6b7280",
        day,
        filter: (a) => !a.professional_id,
      });
      return profCols;
    }
    // Semana: una columna por día. Filtra por profesional si hay uno elegido.
    return weekDaysList.map((d) => {
      const dayStart = startOfDay(d).getTime();
      const dayEnd = dayStart + 24 * 60 * 60 * 1000;
      return {
        key: d.toISOString(),
        label: formatDayShort(d),
        day: d,
        filter: (a) => {
          const t = new Date(a.starts_at).getTime();
          if (t < dayStart || t >= dayEnd) return false;
          if (selectedProfessionalId) return a.professional_id === selectedProfessionalId;
          return true;
        },
      };
    });
  }, [mode, professionals, day, weekDaysList, selectedProfessionalId]);

  // Color de un turno (por su profesional) para los bloques de la vista semana.
  const profColor = useMemo(() => {
    const m = new Map<string, string>();
    for (const p of professionals) m.set(p.id, p.color);
    return m;
  }, [professionals]);

  // Click en la columna en una posición Y → hora del slot (redondeada a 15 min).
  function handleColumnClick(col: Column, e: React.MouseEvent<HTMLDivElement>) {
    const rect = e.currentTarget.getBoundingClientRect();
    const y = e.clientY - rect.top;
    const minutes = Math.max(0, Math.min(TOTAL_MIN - 15, (y / HOUR_PX) * 60));
    const snapped = Math.round(minutes / 15) * 15;
    const hour = START_HOUR + Math.floor(snapped / 60);
    const min = snapped % 60;
    const startsAt = atTime(col.day, hour, min);
    const profId = mode === "day" ? (col.key === "__none__" ? null : col.key) : selectedProfessionalId;
    onNewAt(startsAt, profId);
  }

  return (
    <div className="overflow-x-auto rounded-lg border border-border bg-card">
      <div className="min-w-[640px]">
        {/* Encabezado de columnas */}
        <div
          className="grid border-b border-border"
          style={{ gridTemplateColumns: `52px repeat(${columns.length}, minmax(0,1fr))` }}
        >
          <div className="border-r border-border" />
          {columns.map((c) => (
            <div
              key={c.key}
              className="flex items-center justify-center gap-1.5 border-r border-border px-2 py-2 text-center"
            >
              {c.color && (
                <span
                  className="h-2.5 w-2.5 shrink-0 rounded-full"
                  style={{ backgroundColor: c.color }}
                />
              )}
              <span className="truncate text-sm font-semibold capitalize">{c.label}</span>
            </div>
          ))}
        </div>

        {/* Grid de horas + columnas con bloques posicionados */}
        <div
          className="grid"
          style={{ gridTemplateColumns: `52px repeat(${columns.length}, minmax(0,1fr))` }}
        >
          {/* Eje de horas */}
          <div className="border-r border-border">
            {hours.map((h) => (
              <div
                key={h}
                style={{ height: HOUR_PX }}
                className="relative border-b border-border/60"
              >
                <span className="absolute -top-2 right-1.5 text-[10px] font-medium text-muted-foreground">
                  {String(h).padStart(2, "0")}:00
                </span>
              </div>
            ))}
          </div>

          {/* Columnas */}
          {columns.map((col) => {
            const items = appointments.filter(col.filter);
            return (
              <div
                key={col.key}
                onClick={(e) => handleColumnClick(col, e)}
                className="group relative cursor-copy border-r border-border"
                style={{ height: hours.length * HOUR_PX }}
                title="Click para agendar un turno acá"
              >
                {/* Líneas de hora */}
                {hours.map((h) => (
                  <div
                    key={h}
                    style={{ height: HOUR_PX }}
                    className="border-b border-border/40"
                  />
                ))}
                {/* Indicador "+" al hover (affordance de crear) */}
                <span className="pointer-events-none absolute right-1 top-1 text-muted-foreground/0 transition group-hover:text-muted-foreground/40">
                  <Plus size={14} />
                </span>
                {/* Bloques de turnos */}
                {items.map((a) => (
                  <span
                    key={a.id}
                    onClick={(e) => e.stopPropagation()}
                    className="contents"
                  >
                    <AppointmentBlock
                      a={a}
                      color={
                        col.color ??
                        (a.professional_id ? profColor.get(a.professional_id) ?? "#6b7280" : "#6b7280")
                      }
                      onClick={() => onPick(a)}
                    />
                  </span>
                ))}
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
}
