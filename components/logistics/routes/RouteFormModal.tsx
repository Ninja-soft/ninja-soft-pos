"use client";

// Nueva hoja de ruta o cambio de día, vehículo, repartidor, acompañante y
// origen (ADR-161). Sólo antes de salir; lo valida delivery_route_save.

import { useEffect, useMemo, useState } from "react";
import { Modal } from "@/components/ui/Modal";
import { Button } from "@/components/ui/Button";
import { Input } from "@/components/ui/Input";
import { useToast } from "@/components/ui/Toast";
import { selectCls } from "@/components/stock/transfers/shared";
import { arToday, logisticsErrorMessage } from "@/lib/logistics/logic";
import { useDrivers, useLogisticsMutations, useOrigins, useVehicles, type RouteRow } from "@/modules/logistics/api";
import { useBranchContext } from "@/modules/branches/hooks";

export function RouteFormModal({
  open,
  route,
  defaultStoreId,
  defaultDate,
  onClose,
  onSaved,
}: {
  open: boolean;
  route: Pick<RouteRow, "id" | "number" | "store_id" | "origin_id" | "service_date" | "vehicle_id" | "driver_user_id" | "helper_user_id" | "notes"> | null;
  defaultStoreId: string | null;
  defaultDate: string;
  onClose: () => void;
  onSaved?: (id: string) => void;
}) {
  const { toast } = useToast();
  const m = useLogisticsMutations();
  const { allowed } = useBranchContext();
  const { data: vehicles = [] } = useVehicles(open);
  const { data: drivers = [] } = useDrivers(open);
  const { data: origins = [] } = useOrigins(open);
  const [date, setDate] = useState(defaultDate);
  const [store, setStore] = useState("");
  const [vehicle, setVehicle] = useState("");
  const [driver, setDriver] = useState("");
  const [helper, setHelper] = useState("");
  const [origin, setOrigin] = useState("");
  const [notes, setNotes] = useState("");

  useEffect(() => {
    if (!open) return;
    setDate(route?.service_date ?? defaultDate ?? arToday());
    setStore(route?.store_id ?? defaultStoreId ?? allowed[0]?.id ?? "");
    setVehicle(route?.vehicle_id ?? "");
    setDriver(route?.driver_user_id ?? "");
    setHelper(route?.helper_user_id ?? "");
    setOrigin(route?.origin_id ?? "");
    setNotes(route?.notes ?? "");
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, route?.id]);

  const available = vehicles.filter((v) => v.status === "activo" || v.id === vehicle);
  const ableDrivers = drivers.filter((d) => d.profile?.active !== false || d.user_id === driver || d.user_id === helper);
  const storeOrigins = useMemo(() => origins.filter((o) => o.store_id === store), [origins, store]);

  // Al elegir el vehículo, su repartidor habitual (si no se eligió otro).
  function pickVehicle(id: string) {
    setVehicle(id);
    const v = vehicles.find((x) => x.id === id);
    if (v?.default_driver_user_id && !driver) setDriver(v.default_driver_user_id);
  }

  async function save() {
    try {
      const r = await m.saveRoute.mutateAsync({
        id: route?.id ?? null,
        p: {
          service_date: date,
          store_id: store,
          vehicle_id: vehicle || null,
          driver_user_id: driver || null,
          helper_user_id: helper || null,
          origin_id: origin || null,
          notes,
        },
      });
      toast({ title: route ? "Hoja actualizada" : `Hoja N° ${r.number} creada`, variant: "success" });
      onSaved?.(r.id);
      onClose();
    } catch (e) {
      toast({ title: "No se pudo guardar la hoja", description: logisticsErrorMessage(e), variant: "error" });
    }
  }

  const opt = "bg-popover text-popover-foreground";
  return (
    <Modal
      open={open}
      onOpenChange={(o) => !o && onClose()}
      title={route ? `Hoja N° ${route.number}` : "Nueva hoja de ruta"}
      description="Un vehículo, un repartidor y un día. Las entregas se suman después."
      footer={
        <div className="flex justify-end gap-2">
          <Button variant="secondary" onClick={onClose}>
            Cancelar
          </Button>
          <Button onClick={save} disabled={!store || !date || (helper !== "" && helper === driver)} loading={m.saveRoute.isPending}>
            {route ? "Guardar" : "Crear hoja"}
          </Button>
        </div>
      }
    >
      <div className="space-y-4">
        <div className="grid grid-cols-2 gap-3">
          <Input label="Día del reparto" type="date" value={date} onChange={(e) => setDate(e.target.value)} />
          <label className="block text-sm font-medium">
            Sucursal
            <select className={`${selectCls} mt-1.5`} value={store} onChange={(e) => setStore(e.target.value)} disabled={Boolean(route)}>
              {allowed.map((b) => (
                <option key={b.id} value={b.id} className={opt}>
                  {b.name}
                </option>
              ))}
            </select>
          </label>
        </div>
        <label className="block text-sm font-medium">
          Vehículo
          <select className={`${selectCls} mt-1.5`} value={vehicle} onChange={(e) => pickVehicle(e.target.value)}>
            <option value="" className={opt}>
              Elegir después
            </option>
            {available.map((v) => (
              <option key={v.id} value={v.id} className={opt}>
                {v.name}
                {v.plate ? ` · ${v.plate}` : ""}
                {v.status !== "activo" ? " (no disponible)" : ""}
              </option>
            ))}
          </select>
        </label>
        <div className="grid grid-cols-2 gap-3">
          <label className="block text-sm font-medium">
            Repartidor
            <select className={`${selectCls} mt-1.5`} value={driver} onChange={(e) => setDriver(e.target.value)}>
              <option value="" className={opt}>
                Elegir después
              </option>
              {ableDrivers.map((d) => (
                <option key={d.user_id} value={d.user_id} className={opt}>
                  {d.name}
                </option>
              ))}
            </select>
          </label>
          <label className="block text-sm font-medium">
            Acompañante
            <select className={`${selectCls} mt-1.5`} value={helper} onChange={(e) => setHelper(e.target.value)}>
              <option value="" className={opt}>
                Sin acompañante
              </option>
              {ableDrivers
                .filter((d) => d.user_id !== driver)
                .map((d) => (
                  <option key={d.user_id} value={d.user_id} className={opt}>
                    {d.name}
                  </option>
                ))}
            </select>
          </label>
        </div>
        {storeOrigins.length > 0 && (
          <label className="block text-sm font-medium">
            Sale de
            <select className={`${selectCls} mt-1.5`} value={origin} onChange={(e) => setOrigin(e.target.value)}>
              <option value="" className={opt}>
                El origen por defecto de la sucursal
              </option>
              {storeOrigins.map((o) => (
                <option key={o.id} value={o.id} className={opt}>
                  {o.name}
                </option>
              ))}
            </select>
          </label>
        )}
        {drivers.length === 0 && (
          <p className="rounded-lg bg-muted/50 p-3 text-sm text-muted-foreground">
            Nadie puede repartir todavía. En Equipo, dale a alguien el rol Repartidor.
          </p>
        )}
        <Input label="Notas para el repartidor" value={notes} maxLength={500} onChange={(e) => setNotes(e.target.value)} />
      </div>
    </Modal>
  );
}
RouteFormModal.displayName = "RouteFormModal";
