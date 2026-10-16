"use client";

// Alta y edición de un vehículo (ADR-161): datos, capacidad, documentación
// con vencimientos y transportista si es de un tercero (para el remito y el
// COT). Todo por vehicle_save (logistics.fleet.manage, auditado).

import { useEffect, useState } from "react";
import { Modal } from "@/components/ui/Modal";
import { Button } from "@/components/ui/Button";
import { Input } from "@/components/ui/Input";
import { useToast } from "@/components/ui/Toast";
import { selectCls } from "@/components/stock/transfers/shared";
import { cuitValid, normalizeCuit } from "@/lib/remitos/logic";
import {
  VEHICLE_KIND_LABEL,
  VEHICLE_STATUS_LABEL,
  logisticsErrorMessage,
  normalizePlate,
  plateValid,
  type VehicleKind,
  type VehicleStatus,
} from "@/lib/logistics/logic";
import { useLogisticsMutations, type DriverRow, type Vehicle } from "@/modules/logistics/api";
import { useBranchContext } from "@/modules/branches/hooks";

interface Draft {
  name: string;
  kind: VehicleKind;
  status: VehicleStatus;
  plate: string;
  brand: string;
  model: string;
  year: string;
  color: string;
  home_store_id: string;
  capacity_kg: string;
  capacity_m3: string;
  capacity_packages: string;
  max_stops: string;
  insurance_until: string;
  vtv_until: string;
  senasa_until: string;
  third_party: boolean;
  carrier_name: string;
  carrier_cuit: string;
  trailer_plate: string;
  default_driver_user_id: string;
  notes: string;
}

const s = (v: unknown) => (v === null || v === undefined ? "" : String(v));

function draftOf(v: Vehicle | null): Draft {
  return {
    name: s(v?.name),
    kind: v?.kind ?? "utilitario",
    status: v?.status ?? "activo",
    plate: s(v?.plate),
    brand: s(v?.brand),
    model: s(v?.model),
    year: s(v?.year),
    color: s(v?.color),
    home_store_id: s(v?.home_store_id),
    capacity_kg: s(v?.capacity_kg),
    capacity_m3: s(v?.capacity_m3),
    capacity_packages: s(v?.capacity_packages),
    max_stops: s(v?.max_stops),
    insurance_until: s(v?.insurance_until),
    vtv_until: s(v?.vtv_until),
    senasa_until: s(v?.senasa_until),
    third_party: Boolean(v?.carrier_name || v?.carrier_cuit),
    carrier_name: s(v?.carrier_name),
    carrier_cuit: s(v?.carrier_cuit),
    trailer_plate: s(v?.trailer_plate),
    default_driver_user_id: s(v?.default_driver_user_id),
    notes: s(v?.notes),
  };
}

const numOk = (v: string) => v.trim() === "" || /^\d{1,7}([.,]\d{1,2})?$/.test(v.trim());
const intOk = (v: string) => v.trim() === "" || /^\d{1,4}$/.test(v.trim());
const num = (v: string) => (v.trim() === "" ? null : v.trim().replace(",", "."));

export function VehicleFormModal({
  open,
  vehicle,
  drivers,
  onClose,
  onSaved,
}: {
  open: boolean;
  vehicle: Vehicle | null;
  drivers: DriverRow[];
  onClose: () => void;
  onSaved?: (v: Vehicle) => void;
}) {
  const { toast } = useToast();
  const m = useLogisticsMutations();
  const { allowed } = useBranchContext();
  const [d, setD] = useState<Draft>(() => draftOf(vehicle));
  useEffect(() => {
    if (open) setD(draftOf(vehicle));
  }, [open, vehicle]);

  const set = <K extends keyof Draft>(k: K, v: Draft[K]) => setD((x) => ({ ...x, [k]: v }));
  const yearOk = d.year.trim() === "" || (/^\d{4}$/.test(d.year.trim()) && Number(d.year) >= 1950 && Number(d.year) <= 2100);
  const errors = {
    name: d.name.trim() ? undefined : "Poné un nombre, por ejemplo Camión 1.",
    plate: plateValid(d.plate) ? undefined : "5 a 12 letras o números.",
    trailer: plateValid(d.trailer_plate) ? undefined : "5 a 12 letras o números.",
    cuit: !d.third_party || cuitValid(d.carrier_cuit) ? undefined : "11 dígitos.",
    year: yearOk ? undefined : "Año de 4 cifras.",
  };
  const capsOk = numOk(d.capacity_kg) && numOk(d.capacity_m3) && intOk(d.capacity_packages) && intOk(d.max_stops);
  const ok = !Object.values(errors).some(Boolean) && capsOk;

  async function save() {
    try {
      const v = await m.saveVehicle.mutateAsync({
        id: vehicle?.id ?? null,
        p: {
          name: d.name.trim(),
          kind: d.kind,
          status: d.status,
          plate: normalizePlate(d.plate) || null,
          brand: d.brand,
          model: d.model,
          year: d.year.trim() || null,
          color: d.color,
          home_store_id: d.home_store_id || null,
          capacity_kg: num(d.capacity_kg),
          capacity_m3: num(d.capacity_m3),
          capacity_packages: d.capacity_packages.trim() || null,
          max_stops: d.max_stops.trim() || null,
          insurance_until: d.insurance_until || null,
          vtv_until: d.vtv_until || null,
          senasa_until: d.senasa_until || null,
          carrier_name: d.third_party ? d.carrier_name : null,
          carrier_cuit: d.third_party ? normalizeCuit(d.carrier_cuit) : null,
          trailer_plate: normalizePlate(d.trailer_plate) || null,
          default_driver_user_id: d.default_driver_user_id || null,
          notes: d.notes,
        },
      });
      toast({ title: vehicle ? "Vehículo actualizado" : "Vehículo creado", variant: "success" });
      onSaved?.(v);
      onClose();
    } catch (e) {
      toast({ title: "No se pudo guardar", description: logisticsErrorMessage(e), variant: "error" });
    }
  }

  return (
    <Modal
      open={open}
      onOpenChange={(o) => !o && onClose()}
      title={vehicle ? `Editar ${vehicle.name}` : "Nuevo vehículo"}
      description="Con la patente, la capacidad y los vencimientos, la hoja de ruta y el remito salen completos."
      className="sm:max-w-2xl"
      footer={
        <div className="flex justify-end gap-2">
          <Button variant="secondary" onClick={onClose}>
            Cancelar
          </Button>
          <Button onClick={save} disabled={!ok} loading={m.saveVehicle.isPending}>
            Guardar
          </Button>
        </div>
      }
    >
      <div className="space-y-6">
        <section className="space-y-3">
          <h3 className="text-sm font-semibold text-muted-foreground">Datos</h3>
          <Input label="Nombre" value={d.name} maxLength={60} onChange={(e) => set("name", e.target.value)} error={d.name ? errors.name : undefined} placeholder="Camión 1" />
          <div className="grid grid-cols-2 gap-3">
            <label className="block text-sm font-medium">
              Tipo
              <select className={`${selectCls} mt-1.5`} value={d.kind} onChange={(e) => set("kind", e.target.value as VehicleKind)}>
                {(Object.keys(VEHICLE_KIND_LABEL) as VehicleKind[]).map((k) => (
                  <option key={k} value={k} className="bg-popover text-popover-foreground">
                    {VEHICLE_KIND_LABEL[k]}
                  </option>
                ))}
              </select>
            </label>
            <label className="block text-sm font-medium">
              Estado
              <select className={`${selectCls} mt-1.5`} value={d.status} onChange={(e) => set("status", e.target.value as VehicleStatus)}>
                {(["activo", "en_taller"] as VehicleStatus[]).map((k) => (
                  <option key={k} value={k} className="bg-popover text-popover-foreground">
                    {VEHICLE_STATUS_LABEL[k]}
                  </option>
                ))}
              </select>
            </label>
            <Input label="Patente" value={d.plate} maxLength={12} onChange={(e) => set("plate", e.target.value.toUpperCase())} error={errors.plate} placeholder="AB 123 CD" />
            <Input label="Color" value={d.color} maxLength={30} onChange={(e) => set("color", e.target.value)} />
            <Input label="Marca" value={d.brand} maxLength={40} onChange={(e) => set("brand", e.target.value)} />
            <Input label="Modelo" value={d.model} maxLength={40} onChange={(e) => set("model", e.target.value)} />
            <Input label="Año" inputMode="numeric" value={d.year} maxLength={4} onChange={(e) => set("year", e.target.value)} error={errors.year} />
            <label className="block text-sm font-medium">
              Duerme en
              <select className={`${selectCls} mt-1.5`} value={d.home_store_id} onChange={(e) => set("home_store_id", e.target.value)}>
                <option value="" className="bg-popover text-popover-foreground">
                  Sin sucursal fija
                </option>
                {allowed.map((b) => (
                  <option key={b.id} value={b.id} className="bg-popover text-popover-foreground">
                    {b.name}
                  </option>
                ))}
              </select>
            </label>
          </div>
        </section>

        <section className="space-y-3">
          <h3 className="text-sm font-semibold text-muted-foreground">Capacidad</h3>
          <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
            <Input label="Kilos" inputMode="decimal" value={d.capacity_kg} onChange={(e) => set("capacity_kg", e.target.value)} error={numOk(d.capacity_kg) ? undefined : "Número."} />
            <Input label="Metros cúbicos" inputMode="decimal" value={d.capacity_m3} onChange={(e) => set("capacity_m3", e.target.value)} error={numOk(d.capacity_m3) ? undefined : "Número."} />
            <Input label="Bultos" inputMode="numeric" value={d.capacity_packages} onChange={(e) => set("capacity_packages", e.target.value)} error={intOk(d.capacity_packages) ? undefined : "Entero."} />
            <Input label="Paradas máx." inputMode="numeric" value={d.max_stops} onChange={(e) => set("max_stops", e.target.value)} error={intOk(d.max_stops) ? undefined : "Entero."} />
          </div>
        </section>

        <section className="space-y-3">
          <h3 className="text-sm font-semibold text-muted-foreground">Vencimientos</h3>
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
            <Input label="Seguro" type="date" value={d.insurance_until} onChange={(e) => set("insurance_until", e.target.value)} />
            <Input label="VTV" type="date" value={d.vtv_until} onChange={(e) => set("vtv_until", e.target.value)} />
            <Input label="SENASA" type="date" value={d.senasa_until} onChange={(e) => set("senasa_until", e.target.value)} hint="Si transporta alimentos." />
          </div>
        </section>

        <section className="space-y-3">
          <h3 className="text-sm font-semibold text-muted-foreground">Quién maneja</h3>
          <label className="block text-sm font-medium">
            Repartidor habitual
            <select className={`${selectCls} mt-1.5`} value={d.default_driver_user_id} onChange={(e) => set("default_driver_user_id", e.target.value)}>
              <option value="" className="bg-popover text-popover-foreground">
                Sin asignar
              </option>
              {drivers.map((x) => (
                <option key={x.user_id} value={x.user_id} className="bg-popover text-popover-foreground">
                  {x.name}
                </option>
              ))}
            </select>
          </label>
          <label className="flex items-center gap-2 text-sm">
            <input type="checkbox" checked={d.third_party} onChange={(e) => set("third_party", e.target.checked)} className="h-4 w-4" />
            Es de un transportista (fletero o tercero)
          </label>
          {d.third_party && (
            <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
              <Input label="Transportista" value={d.carrier_name} maxLength={120} onChange={(e) => set("carrier_name", e.target.value)} />
              <Input label="CUIT" value={d.carrier_cuit} maxLength={13} onChange={(e) => set("carrier_cuit", e.target.value)} error={errors.cuit} />
              <Input label="Acoplado" value={d.trailer_plate} maxLength={12} onChange={(e) => set("trailer_plate", e.target.value.toUpperCase())} error={errors.trailer} />
            </div>
          )}
        </section>

        <Input label="Notas" value={d.notes} maxLength={500} onChange={(e) => set("notes", e.target.value)} placeholder="Caja seca, rampa, horarios" />
      </div>
    </Modal>
  );
}
VehicleFormModal.displayName = "VehicleFormModal";
