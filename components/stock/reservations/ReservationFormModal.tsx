"use client";

import { useEffect, useMemo, useState } from "react";
import { Minus, Plus, Trash2 } from "lucide-react";
import { Modal } from "@/components/ui/Modal";
import { Button } from "@/components/ui/Button";
import { Input } from "@/components/ui/Input";
import { ProductSearchCombobox } from "@/components/products/ProductSearchCombobox";
import { useToast } from "@/components/ui/Toast";
import { cn } from "@/lib/utils/cn";
import { formatQty } from "@/lib/utils/format";
import { stockKey } from "@/lib/stock/suggest";
import {
  RESERVATION_CHANNEL_LABEL,
  reservationErrorMessage,
  validateReservationDraft,
  type ReservationChannel,
} from "@/lib/stock/reservations";
import { variantLabel, type Product, type ProductVariant } from "@/modules/products/api";
import { useReservationAvailability, useReservationMutations } from "@/modules/stock/reservations";
import { selectCls } from "@/components/stock/transfers/shared";

// Se reservan productos con stock controlado y que no son kits.
const reservable = (p: Product) => p.track_stock !== false && !p.is_kit;

interface Line {
  key: string;
  product_id: string;
  variant_id: string | null;
  name: string;
  qty: number;
}

const HOURS = [
  { value: 4, label: "4 horas" },
  { value: 24, label: "1 día" },
  { value: 48, label: "2 días" },
  { value: 72, label: "3 días" },
  { value: 168, label: "1 semana" },
];

// Nueva reserva de stock para retiro en tienda (F16 · H77, ADR-091). Se
// puede reservar en otra sucursal (venta asistida con stock de otra tienda):
// el retiro es en la sucursal elegida. El código de retiro se muestra una vez.
export function ReservationFormModal({
  open,
  onOpenChange,
  stores,
  defaultStoreId,
  myStoreId,
  onCreated,
}: {
  open: boolean;
  onOpenChange: (o: boolean) => void;
  stores: { id: string; name: string }[];
  defaultStoreId: string | null;
  myStoreId: string | null;
  onCreated: (r: { number: number; pickup_code: string; customer: string; store: string }) => void;
}) {
  const { toast } = useToast();
  const m = useReservationMutations();
  const [storeId, setStoreId] = useState<string | null>(null);
  const [name, setName] = useState("");
  const [phone, setPhone] = useState("");
  const [doc, setDoc] = useState("");
  const [channel, setChannel] = useState<ReservationChannel>("mostrador");
  const [hours, setHours] = useState(48);
  const [notes, setNotes] = useState("");
  const [lines, setLines] = useState<Line[]>([]);

  useEffect(() => {
    if (!open) return;
    setStoreId(defaultStoreId);
    setName("");
    setPhone("");
    setDoc("");
    setChannel("mostrador");
    setHours(48);
    setNotes("");
    setLines([]);
  }, [open, defaultStoreId]);

  const productIds = useMemo(() => [...new Set(lines.map((l) => l.product_id))], [lines]);
  const { data: avail = [] } = useReservationAvailability(open ? storeId : null, productIds);
  const availableOf = (l: Line) =>
    avail.find((a) => a.product_id === l.product_id && (a.variant_id ?? null) === l.variant_id)?.available ?? 0;

  function addLine(p: Product, v?: ProductVariant | null) {
    const key = stockKey(p.id, v?.id ?? null);
    setLines((prev) => {
      const i = prev.findIndex((l) => l.key === key);
      if (i >= 0) {
        const next = [...prev];
        next[i] = { ...next[i]!, qty: next[i]!.qty + 1 };
        return next;
      }
      return [
        ...prev,
        { key, product_id: p.id, variant_id: v?.id ?? null, name: v ? `${p.name} (${variantLabel(v)})` : p.name, qty: 1 },
      ];
    });
  }

  const setQty = (key: string, qty: number) =>
    setLines((prev) => prev.map((l) => (l.key === key ? { ...l, qty: Math.max(0, qty) } : l)));

  const errors = validateReservationDraft({
    storeId,
    customerName: name,
    customerDoc: doc,
    hours,
    lines: lines.map((l) => ({
      product_id: l.product_id,
      variant_id: l.variant_id,
      qty: l.qty,
      available: avail.length > 0 ? availableOf(l) : null,
    })),
  });

  const otherStore = Boolean(storeId && myStoreId && storeId !== myStoreId);

  async function submit() {
    if (!storeId || errors.length > 0) return;
    try {
      const r = await m.create.mutateAsync({
        storeId,
        originStoreId: otherStore ? myStoreId : null,
        items: lines.map((l) => ({ product_id: l.product_id, variant_id: l.variant_id, qty: l.qty })),
        customerName: name,
        customerId: null,
        customerPhone: phone,
        customerDoc: doc,
        channel: otherStore && channel === "mostrador" ? "otra_sucursal" : channel,
        hours,
        notes,
      });
      onCreated({
        number: r.number,
        pickup_code: r.pickup_code,
        customer: name.trim(),
        store: stores.find((s) => s.id === storeId)?.name ?? "",
      });
      onOpenChange(false);
    } catch (e) {
      toast({ title: "No se pudo reservar", description: reservationErrorMessage(e), variant: "error" });
    }
  }

  return (
    <Modal
      open={open}
      onOpenChange={onOpenChange}
      title="Nueva reserva"
      description="Aparta stock para un cliente. Se cobra cuando retira."
      className="sm:max-w-2xl"
      footer={
        <>
          <Button variant="secondary" onClick={() => onOpenChange(false)}>
            Cancelar
          </Button>
          <Button onClick={submit} disabled={errors.length > 0} loading={m.create.isPending}>
            Reservar
          </Button>
        </>
      }
    >
      <div className="space-y-4">
        <div className="grid gap-3 sm:grid-cols-2">
          <label className="text-sm">
            <span className="mb-1 block font-medium">Retira en</span>
            <select className={selectCls} value={storeId ?? ""} onChange={(e) => setStoreId(e.target.value)}>
              {stores.map((s) => (
                <option key={s.id} value={s.id} className="bg-popover text-popover-foreground">
                  {s.name}
                </option>
              ))}
            </select>
          </label>
          <label className="text-sm">
            <span className="mb-1 block font-medium">Canal</span>
            <select
              className={selectCls}
              value={channel}
              onChange={(e) => setChannel(e.target.value as ReservationChannel)}
            >
              {(Object.keys(RESERVATION_CHANNEL_LABEL) as ReservationChannel[]).map((c) => (
                <option key={c} value={c} className="bg-popover text-popover-foreground">
                  {RESERVATION_CHANNEL_LABEL[c]}
                </option>
              ))}
            </select>
          </label>
          <Input label="Cliente" value={name} onChange={(e) => setName(e.target.value)} maxLength={120} />
          <Input label="Celular (opcional)" inputMode="tel" value={phone} onChange={(e) => setPhone(e.target.value)} maxLength={40} />
          <Input
            label="DNI o CUIT (opcional, valida el retiro)"
            inputMode="numeric"
            value={doc}
            onChange={(e) => setDoc(e.target.value)}
            maxLength={13}
          />
          <label className="text-sm">
            <span className="mb-1 block font-medium">Vence en</span>
            <select className={selectCls} value={hours} onChange={(e) => setHours(Number(e.target.value))}>
              {HOURS.map((h) => (
                <option key={h.value} value={h.value} className="bg-popover text-popover-foreground">
                  {h.label}
                </option>
              ))}
            </select>
          </label>
        </div>
        <Input label="Nota (opcional)" value={notes} onChange={(e) => setNotes(e.target.value)} maxLength={500} />
        {otherStore && (
          <p className="text-xs text-muted-foreground">
            Reservás stock de otra sucursal: el cliente retira y paga allá.
          </p>
        )}

        <ProductSearchCombobox
          enabled={open}
          storeId={storeId}
          filter={reservable}
          rejectMessage={(p) => `${p.name} no se reserva (kit o sin control de stock)`}
          emptyHint="Los kits y los productos sin control de stock no se reservan."
          placeholder="Buscar producto por nombre, SKU, EAN o PLU"
          onPick={(p, v) => addLine(p, v)}
        />

        {lines.length > 0 && (
          <ul className="divide-y divide-border">
            {lines.map((l) => {
              const a = availableOf(l);
              const short = l.qty > a;
              return (
                <li key={l.key} className="flex items-center gap-2 py-2">
                  <div className="min-w-0 flex-1">
                    <p className="truncate text-sm font-medium">{l.name}</p>
                    <p className={cn("text-xs", short ? "text-danger" : "text-muted-foreground")}>
                      Disponible para reservar: {formatQty(a)}
                    </p>
                  </div>
                  <Button size="icon" variant="ghost" aria-label="Menos" onClick={() => setQty(l.key, l.qty - 1)}>
                    <Minus size={16} />
                  </Button>
                  <input
                    aria-label={`Cantidad de ${l.name}`}
                    inputMode="decimal"
                    className="h-11 w-16 rounded-lg border border-input bg-background text-center text-sm tabular-nums"
                    value={l.qty}
                    onChange={(e) => setQty(l.key, Number(e.target.value.replace(",", ".")) || 0)}
                  />
                  <Button size="icon" variant="ghost" aria-label="Más" onClick={() => setQty(l.key, l.qty + 1)}>
                    <Plus size={16} />
                  </Button>
                  <Button
                    size="icon"
                    variant="ghost"
                    aria-label="Quitar"
                    onClick={() => setLines((prev) => prev.filter((x) => x.key !== l.key))}
                  >
                    <Trash2 size={16} />
                  </Button>
                </li>
              );
            })}
          </ul>
        )}

        {lines.length > 0 && errors.length > 0 && (
          <ul className="space-y-1 text-xs text-danger">
            {errors.map((e) => (
              <li key={e}>{e}</li>
            ))}
          </ul>
        )}
      </div>
    </Modal>
  );
}
