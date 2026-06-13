"use client";

import { useMemo, useState } from "react";
import Link from "next/link";
import {
  Bike,
  ChefHat,
  ChevronRight,
  Clock,
  MapPin,
  Phone,
  Plus,
  Settings,
  ShoppingBag,
  Truck,
} from "lucide-react";
import { Button } from "@/components/ui/Button";
import { Eyebrow, Display } from "@/components/ui/Typography";
import { useToast } from "@/components/ui/Toast";
import {
  useDeliveryEnabled,
  useDeliveryOrders,
  useDeliveryItemTotals,
  useDeliveryMutations,
  useDeliveryZones,
} from "@/modules/delivery/hooks";
import {
  DELIVERY_BOARD_COLUMNS,
  DELIVERY_CHANNEL_LABELS,
  DELIVERY_STATUS_LABELS,
  TAKEAWAY_BOARD_COLUMNS,
  nextDeliveryStatus,
  type DeliveryOrder,
  type DeliveryStatus,
} from "@/modules/delivery/api";
import { DeliveryOrderModal } from "@/components/delivery/DeliveryOrderModal";
import { DeliveryAccountModal } from "@/components/delivery/DeliveryAccountModal";
import { formatCurrency } from "@/lib/utils/format";

// Tablero de delivery / take away (F13 · H49): columnas por estado (recibido →
// preparando → en camino → entregado), cada tarjeta con cliente/tel/dirección/
// canal/horario prometido/cadete/total. Acciones: cambiar estado, abrir cuenta
// (ver/editar ítems, asignar cadete, cobrar) y alta de pedido. Sólo se monta con
// delivery habilitado (pos_settings.delivery_enabled); con off, aviso para
// activarlo. Delivery NO requiere mesas.
export default function DeliveryPage() {
  const { toast } = useToast();
  const { data: enabled, isLoading: loadingFlag } = useDeliveryEnabled();
  const { data: orders, isLoading } = useDeliveryOrders();
  const { data: itemTotals } = useDeliveryItemTotals();
  const { setStatus } = useDeliveryMutations();
  // Zonas (incl. inactivas) para resolver el nombre de la zona en las tarjetas.
  const { data: zones } = useDeliveryZones(true);
  const zoneNameById = useMemo(() => {
    const m = new Map<string, string>();
    for (const z of zones ?? []) m.set(z.id, z.name);
    return m;
  }, [zones]);

  const [newOpen, setNewOpen] = useState(false);
  const [activeId, setActiveId] = useState<string | null>(null);
  // Filtro de tipo: todos / delivery / takeaway / mostrador.
  const [typeFilter, setTypeFilter] = useState<
    "all" | "delivery" | "takeaway" | "mostrador"
  >("all");

  // Pedido activo re-derivado del listado vivo (refleja cambios de estado). Si el
  // pedido desapareció (cancelado por otro), devolvemos null → el modal se cierra.
  const activeOrder = useMemo(() => {
    if (!activeId) return null;
    return (orders ?? []).find((o) => o.id === activeId) ?? null;
  }, [activeId, orders]);

  const visible = useMemo(() => {
    const list = orders ?? [];
    return typeFilter === "all"
      ? list
      : list.filter((o) => o.order_type === typeFilter);
  }, [orders, typeFilter]);

  // Columnas a mostrar: unión de delivery + takeaway según el filtro. Con "all",
  // usamos las columnas de delivery (en_camino) + "listo" si hay takeaways.
  const columns: DeliveryStatus[] = useMemo(() => {
    // Mostrador usa las mismas columnas que takeaway (con "listo").
    if (typeFilter === "takeaway" || typeFilter === "mostrador")
      return TAKEAWAY_BOARD_COLUMNS;
    if (typeFilter === "delivery") return DELIVERY_BOARD_COLUMNS;
    const hasListo = (orders ?? []).some(
      (o) => o.order_type === "takeaway" || o.order_type === "mostrador",
    );
    const hasDelivery = (orders ?? []).some((o) => o.order_type === "delivery");
    const cols: DeliveryStatus[] = ["recibido", "preparando"];
    if (hasDelivery) cols.push("en_camino");
    if (hasListo) cols.push("listo");
    cols.push("entregado");
    return cols;
  }, [orders, typeFilter]);

  // Agrupa los pedidos visibles por estado.
  const byStatus = useMemo(() => {
    const map = new Map<DeliveryStatus, DeliveryOrder[]>();
    for (const o of visible) {
      const arr = map.get(o.status);
      if (arr) arr.push(o);
      else map.set(o.status, [o]);
    }
    return map;
  }, [visible]);

  function totalFor(o: DeliveryOrder): number {
    const items = itemTotals?.[o.id] ?? 0;
    const fee = o.order_type === "delivery" ? Number(o.delivery_fee) : 0;
    // Si ya fue cobrado, los ítems no están en itemTotals (filtra sale_id null);
    // mostramos al menos el envío como referencia. Para abiertos, ítems + envío.
    return items + fee;
  }

  function advance(o: DeliveryOrder) {
    const next = nextDeliveryStatus(o.order_type, o.status);
    if (!next) return;
    setStatus.mutate(
      { orderId: o.id, status: next },
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

  // Delivery apagado → aviso para activarlo.
  if (!loadingFlag && !enabled) {
    return (
      <div className="mx-auto max-w-2xl px-4 py-16 text-center">
        <Bike size={36} className="mx-auto text-ninja-flameSoft" />
        <Display className="mt-4">Delivery desactivado</Display>
        <p className="mt-2 text-muted-foreground">
          Activá delivery y take away para tomar pedidos con dirección, cadete y
          costo de envío. El POS de mostrador sigue funcionando igual mientras
          tanto.
        </p>
        <Link href="/configuracion?seccion=operacion" className="mt-6 inline-block">
          <Button>
            <Settings size={16} /> Ir a Configuración
          </Button>
        </Link>
      </div>
    );
  }

  const hasOrders = (orders ?? []).length > 0;

  return (
    <div className="mx-auto max-w-7xl px-4 py-6 sm:px-6">
      <div className="mb-5 flex flex-wrap items-center justify-between gap-3">
        <div>
          <Eyebrow>Gastronomía</Eyebrow>
          <Display className="mt-2 flex items-center gap-2">
            <Bike size={26} className="text-ninja-flameSoft" /> Delivery y take away
          </Display>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <Button
            variant="secondary"
            size="sm"
            onClick={() => window.open("/kds", "_blank", "noopener")}
          >
            <ChefHat size={16} /> Cocina (KDS)
          </Button>
          <Button size="sm" onClick={() => setNewOpen(true)}>
            <Plus size={16} /> Nuevo pedido
          </Button>
        </div>
      </div>

      {/* Filtro por tipo */}
      <div className="mb-4 flex flex-wrap gap-2">
        {(
          [
            { k: "all" as const, label: "Todos" },
            { k: "delivery" as const, label: "Delivery" },
            { k: "takeaway" as const, label: "Take away" },
            { k: "mostrador" as const, label: "Mostrador" },
          ]
        ).map((f) => (
          <button
            key={f.k}
            type="button"
            onClick={() => setTypeFilter(f.k)}
            className={
              typeFilter === f.k
                ? "rounded-lg bg-ninja-flame/15 px-3 py-1.5 text-sm font-medium text-ninja-flameSoft"
                : "rounded-lg px-3 py-1.5 text-sm text-muted-foreground transition hover:bg-muted hover:text-foreground"
            }
          >
            {f.label}
          </button>
        ))}
      </div>

      {/* Aviso si no hay pedidos */}
      {!isLoading && !hasOrders && (
        <div className="flex flex-col items-center gap-3 rounded-xl border border-dashed border-border p-10 text-center">
          <Bike size={30} className="text-ninja-flameSoft" />
          <p className="text-sm text-muted-foreground">
            Todavía no hay pedidos. Tomá un pedido de delivery o take away para
            empezar.
          </p>
          <Button size="sm" onClick={() => setNewOpen(true)}>
            <Plus size={15} /> Nuevo pedido
          </Button>
        </div>
      )}

      {/* Tablero (kanban) por estado */}
      {hasOrders && (
        <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-5">
          {columns.map((col) => {
            const list = byStatus.get(col) ?? [];
            return (
              <section
                key={col}
                className="flex flex-col gap-2 rounded-2xl border border-border bg-muted/20 p-2.5"
              >
                <div className="flex items-center justify-between px-1">
                  <span className="flex items-center gap-1.5 text-sm font-bold text-foreground">
                    {DELIVERY_STATUS_LABELS[col]}
                  </span>
                  <span className="rounded-full bg-ninja-flame/15 px-2 py-0.5 text-xs font-semibold text-ninja-flameSoft tabular-nums">
                    {list.length}
                  </span>
                </div>
                <div className="space-y-2">
                  {list.map((o) => (
                    <OrderCard
                      key={o.id}
                      order={o}
                      total={totalFor(o)}
                      zoneName={o.zone_id ? zoneNameById.get(o.zone_id) ?? null : null}
                      onOpen={() => setActiveId(o.id)}
                      onAdvance={() => advance(o)}
                      advancing={setStatus.isPending}
                    />
                  ))}
                  {list.length === 0 && (
                    <p className="rounded-lg border border-dashed border-border/60 px-2 py-6 text-center text-xs text-muted-foreground">
                      Sin pedidos
                    </p>
                  )}
                </div>
              </section>
            );
          })}
        </div>
      )}

      {/* Alta de pedido */}
      <DeliveryOrderModal
        open={newOpen}
        onOpenChange={setNewOpen}
        onCreated={(orderId) => setActiveId(orderId)}
      />

      {/* Cuenta del pedido seleccionado */}
      <DeliveryAccountModal order={activeOrder} onClose={() => setActiveId(null)} />
    </div>
  );
}

// Tarjeta de un pedido en el tablero: cliente, tipo, canal, dirección, horario
// prometido, cadete y total. Botón para avanzar de estado + tap para abrir cuenta.
function OrderCard({
  order,
  total,
  zoneName,
  onOpen,
  onAdvance,
  advancing,
}: {
  order: DeliveryOrder;
  total: number;
  zoneName: string | null;
  onOpen: () => void;
  onAdvance: () => void;
  advancing: boolean;
}) {
  const isDelivery = order.order_type === "delivery";
  const next = nextDeliveryStatus(order.order_type, order.status);
  return (
    <div className="rounded-xl border border-border bg-card p-3">
      <button
        type="button"
        onClick={onOpen}
        className="block w-full text-left"
      >
        <div className="flex items-start justify-between gap-2">
          <span className="flex min-w-0 items-center gap-1.5">
            {isDelivery ? (
              <Bike size={14} className="shrink-0 text-sky-300" />
            ) : (
              <ShoppingBag size={14} className="shrink-0 text-ninja-flameSoft" />
            )}
            <span className="truncate text-sm font-bold text-foreground">
              {order.customer_name ?? "Sin nombre"}
            </span>
          </span>
          <span className="price-hl font-price shrink-0 text-sm font-bold tabular-nums">
            {formatCurrency(total)}
          </span>
        </div>

        <div className="mt-1.5 space-y-1 text-xs text-muted-foreground">
          <div className="flex items-center gap-1">
            <span className="rounded bg-muted px-1.5 py-0.5 text-[11px] font-medium uppercase tracking-wide">
              {DELIVERY_CHANNEL_LABELS[order.channel]}
            </span>
          </div>
          {order.customer_phone && (
            <div className="flex items-center gap-1">
              <Phone size={11} /> {order.customer_phone}
            </div>
          )}
          {isDelivery && order.address && (
            <div className="flex items-start gap-1">
              <MapPin size={11} className="mt-0.5 shrink-0" />
              <span className="line-clamp-2">{order.address}</span>
            </div>
          )}
          {isDelivery && zoneName && (
            <div className="flex items-center gap-1">
              <span className="rounded bg-ninja-flame/10 px-1.5 py-0.5 text-[11px] font-medium text-ninja-flameSoft">
                {zoneName}
              </span>
            </div>
          )}
          {order.promised_at && (
            <div className="flex items-center gap-1">
              <Clock size={11} />
              {new Date(order.promised_at).toLocaleTimeString("es-AR", {
                hour: "2-digit",
                minute: "2-digit",
              })}
            </div>
          )}
          {order.courier_name && (
            <div className="flex items-center gap-1">
              <Truck size={11} /> {order.courier_name}
            </div>
          )}
        </div>
      </button>

      {/* Avanzar de estado (recibido → preparando → …). 'entregado' se alcanza al
          cobrar (no por este botón). */}
      {next && (
        <button
          type="button"
          onClick={onAdvance}
          disabled={advancing}
          className="mt-2.5 flex w-full items-center justify-center gap-1.5 rounded-lg bg-ninja-flame px-3 py-1.5 text-xs font-semibold text-ninja-voidViolet shadow-ninjaGlow transition hover:brightness-110 disabled:opacity-50"
        >
          {DELIVERY_STATUS_LABELS[next]} <ChevronRight size={14} />
        </button>
      )}
    </div>
  );
}
