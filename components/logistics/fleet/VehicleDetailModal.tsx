"use client";

// Ficha del vehículo (ADR-161, R20): galería con portada, fotos por tipo
// (frente, lateral, carga, documentación), capacidad con barras, vencimientos
// con semáforo, repartidor habitual y últimas hojas de ruta.

import { useRef, useState } from "react";
import Link from "next/link";
import type { Route } from "next";
import { Camera, Pencil, Star, Trash2, Truck } from "lucide-react";
import { Modal } from "@/components/ui/Modal";
import { Button } from "@/components/ui/Button";
import { Badge } from "@/components/ui/Badge";
import { ConfirmDialog } from "@/components/ui/ConfirmDialog";
import { useToast } from "@/components/ui/Toast";
import { SignedImage } from "@/components/logistics/SignedImage";
import { selectCls } from "@/components/stock/transfers/shared";
import { cn } from "@/lib/utils/cn";
import {
  EXPIRY_TONE,
  ROUTE_STATUS_LABEL,
  ROUTE_STATUS_TONE,
  VEHICLE_KIND_LABEL,
  VEHICLE_STATUS_LABEL,
  arToday,
  capacityUse,
  expiryState,
  logisticsErrorMessage,
  type ExpiryState,
} from "@/lib/logistics/logic";
import { useLogisticsMutations, useRoutes, type DriverRow, type Vehicle, type VehiclePhoto } from "@/modules/logistics/api";
import { useMyTenant } from "@/modules/tenants/hooks";

const PHOTO_KIND_LABEL: Record<VehiclePhoto["kind"], string> = {
  frente: "Frente",
  lateral: "Lateral",
  carga: "Caja o carga",
  documento: "Documentación",
  otro: "Otra",
};

const EXPIRY_TEXT: Record<ExpiryState, string> = {
  vencido: "Vencido",
  por_vencer: "Vence pronto",
  al_dia: "Al día",
  sin_dato: "Sin cargar",
};

function dateAr(d: string | null): string {
  if (!d) return "";
  const [y, m, day] = d.slice(0, 10).split("-");
  return `${day}/${m}/${y}`;
}

function Bar({ label, value, max, unit }: { label: string; value: number; max: number | null; unit: string }) {
  const pct = capacityUse(value, max);
  return (
    <div className="space-y-1">
      <div className="flex justify-between text-sm">
        <span className="text-muted-foreground">{label}</span>
        <span className="font-semibold tabular-nums">
          {max ? `${value.toLocaleString("es-AR")} de ${max.toLocaleString("es-AR")} ${unit}` : "Sin capacidad cargada"}
        </span>
      </div>
      <div className="h-2 overflow-hidden rounded-full bg-muted" role="meter" aria-label={label} aria-valuenow={pct ?? 0} aria-valuemin={0} aria-valuemax={100}>
        <div
          className={cn("h-full rounded-full", pct === null ? "bg-transparent" : pct > 100 ? "bg-danger" : pct > 85 ? "bg-warning" : "bg-success")}
          style={{ width: `${Math.min(100, pct ?? 0)}%` }}
        />
      </div>
    </div>
  );
}

export function VehicleDetailModal({
  vehicle,
  drivers,
  canManage,
  onClose,
  onEdit,
}: {
  vehicle: Vehicle | null;
  drivers: DriverRow[];
  canManage: boolean;
  onClose: () => void;
  onEdit: (v: Vehicle) => void;
}) {
  const { toast } = useToast();
  const { data: me } = useMyTenant();
  const m = useLogisticsMutations();
  const fileRef = useRef<HTMLInputElement>(null);
  const [kind, setKind] = useState<VehiclePhoto["kind"]>("frente");
  const [active, setActive] = useState<string | null>(null);
  const [removing, setRemoving] = useState(false);
  const today = arToday();
  const from = new Date(Date.now() - 45 * 86_400_000).toISOString().slice(0, 10);
  const { data: routes = [] } = useRoutes({ from, to: "2999-12-31", storeId: null }, Boolean(vehicle));

  if (!vehicle) return null;
  const v = vehicle;
  const mine = routes.filter((r) => r.vehicle_id === v.id);
  const todayStops = mine.filter((r) => r.service_date === today && r.status !== "cancelada").reduce((a, r) => a + r.stops.length, 0);
  const shown = v.photos.find((p) => p.id === active)?.path ?? v.cover_photo_path ?? v.photos[0]?.path ?? null;
  const driver = drivers.find((d) => d.user_id === v.default_driver_user_id);

  async function upload(files: FileList | null) {
    if (!files?.length || !me?.tenantId) return;
    try {
      for (const f of Array.from(files).slice(0, 6)) {
        await m.addVehiclePhoto.mutateAsync({ tenantId: me.tenantId, vehicleId: v.id, file: f, kind });
      }
      toast({ title: "Fotos subidas", variant: "success" });
    } catch (e) {
      toast({ title: "No se pudo subir la foto", description: logisticsErrorMessage(e), variant: "error" });
    } finally {
      if (fileRef.current) fileRef.current.value = "";
    }
  }

  async function photoAction(id: string, action: "cover" | "delete") {
    try {
      await m.setVehiclePhoto.mutateAsync({ id, action });
      if (action === "delete" && active === id) setActive(null);
    } catch (e) {
      toast({ title: "No se pudo", description: logisticsErrorMessage(e), variant: "error" });
    }
  }

  const expiries: [string, string | null][] = [
    ["Seguro", v.insurance_until],
    ["VTV", v.vtv_until],
    ["SENASA", v.senasa_until],
  ];

  return (
    <>
      <Modal
        open
        onOpenChange={(o) => !o && onClose()}
        title={v.name}
        description={[VEHICLE_KIND_LABEL[v.kind], v.plate, [v.brand, v.model, v.year].filter(Boolean).join(" ")].filter(Boolean).join(" · ")}
        className="sm:max-w-4xl"
      >
        <div className="grid gap-6 md:grid-cols-[minmax(0,1.3fr)_minmax(0,1fr)]">
          <div className="space-y-3">
            <SignedImage
              path={shown}
              alt={`Foto de ${v.name}`}
              className="aspect-[4/3] w-full rounded-lg"
              fallback={
                <span className="flex flex-col items-center gap-2 text-sm">
                  <Truck size={36} aria-hidden /> Sin fotos todavía
                </span>
              }
            />
            {v.photos.length > 0 && (
              <div className="flex gap-2 overflow-x-auto pb-1">
                {v.photos.map((p) => (
                  <div key={p.id} className="relative shrink-0">
                    <button
                      type="button"
                      onClick={() => setActive(p.id)}
                      className={cn("block overflow-hidden rounded-lg", p.path === shown && "ring-2 ring-ninja-flameSoft")}
                      aria-label={`Ver foto ${PHOTO_KIND_LABEL[p.kind]}`}
                    >
                      <SignedImage path={p.path} alt={PHOTO_KIND_LABEL[p.kind]} className="h-16 w-20" />
                    </button>
                    <span className="absolute bottom-1 left-1 rounded-md bg-black/60 px-1.5 text-[10px] font-semibold text-white">{PHOTO_KIND_LABEL[p.kind]}</span>
                    {v.cover_photo_path === p.path && (
                      <span className="absolute right-1 top-1 grid h-5 w-5 place-items-center rounded-md bg-black/60 text-white" aria-label="Portada">
                        <Star size={11} aria-hidden />
                      </span>
                    )}
                  </div>
                ))}
              </div>
            )}
            {canManage && (
              <div className="flex flex-wrap items-center gap-2">
                <select className={cn(selectCls, "h-10 w-auto")} value={kind} onChange={(e) => setKind(e.target.value as VehiclePhoto["kind"])} aria-label="Tipo de foto">
                  {(Object.keys(PHOTO_KIND_LABEL) as VehiclePhoto["kind"][]).map((k) => (
                    <option key={k} value={k} className="bg-popover text-popover-foreground">
                      {PHOTO_KIND_LABEL[k]}
                    </option>
                  ))}
                </select>
                <Button size="sm" variant="secondary" onClick={() => fileRef.current?.click()} loading={m.addVehiclePhoto.isPending}>
                  <Camera size={15} /> Subir fotos
                </Button>
                {active && (
                  <>
                    <Button size="sm" variant="ghost" onClick={() => void photoAction(active, "cover")}>
                      <Star size={15} /> Usar de portada
                    </Button>
                    <Button size="sm" variant="ghost" className="text-danger" onClick={() => void photoAction(active, "delete")}>
                      <Trash2 size={15} /> Quitar
                    </Button>
                  </>
                )}
                <input ref={fileRef} type="file" accept="image/*" multiple className="sr-only" onChange={(e) => void upload(e.target.files)} />
              </div>
            )}
          </div>

          <aside className="space-y-5">
            <div className="flex flex-wrap gap-1.5">
              <Badge tone={v.status === "activo" ? "success" : "warning"}>{VEHICLE_STATUS_LABEL[v.status]}</Badge>
              {v.plate && <Badge tone="neutral">{v.plate}</Badge>}
              {v.carrier_name && <Badge tone="info">De {v.carrier_name}</Badge>}
            </div>

            <div className="space-y-3">
              <p className="text-sm font-semibold">Capacidad</p>
              <Bar label="Paradas de hoy" value={todayStops} max={v.max_stops} unit="paradas" />
              <div className="grid grid-cols-3 gap-2 text-center">
                {[
                  ["Kilos", v.capacity_kg],
                  ["m³", v.capacity_m3],
                  ["Bultos", v.capacity_packages],
                ].map(([l, val]) => (
                  <div key={l as string} className="rounded-lg bg-muted/50 p-2">
                    <p className="text-lg font-semibold tabular-nums">{val != null ? Number(val).toLocaleString("es-AR") : "-"}</p>
                    <p className="text-xs text-muted-foreground">{l}</p>
                  </div>
                ))}
              </div>
            </div>

            <div className="space-y-2">
              <p className="text-sm font-semibold">Vencimientos</p>
              {expiries.map(([label, date]) => {
                const st = expiryState(date, today);
                return (
                  <div key={label} className="flex items-center justify-between gap-2 text-sm">
                    <span>{label}</span>
                    <span className="flex items-center gap-2">
                      <span className="tabular-nums text-muted-foreground">{dateAr(date)}</span>
                      <Badge tone={EXPIRY_TONE[st]}>{EXPIRY_TEXT[st]}</Badge>
                    </span>
                  </div>
                );
              })}
            </div>

            <div className="space-y-1 text-sm">
              <p className="font-semibold">Repartidor habitual</p>
              <p className="text-muted-foreground">{driver?.name ?? "Sin asignar"}</p>
              {v.notes && <p className="pt-2 text-muted-foreground">{v.notes}</p>}
            </div>

            <div className="space-y-2">
              <p className="text-sm font-semibold">Últimas hojas de ruta</p>
              {mine.length === 0 ? (
                <p className="text-sm text-muted-foreground">Todavía no salió en ninguna hoja.</p>
              ) : (
                <ul className="divide-y divide-border rounded-lg bg-muted/30">
                  {mine.slice(0, 6).map((r) => (
                    <li key={r.id}>
                      <Link href={`/logistica/reparto?hoja=${r.id}` as Route} className="flex items-center justify-between gap-2 px-3 py-2 text-sm hover:bg-muted/60">
                        <span>
                          Hoja N° {r.number} · {dateAr(r.service_date)}
                        </span>
                        <span className="flex items-center gap-2">
                          <span className="text-muted-foreground">{r.stops.length} paradas</span>
                          <Badge tone={ROUTE_STATUS_TONE[r.status]}>{ROUTE_STATUS_LABEL[r.status]}</Badge>
                        </span>
                      </Link>
                    </li>
                  ))}
                </ul>
              )}
            </div>

            {canManage && (
              <div className="flex flex-wrap gap-2">
                <Button variant="secondary" onClick={() => onEdit(v)}>
                  <Pencil size={15} /> Editar
                </Button>
                <Button variant="ghost" className="text-danger" onClick={() => setRemoving(true)}>
                  Dar de baja
                </Button>
              </div>
            )}
          </aside>
        </div>
      </Modal>
      <ConfirmDialog
        open={removing}
        onOpenChange={setRemoving}
        title={`Dar de baja ${v.name}`}
        description="Deja de aparecer para armar hojas. Las hojas y remitos donde salió quedan como están."
        confirmLabel="Dar de baja"
        danger
        loading={m.deleteVehicle.isPending}
        onConfirm={async () => {
          try {
            await m.deleteVehicle.mutateAsync(v.id);
            toast({ title: `${v.name} dado de baja`, variant: "success" });
            setRemoving(false);
            onClose();
          } catch (e) {
            toast({ title: "No se pudo dar de baja", description: logisticsErrorMessage(e), variant: "error" });
          }
        }}
      />
    </>
  );
}
VehicleDetailModal.displayName = "VehicleDetailModal";
