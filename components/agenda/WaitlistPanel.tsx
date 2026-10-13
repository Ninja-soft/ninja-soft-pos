"use client";

import { useEffect, useMemo, useState } from "react";
import { CalendarPlus, ListOrdered, MessageCircle, Plus, X } from "lucide-react";
import { Button } from "@/components/ui/Button";
import { Input } from "@/components/ui/Input";
import { Modal } from "@/components/ui/Modal";
import { useToast } from "@/components/ui/Toast";
import { SpinnerBlock } from "@/components/ui/Spinner";
import { EmptyState } from "@/components/ui/EmptyState";
import { useProfessionals, useWaitlist, useWaitlistMutations } from "@/modules/agenda/hooks";
import type { AgendaResource } from "@/modules/agenda/api";
import { useProducts } from "@/modules/products/hooks";
import { useCustomers } from "@/modules/customers/hooks";
import { toDatetimeLocalValue } from "@/modules/agenda/dates";
import { agendaErrorMessage } from "@/modules/agenda/overlap";
import {
  SLOT_LABELS,
  sortWaitlist,
  validateWaitlistInput,
  waitlistPhone,
  waitlistWho,
  type WaitlistEntry,
  type WaitlistSlot,
} from "@/modules/agenda/waitlist";

const selectClass =
  "h-11 w-full rounded-lg border border-input bg-background px-3 text-sm text-foreground outline-none transition focus:border-ninja-flameSoft focus:ring-4 focus:ring-ninja-flameSoft/15";

function errText(e: unknown) {
  return agendaErrorMessage(e instanceof Error ? e.message : (e as { message?: string } | null)?.message);
}

function AddEntryModal({ open, onOpenChange }: { open: boolean; onOpenChange: (o: boolean) => void }) {
  const { toast } = useToast();
  const { data: professionals } = useProfessionals(true);
  const { data: products } = useProducts("");
  const { create } = useWaitlistMutations();
  const [custSearch, setCustSearch] = useState("");
  const { data: customers } = useCustomers(custSearch);
  const [customerId, setCustomerId] = useState("");
  const [name, setName] = useState("");
  const [phone, setPhone] = useState("");
  const [serviceId, setServiceId] = useState("");
  const [serviceName, setServiceName] = useState("");
  const [professionalId, setProfessionalId] = useState("");
  const [date, setDate] = useState("");
  const [slot, setSlot] = useState<WaitlistSlot>("cualquiera");
  const [notes, setNotes] = useState("");

  useEffect(() => {
    if (!open) return;
    setCustSearch("");
    setCustomerId("");
    setName("");
    setPhone("");
    setServiceId("");
    setServiceName("");
    setProfessionalId("");
    setDate("");
    setSlot("cualquiera");
    setNotes("");
  }, [open]);

  const services = useMemo(() => (products ?? []).filter((p) => p.is_active), [products]);

  async function save() {
    const input = {
      customer_id: customerId || null,
      customer_name: customerId ? null : name.trim() || null,
      phone: phone.trim() || null,
      service_product_id: serviceId || null,
      service_name: serviceName.trim() || null,
      professional_id: professionalId || null,
      preferred_date: date || null,
      preferred_slot: slot,
      notes: notes.trim() || null,
    };
    const invalid = validateWaitlistInput(input);
    if (invalid) {
      toast({ title: invalid, variant: "error" });
      return;
    }
    try {
      await create.mutateAsync(input);
      toast({ title: "Anotado en la lista de espera", variant: "success" });
      onOpenChange(false);
    } catch (e) {
      toast({ title: "No se pudo anotar", description: errText(e), variant: "error" });
    }
  }

  return (
    <Modal open={open} onOpenChange={onOpenChange} title="Anotar en lista de espera">
      <div className="space-y-4">
        <div>
          <label className="mb-1.5 block text-sm font-medium text-muted-foreground">Cliente</label>
          <Input placeholder="Buscar cliente…" value={custSearch} onChange={(e) => setCustSearch(e.target.value)} />
          <select className={`${selectClass} mt-2`} value={customerId} onChange={(e) => setCustomerId(e.target.value)}>
            <option value="">Cliente nuevo (escribo el nombre)</option>
            {(customers ?? []).map((c) => (
              <option key={c.id} value={c.id} className="bg-popover text-popover-foreground">
                {c.name}
              </option>
            ))}
          </select>
        </div>
        {!customerId && <Input label="Nombre" value={name} onChange={(e) => setName(e.target.value)} placeholder="Ej. Paula" />}
        <Input label="Teléfono o WhatsApp (opcional)" value={phone} onChange={(e) => setPhone(e.target.value)} inputMode="tel" />
        <div>
          <label className="mb-1.5 block text-sm font-medium text-muted-foreground">Servicio</label>
          <select
            className={selectClass}
            value={serviceId}
            onChange={(e) => {
              setServiceId(e.target.value);
              const p = services.find((x) => x.id === e.target.value);
              if (p) setServiceName(p.name);
            }}
          >
            <option value="">Elegí un servicio…</option>
            {services.map((p) => (
              <option key={p.id} value={p.id} className="bg-popover text-popover-foreground">
                {p.name}
              </option>
            ))}
          </select>
          {!serviceId && (
            <Input className="mt-2" placeholder="O escribí el servicio" value={serviceName} onChange={(e) => setServiceName(e.target.value)} />
          )}
        </div>
        <div>
          <label className="mb-1.5 block text-sm font-medium text-muted-foreground">Profesional preferido</label>
          <select className={selectClass} value={professionalId} onChange={(e) => setProfessionalId(e.target.value)}>
            <option value="">Cualquiera</option>
            {(professionals ?? []).map((p) => (
              <option key={p.id} value={p.id} className="bg-popover text-popover-foreground">
                {p.name}
              </option>
            ))}
          </select>
        </div>
        <div className="grid grid-cols-2 gap-3">
          <Input label="Fecha preferida" type="date" value={date} onChange={(e) => setDate(e.target.value)} />
          <div>
            <label className="mb-1.5 block text-sm font-medium text-muted-foreground">Franja</label>
            <select className={selectClass} value={slot} onChange={(e) => setSlot(e.target.value as WaitlistSlot)}>
              {(Object.keys(SLOT_LABELS) as WaitlistSlot[]).map((k) => (
                <option key={k} value={k} className="bg-popover text-popover-foreground">
                  {SLOT_LABELS[k]}
                </option>
              ))}
            </select>
          </div>
        </div>
        <Input label="Notas (opcional)" value={notes} onChange={(e) => setNotes(e.target.value)} />
        <div className="flex justify-end gap-2 pt-1">
          <Button variant="ghost" onClick={() => onOpenChange(false)}>
            Cancelar
          </Button>
          <Button onClick={save} loading={create.isPending}>
            Anotar
          </Button>
        </div>
      </div>
    </Modal>
  );
}

function ScheduleModal({
  entry,
  resources,
  onClose,
}: {
  entry: WaitlistEntry | null;
  resources: AgendaResource[];
  onClose: () => void;
}) {
  const { toast } = useToast();
  const { data: professionals } = useProfessionals(true);
  const { schedule } = useWaitlistMutations();
  const [startsAt, setStartsAt] = useState("");
  const [professionalId, setProfessionalId] = useState("");
  const [resourceId, setResourceId] = useState("");

  useEffect(() => {
    if (!entry) return;
    const base = entry.preferred_date ? new Date(`${entry.preferred_date}T10:00`) : new Date();
    setStartsAt(toDatetimeLocalValue(base));
    setProfessionalId(entry.professional_id ?? "");
    setResourceId("");
  }, [entry]);

  async function save() {
    if (!entry || !startsAt) return;
    try {
      await schedule.mutateAsync({
        entryId: entry.id,
        startsAt: new Date(startsAt).toISOString(),
        professionalId: professionalId || null,
        resourceId: resourceId || null,
        durationMin: null,
      });
      toast({ title: "Turno agendado desde la lista de espera", variant: "success" });
      onClose();
    } catch (e) {
      toast({ title: "No se pudo agendar", description: errText(e), variant: "error" });
    }
  }

  return (
    <Modal open={Boolean(entry)} onOpenChange={(o) => !o && onClose()} title="Pasar a turno">
      {entry && (
        <div className="space-y-4">
          <p className="text-sm text-muted-foreground">
            {waitlistWho(entry)} · {entry.service_name ?? "Servicio"}
          </p>
          <Input label="Fecha y hora" type="datetime-local" value={startsAt} onChange={(e) => setStartsAt(e.target.value)} />
          <div>
            <label className="mb-1.5 block text-sm font-medium text-muted-foreground">Profesional</label>
            <select className={selectClass} value={professionalId} onChange={(e) => setProfessionalId(e.target.value)}>
              <option value="">Sin asignar</option>
              {(professionals ?? []).map((p) => (
                <option key={p.id} value={p.id} className="bg-popover text-popover-foreground">
                  {p.name}
                </option>
              ))}
            </select>
          </div>
          {resources.length > 0 && (
            <div>
              <label className="mb-1.5 block text-sm font-medium text-muted-foreground">Recurso</label>
              <select className={selectClass} value={resourceId} onChange={(e) => setResourceId(e.target.value)}>
                <option value="">Sin recurso</option>
                {resources.map((r) => (
                  <option key={r.id} value={r.id} className="bg-popover text-popover-foreground">
                    {r.name}
                  </option>
                ))}
              </select>
            </div>
          )}
          <div className="flex justify-end gap-2 pt-1">
            <Button variant="ghost" onClick={onClose}>
              Cancelar
            </Button>
            <Button onClick={save} loading={schedule.isPending}>
              <CalendarPlus size={15} /> Agendar
            </Button>
          </div>
        </div>
      )}
    </Modal>
  );
}

function waLink(phone: string | null, who: string, service: string | null): string | null {
  const digits = (phone ?? "").replace(/\D/g, "");
  if (digits.length < 8) return null;
  const text = `Hola ${who}, se liberó un turno${service ? ` para ${service}` : ""}. ¿Te lo reservamos?`;
  return `https://wa.me/${digits.startsWith("54") ? digits : `54${digits}`}?text=${encodeURIComponent(text)}`;
}

// Lista de espera (feature lista_espera). Recepción (dueño, encargado o cajero)
// anota y pasa a turno; solo lectura sólo mira.
export function WaitlistPanel({ canWrite, resources }: { canWrite: boolean; resources: AgendaResource[] }) {
  const { toast } = useToast();
  const { data, isLoading } = useWaitlist();
  const { cancel } = useWaitlistMutations();
  const [addOpen, setAddOpen] = useState(false);
  const [scheduling, setScheduling] = useState<WaitlistEntry | null>(null);
  const list = useMemo(() => sortWaitlist(data ?? []), [data]);

  async function remove(e: WaitlistEntry) {
    try {
      await cancel.mutateAsync(e.id);
      toast({ title: "Quitado de la lista de espera", variant: "success" });
    } catch (err) {
      toast({ title: "No se pudo quitar", description: errText(err), variant: "error" });
    }
  }

  return (
    <div>
      <div className="mb-3 flex items-center justify-between gap-2">
        <span className="flex items-center gap-2 text-sm font-semibold">
          <ListOrdered size={16} className="text-ninja-flameSoft" /> Lista de espera
          <span className="rounded bg-muted px-1.5 py-0.5 text-xs text-muted-foreground">{list.length}</span>
        </span>
        {canWrite && (
          <Button size="sm" variant="secondary" onClick={() => setAddOpen(true)}>
            <Plus size={15} /> Anotar
          </Button>
        )}
      </div>
      {isLoading ? (
        <SpinnerBlock className="py-6" />
      ) : list.length === 0 ? (
        <div className="rounded-xl bg-muted/50">
          <EmptyState compact icon={ListOrdered} title="Nadie esperando" description="Anotá a quien quiere un turno que hoy no tenés libre." />
        </div>
      ) : (
        <ul className="space-y-2">
          {list.map((e) => {
            const who = waitlistWho(e);
            const phone = waitlistPhone(e);
            const wa = waLink(phone, who, e.service_name);
            return (
              <li key={e.id} className="flex flex-wrap items-center justify-between gap-2 rounded-lg border border-border bg-card px-3 py-2">
                <span className="min-w-0">
                  <span className="block truncate text-sm font-medium text-foreground">{who}</span>
                  <span className="block text-xs text-muted-foreground">
                    {e.service_name ?? "Servicio a definir"} · {e.preferred_date ?? "Cualquier día"} · {SLOT_LABELS[e.preferred_slot]}
                  </span>
                  {e.notes && <span className="block truncate text-xs text-muted-foreground">{e.notes}</span>}
                </span>
                <span className="flex shrink-0 items-center gap-1">
                  {wa && (
                    <a
                      href={wa}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="rounded-md p-2 text-muted-foreground transition hover:bg-muted hover:text-foreground"
                      aria-label="Avisar por WhatsApp"
                    >
                      <MessageCircle size={16} />
                    </a>
                  )}
                  {canWrite && (
                    <>
                      <Button size="sm" onClick={() => setScheduling(e)}>
                        <CalendarPlus size={15} /> Agendar
                      </Button>
                      <button
                        type="button"
                        onClick={() => remove(e)}
                        className="rounded-md p-2 text-muted-foreground transition hover:bg-muted hover:text-danger"
                        aria-label="Quitar de la lista"
                      >
                        <X size={16} />
                      </button>
                    </>
                  )}
                </span>
              </li>
            );
          })}
        </ul>
      )}
      <AddEntryModal open={addOpen} onOpenChange={setAddOpen} />
      <ScheduleModal entry={scheduling} resources={resources} onClose={() => setScheduling(null)} />
    </div>
  );
}
