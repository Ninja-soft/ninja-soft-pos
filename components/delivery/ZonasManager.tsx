"use client";

import { useState } from "react";
import { Bike, Clock, MapPin, Pencil, Plus, Power, Trash2 } from "lucide-react";
import { Button } from "@/components/ui/Button";
import { Input } from "@/components/ui/Input";
import { Modal } from "@/components/ui/Modal";
import { ConfirmDialog } from "@/components/ui/ConfirmDialog";
import { useToast } from "@/components/ui/Toast";
import {
  useDeliveryZones,
  useDeliveryZoneMutations,
} from "@/modules/delivery/hooks";
import type { DeliveryZone } from "@/modules/delivery/api";
import { formatCurrency } from "@/lib/utils/format";

// ── Modal de zona (alta/edición) ──────────────────────────────────────────────
function ZoneModal({
  open,
  onOpenChange,
  zone,
}: {
  open: boolean;
  onOpenChange: (o: boolean) => void;
  zone: DeliveryZone | null;
}) {
  const { toast } = useToast();
  const { create, update } = useDeliveryZoneMutations();
  const [name, setName] = useState("");
  const [fee, setFee] = useState("0");
  const [eta, setEta] = useState("");

  function sync() {
    setName(zone?.name ?? "");
    setFee(zone ? String(zone.fee) : "0");
    setEta(zone?.eta_minutes != null ? String(zone.eta_minutes) : "");
  }

  async function save() {
    if (!name.trim()) {
      toast({ title: "Poné un nombre a la zona", variant: "error" });
      return;
    }
    const feeNum = Number(fee || 0);
    if (!Number.isFinite(feeNum) || feeNum < 0) {
      toast({ title: "La tarifa no es válida", variant: "error" });
      return;
    }
    const etaNum = eta.trim() === "" ? null : Number(eta);
    if (etaNum !== null && (!Number.isFinite(etaNum) || etaNum < 0)) {
      toast({ title: "El tiempo estimado no es válido", variant: "error" });
      return;
    }
    const payload = {
      name: name.trim(),
      fee: feeNum,
      eta_minutes: etaNum === null ? null : Math.round(etaNum),
    };
    try {
      if (zone) {
        await update.mutateAsync({ id: zone.id, patch: payload });
        toast({ title: "Zona actualizada", variant: "success" });
      } else {
        await create.mutateAsync(payload);
        toast({ title: "Zona agregada", variant: "success" });
      }
      onOpenChange(false);
    } catch (e) {
      toast({
        title: "No se pudo guardar",
        description: e instanceof Error ? e.message : undefined,
        variant: "error",
      });
    }
  }

  return (
    <Modal
      open={open}
      onOpenChange={(o) => {
        if (o) sync();
        onOpenChange(o);
      }}
      title={zone ? "Editar zona" : "Nueva zona"}
    >
      <div className="space-y-4">
        <Input
          label="Nombre de la zona"
          value={name}
          onChange={(e) => setName(e.target.value)}
          autoFocus
          placeholder="Ej. Centro, Zona Norte, Barrio Sur"
        />
        <div className="grid gap-3 sm:grid-cols-2">
          <Input
            label="Tarifa de envío"
            type="number"
            min="0"
            step="1"
            value={fee}
            onChange={(e) => setFee(e.target.value)}
            placeholder="0"
          />
          <Input
            label="Tiempo estimado (min, opcional)"
            type="number"
            min="0"
            step="1"
            value={eta}
            onChange={(e) => setEta(e.target.value)}
            placeholder="Ej. 30"
          />
        </div>
        <div className="flex justify-end gap-2 pt-1">
          <Button variant="ghost" onClick={() => onOpenChange(false)}>
            Cancelar
          </Button>
          <Button onClick={save} loading={create.isPending || update.isPending}>
            {zone ? "Guardar" : "Agregar"}
          </Button>
        </div>
      </div>
    </Modal>
  );
}

// Gestión de zonas de envío (F13 · H49 follow-up). Alta/edición/activar-desactivar/
// baja de zonas (nombre + tarifa + eta opcional). Escritura RLS sólo owner/manager
// (la DB lo enforcea). Usado en Configuración → Zonas de envío. Al tomar un pedido
// de delivery, elegir la zona autocompleta el costo de envío con su tarifa.
export function ZonasManager() {
  const { toast } = useToast();
  // includeInactive=true: la gestión muestra también las desactivadas.
  const { data: zones, isLoading } = useDeliveryZones(true);
  const { update, remove } = useDeliveryZoneMutations();

  const [zoneModal, setZoneModal] = useState(false);
  const [editing, setEditing] = useState<DeliveryZone | null>(null);
  const [deleting, setDeleting] = useState<DeliveryZone | null>(null);

  function openNew() {
    setEditing(null);
    setZoneModal(true);
  }

  async function toggleActive(z: DeliveryZone) {
    try {
      await update.mutateAsync({ id: z.id, patch: { is_active: !z.is_active } });
      toast({
        title: z.is_active ? "Zona desactivada" : "Zona activada",
        variant: "success",
      });
    } catch {
      toast({ title: "No se pudo cambiar la zona", variant: "error" });
    }
  }

  async function confirmDelete() {
    if (!deleting) return;
    try {
      await remove.mutateAsync(deleting.id);
      toast({ title: "Zona eliminada", variant: "success" });
      setDeleting(null);
    } catch {
      toast({ title: "No se pudo eliminar la zona", variant: "error" });
    }
  }

  const list = zones ?? [];

  return (
    <div>
      <div className="mb-4 flex items-center justify-between gap-2">
        <span className="flex items-center gap-2 text-sm font-semibold">
          <MapPin size={16} className="text-ninja-flameSoft" /> Zonas de envío
        </span>
        <Button size="sm" variant="secondary" onClick={openNew}>
          <Plus size={15} /> Nueva zona
        </Button>
      </div>

      {isLoading ? (
        <p className="py-4 text-sm text-muted-foreground">Cargando…</p>
      ) : list.length === 0 ? (
        <div className="rounded-lg border border-dashed border-border p-5 text-center">
          <Bike size={26} className="mx-auto mb-2 text-ninja-flameSoft" />
          <p className="text-sm text-muted-foreground">
            Creá tus zonas de envío (ej. Centro, Zona Norte) con su tarifa. Al
            tomar un pedido de delivery vas a elegir la zona y el costo de envío se
            completa solo.
          </p>
        </div>
      ) : (
        <div className="space-y-2">
          {list.map((z) => (
            <div
              key={z.id}
              className={
                z.is_active
                  ? "flex items-center justify-between gap-3 rounded-xl border border-border bg-card p-3"
                  : "flex items-center justify-between gap-3 rounded-xl border border-border bg-muted/30 p-3 opacity-70"
              }
            >
              <div className="min-w-0">
                <div className="flex items-center gap-2">
                  <span className="truncate font-semibold text-foreground">
                    {z.name}
                  </span>
                  {!z.is_active && (
                    <span className="rounded bg-muted px-1.5 py-0.5 text-[11px] font-medium text-muted-foreground">
                      Inactiva
                    </span>
                  )}
                </div>
                <div className="mt-0.5 flex flex-wrap items-center gap-x-3 gap-y-0.5 text-xs text-muted-foreground">
                  <span className="price-hl font-price font-semibold tabular-nums">
                    {formatCurrency(Number(z.fee))}
                  </span>
                  {z.eta_minutes != null && (
                    <span className="flex items-center gap-1">
                      <Clock size={11} /> {z.eta_minutes} min
                    </span>
                  )}
                </div>
              </div>
              <div className="flex shrink-0 items-center gap-0.5">
                <button
                  type="button"
                  onClick={() => toggleActive(z)}
                  className={
                    z.is_active
                      ? "rounded-md p-1.5 text-ninja-flameSoft transition hover:bg-muted"
                      : "rounded-md p-1.5 text-muted-foreground transition hover:bg-muted hover:text-foreground"
                  }
                  aria-label={z.is_active ? "Desactivar zona" : "Activar zona"}
                  title={z.is_active ? "Desactivar" : "Activar"}
                >
                  <Power size={15} />
                </button>
                <button
                  type="button"
                  onClick={() => {
                    setEditing(z);
                    setZoneModal(true);
                  }}
                  className="rounded-md p-1.5 text-muted-foreground transition hover:bg-muted hover:text-foreground"
                  aria-label="Editar zona"
                >
                  <Pencil size={15} />
                </button>
                <button
                  type="button"
                  onClick={() => setDeleting(z)}
                  className="rounded-md p-1.5 text-muted-foreground transition hover:bg-muted hover:text-red-300"
                  aria-label="Eliminar zona"
                >
                  <Trash2 size={15} />
                </button>
              </div>
            </div>
          ))}
        </div>
      )}

      <ZoneModal open={zoneModal} onOpenChange={setZoneModal} zone={editing} />
      <ConfirmDialog
        open={deleting !== null}
        onOpenChange={(o) => !o && setDeleting(null)}
        title="Eliminar zona"
        description={
          deleting
            ? `¿Eliminar la zona "${deleting.name}"? Los pedidos viejos conservan su costo de envío.`
            : undefined
        }
        confirmLabel="Eliminar"
        danger
        loading={remove.isPending}
        onConfirm={confirmDelete}
      />
    </div>
  );
}
