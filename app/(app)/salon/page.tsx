"use client";

import { useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { ChefHat, LayoutGrid, Settings, Users, Utensils } from "lucide-react";
import { Button } from "@/components/ui/Button";
import { Eyebrow, Display } from "@/components/ui/Typography";
import { useToast } from "@/components/ui/Toast";
import {
  useDiningEnabled,
  useDiningAreas,
  useDiningTables,
  useOpenTableTotals,
  useTableMutations,
  useTableOrderMutations,
} from "@/modules/dining/hooks";
import type { DiningTable, TableStatus } from "@/modules/dining/api";
import {
  TABLE_STATUS_LABELS,
  TABLE_STATUS_TILE,
  TABLE_STATUS_DOT,
} from "@/modules/dining/api";
import { TableAccountModal } from "@/components/dining/TableAccountModal";
import { formatCurrency } from "@/lib/utils/format";

// Vista de Salón (F13 · H44): grid de mesas por salón, color por estado, total
// vivo. Tap mesa libre → abrir + cargar; tap ocupada → ver/editar cuenta y cobrar.
// Mobile/tablet-first. Sólo se monta si el modo gastronómico está activo (H43);
// con off, redirige a un aviso para activarlo en Configuración.
export default function SalonPage() {
  const { toast } = useToast();
  const { data: diningEnabled, isLoading: loadingFlag } = useDiningEnabled();
  const { data: areas } = useDiningAreas();
  const { data: tables, isLoading } = useDiningTables();
  const { data: totals } = useOpenTableTotals();
  const { setStatus } = useTableMutations();
  const { open: openTable } = useTableOrderMutations();

  // Mesa seleccionada para ver/editar su cuenta.
  const [activeTable, setActiveTable] = useState<DiningTable | null>(null);
  // Filtro por salón (null = todos).
  const [areaFilter, setAreaFilter] = useState<string | null>(null);

  // La mesa activa se re-deriva del listado vivo (refleja cambios de estado/orden).
  // El listado se refresca async tras abrir la mesa; mientras tanto conservamos el
  // current_order_id que ya teníamos (de la RPC open) si la versión del listado
  // todavía no lo trae, para que la cuenta abra sin esperar el refetch.
  //
  // BUG 13 — pero si OTRO mozo cerró/cobró la mesa (live.status === 'libre'), NO
  // reusar el order viejo: ese fallback dejaba el modal abierto sobre un pedido ya
  // cobrado (order fantasma). En ese caso devolvemos null → un efecto cierra el
  // modal. El fallback sólo aplica cuando la mesa SIGUE ocupada y el snapshot
  // todavía no trajo el current_order_id (ventana breve tras abrir).
  const activeLive = useMemo(() => {
    if (!activeTable) return null;
    const live = (tables ?? []).find((t) => t.id === activeTable.id);
    if (!live) return activeTable;
    if (live.status === "libre") return null; // la mesa fue liberada por otro
    const orderId = live.current_order_id ?? activeTable.current_order_id;
    if (!orderId) return null; // sin pedido vigente → no abrir sobre nada
    return { ...live, current_order_id: orderId };
  }, [activeTable, tables]);

  // Si la mesa activa dejó de tener un pedido vigente (la liberó/cobró otro mozo),
  // limpiamos la selección para que el modal de cuenta se cierre solo.
  useEffect(() => {
    if (activeTable && activeLive === null) setActiveTable(null);
  }, [activeTable, activeLive]);

  const visibleTables = useMemo(() => {
    const list = tables ?? [];
    return areaFilter ? list.filter((t) => t.area_id === areaFilter) : list;
  }, [tables, areaFilter]);

  // Agrupa las mesas visibles por salón (para encabezados de sección).
  const grouped = useMemo(() => {
    const byArea = new Map<string | null, DiningTable[]>();
    for (const t of visibleTables) {
      const k = t.area_id ?? null;
      if (!byArea.has(k)) byArea.set(k, []);
      byArea.get(k)!.push(t);
    }
    return byArea;
  }, [visibleTables]);

  const areaName = (id: string | null) =>
    id ? (areas ?? []).find((a) => a.id === id)?.name ?? "Salón" : "Sin salón";

  async function handleTap(t: DiningTable) {
    if (t.status === "bloqueada") {
      toast({ title: `Mesa ${t.label} bloqueada`, variant: "info" });
      return;
    }
    // Reservada (H51): la mesa está tomada por una reserva. Se ocupa al SENTAR la
    // reserva desde la agenda (no abriéndola suelta acá, que perdería el enlace).
    if (t.status === "reservada") {
      toast({
        title: `Mesa ${t.label} reservada`,
        description: "Sentá la reserva desde la sección Reservas.",
        variant: "info",
      });
      return;
    }
    if (t.status === "libre") {
      // Abrir la mesa: crea el pedido y la marca ocupada; luego abrir la cuenta.
      // Usamos el order_id que devuelve la RPC (el listado se refresca async, así
      // que el snapshot todavía no trae current_order_id).
      try {
        const orderId = await openTable.mutateAsync({ tableId: t.id });
        setActiveTable({ ...t, status: "ocupada", current_order_id: orderId });
      } catch (e) {
        toast({
          title: "No se pudo abrir la mesa",
          description: e instanceof Error ? e.message : undefined,
          variant: "error",
        });
      }
      return;
    }
    // Ocupada / cuenta pedida: abrir la cuenta directamente.
    setActiveTable(t);
  }

  function onSetStatus(tableId: string, status: TableStatus) {
    setStatus.mutate(
      { id: tableId, status },
      {
        onError: (e) =>
          toast({
            title: "No se pudo cambiar el estado",
            description: e instanceof Error ? e.message : undefined,
            variant: "error",
          }),
      },
    );
  }

  // Modo gastronómico apagado → aviso para activarlo.
  if (!loadingFlag && !diningEnabled) {
    return (
      <div className="mx-auto max-w-2xl px-4 py-16 text-center">
        <Utensils size={36} className="mx-auto text-ninja-flameSoft" />
        <Display className="mt-4">Modo gastronómico desactivado</Display>
        <p className="mt-2 text-muted-foreground">
          Activá el modo gastronómico para usar salones y mesas. El POS de
          mostrador sigue funcionando igual mientras tanto.
        </p>
        <Link href="/configuracion?seccion=operacion" className="mt-6 inline-block">
          <Button>
            <Settings size={16} /> Ir a Configuración
          </Button>
        </Link>
      </div>
    );
  }

  const hasTables = (tables ?? []).length > 0;

  return (
    <div className="mx-auto max-w-7xl px-4 py-6 sm:px-6">
      <div className="mb-5 flex flex-wrap items-center justify-between gap-3">
        <div>
          <Eyebrow>Gastronomía</Eyebrow>
          <Display className="mt-2 flex items-center gap-2">
            <Utensils size={26} className="text-ninja-flameSoft" /> Salón
          </Display>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          {/* KDS (F13 · H46): se abre en una pantalla aparte (monitor de cocina/
              barra). Está en una página ya gateada por modo gastronómico. */}
          <Button
            variant="secondary"
            size="sm"
            onClick={() => window.open("/kds", "_blank", "noopener")}
          >
            <ChefHat size={16} /> Cocina (KDS)
          </Button>
          <Link href="/configuracion?seccion=salones">
            <Button variant="secondary" size="sm">
              <LayoutGrid size={16} /> Salones y mesas
            </Button>
          </Link>
        </div>
      </div>

      {/* Filtro por salón (pills). Sólo si hay más de un salón. */}
      {(areas ?? []).length > 1 && (
        <div className="mb-4 flex flex-wrap gap-2">
          <button
            type="button"
            onClick={() => setAreaFilter(null)}
            className={
              areaFilter === null
                ? "rounded-lg bg-ninja-flame/15 px-3 py-1.5 text-sm font-medium text-ninja-flameSoft"
                : "rounded-lg px-3 py-1.5 text-sm text-muted-foreground transition hover:bg-muted hover:text-foreground"
            }
          >
            Todos
          </button>
          {(areas ?? []).map((a) => (
            <button
              key={a.id}
              type="button"
              onClick={() => setAreaFilter(a.id)}
              className={
                areaFilter === a.id
                  ? "rounded-lg bg-ninja-flame/15 px-3 py-1.5 text-sm font-medium text-ninja-flameSoft"
                  : "rounded-lg px-3 py-1.5 text-sm text-muted-foreground transition hover:bg-muted hover:text-foreground"
              }
            >
              {a.name}
            </button>
          ))}
        </div>
      )}

      {/* Leyenda de estados */}
      <div className="mb-5 flex flex-wrap gap-3 text-xs text-muted-foreground">
        {(["libre", "ocupada", "cuenta_pedida", "reservada", "bloqueada"] as TableStatus[]).map((s) => (
          <span key={s} className="flex items-center gap-1.5">
            <span className={`h-2.5 w-2.5 rounded-full ${TABLE_STATUS_DOT[s]}`} />
            {TABLE_STATUS_LABELS[s]}
          </span>
        ))}
      </div>

      {/* Aviso si todavía no hay mesas cargadas */}
      {!isLoading && !hasTables && (
        <div className="flex flex-col items-center gap-3 rounded-xl border border-dashed border-border p-10 text-center">
          <LayoutGrid size={30} className="text-ninja-flameSoft" />
          <p className="text-sm text-muted-foreground">
            Todavía no cargaste mesas. Definí tus salones y mesas para empezar a
            atender en el salón.
          </p>
          <Link href="/configuracion?seccion=salones">
            <Button size="sm">
              <LayoutGrid size={15} /> Configurar salones y mesas
            </Button>
          </Link>
        </div>
      )}

      {/* Grid de mesas por salón */}
      {[...grouped.entries()].map(([areaId, areaTables]) => (
        <div key={areaId ?? "none"} className="mb-6">
          {grouped.size > 1 && (
            <h2 className="mb-2 text-sm font-semibold text-foreground">
              {areaName(areaId)}
            </h2>
          )}
          <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-5">
            {areaTables.map((t) => {
              const total = t.current_order_id ? totals?.[t.current_order_id] ?? 0 : 0;
              return (
                <button
                  key={t.id}
                  type="button"
                  onClick={() => handleTap(t)}
                  className={`flex aspect-[4/3] flex-col items-start justify-between rounded-xl border p-3 text-left transition ${TABLE_STATUS_TILE[t.status]}`}
                >
                  <div className="flex w-full items-start justify-between">
                    <span className="text-lg font-bold tracking-tight text-foreground">
                      {t.label}
                    </span>
                    <span className={`mt-1 h-2.5 w-2.5 rounded-full ${TABLE_STATUS_DOT[t.status]}`} />
                  </div>
                  <div className="w-full">
                    <span className="flex items-center gap-1 text-xs text-muted-foreground">
                      <Users size={12} /> {t.capacity}
                    </span>
                    {t.status !== "libre" && t.current_order_id ? (
                      <span className="mt-0.5 block price-hl font-price text-sm font-bold tabular-nums">
                        {formatCurrency(total)}
                      </span>
                    ) : (
                      <span className="mt-0.5 block text-xs font-medium text-ninja-flameSoft">
                        {t.status === "libre" ? "Tocá para abrir" : TABLE_STATUS_LABELS[t.status]}
                      </span>
                    )}
                  </div>
                </button>
              );
            })}
          </div>
        </div>
      ))}

      {/* Cuenta de la mesa seleccionada */}
      <TableAccountModal
        table={activeLive}
        onClose={() => setActiveTable(null)}
        onSetStatus={onSetStatus}
      />
    </div>
  );
}
