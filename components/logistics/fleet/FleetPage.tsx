"use client";

// Logística › Flota (ADR-161, R20): vehículos en tarjetas con su foto,
// patente, capacidad y vencimientos con semáforo, y repartidores con su
// licencia y vehículo habitual. Mobile-first: una columna en el teléfono.

import { useMemo, useState } from "react";
import Link from "next/link";
import type { Route } from "next";
import { Plus, Truck, UserRound, Users } from "lucide-react";
import { PageContainer, PageHeader } from "@/components/ui/PageHeader";
import { Button, buttonVariants } from "@/components/ui/Button";
import { Badge } from "@/components/ui/Badge";
import { Segmented } from "@/components/ui/Segmented";
import { EmptyState } from "@/components/ui/EmptyState";
import { Skeleton } from "@/components/ui/Skeleton";
import { LogisticsNav } from "@/components/logistics/LogisticsNav";
import { LogisticsLocked } from "@/components/logistics/LogisticsLocked";
import { SignedImage } from "@/components/logistics/SignedImage";
import { VehicleFormModal } from "@/components/logistics/fleet/VehicleFormModal";
import { VehicleDetailModal } from "@/components/logistics/fleet/VehicleDetailModal";
import { DriverProfileModal } from "@/components/logistics/fleet/DriverProfileModal";
import {
  EXPIRY_TONE,
  VEHICLE_KIND_LABEL,
  VEHICLE_STATUS_LABEL,
  arToday,
  expiryState,
  type ExpiryState,
} from "@/lib/logistics/logic";
import { useCan, useDrivers, useVehicles, type DriverRow, type Vehicle } from "@/modules/logistics/api";
import { useFeature } from "@/modules/saas/gating";

type Tab = "vehiculos" | "repartidores";

const WORST: ExpiryState[] = ["vencido", "por_vencer", "al_dia", "sin_dato"];

function worstExpiry(v: Vehicle, today: string): { state: ExpiryState; label: string } | null {
  const list: [string, ExpiryState][] = [
    ["Seguro", expiryState(v.insurance_until, today)],
    ["VTV", expiryState(v.vtv_until, today)],
    ["SENASA", expiryState(v.senasa_until, today)],
  ];
  const bad = list.filter(([, s]) => s === "vencido" || s === "por_vencer").sort((a, b) => WORST.indexOf(a[1]) - WORST.indexOf(b[1]));
  if (!bad.length) return list.some(([, s]) => s === "al_dia") ? { state: "al_dia", label: "Papeles al día" } : null;
  const [label, state] = bad[0]!;
  return { state, label: state === "vencido" ? `${label} vencido` : `${label} vence pronto` };
}

function VehicleCard({ v, onOpen, today }: { v: Vehicle; onOpen: () => void; today: string }) {
  const exp = worstExpiry(v, today);
  return (
    <button type="button" onClick={onOpen} className="group overflow-hidden rounded-lg bg-card text-left ring-1 ring-border transition hover:ring-foreground/20">
      <SignedImage
        path={v.cover_photo_path}
        alt={`Foto de ${v.name}`}
        className="aspect-[16/9] w-full"
        fallback={<Truck size={34} aria-hidden />}
      />
      <div className="space-y-2 p-4">
        <div className="flex items-start justify-between gap-2">
          <div className="min-w-0">
            <p className="truncate font-semibold">{v.name}</p>
            <p className="truncate text-sm text-muted-foreground">
              {[VEHICLE_KIND_LABEL[v.kind], [v.brand, v.model].filter(Boolean).join(" ")].filter(Boolean).join(" · ")}
            </p>
          </div>
          {v.plate && <Badge tone="neutral" className="font-mono">{v.plate}</Badge>}
        </div>
        <div className="flex flex-wrap gap-1.5">
          {v.status !== "activo" && <Badge tone="warning">{VEHICLE_STATUS_LABEL[v.status]}</Badge>}
          {exp && <Badge tone={EXPIRY_TONE[exp.state]}>{exp.label}</Badge>}
          {v.capacity_kg != null && <Badge tone="info">{Number(v.capacity_kg).toLocaleString("es-AR")} kg</Badge>}
          {v.capacity_packages != null && <Badge tone="info">{v.capacity_packages} bultos</Badge>}
          <Badge tone="neutral">{v.photos.length === 1 ? "1 foto" : `${v.photos.length} fotos`}</Badge>
        </div>
      </div>
    </button>
  );
}

function DriverItem({ d, vehicles, today, onEdit, canManage }: { d: DriverRow; vehicles: Vehicle[]; today: string; onEdit: () => void; canManage: boolean }) {
  const lic = expiryState(d.profile?.license_until ?? null, today);
  const veh = vehicles.find((v) => v.id === d.profile?.default_vehicle_id);
  return (
    <li className="flex flex-col gap-3 p-4 sm:flex-row sm:items-center sm:justify-between">
      <div className="flex min-w-0 items-center gap-3">
        <span className="grid h-10 w-10 shrink-0 place-items-center rounded-lg bg-muted text-muted-foreground">
          <UserRound size={20} aria-hidden />
        </span>
        <div className="min-w-0">
          <p className="truncate font-semibold">{d.name}</p>
          <p className="truncate text-sm text-muted-foreground">
            {[d.role_name, d.profile?.phone, veh ? `${veh.name}${veh.plate ? ` (${veh.plate})` : ""}` : null].filter(Boolean).join(" · ")}
          </p>
        </div>
      </div>
      <div className="flex flex-wrap items-center gap-1.5">
        {d.is_driver_role && <Badge tone="brand">Repartidor</Badge>}
        {d.profile?.active === false && <Badge tone="neutral">No disponible</Badge>}
        {lic !== "sin_dato" && <Badge tone={EXPIRY_TONE[lic]}>{lic === "vencido" ? "Licencia vencida" : lic === "por_vencer" ? "Licencia vence pronto" : "Licencia al día"}</Badge>}
        {d.active_routes > 0 && <Badge tone="info">{d.active_routes === 1 ? "1 hoja abierta" : `${d.active_routes} hojas abiertas`}</Badge>}
        {canManage && (
          <Button size="sm" variant="secondary" onClick={onEdit}>
            Perfil
          </Button>
        )}
      </div>
    </li>
  );
}

export function FleetPage() {
  const enabled = useFeature("reparto_propio");
  const canManage = useCan("logistics.fleet.manage");
  const [tab, setTab] = useState<Tab>("vehiculos");
  const { data: vehicles = [], isLoading } = useVehicles(enabled === true);
  const { data: drivers = [] } = useDrivers(enabled === true);
  const [editing, setEditing] = useState<Vehicle | null | "new">(null);
  const [openId, setOpenId] = useState<string | null>(null);
  const [driverId, setDriverId] = useState<string | null>(null);
  const today = arToday();
  const open = useMemo(() => vehicles.find((v) => v.id === openId) ?? null, [vehicles, openId]);

  const header = (
    <PageHeader
      eyebrow="Logística"
      title="Flota"
      icon={Truck}
      description="Tus vehículos con fotos, capacidad y vencimientos, y quién reparte."
      actions={
        enabled && canManage && tab === "vehiculos" ? (
          <Button onClick={() => setEditing("new")}>
            <Plus size={16} /> Nuevo vehículo
          </Button>
        ) : undefined
      }
    />
  );

  if (enabled === false) {
    return (
      <PageContainer>
        {header}
        <LogisticsNav className="mt-4" />
        <LogisticsLocked
          title="El reparto propio no está incluido en tu plan"
          description="Cargá tus camiones con fotos, armá hojas de ruta y que cada repartidor entregue con firma, foto y ubicación desde su celular."
        />
      </PageContainer>
    );
  }

  return (
    <PageContainer>
      {header}
      <LogisticsNav className="mt-4" />
      <Segmented
        className="mt-6"
        value={tab}
        onChange={setTab}
        aria-label="Flota"
        options={[
          { value: "vehiculos", label: `Vehículos${vehicles.length ? ` (${vehicles.length})` : ""}`, icon: <Truck size={15} /> },
          { value: "repartidores", label: `Repartidores${drivers.length ? ` (${drivers.length})` : ""}`, icon: <Users size={15} /> },
        ]}
      />

      {tab === "vehiculos" ? (
        isLoading ? (
          <div className="mt-6 grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
            {[0, 1, 2].map((i) => (
              <Skeleton key={i} className="aspect-[4/3] rounded-lg" />
            ))}
          </div>
        ) : vehicles.length === 0 ? (
          <EmptyState
            icon={Truck}
            title="Todavía no cargaste vehículos"
            description="Sumá tu primer camión, utilitario o moto con su patente, capacidad y fotos para armar hojas de ruta."
            action={canManage ? <Button onClick={() => setEditing("new")}>Cargar un vehículo</Button> : undefined}
          />
        ) : (
          <div className="mt-6 grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
            {vehicles.map((v) => (
              <VehicleCard key={v.id} v={v} today={today} onOpen={() => setOpenId(v.id)} />
            ))}
          </div>
        )
      ) : drivers.length === 0 ? (
        <EmptyState
          icon={Users}
          title="Nadie puede repartir todavía"
          description="Invitá a la persona desde Equipo y dale el rol Repartidor: entra directo a la app de reparto, sin ventas ni caja."
          action={
            <Link href={"/dashboard-team" as Route} className={buttonVariants({ variant: "secondary" })}>
              Ir a Equipo
            </Link>
          }
        />
      ) : (
        <ul className="mt-6 divide-y divide-border rounded-lg bg-card ring-1 ring-border">
          {drivers.map((d) => (
            <DriverItem key={d.user_id} d={d} vehicles={vehicles} today={today} canManage={canManage} onEdit={() => setDriverId(d.user_id)} />
          ))}
        </ul>
      )}

      <VehicleFormModal
        open={editing !== null}
        vehicle={editing === "new" ? null : editing}
        drivers={drivers}
        onClose={() => setEditing(null)}
        onSaved={(v) => editing === "new" && setOpenId(v.id)}
      />
      <VehicleDetailModal
        vehicle={open}
        drivers={drivers}
        canManage={canManage}
        onClose={() => setOpenId(null)}
        onEdit={(v) => {
          setOpenId(null);
          setEditing(v);
        }}
      />
      <DriverProfileModal driver={drivers.find((d) => d.user_id === driverId) ?? null} vehicles={vehicles} onClose={() => setDriverId(null)} />
    </PageContainer>
  );
}
FleetPage.displayName = "FleetPage";
