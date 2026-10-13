"use client";

import { useEffect, useMemo, useState } from "react";
import { Modal } from "@/components/ui/Modal";
import { Button } from "@/components/ui/Button";
import { Input } from "@/components/ui/Input";
import { useToast } from "@/components/ui/Toast";
import {
  useProfessionals,
  useAppointmentMutations,
  useAgendaResources,
  useAppointments,
} from "@/modules/agenda/hooks";
import { findConflicts, agendaErrorMessage } from "@/modules/agenda/overlap";
import { addDays, hhmm, startOfDay } from "@/modules/agenda/dates";
import type { Appointment } from "@/modules/agenda/api";
import { toDatetimeLocalValue } from "@/modules/agenda/dates";
import { useProducts } from "@/modules/products/hooks";
import { useCustomers } from "@/modules/customers/hooks";
import { formatCurrency } from "@/lib/utils/format";

// Crear / editar un turno. Al elegir un servicio (producto), se autocompletan
// precio, duración y comisión desde sus defaults (snapshot al guardar). El turno
// guarda el snapshot, así que sigue siendo estable aunque el producto cambie.
export function AppointmentModal({
  open,
  onOpenChange,
  appointment,
  // Valores iniciales al crear desde un slot del calendario (día/hora/profesional).
  initial,
  resourcesEnabled = false,
}: {
  open: boolean;
  onOpenChange: (o: boolean) => void;
  appointment: Appointment | null;
  initial?: { startsAt?: Date; professionalId?: string | null; resourceId?: string | null };
  // Feature agenda_recursos: muestra el selector de recurso.
  resourcesEnabled?: boolean;
}) {
  const { toast } = useToast();
  const { data: professionals } = useProfessionals(true);
  const { data: products } = useProducts("");
  const { create, update } = useAppointmentMutations();

  const [professionalId, setProfessionalId] = useState<string>("");
  const [serviceId, setServiceId] = useState<string>("");
  const [serviceName, setServiceName] = useState("");
  const [servicePrice, setServicePrice] = useState("0");
  const [commission, setCommission] = useState("");
  const [duration, setDuration] = useState("30");
  const [startsAt, setStartsAt] = useState("");
  const [customerId, setCustomerId] = useState<string>("");
  const [custSearch, setCustSearch] = useState("");
  const [notes, setNotes] = useState("");
  const [resourceId, setResourceId] = useState<string>("");
  const { data: customers } = useCustomers(custSearch);
  const { data: resources } = useAgendaResources(true, open && resourcesEnabled);

  // Turnos del día elegido, para avisar choques de profesional o recurso.
  const dayRange = useMemo(() => {
    const base = startsAt ? new Date(startsAt) : new Date();
    const from = startOfDay(Number.isFinite(base.getTime()) ? base : new Date());
    return { from, to: addDays(from, 1) };
  }, [startsAt]);
  const { data: dayAppointments } = useAppointments(dayRange.from, dayRange.to);
  const conflicts = useMemo(() => {
    if (!startsAt || !Number.isFinite(new Date(startsAt).getTime())) return { professional: [], resource: [] };
    return findConflicts(dayAppointments ?? [], {
      id: appointment?.id,
      starts_at: new Date(startsAt).toISOString(),
      duration_min: Number(duration) || 0,
      status: appointment?.status ?? "reservado",
      professional_id: professionalId || null,
      resource_id: resourceId || null,
    });
  }, [dayAppointments, startsAt, duration, professionalId, resourceId, appointment]);

  const isEdit = Boolean(appointment);

  // Servicios sugeridos primero (los que tienen duración cargada), luego el resto
  // de productos activos (cualquiera puede ser un servicio de turno).
  const productOptions = useMemo(() => {
    const list = (products ?? []).filter((p) => p.is_active);
    const services = list.filter((p) => p.service_duration_min != null);
    const others = list.filter((p) => p.service_duration_min == null);
    return { services, others };
  }, [products]);

  // Sincroniza el form al abrir (edición o alta con valores iniciales del slot).
  useEffect(() => {
    if (!open) return;
    if (appointment) {
      setProfessionalId(appointment.professional_id ?? "");
      setServiceId(appointment.service_product_id ?? "");
      setServiceName(appointment.service_name);
      setServicePrice(String(appointment.service_price));
      setCommission(appointment.commission_pct != null ? String(appointment.commission_pct) : "");
      setDuration(String(appointment.duration_min));
      setStartsAt(toDatetimeLocalValue(new Date(appointment.starts_at)));
      setCustomerId(appointment.customer_id ?? "");
      setNotes(appointment.notes ?? "");
      setResourceId(appointment.resource_id ?? "");
    } else {
      setProfessionalId(initial?.professionalId ?? "");
      setServiceId("");
      setServiceName("");
      setServicePrice("0");
      setCommission("");
      setDuration("30");
      setStartsAt(toDatetimeLocalValue(initial?.startsAt ?? new Date()));
      setCustomerId("");
      setNotes("");
      setResourceId(initial?.resourceId ?? "");
    }
    setCustSearch("");
  }, [open, appointment, initial]);

  // Al elegir un servicio del catálogo, autocompletar nombre/precio/duración/
  // comisión desde sus defaults (el usuario puede ajustarlos antes de guardar).
  function pickService(id: string) {
    setServiceId(id);
    const p = (products ?? []).find((x) => x.id === id);
    if (p) {
      setServiceName(p.name);
      setServicePrice(String(p.price));
      if (p.service_duration_min != null) setDuration(String(p.service_duration_min));
      // Comisión: la del servicio o, si no, la del profesional elegido.
      const prof = (professionals ?? []).find((x) => x.id === professionalId);
      const pct = p.commission_pct ?? prof?.commission_pct ?? null;
      setCommission(pct != null ? String(pct) : "");
    }
  }

  async function save() {
    const price = Number(servicePrice);
    const dur = Number(duration);
    const name = serviceName.trim();
    if (!name) {
      toast({ title: "Elegí o escribí el servicio", variant: "error" });
      return;
    }
    if (!startsAt) {
      toast({ title: "Elegí fecha y hora", variant: "error" });
      return;
    }
    if (!Number.isFinite(dur) || dur <= 0) {
      toast({ title: "Duración inválida", variant: "error" });
      return;
    }
    const commissionPct = commission.trim() === "" ? null : Number(commission);
    const payload = {
      professional_id: professionalId || null,
      customer_id: customerId || null,
      service_product_id: serviceId || null,
      service_name: name,
      service_price: Number.isFinite(price) ? price : 0,
      commission_pct: commissionPct,
      starts_at: new Date(startsAt).toISOString(),
      duration_min: Math.round(dur),
      notes: notes.trim() || null,
      ...(resourcesEnabled || resourceId ? { resource_id: resourceId || null } : {}),
    };
    if (conflicts.resource.length > 0) {
      toast({ title: "Ese recurso ya está ocupado en ese horario", variant: "error" });
      return;
    }
    try {
      if (appointment) {
        await update.mutateAsync({ id: appointment.id, patch: payload });
        toast({ title: "Turno actualizado", variant: "success" });
      } else {
        await create.mutateAsync(payload);
        toast({ title: "Turno agendado", variant: "success" });
      }
      onOpenChange(false);
    } catch (e) {
      toast({
        title: "No se pudo guardar el turno",
        description: agendaErrorMessage(e instanceof Error ? e.message : (e as { message?: string } | null)?.message),
        variant: "error",
      });
    }
  }

  const selectClass =
    "h-11 w-full rounded-lg border border-input bg-background px-3 text-sm text-foreground outline-none transition focus:border-ninja-flameSoft focus:ring-4 focus:ring-ninja-flameSoft/15";

  return (
    <Modal
      open={open}
      onOpenChange={onOpenChange}
      title={isEdit ? "Editar turno" : "Nuevo turno"}
    >
      <div className="space-y-4">
        {/* Profesional */}
        <div>
          <label className="mb-1.5 block text-sm font-medium text-muted-foreground">
            Profesional
          </label>
          <select
            className={selectClass}
            value={professionalId}
            onChange={(e) => setProfessionalId(e.target.value)}
          >
            <option value="">Sin asignar</option>
            {(professionals ?? []).map((p) => (
              <option key={p.id} value={p.id} className="bg-popover text-popover-foreground">
                {p.name}
              </option>
            ))}
          </select>
        </div>

        {/* Recurso (silla, cabina, equipo) */}
        {resourcesEnabled && (resources ?? []).length > 0 && (
          <div>
            <label className="mb-1.5 block text-sm font-medium text-muted-foreground">
              Recurso
            </label>
            <select
              className={selectClass}
              value={resourceId}
              onChange={(e) => setResourceId(e.target.value)}
            >
              <option value="">Sin recurso</option>
              {(resources ?? []).map((r) => (
                <option key={r.id} value={r.id} className="bg-popover text-popover-foreground">
                  {r.name}
                </option>
              ))}
            </select>
          </div>
        )}

        {/* Servicio (producto del catálogo) */}
        <div>
          <label className="mb-1.5 block text-sm font-medium text-muted-foreground">
            Servicio
          </label>
          <select
            className={selectClass}
            value={serviceId}
            onChange={(e) => pickService(e.target.value)}
          >
            <option value="">Elegí un servicio…</option>
            {productOptions.services.length > 0 && (
              <optgroup label="Servicios">
                {productOptions.services.map((p) => (
                  <option key={p.id} value={p.id} className="bg-popover text-popover-foreground">
                    {p.name} · {formatCurrency(p.price)}
                    {p.service_duration_min ? ` · ${p.service_duration_min}min` : ""}
                  </option>
                ))}
              </optgroup>
            )}
            {productOptions.others.length > 0 && (
              <optgroup label="Otros productos">
                {productOptions.others.map((p) => (
                  <option key={p.id} value={p.id} className="bg-popover text-popover-foreground">
                    {p.name} · {formatCurrency(p.price)}
                  </option>
                ))}
              </optgroup>
            )}
          </select>
          <p className="mt-1 text-xs text-muted-foreground">
            Cargá servicios con duración en Productos (sección “Servicio para
            agenda”) para que aparezcan acá con su precio y duración.
          </p>
        </div>

        {/* Nombre editable (permite ajustar el snapshot o un servicio suelto) */}
        <Input
          label="Detalle del servicio"
          value={serviceName}
          onChange={(e) => setServiceName(e.target.value)}
          placeholder="Ej. Corte + barba"
        />

        <div className="grid grid-cols-2 gap-3">
          <Input
            label="Precio"
            type="number"
            step="0.01"
            value={servicePrice}
            onChange={(e) => setServicePrice(e.target.value)}
          />
          <Input
            label="Duración (min)"
            type="number"
            step="5"
            min="1"
            value={duration}
            onChange={(e) => setDuration(e.target.value)}
          />
        </div>

        <div className="grid grid-cols-2 gap-3">
          <Input
            label="Fecha y hora"
            type="datetime-local"
            value={startsAt}
            onChange={(e) => setStartsAt(e.target.value)}
          />
          <Input
            label="Comisión en % (opcional)"
            type="number"
            step="1"
            min="0"
            max="100"
            value={commission}
            onChange={(e) => setCommission(e.target.value)}
            placeholder="Ej. 30"
          />
        </div>

        {/* Cliente (opcional): buscar y elegir, o dejar sin cliente */}
        <div>
          <label className="mb-1.5 block text-sm font-medium text-muted-foreground">
            Cliente (opcional)
          </label>
          <Input
            placeholder="Buscar por nombre, documento…"
            value={custSearch}
            onChange={(e) => setCustSearch(e.target.value)}
          />
          <select
            className={`${selectClass} mt-2`}
            value={customerId}
            onChange={(e) => setCustomerId(e.target.value)}
          >
            <option value="">Sin cliente</option>
            {(customers ?? []).map((c) => (
              <option key={c.id} value={c.id} className="bg-popover text-popover-foreground">
                {c.name}
                {c.document_number ? ` (${c.document_number})` : ""}
              </option>
            ))}
          </select>
        </div>

        <Input
          label="Notas (opcional)"
          value={notes}
          onChange={(e) => setNotes(e.target.value)}
          placeholder="Color usado, preferencias, observaciones…"
        />

        {(conflicts.professional.length > 0 || conflicts.resource.length > 0) && (
          <div className="rounded-lg border border-border border-t-2 border-t-amber-400 bg-muted/40 p-3 text-sm">
            {conflicts.resource.length > 0 && (
              <p className="font-medium text-foreground">
                El recurso ya tiene un turno a las{" "}
                {conflicts.resource.map((c) => hhmm(c.starts_at)).join(", ")}. Elegí otro horario o recurso.
              </p>
            )}
            {conflicts.professional.length > 0 && (
              <p className="text-muted-foreground">
                Aviso: el profesional ya tiene turno a las{" "}
                {conflicts.professional.map((c) => hhmm(c.starts_at)).join(", ")}.
              </p>
            )}
          </div>
        )}

        <div className="flex justify-end gap-2 pt-1">
          <Button variant="ghost" onClick={() => onOpenChange(false)}>
            Cancelar
          </Button>
          <Button onClick={save} loading={create.isPending || update.isPending}>
            {isEdit ? "Guardar" : "Agendar"}
          </Button>
        </div>
      </div>
    </Modal>
  );
}
