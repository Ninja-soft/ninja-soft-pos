"use client";

import { useEffect, useMemo, useState } from "react";
import { Zap } from "lucide-react";
import { Modal } from "@/components/ui/Modal";
import { Button } from "@/components/ui/Button";
import { Input } from "@/components/ui/Input";
import { useToast } from "@/components/ui/Toast";
import { useProfessionals, useAppointmentMutations } from "@/modules/agenda/hooks";
import { useProducts } from "@/modules/products/hooks";
import { formatCurrency } from "@/lib/utils/format";

// Walk-in: cliente sin reserva, atendido ahora. Crea un turno con starts_at=ahora,
// status 'en_curso' e is_walk_in=true, listo para cobrar desde el detalle/POS.
export function WalkInModal({
  open,
  onOpenChange,
  onCreated,
}: {
  open: boolean;
  onOpenChange: (o: boolean) => void;
  onCreated: () => void;
}) {
  const { toast } = useToast();
  const { data: professionals } = useProfessionals(true);
  const { data: products } = useProducts("");
  const { create } = useAppointmentMutations();

  const [professionalId, setProfessionalId] = useState("");
  const [serviceId, setServiceId] = useState("");
  const [serviceName, setServiceName] = useState("");
  const [price, setPrice] = useState("0");
  const [duration, setDuration] = useState("30");

  const services = useMemo(
    () => (products ?? []).filter((p) => p.is_active),
    [products],
  );

  useEffect(() => {
    if (open) {
      setProfessionalId("");
      setServiceId("");
      setServiceName("");
      setPrice("0");
      setDuration("30");
    }
  }, [open]);

  function pickService(id: string) {
    setServiceId(id);
    const p = (products ?? []).find((x) => x.id === id);
    if (p) {
      setServiceName(p.name);
      setPrice(String(p.price));
      if (p.service_duration_min != null) setDuration(String(p.service_duration_min));
    }
  }

  async function save() {
    const name = serviceName.trim();
    if (!name) {
      toast({ title: "Elegí el servicio", variant: "error" });
      return;
    }
    const dur = Number(duration);
    const p = Number(price);
    const prof = (professionals ?? []).find((x) => x.id === professionalId);
    const svc = (products ?? []).find((x) => x.id === serviceId);
    try {
      await create.mutateAsync({
        professional_id: professionalId || null,
        customer_id: null,
        service_product_id: serviceId || null,
        service_name: name,
        service_price: Number.isFinite(p) ? p : 0,
        commission_pct: svc?.commission_pct ?? prof?.commission_pct ?? null,
        starts_at: new Date().toISOString(),
        duration_min: Number.isFinite(dur) && dur > 0 ? Math.round(dur) : 30,
        status: "en_curso",
        notes: null,
        is_walk_in: true,
      });
      onCreated();
    } catch (e) {
      toast({
        title: "No se pudo crear el walk-in",
        description: e instanceof Error ? e.message : undefined,
        variant: "error",
      });
    }
  }

  const selectClass =
    "h-11 w-full rounded-lg border border-input bg-background px-3 text-sm text-foreground outline-none transition focus:border-ninja-flameSoft focus:ring-4 focus:ring-ninja-flameSoft/15";

  return (
    <Modal open={open} onOpenChange={onOpenChange} title="Walk-in (sin reserva)">
      <div className="space-y-4">
        <p className="flex items-center gap-2 rounded-lg border border-ninja-flame/25 bg-ninja-flame/[0.06] p-3 text-sm text-muted-foreground">
          <Zap size={16} className="shrink-0 text-ninja-flameSoft" />
          Cliente que llegó sin turno. Se agenda ahora y queda “en curso”, listo
          para cobrar.
        </p>

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
            {services.map((p) => (
              <option key={p.id} value={p.id} className="bg-popover text-popover-foreground">
                {p.name} — {formatCurrency(p.price)}
              </option>
            ))}
          </select>
        </div>

        <Input
          label="Detalle del servicio"
          value={serviceName}
          onChange={(e) => setServiceName(e.target.value)}
          placeholder="Ej. Corte"
        />

        <div className="grid grid-cols-2 gap-3">
          <Input
            label="Precio"
            type="number"
            step="0.01"
            value={price}
            onChange={(e) => setPrice(e.target.value)}
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

        <div className="flex justify-end gap-2 pt-1">
          <Button variant="ghost" onClick={() => onOpenChange(false)}>
            Cancelar
          </Button>
          <Button onClick={save} loading={create.isPending}>
            Agregar walk-in
          </Button>
        </div>
      </div>
    </Modal>
  );
}
