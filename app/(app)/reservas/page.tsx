"use client";

import { useMemo, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import {
  CalendarClock,
  CalendarPlus,
  Check,
  Clock,
  Phone,
  Settings,
  Users,
  Utensils,
  X,
} from "lucide-react";
import { Button } from "@/components/ui/Button";
import { Eyebrow, Display } from "@/components/ui/Typography";
import { Modal } from "@/components/ui/Modal";
import { useToast } from "@/components/ui/Toast";
import { useDiningEnabled, useDiningAreas, useDiningTables } from "@/modules/dining/hooks";
import {
  useReservations,
  useReservationMutations,
} from "@/modules/dining/reservationsHooks";
import {
  RESERVATION_STATUS_CHIP,
  RESERVATION_STATUS_LABELS,
  type Reservation,
} from "@/modules/dining/reservations";
import { ReservationModal } from "@/components/dining/ReservationModal";
import { formatCurrency } from "@/lib/utils/format";

// Agenda de reservas gastronómicas (F13 · H51). Parte de la suite de mesas:
// lista las reservas de hoy / próximos días con cliente, hora, comensales,
// mesa/sector, estado y seña. Acciones: nueva reserva, confirmar / cancelar /
// no-show y SENTAR (abre la mesa y navega a la cuenta de la mesa en el POS).
// Sólo se monta con el modo gastronómico activo (H43); con off, aviso para
// activarlo en Configuración.
export default function ReservasPage() {
  const { toast } = useToast();
  const router = useRouter();
  const { data: diningEnabled, isLoading: loadingFlag } = useDiningEnabled();
  const { data: areas } = useDiningAreas();
  const { data: tables } = useDiningTables();
  const { setStatus, cancel, seat } = useReservationMutations();

  // Rango de la agenda: hoy o próximos 7 días (desde el inicio de hoy).
  const [range, setRange] = useState<"today" | "week">("today");
  const [newOpen, setNewOpen] = useState(false);
  // Reserva en proceso de sentar sin mesa asignada → elegir mesa libre.
  const [seating, setSeating] = useState<Reservation | null>(null);

  const { from, to } = useMemo(() => {
    const start = new Date();
    start.setHours(0, 0, 0, 0);
    const end = new Date(start);
    end.setDate(end.getDate() + (range === "today" ? 1 : 7));
    return { from: start.toISOString(), to: end.toISOString() };
  }, [range]);

  const { data: reservations, isLoading } = useReservations({ from, to });

  const areaName = (id: string | null) =>
    id ? (areas ?? []).find((a) => a.id === id)?.name ?? "Sector" : null;
  const tableLabel = (id: string | null) =>
    id ? (tables ?? []).find((t) => t.id === id)?.label ?? "Mesa" : null;

  // Mesas donde se puede sentar: libres o reservadas (su propia reserva).
  const seatableTables = useMemo(
    () => (tables ?? []).filter((t) => t.status === "libre" || t.status === "reservada"),
    [tables],
  );

  // Agrupa por día (encabezados) cuando el rango es la semana.
  const grouped = useMemo(() => {
    const map = new Map<string, Reservation[]>();
    for (const r of reservations ?? []) {
      const day = new Date(r.reserved_at).toLocaleDateString("es-AR", {
        weekday: "long",
        day: "numeric",
        month: "short",
      });
      const arr = map.get(day);
      if (arr) arr.push(r);
      else map.set(day, [r]);
    }
    return map;
  }, [reservations]);

  function onConfirm(r: Reservation) {
    setStatus.mutate(
      { id: r.id, status: "confirmada" },
      {
        onError: (e) => errToast("No se pudo confirmar", e),
      },
    );
  }

  function onNoShow(r: Reservation) {
    setStatus.mutate(
      { id: r.id, status: "no_show" },
      { onError: (e) => errToast("No se pudo marcar", e) },
    );
  }

  function onCancel(r: Reservation) {
    cancel.mutate({ id: r.id }, { onError: (e) => errToast("No se pudo cancelar", e) });
  }

  // Sentar: si ya tiene mesa, abrir directo; si no, elegir una mesa libre.
  function onSeat(r: Reservation) {
    if (r.table_id) {
      doSeat(r, null);
      return;
    }
    setSeating(r);
  }

  function doSeat(r: Reservation, tableId: string | null) {
    seat.mutate(
      { id: r.id, tableId },
      {
        onSuccess: (res) => {
          setSeating(null);
          toast({ title: "Mesa abierta", variant: "success" });
          // Navegá a la cuenta de la mesa en el POS (cargar ítems / cobrar).
          router.push(`/pos?table=${res.table_order_id}`);
        },
        onError: (e) => errToast("No se pudo sentar", e),
      },
    );
  }

  function errToast(title: string, e: unknown) {
    toast({
      title,
      description: e instanceof Error ? e.message : undefined,
      variant: "error",
    });
  }

  // Modo gastronómico apagado → aviso para activarlo.
  if (!loadingFlag && !diningEnabled) {
    return (
      <div className="mx-auto max-w-2xl px-4 py-16 text-center">
        <CalendarClock size={36} className="mx-auto text-ninja-flameSoft" />
        <Display className="mt-4">Modo gastronómico desactivado</Display>
        <p className="mt-2 text-muted-foreground">
          Activá el modo gastronómico para tomar reservas de mesas. El POS de
          mostrador sigue funcionando igual mientras tanto.
        </p>
        <Link href="/configuracion?seccion=operacion" className="mt-6 inline-block">
          <Button>
            <Settings size={16} /> Ir a Configuración
          </Button>
        </Link>
      </div>
    );
  }

  const hasReservations = (reservations ?? []).length > 0;

  return (
    <div className="mx-auto max-w-5xl px-4 py-6 sm:px-6">
      <div className="mb-5 flex flex-wrap items-center justify-between gap-3">
        <div>
          <Eyebrow>Gastronomía</Eyebrow>
          <Display className="mt-2 flex items-center gap-2">
            <CalendarClock size={26} className="text-ninja-flameSoft" /> Reservas
          </Display>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <Link href="/salon">
            <Button variant="secondary" size="sm">
              <Utensils size={16} /> Salón
            </Button>
          </Link>
          <Button size="sm" onClick={() => setNewOpen(true)}>
            <CalendarPlus size={16} /> Nueva reserva
          </Button>
        </div>
      </div>

      {/* Filtro de rango */}
      <div className="mb-4 flex flex-wrap gap-2">
        {(
          [
            { k: "today" as const, label: "Hoy" },
            { k: "week" as const, label: "Próximos 7 días" },
          ]
        ).map((f) => (
          <button
            key={f.k}
            type="button"
            onClick={() => setRange(f.k)}
            className={
              range === f.k
                ? "rounded-lg bg-ninja-flame/15 px-3 py-1.5 text-sm font-medium text-ninja-flameSoft"
                : "rounded-lg px-3 py-1.5 text-sm text-muted-foreground transition hover:bg-muted hover:text-foreground"
            }
          >
            {f.label}
          </button>
        ))}
      </div>

      {/* Aviso si no hay reservas */}
      {!isLoading && !hasReservations && (
        <div className="flex flex-col items-center gap-3 rounded-xl border border-dashed border-border p-10 text-center">
          <CalendarClock size={30} className="text-ninja-flameSoft" />
          <p className="text-sm text-muted-foreground">
            No hay reservas {range === "today" ? "para hoy" : "en los próximos días"}.
            Tomá una reserva para empezar a llenar la agenda.
          </p>
          <Button size="sm" onClick={() => setNewOpen(true)}>
            <CalendarPlus size={15} /> Nueva reserva
          </Button>
        </div>
      )}

      {/* Agenda agrupada por día */}
      {[...grouped.entries()].map(([day, items]) => (
        <div key={day} className="mb-6">
          {grouped.size > 1 && (
            <h2 className="mb-2 text-sm font-semibold capitalize text-foreground">
              {day}
            </h2>
          )}
          <div className="space-y-2">
            {items.map((r) => (
              <ReservationRow
                key={r.id}
                r={r}
                areaName={areaName(r.area_id)}
                tableLabel={tableLabel(r.table_id)}
                onConfirm={() => onConfirm(r)}
                onCancel={() => onCancel(r)}
                onNoShow={() => onNoShow(r)}
                onSeat={() => onSeat(r)}
                busy={setStatus.isPending || cancel.isPending || seat.isPending}
              />
            ))}
          </div>
        </div>
      ))}

      {/* Alta de reserva */}
      <ReservationModal
        open={newOpen}
        onOpenChange={setNewOpen}
        onCreated={() => undefined}
      />

      {/* Elegir mesa libre para sentar una reserva sin mesa asignada */}
      <Modal
        open={seating !== null}
        onOpenChange={(o) => {
          if (!o) setSeating(null);
        }}
        title="Sentar reserva"
      >
        <div className="space-y-3">
          <p className="text-sm text-muted-foreground">
            Elegí una mesa libre para{" "}
            <span className="font-medium text-foreground">
              {seating?.customer_name ?? "la reserva"}
            </span>{" "}
            ({seating?.party_size} comensales).
          </p>
          {seatableTables.length === 0 ? (
            <p className="rounded-lg border border-dashed border-border p-4 text-center text-sm text-muted-foreground">
              No hay mesas libres en este momento.
            </p>
          ) : (
            <div className="grid grid-cols-3 gap-2 sm:grid-cols-4">
              {seatableTables.map((t) => (
                <button
                  key={t.id}
                  type="button"
                  disabled={seat.isPending}
                  onClick={() => seating && doSeat(seating, t.id)}
                  className="flex flex-col items-center gap-1 rounded-xl border border-ninja-flame/40 bg-ninja-flame/[0.06] p-3 text-center transition hover:border-ninja-flame disabled:opacity-50"
                >
                  <span className="text-base font-bold text-foreground">
                    {t.label}
                  </span>
                  <span className="flex items-center gap-1 text-xs text-muted-foreground">
                    <Users size={11} /> {t.capacity}
                  </span>
                </button>
              ))}
            </div>
          )}
          <div className="flex justify-end pt-1">
            <Button variant="ghost" onClick={() => setSeating(null)}>
              Cancelar
            </Button>
          </div>
        </div>
      </Modal>
    </div>
  );
}

// Una fila de la agenda: hora + cliente + comensales + mesa/sector + estado +
// seña, con las acciones según el estado de la reserva.
function ReservationRow({
  r,
  areaName,
  tableLabel,
  onConfirm,
  onCancel,
  onNoShow,
  onSeat,
  busy,
}: {
  r: Reservation;
  areaName: string | null;
  tableLabel: string | null;
  onConfirm: () => void;
  onCancel: () => void;
  onNoShow: () => void;
  onSeat: () => void;
  busy: boolean;
}) {
  const time = new Date(r.reserved_at).toLocaleTimeString("es-AR", {
    hour: "2-digit",
    minute: "2-digit",
  });
  const canSeat = r.status === "pendiente" || r.status === "confirmada";

  return (
    <div className="rounded-xl border border-border bg-card p-3">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <div className="flex items-center gap-2">
            <span className="flex items-center gap-1 text-sm font-bold tabular-nums text-foreground">
              <Clock size={13} className="text-ninja-flameSoft" /> {time}
            </span>
            <span
              className={`rounded-full border px-2 py-0.5 text-[11px] font-medium ${RESERVATION_STATUS_CHIP[r.status]}`}
            >
              {RESERVATION_STATUS_LABELS[r.status]}
            </span>
          </div>
          <p className="mt-1 truncate text-sm font-semibold text-foreground">
            {r.customer_name ?? "Sin nombre"}
          </p>
          <div className="mt-0.5 flex flex-wrap items-center gap-x-3 gap-y-0.5 text-xs text-muted-foreground">
            <span className="flex items-center gap-1">
              <Users size={11} /> {r.party_size}
            </span>
            {r.customer_phone && (
              <span className="flex items-center gap-1">
                <Phone size={11} /> {r.customer_phone}
              </span>
            )}
            {(tableLabel || areaName) && (
              <span className="flex items-center gap-1">
                <Utensils size={11} />
                {tableLabel ?? areaName}
              </span>
            )}
            {r.deposit_amount > 0 && (
              <span className="rounded bg-ninja-flame/10 px-1.5 py-0.5 text-[11px] font-medium text-ninja-flameSoft">
                Seña {formatCurrency(Number(r.deposit_amount))}
              </span>
            )}
          </div>
          {r.notes && (
            <p className="mt-1 line-clamp-2 text-xs text-muted-foreground">
              {r.notes}
            </p>
          )}
        </div>

        {/* Acciones (según estado) */}
        <div className="flex shrink-0 flex-wrap items-center gap-1.5">
          {r.status === "pendiente" && (
            <Button variant="secondary" size="sm" onClick={onConfirm} disabled={busy}>
              <Check size={14} /> Confirmar
            </Button>
          )}
          {canSeat && (
            <Button size="sm" onClick={onSeat} disabled={busy}>
              <Utensils size={14} /> Sentar
            </Button>
          )}
          {canSeat && (
            <>
              <button
                type="button"
                onClick={onNoShow}
                disabled={busy}
                className="rounded-lg px-2 py-1.5 text-xs text-muted-foreground transition hover:bg-muted hover:text-foreground disabled:opacity-50"
                title="No vino"
              >
                No vino
              </button>
              <button
                type="button"
                onClick={onCancel}
                disabled={busy}
                className="rounded-lg p-1.5 text-muted-foreground transition hover:bg-muted hover:text-foreground disabled:opacity-50"
                aria-label="Cancelar reserva"
                title="Cancelar"
              >
                <X size={15} />
              </button>
            </>
          )}
        </div>
      </div>
    </div>
  );
}
