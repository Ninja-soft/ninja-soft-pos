"use client";

import { useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import {
  AlertTriangle,
  Bike,
  ChefHat,
  Clock,
  CreditCard,
  MapPin,
  Minus,
  Phone,
  Plus,
  ShoppingBag,
  Trash2,
  Truck,
  X,
} from "lucide-react";
import { Modal } from "@/components/ui/Modal";
import { Button } from "@/components/ui/Button";
import { Input } from "@/components/ui/Input";
import { useToast } from "@/components/ui/Toast";
import { ConfirmDialog } from "@/components/ui/ConfirmDialog";
import { ComandaModal } from "@/components/dining/ComandaModal";
import { useTicketBranding } from "@/modules/tickets/hooks";
import {
  useDeliveryOrderItems,
  useDeliveryMutations,
  useDeliveryZones,
} from "@/modules/delivery/hooks";
import {
  DELIVERY_CHANNEL_LABELS,
  DELIVERY_STATUS_LABELS,
  DELIVERY_TYPE_LABELS,
  type DeliveryOrder,
  type DeliveryOrderItem,
} from "@/modules/delivery/api";
import { DeliveryProductPicker } from "./DeliveryProductPicker";
import { formatCurrency, formatQty } from "@/lib/utils/format";

// Cuenta de un pedido de delivery / take away (F13 · H49). Espeja
// TableAccountModal (H44): ver/editar ítems, asignar cadete, ver datos del
// pedido y COBRAR. El cobro abre el POS con los ítems + el costo de envío
// cargados (/pos?delivery=<id>) y reusa create_sale (atómico, marca el pedido
// cobrado/entregado y libera).
export function DeliveryAccountModal({
  order,
  onClose,
}: {
  order: DeliveryOrder | null;
  onClose: () => void;
}) {
  const router = useRouter();
  const { toast } = useToast();
  const orderId = order?.id ?? null;
  const open = order !== null;
  const { data: items } = useDeliveryOrderItems(orderId);
  const { setItemQty, removeItem, cancel, assignCourier } = useDeliveryMutations();
  // Nombre del local para la cabecera (opcional) de la comanda de cocina (H49).
  const { data: brand } = useTicketBranding(open);

  const [pickerOpen, setPickerOpen] = useState(false);
  const [confirmCancel, setConfirmCancel] = useState(false);
  const [comandaOpen, setComandaOpen] = useState(false);
  const [courier, setCourier] = useState("");

  const isDelivery = order?.order_type === "delivery";
  const closed =
    order?.status === "entregado" ||
    order?.status === "cancelado" ||
    Boolean(order?.sale_id);

  const itemsTotal = useMemo(
    () => (items ?? []).reduce((acc, it) => acc + it.qty * it.unit_price, 0),
    [items],
  );
  const fee = isDelivery ? Number(order?.delivery_fee ?? 0) : 0;
  const total = itemsTotal + fee;

  // Zona del pedido (incl. inactivas) para mostrar nombre + eta. Cache compartida
  // con el board / la gestión (mismo queryKey). El fee real ya vive snapshotteado
  // en order.delivery_fee (no se recalcula desde la zona).
  const { data: zones } = useDeliveryZones(true);
  const zone = useMemo(
    () => (order?.zone_id ? (zones ?? []).find((z) => z.id === order.zone_id) ?? null : null),
    [zones, order?.zone_id],
  );

  async function changeQty(itemId: string, qty: number) {
    try {
      await setItemQty.mutateAsync({ itemId, qty: Math.max(0, qty) });
    } catch (e) {
      toast({
        title: "No se pudo actualizar",
        description: e instanceof Error ? e.message : undefined,
        variant: "error",
      });
    }
  }

  async function saveCourier() {
    if (!orderId) return;
    try {
      await assignCourier.mutateAsync({ orderId, courierName: courier.trim() });
      toast({ title: "Cadete asignado", variant: "success" });
      setCourier("");
    } catch (e) {
      toast({
        title: "No se pudo asignar el cadete",
        description: e instanceof Error ? e.message : undefined,
        variant: "error",
      });
    }
  }

  async function doCancel() {
    if (!orderId) return;
    try {
      await cancel.mutateAsync(orderId);
      toast({ title: "Pedido cancelado", variant: "success" });
      setConfirmCancel(false);
      onClose();
    } catch (e) {
      toast({
        title: "No se pudo cancelar",
        description: e instanceof Error ? e.message : undefined,
        variant: "error",
      });
    }
  }

  // Cobrar: lleva al POS con el pedido + costo de envío cargados.
  function charge() {
    if (!orderId) return;
    if ((items ?? []).length === 0) {
      toast({ title: "El pedido no tiene ítems para cobrar", variant: "info" });
      return;
    }
    router.push(`/pos?delivery=${orderId}`);
  }

  return (
    <>
      <Modal
        open={open}
        onOpenChange={(o) => {
          if (!o) onClose();
        }}
        title={
          order
            ? `${DELIVERY_TYPE_LABELS[order.order_type]} · ${order.customer_name ?? "Pedido"}`
            : "Pedido"
        }
      >
        <div className="space-y-4">
          {/* Cabecera: estado + canal + datos del pedido */}
          {order && (
            <div className="space-y-2 rounded-lg border border-border bg-muted/20 p-3 text-sm">
              <div className="flex flex-wrap items-center gap-2">
                <span className="inline-flex items-center gap-1.5 rounded-full bg-ninja-flame/15 px-2 py-0.5 text-xs font-semibold text-ninja-flameSoft">
                  {isDelivery ? <Bike size={12} /> : <ShoppingBag size={12} />}
                  {DELIVERY_TYPE_LABELS[order.order_type]}
                </span>
                <span className="rounded-full border border-border px-2 py-0.5 text-xs text-muted-foreground">
                  {DELIVERY_STATUS_LABELS[order.status]}
                </span>
                <span className="text-xs text-muted-foreground">
                  {DELIVERY_CHANNEL_LABELS[order.channel]}
                </span>
              </div>
              {order.customer_phone && (
                <div className="flex items-center gap-1.5 text-muted-foreground">
                  <Phone size={13} /> {order.customer_phone}
                </div>
              )}
              {isDelivery && order.address && (
                <div className="flex items-start gap-1.5 text-muted-foreground">
                  <MapPin size={13} className="mt-0.5 shrink-0" />
                  <span>
                    {order.address}
                    {order.address_reference ? (
                      <span className="block text-xs opacity-80">
                        {order.address_reference}
                      </span>
                    ) : null}
                  </span>
                </div>
              )}
              {isDelivery && zone && (
                <div className="flex items-center gap-1.5 text-muted-foreground">
                  <MapPin size={13} className="shrink-0" />
                  <span>
                    Zona: <span className="text-foreground">{zone.name}</span>
                    {zone.eta_minutes != null ? ` · ${zone.eta_minutes} min` : ""}
                  </span>
                </div>
              )}
              {order.promised_at && (
                <div className="flex items-center gap-1.5 text-muted-foreground">
                  <Clock size={13} />{" "}
                  {new Date(order.promised_at).toLocaleString("es-AR", {
                    day: "2-digit",
                    month: "2-digit",
                    hour: "2-digit",
                    minute: "2-digit",
                  })}
                </div>
              )}
              {order.courier_name && (
                <div className="flex items-center gap-1.5 text-muted-foreground">
                  <Truck size={13} /> {order.courier_name}
                </div>
              )}
            </div>
          )}

          {/* Acción agregar ítem (sólo si el pedido sigue abierto) */}
          {!closed && (
            <div className="flex justify-end">
              <Button size="sm" onClick={() => setPickerOpen(true)}>
                <Plus size={15} /> Agregar ítem
              </Button>
            </div>
          )}

          {/* Líneas del pedido */}
          <div className="max-h-[40vh] space-y-2 overflow-y-auto">
            {(items ?? []).length === 0 ? (
              <p className="rounded-lg border border-dashed border-border p-5 text-center text-sm text-muted-foreground">
                Pedido sin ítems.{" "}
                {!closed && (
                  <>
                    Tocá{" "}
                    <span className="font-medium text-foreground">Agregar ítem</span>{" "}
                    para cargarlo.
                  </>
                )}
              </p>
            ) : (
              (items ?? []).map((it) => (
                <ItemRow
                  key={it.id}
                  item={it}
                  readOnly={closed}
                  onQty={changeQty}
                  onRemove={(id) => removeItem.mutate(id)}
                />
              ))
            )}
          </div>

          {/* Totales: ítems + envío */}
          <div className="space-y-1 border-t border-border pt-3 text-sm">
            <div className="flex items-center justify-between text-muted-foreground">
              <span>Ítems</span>
              <span className="tabular-nums">{formatCurrency(itemsTotal)}</span>
            </div>
            {isDelivery && (
              <div className="flex items-center justify-between text-muted-foreground">
                <span>Envío</span>
                <span className="tabular-nums">{formatCurrency(fee)}</span>
              </div>
            )}
            <div className="flex items-center justify-between pt-1">
              <span className="font-medium text-muted-foreground">Total</span>
              <span className="price-hl font-price text-2xl font-bold tabular-nums">
                {formatCurrency(total)}
              </span>
            </div>
          </div>

          {/* Asignar cadete (sólo delivery, no cerrado) */}
          {!closed && isDelivery && (
            <div className="flex items-end gap-2">
              <Input
                label="Cadete / repartidor"
                value={courier}
                onChange={(e) => setCourier(e.target.value)}
                placeholder={order?.courier_name ?? "Nombre del cadete"}
                className="flex-1"
              />
              <Button
                variant="secondary"
                onClick={saveCourier}
                loading={assignCourier.isPending}
                disabled={!courier.trim()}
              >
                <Truck size={15} /> Asignar
              </Button>
            </div>
          )}

          {/* Comanda de cocina (H49): imprime la(s) comanda(s) por estación de las
              líneas ya disparadas. Por defecto envía sólo lo nuevo a cocina/barra.
              Disponible aunque el pedido esté cerrado (reimpresión). */}
          <Button
            variant="secondary"
            onClick={() => setComandaOpen(true)}
            disabled={(items ?? []).length === 0}
            className="w-full"
          >
            <ChefHat size={16} /> Imprimir comanda
          </Button>

          {/* Acciones: cobrar + cancelar */}
          {!closed && (
            <div className="flex flex-wrap items-center gap-2">
              <Button onClick={charge} className="flex-1">
                <CreditCard size={16} /> Cobrar pedido
              </Button>
              <Button
                variant="ghost"
                onClick={() => setConfirmCancel(true)}
                className="text-destructive"
              >
                <X size={15} /> Cancelar
              </Button>
            </div>
          )}
        </div>
      </Modal>

      {/* Picker de productos */}
      <DeliveryProductPicker
        open={pickerOpen}
        onOpenChange={setPickerOpen}
        orderId={orderId}
      />

      {/* Comanda de cocina por estación (H49). Reusa el modal de mesa (H45) con
          source="delivery": misma agrupación/impresión, encabezado del pedido. */}
      <ComandaModal
        source="delivery"
        open={comandaOpen}
        onOpenChange={setComandaOpen}
        orderId={orderId}
        order={order}
        businessName={brand?.legal_name ?? null}
      />

      {/* Confirmación de cancelación */}
      <ConfirmDialog
        open={confirmCancel}
        onOpenChange={setConfirmCancel}
        title="Cancelar el pedido"
        description="Se anula el pedido. Esta acción no se puede deshacer."
        confirmLabel="Cancelar pedido"
        danger
        loading={cancel.isPending}
        onConfirm={doCancel}
      />
    </>
  );
}

// Una línea del pedido: nombre + precio, controles de cantidad, total y quitar.
function ItemRow({
  item,
  readOnly,
  onQty,
  onRemove,
}: {
  item: DeliveryOrderItem;
  readOnly: boolean;
  onQty: (itemId: string, qty: number) => void;
  onRemove: (itemId: string) => void;
}) {
  return (
    <div className="flex items-center gap-2 rounded-lg border border-border bg-card px-3 py-2">
      <div className="min-w-0 flex-1">
        <div className="truncate text-sm font-medium text-foreground">
          {item.name}
        </div>
        <div className="text-xs text-muted-foreground">
          {formatCurrency(item.unit_price)} c/u
          {item.notes ? ` · ${item.notes}` : ""}
        </div>
        {/* Alergia/intolerancia (F13 · H47): destacada en rojo. */}
        {item.allergens && (
          <span className="mt-0.5 inline-flex items-center gap-1 rounded bg-red-500/15 px-1.5 py-0.5 text-[11px] font-bold uppercase text-danger">
            <AlertTriangle size={11} /> Alergia: {item.allergens}
          </span>
        )}
      </div>

      {!readOnly && (
        <div className="flex shrink-0 items-center gap-1">
          <button
            type="button"
            onClick={() => onQty(item.id, item.qty - 1)}
            className="grid h-7 w-7 place-items-center rounded-md border border-border text-muted-foreground transition hover:bg-muted hover:text-foreground"
            aria-label="Restar"
          >
            <Minus size={14} />
          </button>
          <span className="w-8 text-center text-sm font-semibold tabular-nums">
            {formatQty(item.qty)}
          </span>
          <button
            type="button"
            onClick={() => onQty(item.id, item.qty + 1)}
            className="grid h-7 w-7 place-items-center rounded-md border border-border text-muted-foreground transition hover:bg-muted hover:text-foreground"
            aria-label="Sumar"
          >
            <Plus size={14} />
          </button>
        </div>
      )}
      {readOnly && (
        <span className="w-8 text-center text-sm font-semibold tabular-nums">
          {formatQty(item.qty)}
        </span>
      )}

      <div className="w-20 shrink-0 text-right price-hl font-price text-sm font-bold tabular-nums">
        {formatCurrency(item.qty * item.unit_price)}
      </div>

      {!readOnly && (
        <button
          type="button"
          onClick={() => onRemove(item.id)}
          className="shrink-0 rounded-md p-1.5 text-muted-foreground transition hover:bg-muted hover:text-danger"
          aria-label="Quitar"
        >
          <Trash2 size={15} />
        </button>
      )}
    </div>
  );
}
