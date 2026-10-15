"use client";

// "Pedido" del POS (F11 · H32, ADR-129): el vendedor guarda el carrito como
// pedido de salón para que lo cobre la caja. Reserva el stock por los minutos
// de Configuración, registra al vendedor (comisiones) y el tipo de entrega:
// retira ahora, retira después en una sucursal (con código o a su nombre) o
// envío a domicilio. El carrito se guarda con el mismo formato que una venta
// pausada (ADR-106), así la caja lo levanta tal cual.
import { useEffect, useMemo, useState } from "react";
import { CheckCircle2, ClipboardList } from "lucide-react";
import { Modal } from "@/components/ui/Modal";
import { Button } from "@/components/ui/Button";
import { Input } from "@/components/ui/Input";
import { Segmented } from "@/components/ui/Segmented";
import { Select } from "@/components/ui/Select";
import { useToast } from "@/components/ui/Toast";
import { formatCurrency } from "@/lib/utils/format";
import {
  DELIVERY_TYPE_HINT,
  DELIVERY_TYPE_LABEL,
  crossBranchAllowed,
  enabledDeliveryTypes,
  minutesLeftLabel,
  orderErrorMessage,
  orderItemsFromCart,
  type DeliveryType,
} from "@/lib/orders/logic";
import { useOrderConfig, useOrderMutations } from "@/modules/orders/hooks";
import type { CreateOrderResult } from "@/modules/orders/api";
import type { PausedCart } from "@/modules/paused-sales/logic";
import type { CartLine } from "@/modules/pos/store";

export interface OrderSeller {
  id: string;
  name: string;
  user_id: string | null;
}

export function OrderFromCartModal({
  open,
  onOpenChange,
  storeId,
  stores,
  cart,
  lines,
  total,
  itemCount,
  customer,
  sellers,
  currentUserId,
  onSaved,
}: {
  open: boolean;
  onOpenChange: (o: boolean) => void;
  storeId: string | null;
  stores: { id: string; name: string }[];
  /** Carrito serializado como el de una venta pausada. */
  cart: () => PausedCart;
  lines: CartLine[];
  total: number;
  itemCount: number;
  customer: { id: string; name: string } | null;
  sellers: OrderSeller[];
  currentUserId: string | null;
  /** El pedido quedó guardado: el POS vacía la venta. */
  onSaved: (r: CreateOrderResult) => void;
}) {
  const { toast } = useToast();
  const m = useOrderMutations();
  const { config } = useOrderConfig(open);
  const types = enabledDeliveryTypes(config);
  const [type, setType] = useState<DeliveryType>("inmediato");
  const [fulfillment, setFulfillment] = useState<string>("");
  const [name, setName] = useState("");
  const [phone, setPhone] = useState("");
  const [address, setAddress] = useState("");
  const [notes, setNotes] = useState("");
  const [seller, setSeller] = useState<string>("none");
  const [saved, setSaved] = useState<CreateOrderResult | null>(null);

  useEffect(() => {
    if (!open) return;
    setSaved(null);
    setType(types[0] ?? "inmediato");
    setFulfillment(storeId ?? "");
    setName(customer?.name ?? "");
    setPhone("");
    setAddress("");
    setNotes("");
    const mine = sellers.find((s) => s.user_id && s.user_id === currentUserId);
    setSeller(mine?.id ?? "none");
    // Sólo al abrir.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  const items = useMemo(() => orderItemsFromCart(lines), [lines]);
  const cross = crossBranchAllowed(config, type) && stores.length > 1;
  const needsName = type === "retiro";
  const needsAddress = type === "envio";
  const ready =
    Boolean(storeId) &&
    lines.length > 0 &&
    (!needsName || name.trim().length >= 2) &&
    (!needsAddress || address.trim().length >= 5);

  async function save() {
    if (!storeId) {
      toast({ title: "Elegí la sucursal y la caja del POS", variant: "error" });
      return;
    }
    try {
      const r = await m.create.mutateAsync({
        id: crypto.randomUUID(),
        storeId,
        cart: cart(),
        checkout:
          seller !== "none"
            ? { v: 1, lines: [], tipPct: null, tipCustom: "", warrantyId: "", warrantyLineId: "", professionalId: seller }
            : null,
        items,
        total,
        itemCount,
        customerId: customer?.id ?? null,
        customerName: customer ? customer.name : name.trim() || null,
        customerPhone: phone.trim() || null,
        deliveryType: type,
        fulfillmentStoreId: cross && fulfillment ? fulfillment : storeId,
        pickupName: type === "retiro" ? name.trim() || null : null,
        shipAddress: type === "envio" ? address.trim() : null,
        notes: notes.trim() || null,
        sellerProfessionalId: seller !== "none" ? seller : null,
      });
      setSaved(r);
      onSaved(r);
    } catch (e) {
      toast({ title: "No se pudo guardar el pedido", description: orderErrorMessage(e), variant: "error" });
    }
  }

  if (saved) {
    const left = saved.reserved_until ? new Date(saved.reserved_until).getTime() - Date.now() : 0;
    return (
      <Modal
        open={open}
        onOpenChange={onOpenChange}
        title={`Pedido N° ${saved.number} guardado`}
        description={saved.pickup_code ? "Pasale el código al cliente: lo vas a ver una sola vez." : undefined}
        footer={<Button onClick={() => onOpenChange(false)}>Listo</Button>}
      >
        <div className="flex flex-col items-center gap-2 py-2 text-center">
          <CheckCircle2 size={36} className="text-success" aria-hidden />
          <p className="text-sm text-muted-foreground">
            Que el cliente pase por caja. {saved.reservation_id && left > 0
              ? `El stock queda reservado ${minutesLeftLabel(left)}.`
              : "No se reservó stock (tu plan o los productos no lo controlan)."}
          </p>
          {saved.pickup_code && (
            <p className="font-mono text-4xl font-bold tracking-[0.3em] tabular-nums">{saved.pickup_code}</p>
          )}
        </div>
      </Modal>
    );
  }

  return (
    <Modal
      open={open}
      onOpenChange={onOpenChange}
      title="Guardar como pedido"
      description={`La caja lo levanta y lo cobra. El stock queda reservado ${config.reservation_minutes} min.`}
      footer={
        <div className="flex w-full flex-wrap items-center justify-between gap-2">
          <span className="font-price text-lg font-bold tabular-nums">{formatCurrency(total)}</span>
          <div className="flex gap-2">
            <Button variant="secondary" onClick={() => onOpenChange(false)}>
              Cancelar
            </Button>
            <Button onClick={save} loading={m.create.isPending} disabled={!ready}>
              <ClipboardList size={15} /> Guardar pedido
            </Button>
          </div>
        </div>
      }
    >
      <div className="space-y-4">
        <div className="rounded-lg bg-fg-4 px-3 py-2.5 text-sm">
          <p className="font-medium">{customer ? customer.name : "Sin cliente elegido"}</p>
          <p className="text-xs text-muted-foreground">
            {lines.length === 1 ? "1 producto" : `${lines.length} productos`} · {formatCurrency(total)}
          </p>
        </div>

        {types.length > 1 && (
          <div>
            <p className="mb-1.5 text-xs font-medium text-muted-foreground">Entrega</p>
            <Segmented<DeliveryType>
              scrollOnMobile
              size="sm"
              aria-label="Tipo de entrega"
              value={type}
              onChange={setType}
              options={types.map((t) => ({ value: t, label: DELIVERY_TYPE_LABEL[t] }))}
            />
            <p className="mt-1.5 text-xs text-muted-foreground">{DELIVERY_TYPE_HINT[type]}</p>
          </div>
        )}

        {cross && (
          <Select
            label={type === "envio" ? "Sale desde" : "Retira en"}
            value={fulfillment || storeId}
            onChange={setFulfillment}
            options={stores.map((s) => ({ value: s.id, label: s.id === storeId ? `${s.name} (esta sucursal)` : s.name }))}
          />
        )}

        {(needsName || !customer) && (
          <Input
            label={needsName ? "Retira a nombre de" : "Nombre del cliente (opcional)"}
            value={name}
            onChange={(e) => setName(e.target.value)}
            maxLength={120}
            autoComplete="off"
          />
        )}
        {needsAddress && (
          <Input
            label="Domicilio de entrega"
            value={address}
            onChange={(e) => setAddress(e.target.value)}
            maxLength={300}
            autoComplete="off"
          />
        )}
        <Input
          label="Teléfono (opcional)"
          value={phone}
          onChange={(e) => setPhone(e.target.value)}
          maxLength={40}
          inputMode="tel"
          autoComplete="off"
        />
        {sellers.length > 0 && (
          <Select
            label="Vendedor"
            hint="Para las comisiones: viaja con la venta cuando la caja cobra."
            value={seller}
            onChange={setSeller}
            options={[
              { value: "none", label: "Sin asignar" },
              ...sellers.map((s) => ({ value: s.id, label: s.name })),
            ]}
          />
        )}
        <Input label="Nota (opcional)" value={notes} onChange={(e) => setNotes(e.target.value)} maxLength={500} />
      </div>
    </Modal>
  );
}
