"use client";

import { useEffect, useMemo, useState } from "react";
import { Minus, Plus, Search, Trash2 } from "lucide-react";
import { Modal } from "@/components/ui/Modal";
import { Button } from "@/components/ui/Button";
import { Input } from "@/components/ui/Input";
import { Checkbox } from "@/components/ui/Checkbox";
import { useToast } from "@/components/ui/Toast";
import { cn } from "@/lib/utils/cn";
import { formatQty } from "@/lib/utils/format";
import { stockKey } from "@/lib/stock/suggest";
import {
  MOVE_REASON_LABEL,
  WAREHOUSE_KIND_LABEL,
  qtyIn,
  warehouseErrorMessage,
  type Warehouse,
  type WarehouseMoveReason,
  type WarehouseOverviewRow,
} from "@/lib/stock/warehouses";
import { variantsApi, variantLabel, type Product, type ProductVariant } from "@/modules/products/api";
import { useProducts } from "@/modules/products/hooks";
import { useWarehouseMutations } from "@/modules/stock/warehouses";
import { selectCls } from "@/components/stock/transfers/shared";

export interface MoveLine {
  key: string;
  product_id: string;
  variant_id: string | null;
  name: string;
  qty: number;
}

export interface MoveInitial {
  origin?: string;
  dest?: string;
  reason?: WarehouseMoveReason;
  lines?: MoveLine[];
  receiveNow?: boolean;
}

// Movimiento interno entre depósitos de la misma sucursal (F11 · H33). Con
// "Recibir ahora" llega al destino en el acto (reponer el salón); sin eso
// queda en tránsito y se recibe después, con control de diferencias.
export function WarehouseMoveModal({
  open,
  onOpenChange,
  warehouses,
  overview,
  initial,
}: {
  open: boolean;
  onOpenChange: (o: boolean) => void;
  warehouses: Warehouse[];
  overview: WarehouseOverviewRow[];
  initial?: MoveInitial | null;
}) {
  const { toast } = useToast();
  const m = useWarehouseMutations();
  const [origin, setOrigin] = useState("");
  const [dest, setDest] = useState("");
  const [reason, setReason] = useState<WarehouseMoveReason>("reposicion");
  const [notes, setNotes] = useState("");
  const [receiveNow, setReceiveNow] = useState(true);
  const [lines, setLines] = useState<MoveLine[]>([]);
  const [search, setSearch] = useState("");
  const [variantsOf, setVariantsOf] = useState<{ product: Product; variants: ProductVariant[] } | null>(null);

  useEffect(() => {
    if (!open) return;
    const principal = warehouses.find((w) => w.kind === "principal");
    const other = warehouses.find((w) => w.kind !== "principal");
    setOrigin(initial?.origin ?? other?.id ?? "");
    setDest(initial?.dest ?? principal?.id ?? "");
    setReason(initial?.reason ?? "reposicion");
    setReceiveNow(initial?.receiveNow ?? true);
    setLines(initial?.lines ?? []);
    setNotes("");
    setSearch("");
    setVariantsOf(null);
  }, [open, initial, warehouses]);

  const { data: found = [] } = useProducts(open ? search : "");
  const results = useMemo(
    () => (search.trim().length >= 2 ? found.filter((p) => p.track_stock !== false && !p.is_kit).slice(0, 8) : []),
    [found, search],
  );

  const originWh = warehouses.find((w) => w.id === origin);
  const available = (l: MoveLine) => {
    const row = overview.find((r) => r.product_id === l.product_id && (r.variant_id ?? null) === l.variant_id);
    return row && originWh ? qtyIn(row, originWh) : 0;
  };

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

  async function pick(p: Product) {
    if (p.has_variants) {
      setVariantsOf({ product: p, variants: await variantsApi.list(p.id) });
      return;
    }
    addLine(p);
    setSearch("");
  }

  function setQty(key: string, qty: number) {
    setLines((prev) => prev.map((l) => (l.key === key ? { ...l, qty: Math.max(0, qty) } : l)));
  }

  const valid = origin && dest && origin !== dest && lines.length > 0 && lines.every((l) => l.qty > 0);

  async function submit() {
    try {
      await m.createMove.mutateAsync({
        origin,
        dest,
        reason,
        notes: notes.trim() || null,
        receiveNow,
        items: lines.map((l) => ({ product_id: l.product_id, variant_id: l.variant_id, qty: l.qty })),
      });
      toast({ title: receiveNow ? "Movimiento hecho" : "Movimiento en tránsito", variant: "success" });
      onOpenChange(false);
    } catch (e) {
      toast({ title: "No se pudo mover", description: warehouseErrorMessage(e), variant: "error" });
    }
  }

  const whOption = (w: Warehouse) => (
    <option key={w.id} value={w.id} className="bg-popover text-popover-foreground">
      {w.name}
      {w.kind !== "principal" ? ` · ${WAREHOUSE_KIND_LABEL[w.kind]}` : ""}
    </option>
  );

  return (
    <Modal
      open={open}
      onOpenChange={onOpenChange}
      title="Mover entre depósitos"
      description="Dentro de la sucursal. Entre sucursales se usa un traslado."
      className="sm:max-w-2xl"
      footer={
        <>
          <Button variant="secondary" onClick={() => onOpenChange(false)}>
            Cancelar
          </Button>
          <Button onClick={submit} disabled={!valid} loading={m.createMove.isPending}>
            {receiveNow ? "Mover ahora" : "Enviar"}
          </Button>
        </>
      }
    >
      <div className="space-y-4">
        <div className="grid gap-3 sm:grid-cols-2">
          <label className="text-sm">
            <span className="mb-1 block font-medium">Desde</span>
            <select className={selectCls} value={origin} onChange={(e) => setOrigin(e.target.value)}>
              {warehouses.map(whOption)}
            </select>
          </label>
          <label className="text-sm">
            <span className="mb-1 block font-medium">Hacia</span>
            <select className={selectCls} value={dest} onChange={(e) => setDest(e.target.value)}>
              {warehouses.filter((w) => w.id !== origin).map(whOption)}
            </select>
          </label>
          <label className="text-sm">
            <span className="mb-1 block font-medium">Motivo</span>
            <select
              className={selectCls}
              value={reason}
              onChange={(e) => setReason(e.target.value as WarehouseMoveReason)}
            >
              {(Object.keys(MOVE_REASON_LABEL) as WarehouseMoveReason[]).map((r) => (
                <option key={r} value={r} className="bg-popover text-popover-foreground">
                  {MOVE_REASON_LABEL[r]}
                </option>
              ))}
            </select>
          </label>
          <Input label="Nota (opcional)" value={notes} onChange={(e) => setNotes(e.target.value)} maxLength={500} />
        </div>

        <label className="flex min-h-11 items-center gap-3 text-sm">
          <Checkbox checked={receiveNow} onCheckedChange={setReceiveNow} />
          <span>
            Recibir ahora
            <span className="block text-xs text-muted-foreground">
              Destildalo si la mercadería tarda en llegar: queda en tránsito hasta que alguien la reciba.
            </span>
          </span>
        </label>

        <div>
          <div className="relative">
            <Search size={16} className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-muted-foreground" />
            <Input
              placeholder="Buscar producto por nombre, SKU o código"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              className="pl-9"
            />
          </div>
          {variantsOf ? (
            <div className="mt-2 space-y-1">
              <p className="text-xs text-muted-foreground">Elegí la variante de {variantsOf.product.name}</p>
              <div className="flex flex-wrap gap-2">
                {variantsOf.variants.map((v) => (
                  <Button
                    key={v.id}
                    size="sm"
                    variant="secondary"
                    onClick={() => {
                      addLine(variantsOf.product, v);
                      setVariantsOf(null);
                      setSearch("");
                    }}
                  >
                    {variantLabel(v)}
                  </Button>
                ))}
              </div>
            </div>
          ) : (
            results.length > 0 && (
              <ul className="mt-2 divide-y divide-border rounded-lg border border-border">
                {results.map((p) => (
                  <li key={p.id}>
                    <button
                      type="button"
                      onClick={() => void pick(p)}
                      className="flex min-h-11 w-full items-center justify-between px-3 text-left text-sm hover:bg-muted/50"
                    >
                      <span className="truncate">{p.name}</span>
                      <span className="text-xs text-muted-foreground">{p.sku}</span>
                    </button>
                  </li>
                ))}
              </ul>
            )
          )}
        </div>

        {lines.length > 0 && (
          <ul className="divide-y divide-border">
            {lines.map((l) => {
              const avail = available(l);
              const short = l.qty > avail;
              return (
                <li key={l.key} className="flex items-center gap-2 py-2">
                  <div className="min-w-0 flex-1">
                    <p className="truncate text-sm font-medium">{l.name}</p>
                    <p className={cn("text-xs", short ? "text-danger" : "text-muted-foreground")}>
                      Disponible en origen: {formatQty(avail)}
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
      </div>
    </Modal>
  );
}
