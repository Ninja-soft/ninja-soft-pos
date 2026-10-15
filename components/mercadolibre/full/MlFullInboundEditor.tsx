"use client";

import { useEffect, useMemo, useState } from "react";
import { Plus, Trash2 } from "lucide-react";
import { Button } from "@/components/ui/Button";
import { Callout } from "@/components/ui/Callout";
import { Input } from "@/components/ui/Input";
import { Modal } from "@/components/ui/Modal";
import { useToast } from "@/components/ui/Toast";
import { selectCls } from "@/components/stock/transfers/shared";
import { formatInt } from "@/lib/utils/format";
import { fullErrorMessage, isValidMlInboundId } from "@/lib/mercadolibre/full";
import { useStores } from "@/modules/stock/hooks";
import { useWarehouses } from "@/modules/stock/warehouses";
import { useMlFullMutations, type MlFullInbound, type MlFullRow } from "@/modules/mercadolibre/fullHooks";

export interface DraftLine {
  product_id: string;
  variant_id: string | null;
  qty: number;
}

const key = (p: string, v: string | null) => `${p}:${v ?? ""}`;

/** Alta o edición de un envío a Full en borrador (ADR-142). */
export function MlFullInboundEditor({
  open,
  onOpenChange,
  accountId,
  rows,
  defaultStoreId,
  inbound,
  initial,
  onSaved,
}: {
  open: boolean;
  onOpenChange: (o: boolean) => void;
  accountId: string;
  /** Filas del depósito Full (sólo las vinculadas se pueden mandar). */
  rows: MlFullRow[];
  defaultStoreId: string | null;
  inbound?: MlFullInbound | null;
  initial?: DraftLine[];
  onSaved?: (id: string) => void;
}) {
  const { toast } = useToast();
  const { data: stores = [] } = useStores();
  const { saveInbound } = useMlFullMutations();
  const [storeId, setStoreId] = useState<string>("");
  const [warehouseId, setWarehouseId] = useState<string>("");
  const [mlId, setMlId] = useState("");
  const [boxes, setBoxes] = useState(1);
  const [date, setDate] = useState("");
  const [notes, setNotes] = useState("");
  const [lines, setLines] = useState<DraftLine[]>([]);
  const [pick, setPick] = useState("");
  const { data: warehouses = [] } = useWarehouses(storeId || null);

  useEffect(() => {
    if (!open) return;
    setStoreId(inbound?.store_id ?? defaultStoreId ?? stores[0]?.id ?? "");
    setWarehouseId(inbound?.warehouse_id ?? "");
    setMlId(inbound?.ml_inbound_id ?? "");
    setBoxes(inbound?.boxes ?? 1);
    setDate(inbound?.scheduled_for ?? "");
    setNotes(inbound?.notes ?? "");
    setLines(
      inbound
        ? inbound.items.map((i) => ({ product_id: i.product_id, variant_id: i.variant_id, qty: i.qty_sent }))
        : (initial ?? []),
    );
    setPick("");
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, inbound?.id]);

  const linked = useMemo(() => rows.filter((r) => r.product_id), [rows]);
  const byKey = useMemo(() => new Map(linked.map((r) => [key(r.product_id!, r.variant_id), r])), [linked]);
  const available = linked.filter((r) => !lines.some((l) => key(l.product_id, l.variant_id) === key(r.product_id!, r.variant_id)));
  const units = lines.reduce((a, l) => a + (Number.isFinite(l.qty) ? l.qty : 0), 0);
  const badQty = lines.some((l) => !Number.isInteger(l.qty) || l.qty < 1 || l.qty > 99999);
  const badMl = mlId.trim() !== "" && !isValidMlInboundId(mlId);
  const canSave = Boolean(storeId) && lines.length > 0 && !badQty && !badMl && !saveInbound.isPending;

  const add = () => {
    const r = linked.find((x) => key(x.product_id!, x.variant_id) === pick);
    if (!r) return;
    setLines((ls) => [...ls, { product_id: r.product_id!, variant_id: r.variant_id, qty: 1 }]);
    setPick("");
  };

  const save = () => {
    saveInbound.mutate(
      {
        id: inbound?.id ?? null,
        input: {
          account_id: accountId,
          store_id: storeId,
          warehouse_id: warehouseId || null,
          ml_inbound_id: mlId.trim() || null,
          boxes,
          scheduled_for: date || null,
          notes: notes.trim() || null,
          items: lines,
        },
      },
      {
        onSuccess: (id) => {
          toast({ title: inbound ? "Envío actualizado" : "Envío a Full creado", description: "Queda en borrador hasta que lo despaches.", variant: "success" });
          onOpenChange(false);
          onSaved?.(id);
        },
        onError: (e) => toast({ title: "No se pudo guardar el envío", description: fullErrorMessage(e), variant: "error" }),
      },
    );
  };

  return (
    <Modal
      open={open}
      onOpenChange={onOpenChange}
      title={inbound ? `Envío a Full N° ${inbound.number}` : "Nuevo envío a Full"}
      description="Elegí de dónde sale la mercadería y qué mandás. Sólo se pueden agregar productos vinculados a una publicación con Full."
      footer={
        <div className="flex w-full flex-col-reverse gap-2 sm:flex-row sm:justify-end">
          <Button variant="secondary" onClick={() => onOpenChange(false)}>
            Cancelar
          </Button>
          <Button onClick={save} disabled={!canSave} loading={saveInbound.isPending}>
            Guardar borrador
          </Button>
        </div>
      }
    >
      <div className="space-y-4">
        <div className="grid gap-3 sm:grid-cols-2">
          <label className="space-y-1 text-sm">
            <span className="font-medium">Sale de la sucursal</span>
            <select className={selectCls} value={storeId} onChange={(e) => { setStoreId(e.target.value); setWarehouseId(""); }} aria-label="Sucursal de origen">
              {stores.map((s) => (
                <option key={s.id} value={s.id}>
                  {s.name}
                </option>
              ))}
            </select>
          </label>
          <label className="space-y-1 text-sm">
            <span className="font-medium">Depósito</span>
            <select className={selectCls} value={warehouseId} onChange={(e) => setWarehouseId(e.target.value)} aria-label="Depósito de origen">
              <option value="">Stock de la sucursal</option>
              {warehouses
                .filter((w) => w.kind !== "principal" && w.kind !== "merma" && w.kind !== "devolucion")
                .map((w) => (
                  <option key={w.id} value={w.id}>
                    {w.name}
                  </option>
                ))}
            </select>
          </label>
          <Input
            label="Número del envío en Mercado Libre"
            value={mlId}
            onChange={(e) => setMlId(e.target.value)}
            placeholder="Lo cargás cuando lo crees en ML"
            error={badMl ? "Letras, números o guiones" : undefined}
            hint="Hace falta para despachar y para conciliar lo recibido."
          />
          <Input
            label="Bultos"
            type="number"
            min={1}
            max={999}
            inputMode="numeric"
            value={boxes}
            onChange={(e) => setBoxes(Math.min(999, Math.max(1, Math.floor(Number(e.target.value) || 1))))}
          />
          <Input label="Fecha de entrega o colecta" type="date" value={date} onChange={(e) => setDate(e.target.value)} />
          <Input label="Notas" value={notes} maxLength={1000} onChange={(e) => setNotes(e.target.value)} />
        </div>

        <div className="space-y-2">
          <p className="text-sm font-medium">Productos</p>
          {linked.length === 0 ? (
            <Callout tone="warning" title="No hay productos habilitados para Full">
              Vinculá tus publicaciones con Full a tus productos y sincronizá el stock de Full.
            </Callout>
          ) : (
            <div className="flex flex-col gap-2 sm:flex-row">
              <select className={selectCls} value={pick} onChange={(e) => setPick(e.target.value)} aria-label="Producto para agregar">
                <option value="">Elegí un producto con Full…</option>
                {available.map((r) => (
                  <option key={r.id} value={key(r.product_id!, r.variant_id)}>
                    {r.product_name ?? r.title}
                    {r.variation_label ? ` · ${r.variation_label}` : ""} ({r.inventory_id})
                  </option>
                ))}
              </select>
              <Button variant="secondary" onClick={add} disabled={!pick}>
                <Plus size={15} /> Agregar
              </Button>
            </div>
          )}
          <ul className="divide-y divide-border rounded-xl bg-card">
            {lines.map((l, i) => {
              const r = byKey.get(key(l.product_id, l.variant_id));
              return (
                <li key={key(l.product_id, l.variant_id)} className="flex items-center gap-2 px-3 py-2.5">
                  <div className="min-w-0 flex-1">
                    <p className="truncate text-sm font-medium">{r?.product_name ?? r?.title ?? "Producto"}</p>
                    <p className="text-xs text-muted-foreground">
                      {r?.inventory_id ?? "Sin código de inventario"}
                      {r?.own_qty !== null && r?.own_qty !== undefined ? ` · propio ${formatInt(r.own_qty)}` : ""}
                      {r ? ` · en Full ${formatInt(r.available)}` : ""}
                    </p>
                  </div>
                  <input
                    type="number"
                    inputMode="numeric"
                    min={1}
                    className="h-10 w-20 rounded-lg border border-input bg-background px-2 text-right text-sm tabular-nums"
                    value={l.qty}
                    aria-label={`Cantidad de ${r?.title ?? "producto"}`}
                    onChange={(e) => {
                      const qty = Math.floor(Number(e.target.value));
                      setLines((ls) => ls.map((x, j) => (j === i ? { ...x, qty: Number.isFinite(qty) ? qty : 0 } : x)));
                    }}
                  />
                  <Button variant="ghost" size="icon" aria-label="Quitar" onClick={() => setLines((ls) => ls.filter((_, j) => j !== i))}>
                    <Trash2 size={16} />
                  </Button>
                </li>
              );
            })}
          </ul>
          <p className="text-xs text-muted-foreground">
            {lines.length} {lines.length === 1 ? "producto" : "productos"} · {formatInt(units)} unidades. El stock se valida y se
            descuenta recién al despachar.
          </p>
          {badQty && <p className="text-xs text-danger">Las cantidades tienen que ser enteras y mayores a cero.</p>}
        </div>
      </div>
    </Modal>
  );
}
