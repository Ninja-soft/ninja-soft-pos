"use client";

import { useMemo, useState } from "react";
import { Bike, Coffee, Search, ShoppingBag, UserPlus, X } from "lucide-react";
import { Modal } from "@/components/ui/Modal";
import { Button } from "@/components/ui/Button";
import { Input } from "@/components/ui/Input";
import { useToast } from "@/components/ui/Toast";
import { useCustomers } from "@/modules/customers/hooks";
import {
  useDeliveryMutations,
  useDeliveryZones,
} from "@/modules/delivery/hooks";
import {
  DELIVERY_CHANNELS,
  DELIVERY_CHANNEL_LABELS,
  type DeliveryChannel,
  type DeliveryOrderType,
} from "@/modules/delivery/api";
import { formatCurrency } from "@/lib/utils/format";

// Alta de un pedido de delivery / take away (F13 · H49). Elegí canal y tipo,
// cliente (existente del catálogo o datos sueltos nombre+teléfono), dirección +
// referencia (sólo delivery), horario prometido y costo de envío. Al crear,
// devuelve el order_id (el board abre la cuenta para cargar ítems). No cobra:
// el cobro va por el POS (/pos?delivery=<id>).
export function DeliveryOrderModal({
  open,
  onOpenChange,
  onCreated,
}: {
  open: boolean;
  onOpenChange: (o: boolean) => void;
  onCreated: (orderId: string) => void;
}) {
  const { toast } = useToast();
  const { create } = useDeliveryMutations();

  const [orderType, setOrderType] = useState<DeliveryOrderType>("delivery");
  const [channel, setChannel] = useState<DeliveryChannel>("telefono");

  // Cliente: existente (del catálogo) o datos sueltos. customerId set = elegido.
  const [customerSearch, setCustomerSearch] = useState("");
  const [customerId, setCustomerId] = useState<string | null>(null);
  const [customerName, setCustomerName] = useState("");
  const [customerPhone, setCustomerPhone] = useState("");

  const [address, setAddress] = useState("");
  const [addressRef, setAddressRef] = useState("");
  const [promisedAt, setPromisedAt] = useState(""); // datetime-local
  const [fee, setFee] = useState("");
  const [zoneId, setZoneId] = useState<string>(""); // "" = sin zona
  const [notes, setNotes] = useState("");

  // Zonas de envío activas del tenant (F13 · H49 follow-up). Si hay zonas, se
  // ofrece un selector que autocompleta el costo de envío con la tarifa de la
  // zona. Si no hay zonas cargadas, el campo de fee manual queda como hasta ahora.
  const { data: zones } = useDeliveryZones(false);
  const hasZones = (zones ?? []).length > 0;

  const { data: customers } = useCustomers(customerSearch);
  const showCustomerList =
    customerSearch.trim().length > 0 && customerId === null;
  const list = useMemo(() => (customers ?? []).slice(0, 8), [customers]);

  function reset() {
    setOrderType("delivery");
    setChannel("telefono");
    setCustomerSearch("");
    setCustomerId(null);
    setCustomerName("");
    setCustomerPhone("");
    setAddress("");
    setAddressRef("");
    setPromisedAt("");
    setFee("");
    setZoneId("");
    setNotes("");
  }

  // Al elegir una zona, autocompletá el costo de envío con su tarifa (queda
  // editable: override manual). "" = sin zona (no toca el fee).
  function pickZone(id: string) {
    setZoneId(id);
    const z = (zones ?? []).find((x) => x.id === id);
    if (z) setFee(String(z.fee));
  }

  function pickCustomer(c: { id: string; name: string; phone: string | null; address: string | null }) {
    setCustomerId(c.id);
    setCustomerName(c.name);
    setCustomerPhone(c.phone ?? "");
    setCustomerSearch(c.name);
    // Si el cliente tiene dirección cargada y es delivery, precargala.
    if (orderType === "delivery" && c.address && !address) setAddress(c.address);
  }

  function clearCustomer() {
    setCustomerId(null);
    setCustomerSearch("");
    setCustomerName("");
    setCustomerPhone("");
  }

  async function submit() {
    const name = customerName.trim();
    if (!name) {
      toast({ title: "Poné el nombre del cliente", variant: "error" });
      return;
    }
    if (orderType === "delivery" && !address.trim()) {
      toast({ title: "La dirección es obligatoria para delivery", variant: "error" });
      return;
    }
    const feeNum = Number(fee || 0);
    if (!Number.isFinite(feeNum) || feeNum < 0) {
      toast({ title: "El costo de envío no es válido", variant: "error" });
      return;
    }
    try {
      const orderId = await create.mutateAsync({
        channel,
        order_type: orderType,
        customer_id: customerId,
        customer_name: name,
        customer_phone: customerPhone.trim() || null,
        address: orderType === "delivery" ? address.trim() : null,
        address_reference:
          orderType === "delivery" ? addressRef.trim() || null : null,
        // datetime-local → ISO (local). Vacío = sin horario prometido.
        promised_at: promisedAt ? new Date(promisedAt).toISOString() : null,
        delivery_fee: orderType === "delivery" ? feeNum : 0,
        zone_id: orderType === "delivery" && zoneId ? zoneId : null,
        notes: notes.trim() || null,
      });
      toast({ title: "Pedido creado", variant: "success" });
      reset();
      onOpenChange(false);
      onCreated(orderId);
    } catch (e) {
      toast({
        title: "No se pudo crear el pedido",
        description: e instanceof Error ? e.message : undefined,
        variant: "error",
      });
    }
  }

  return (
    <Modal
      open={open}
      onOpenChange={(o) => {
        if (!o) reset();
        onOpenChange(o);
      }}
      title="Nuevo pedido"
    >
      <div className="space-y-4">
        {/* Tipo: delivery / takeaway / mostrador */}
        <div>
          <span className="mb-1.5 block text-sm font-medium text-muted-foreground">
            Tipo de pedido
          </span>
          <div className="grid grid-cols-3 gap-2">
            <button
              type="button"
              onClick={() => setOrderType("delivery")}
              className={
                orderType === "delivery"
                  ? "flex items-center justify-center gap-2 rounded-lg border border-ninja-flame bg-ninja-flame/[0.08] px-3 py-2.5 text-sm font-semibold text-ninja-flameSoft"
                  : "flex items-center justify-center gap-2 rounded-lg border border-border px-3 py-2.5 text-sm text-muted-foreground transition hover:border-ninja-flameSoft/40"
              }
            >
              <Bike size={16} /> Delivery
            </button>
            <button
              type="button"
              onClick={() => setOrderType("takeaway")}
              className={
                orderType === "takeaway"
                  ? "flex items-center justify-center gap-2 rounded-lg border border-ninja-flame bg-ninja-flame/[0.08] px-3 py-2.5 text-sm font-semibold text-ninja-flameSoft"
                  : "flex items-center justify-center gap-2 rounded-lg border border-border px-3 py-2.5 text-sm text-muted-foreground transition hover:border-ninja-flameSoft/40"
              }
            >
              <ShoppingBag size={16} /> Take away
            </button>
            <button
              type="button"
              onClick={() => setOrderType("mostrador")}
              className={
                orderType === "mostrador"
                  ? "flex items-center justify-center gap-2 rounded-lg border border-ninja-flame bg-ninja-flame/[0.08] px-3 py-2.5 text-sm font-semibold text-ninja-flameSoft"
                  : "flex items-center justify-center gap-2 rounded-lg border border-border px-3 py-2.5 text-sm text-muted-foreground transition hover:border-ninja-flameSoft/40"
              }
            >
              <Coffee size={16} /> Mostrador
            </button>
          </div>
        </div>

        {/* Canal */}
        <label className="block">
          <span className="mb-1.5 block text-sm font-medium text-muted-foreground">
            Canal
          </span>
          <select
            value={channel}
            onChange={(e) => setChannel(e.target.value as DeliveryChannel)}
            className="h-11 w-full rounded-lg border border-input bg-background px-3 text-sm text-foreground outline-none transition focus:border-ninja-flameSoft"
          >
            {DELIVERY_CHANNELS.map((c) => (
              <option key={c} value={c}>
                {DELIVERY_CHANNEL_LABELS[c]}
              </option>
            ))}
          </select>
        </label>

        {/* Cliente: buscar existente o cargar suelto */}
        <div>
          <span className="mb-1.5 block text-sm font-medium text-muted-foreground">
            Cliente
          </span>
          {customerId ? (
            <div className="flex items-center justify-between gap-2 rounded-lg border border-ninja-flame/40 bg-ninja-flame/[0.06] px-3 py-2">
              <span className="min-w-0 text-sm">
                <span className="block truncate font-medium text-foreground">
                  {customerName}
                </span>
                {customerPhone && (
                  <span className="block truncate text-xs text-muted-foreground">
                    {customerPhone}
                  </span>
                )}
              </span>
              <button
                type="button"
                onClick={clearCustomer}
                className="shrink-0 rounded-md p-1.5 text-muted-foreground transition hover:bg-muted hover:text-foreground"
                aria-label="Quitar cliente"
              >
                <X size={15} />
              </button>
            </div>
          ) : (
            <div className="relative">
              <Search
                size={15}
                className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-muted-foreground"
              />
              <input
                value={customerSearch}
                onChange={(e) => setCustomerSearch(e.target.value)}
                placeholder="Buscar cliente por nombre o documento…"
                className="h-11 w-full rounded-lg border border-input bg-background pl-9 pr-3 text-sm text-foreground outline-none transition focus:border-ninja-flameSoft focus:ring-2 focus:ring-ninja-flameSoft/20"
              />
              {showCustomerList && list.length > 0 && (
                <div className="mt-1 max-h-44 space-y-0.5 overflow-y-auto rounded-lg border border-border bg-card p-1">
                  {list.map((c) => (
                    <button
                      key={c.id}
                      type="button"
                      onClick={() => pickCustomer(c)}
                      className="flex w-full items-center justify-between gap-2 rounded-md px-2.5 py-1.5 text-left text-sm transition hover:bg-muted"
                    >
                      <span className="min-w-0 truncate font-medium text-foreground">
                        {c.name}
                      </span>
                      {c.phone && (
                        <span className="shrink-0 text-xs text-muted-foreground">
                          {c.phone}
                        </span>
                      )}
                    </button>
                  ))}
                </div>
              )}
            </div>
          )}
        </div>

        {/* Datos sueltos (nombre + teléfono) cuando NO se eligió un cliente del
            catálogo. El nombre es obligatorio (queda como snapshot del pedido). */}
        {!customerId && (
          <div className="grid gap-3 sm:grid-cols-2">
            <Input
              label="Nombre"
              value={customerName}
              onChange={(e) => setCustomerName(e.target.value)}
              placeholder="Nombre del cliente"
            />
            <Input
              label="Teléfono"
              value={customerPhone}
              onChange={(e) => setCustomerPhone(e.target.value)}
              placeholder="Ej. 11 3000 1111"
            />
          </div>
        )}

        {/* Dirección + referencia (sólo delivery) */}
        {orderType === "delivery" && (
          <div className="space-y-3">
            <Input
              label="Dirección"
              value={address}
              onChange={(e) => setAddress(e.target.value)}
              placeholder="Calle y número"
            />
            <Input
              label="Referencia (opcional)"
              value={addressRef}
              onChange={(e) => setAddressRef(e.target.value)}
              placeholder="Timbre, piso, entre calles…"
            />
          </div>
        )}

        {/* Zona de envío (sólo delivery, si hay zonas cargadas). Al elegirla,
            autocompleta el costo de envío con su tarifa (queda editable). */}
        {orderType === "delivery" && hasZones && (
          <label className="block">
            <span className="mb-1.5 block text-sm font-medium text-muted-foreground">
              Zona de envío
            </span>
            <select
              value={zoneId}
              onChange={(e) => pickZone(e.target.value)}
              className="h-11 w-full rounded-lg border border-input bg-background px-3 text-sm text-foreground outline-none transition focus:border-ninja-flameSoft"
            >
              <option value="">Sin zona</option>
              {(zones ?? []).map((z) => (
                <option key={z.id} value={z.id} className="bg-popover text-popover-foreground">
                  {z.name} · {formatCurrency(Number(z.fee))}
                  {z.eta_minutes != null ? ` · ${z.eta_minutes} min` : ""}
                </option>
              ))}
            </select>
          </label>
        )}

        {/* Horario prometido + costo de envío */}
        <div className="grid gap-3 sm:grid-cols-2">
          <label className="block">
            <span className="mb-2 block text-sm font-medium text-muted-foreground">
              Horario prometido (opcional)
            </span>
            <input
              type="datetime-local"
              value={promisedAt}
              onChange={(e) => setPromisedAt(e.target.value)}
              className="h-11 w-full rounded-lg border border-input bg-background px-3 text-sm text-foreground outline-none transition focus:border-ninja-flameSoft"
            />
          </label>
          {orderType === "delivery" && (
            <Input
              label="Costo de envío"
              type="number"
              min="0"
              step="1"
              value={fee}
              onChange={(e) => setFee(e.target.value)}
              placeholder="0"
            />
          )}
        </div>

        <Input
          label="Notas (opcional)"
          value={notes}
          onChange={(e) => setNotes(e.target.value)}
          placeholder="Aclaraciones del pedido"
        />

        <div className="flex items-center justify-end gap-2 pt-1">
          <Button variant="ghost" onClick={() => onOpenChange(false)}>
            Cancelar
          </Button>
          <Button onClick={submit} loading={create.isPending}>
            <UserPlus size={16} /> Crear y cargar ítems
          </Button>
        </div>
      </div>
    </Modal>
  );
}
