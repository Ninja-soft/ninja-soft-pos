"use client";

// Orígenes del reparto (ADR-161, R8): de dónde sale cada hoja de ruta (la
// sucursal o un depósito aparte), con su dirección en el mapa y el horario de
// carga. Uno por defecto por sucursal; ordena las paradas desde ahí.

import { useState } from "react";
import { MapPin, Plus } from "lucide-react";
import { Button } from "@/components/ui/Button";
import { Badge } from "@/components/ui/Badge";
import { Input } from "@/components/ui/Input";
import { Modal } from "@/components/ui/Modal";
import { Switch } from "@/components/ui/Switch";
import { ConfirmDialog } from "@/components/ui/ConfirmDialog";
import { useToast } from "@/components/ui/Toast";
import { SettingsCard } from "@/components/settings/Settings";
import { AddressAutocomplete } from "@/components/geo/AddressAutocomplete";
import { selectCls } from "@/components/stock/transfers/shared";
import { logisticsErrorMessage } from "@/lib/logistics/logic";
import type { GeoAddress } from "@/lib/geo/address";
import { useCan, useLogisticsMutations, useOrigins, type LogisticsOrigin } from "@/modules/logistics/api";
import { useBranchContext } from "@/modules/branches/hooks";

function OriginModal({ origin, onClose }: { origin: LogisticsOrigin | "new"; onClose: () => void }) {
  const { toast } = useToast();
  const m = useLogisticsMutations();
  const { allowed } = useBranchContext();
  const o = origin === "new" ? null : origin;
  const [name, setName] = useState(o?.name ?? "");
  const [store, setStore] = useState(o?.store_id ?? allowed[0]?.id ?? "");
  const [address, setAddress] = useState<GeoAddress | null>(o?.address ?? null);
  const [hours, setHours] = useState(o?.loading_hours ?? "");
  const [isDefault, setIsDefault] = useState(o?.is_default ?? false);

  async function save() {
    try {
      await m.saveOrigin.mutateAsync({
        id: o?.id ?? null,
        p: { name: name.trim(), store_id: store, address, loading_hours: hours, is_default: isDefault },
      });
      toast({ title: "Origen guardado", variant: "success" });
      onClose();
    } catch (e) {
      toast({ title: "No se pudo guardar", description: logisticsErrorMessage(e), variant: "error" });
    }
  }

  return (
    <Modal
      open
      onOpenChange={(v) => !v && onClose()}
      title={o ? o.name : "Nuevo origen"}
      description="De acá sale el camión y acá vuelve."
      footer={
        <div className="flex justify-end gap-2">
          <Button variant="secondary" onClick={onClose}>
            Cancelar
          </Button>
          <Button onClick={save} disabled={!name.trim() || !store} loading={m.saveOrigin.isPending}>
            Guardar
          </Button>
        </div>
      }
    >
      <div className="space-y-4">
        <Input label="Nombre" value={name} maxLength={60} onChange={(e) => setName(e.target.value)} placeholder="Depósito Pilar" />
        <label className="block text-sm font-medium">
          Sucursal
          <select className={`${selectCls} mt-1.5`} value={store} onChange={(e) => setStore(e.target.value)}>
            {allowed.map((b) => (
              <option key={b.id} value={b.id} className="bg-popover text-popover-foreground">
                {b.name}
              </option>
            ))}
          </select>
        </label>
        <AddressAutocomplete value={address} onChange={setAddress} label="Dirección" />
        <Input label="Horario de carga" value={hours} maxLength={120} onChange={(e) => setHours(e.target.value)} placeholder="Lunes a viernes de 7 a 9" />
        <div className="flex items-center justify-between gap-3 rounded-lg bg-muted/40 p-3">
          <span className="text-sm font-medium">Origen por defecto de la sucursal</span>
          <Switch label="Origen por defecto" checked={isDefault} onCheckedChange={setIsDefault} />
        </div>
      </div>
    </Modal>
  );
}

export function OriginsCard() {
  const { toast } = useToast();
  const canManage = useCan("logistics.fleet.manage");
  const { data: origins = [] } = useOrigins();
  const { branchName } = useBranchContext();
  const m = useLogisticsMutations();
  const [editing, setEditing] = useState<LogisticsOrigin | "new" | null>(null);
  const [removing, setRemoving] = useState<LogisticsOrigin | null>(null);

  return (
    <SettingsCard
      title="Orígenes del reparto"
      description="Sin origen cargado, la hoja sale de la sucursal. Con la dirección en el mapa, las paradas se ordenan desde ahí."
      actions={
        canManage ? (
          <Button size="sm" onClick={() => setEditing("new")}>
            <Plus size={15} /> Nuevo origen
          </Button>
        ) : undefined
      }
    >
      {origins.length === 0 ? (
        <p className="px-5 py-6 text-sm text-muted-foreground">Todavía no hay orígenes. Cargá la dirección de tu depósito o sucursal.</p>
      ) : (
        <ul className="divide-y divide-border">
          {origins.map((o) => (
            <li key={o.id} className="flex flex-col gap-2 px-5 py-4 sm:flex-row sm:items-center sm:justify-between">
              <div className="min-w-0">
                <p className="flex flex-wrap items-center gap-2 font-medium">
                  {o.name}
                  {o.is_default && <Badge tone="brand">Por defecto</Badge>}
                  {o.lat == null && <Badge tone="warning">Sin ubicación</Badge>}
                </p>
                <p className="flex items-center gap-1.5 text-sm text-muted-foreground">
                  <MapPin size={13} aria-hidden />
                  {[branchName(o.store_id), o.address_text, o.loading_hours].filter(Boolean).join(" · ")}
                </p>
              </div>
              {canManage && (
                <div className="flex gap-2">
                  <Button size="sm" variant="secondary" onClick={() => setEditing(o)}>
                    Editar
                  </Button>
                  <Button size="sm" variant="ghost" className="text-danger" onClick={() => setRemoving(o)}>
                    Quitar
                  </Button>
                </div>
              )}
            </li>
          ))}
        </ul>
      )}
      {editing && <OriginModal origin={editing} onClose={() => setEditing(null)} />}
      <ConfirmDialog
        open={Boolean(removing)}
        onOpenChange={(v) => !v && setRemoving(null)}
        title={`Quitar ${removing?.name ?? "el origen"}`}
        description="Las hojas que ya salieron de acá no cambian."
        confirmLabel="Quitar"
        danger
        loading={m.deleteOrigin.isPending}
        onConfirm={async () => {
          if (!removing) return;
          try {
            await m.deleteOrigin.mutateAsync(removing.id);
            setRemoving(null);
          } catch (e) {
            toast({ title: "No se pudo quitar", description: logisticsErrorMessage(e), variant: "error" });
          }
        }}
      />
    </SettingsCard>
  );
}
OriginsCard.displayName = "OriginsCard";
