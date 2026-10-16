"use client";

// Perfil del repartidor (ADR-161): licencia con vencimiento, teléfono,
// vehículo habitual y si está activo para armar hojas.

import { useEffect, useState } from "react";
import { Modal } from "@/components/ui/Modal";
import { Button } from "@/components/ui/Button";
import { Input } from "@/components/ui/Input";
import { Switch } from "@/components/ui/Switch";
import { useToast } from "@/components/ui/Toast";
import { selectCls } from "@/components/stock/transfers/shared";
import { logisticsErrorMessage } from "@/lib/logistics/logic";
import { useLogisticsMutations, type DriverRow, type Vehicle } from "@/modules/logistics/api";

export function DriverProfileModal({ driver, vehicles, onClose }: { driver: DriverRow | null; vehicles: Vehicle[]; onClose: () => void }) {
  const { toast } = useToast();
  const m = useLogisticsMutations();
  const p = driver?.profile;
  const [phone, setPhone] = useState("");
  const [license, setLicense] = useState("");
  const [licenseClass, setLicenseClass] = useState("");
  const [until, setUntil] = useState("");
  const [vehicle, setVehicle] = useState("");
  const [active, setActive] = useState(true);
  const [notes, setNotes] = useState("");

  useEffect(() => {
    setPhone(p?.phone ?? "");
    setLicense(p?.license_number ?? "");
    setLicenseClass(p?.license_class ?? "");
    setUntil(p?.license_until ?? "");
    setVehicle(p?.default_vehicle_id ?? "");
    setActive(p?.active ?? true);
    setNotes(p?.notes ?? "");
  }, [p, driver?.user_id]);

  if (!driver) return null;

  async function save() {
    if (!driver) return;
    try {
      await m.saveDriverProfile.mutateAsync({
        userId: driver.user_id,
        p: {
          phone,
          license_number: license,
          license_class: licenseClass,
          license_until: until || null,
          default_vehicle_id: vehicle || null,
          active,
          notes,
        },
      });
      toast({ title: "Perfil guardado", variant: "success" });
      onClose();
    } catch (e) {
      toast({ title: "No se pudo guardar", description: logisticsErrorMessage(e), variant: "error" });
    }
  }

  return (
    <Modal
      open
      onOpenChange={(o) => !o && onClose()}
      title={driver.name}
      description={`${driver.role_name}${driver.email ? ` · ${driver.email}` : ""}`}
      footer={
        <div className="flex justify-end gap-2">
          <Button variant="secondary" onClick={onClose}>
            Cancelar
          </Button>
          <Button onClick={save} loading={m.saveDriverProfile.isPending}>
            Guardar
          </Button>
        </div>
      }
    >
      <div className="space-y-4">
        <Input label="Teléfono" inputMode="tel" value={phone} maxLength={40} onChange={(e) => setPhone(e.target.value)} />
        <div className="grid grid-cols-2 gap-3">
          <Input label="Licencia" value={license} maxLength={30} onChange={(e) => setLicense(e.target.value)} />
          <Input label="Clase" value={licenseClass} maxLength={20} onChange={(e) => setLicenseClass(e.target.value.toUpperCase())} placeholder="B1, C, D2" />
        </div>
        <Input label="Licencia vence" type="date" value={until} onChange={(e) => setUntil(e.target.value)} />
        <label className="block text-sm font-medium">
          Vehículo habitual
          <select className={`${selectCls} mt-1.5`} value={vehicle} onChange={(e) => setVehicle(e.target.value)}>
            <option value="" className="bg-popover text-popover-foreground">
              Sin asignar
            </option>
            {vehicles.map((v) => (
              <option key={v.id} value={v.id} className="bg-popover text-popover-foreground">
                {v.name}
                {v.plate ? ` · ${v.plate}` : ""}
              </option>
            ))}
          </select>
        </label>
        <div className="flex items-center justify-between gap-3 rounded-lg bg-muted/40 p-3">
          <div>
            <p className="text-sm font-medium">Disponible para repartir</p>
            <p className="text-xs text-muted-foreground">Apagado, no aparece para armar hojas.</p>
          </div>
          <Switch label="Disponible para repartir" checked={active} onCheckedChange={setActive} />
        </div>
        <Input label="Notas" value={notes} maxLength={300} onChange={(e) => setNotes(e.target.value)} />
      </div>
    </Modal>
  );
}
DriverProfileModal.displayName = "DriverProfileModal";
