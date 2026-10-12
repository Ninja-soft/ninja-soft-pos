"use client";

import { useEffect, useMemo, useState } from "react";
import { ArrowRight, Lightbulb } from "lucide-react";
import { Modal } from "@/components/ui/Modal";
import { Button } from "@/components/ui/Button";
import { SpinnerBlock } from "@/components/ui/Spinner";
import { useToast } from "@/components/ui/Toast";
import { formatQty } from "@/lib/utils/format";
import {
  groupSuggestions,
  parseStockKey,
  stockKey,
  suggestTransfers,
  type StockCell,
} from "@/lib/stock/suggest";
import { localDate, transferErrorMessage } from "@/lib/stock/transfers";
import type { StoreRef } from "@/lib/stock/byStore";
import {
  useLowStockByStore,
  useTransferMutations,
} from "@/modules/stock/hooks";
import { selectCls, storeName } from "./shared";

// "Sugerir traslados" (F17 · H94/H95): con las sucursales bajo su mínimo y las
// que tienen sobrante, propone traslados y los crea como borradores.
export function TransferSuggestModal({
  open,
  onOpenChange,
  stores,
}: {
  open: boolean;
  onOpenChange: (o: boolean) => void;
  stores: StoreRef[];
}) {
  const { toast } = useToast();
  const { data: low, isLoading } = useLowStockByStore(open);
  const m = useTransferMutations();
  const [dest, setDest] = useState<string>("");
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [busy, setBusy] = useState(false);

  const meta = useMemo(() => {
    const map = new Map<
      string,
      { name: string; variant: string | null; unit: string }
    >();
    for (const r of low ?? []) {
      map.set(stockKey(r.product_id, r.variant_id), {
        name: r.product_name,
        variant: r.variant_label,
        unit: r.unit,
      });
    }
    return map;
  }, [low]);

  const groups = useMemo(() => {
    const cells: StockCell[] = (low ?? []).map((r) => ({
      key: stockKey(r.product_id, r.variant_id),
      storeId: r.store_id,
      qty: r.qty,
      min: r.min_qty,
      max: r.max_qty,
      inTransitIn: r.in_transit_in,
    }));
    return groupSuggestions(
      suggestTransfers(cells, {
        destStoreId: dest || null,
        isInteger: (k) => (meta.get(k)?.unit ?? "un") === "un",
      }),
    );
  }, [low, dest, meta]);

  const groupId = (g: { fromStoreId: string; toStoreId: string }) =>
    `${g.fromStoreId}>${g.toStoreId}`;

  useEffect(() => {
    setSelected(new Set(groups.map(groupId)));
  }, [groups]);

  async function create() {
    const chosen = groups.filter((g) => selected.has(groupId(g)));
    if (chosen.length === 0) return;
    setBusy(true);
    let ok = 0;
    try {
      for (const g of chosen) {
        await m.save.mutateAsync({
          origin_store_id: g.fromStoreId,
          dest_store_id: g.toStoreId,
          scheduled_for: localDate(),
          notes: "Sugerido por stock bajo",
          items: g.lines.map((l) => {
            const { productId, variantId } = parseStockKey(l.key);
            return { product_id: productId, variant_id: variantId, qty: l.qty };
          }),
        });
        ok++;
      }
      toast({
        title:
          ok === 1
            ? "Se creó 1 borrador de traslado"
            : `Se crearon ${ok} borradores de traslado`,
        description: "Revisalos y confirmalos desde la lista.",
        variant: "success",
      });
      onOpenChange(false);
    } catch (e) {
      toast({
        title: "No se pudieron crear todos",
        description: transferErrorMessage(e),
        variant: "error",
      });
    } finally {
      setBusy(false);
    }
  }

  return (
    <Modal
      open={open}
      onOpenChange={onOpenChange}
      title="Sugerir traslados"
      description="Repone las sucursales bajo su mínimo desde las que tienen de más, sin dejarlas bajo su propio mínimo."
      className="sm:max-w-2xl"
      footer={
        <div className="flex justify-end gap-2">
          <Button variant="secondary" onClick={() => onOpenChange(false)}>
            Cerrar
          </Button>
          <Button
            onClick={create}
            loading={busy}
            disabled={selected.size === 0}
          >
            Crear borradores ({selected.size})
          </Button>
        </div>
      }
    >
      <div className="space-y-4">
        <div>
          <label className="mb-2 block text-sm font-medium text-muted-foreground">
            Reponer
          </label>
          <select
            className={selectCls}
            value={dest}
            onChange={(e) => setDest(e.target.value)}
          >
            <option value="" className="bg-popover text-popover-foreground">
              Todas las sucursales
            </option>
            {stores.map((s) => (
              <option
                key={s.id}
                value={s.id}
                className="bg-popover text-popover-foreground"
              >
                {s.name}
              </option>
            ))}
          </select>
        </div>
        {isLoading ? (
          <SpinnerBlock className="py-8" />
        ) : groups.length === 0 ? (
          <div className="rounded-xl bg-muted p-6 text-center text-sm text-muted-foreground">
            <Lightbulb
              className="mx-auto mb-2 text-ninja-flameSoft"
              size={22}
            />
            No hay faltantes que se puedan cubrir con otra sucursal. Cargá el
            mínimo por sucursal en la ficha del producto para que aparezcan
            sugerencias.
          </div>
        ) : (
          groups.map((g) => {
            const id = groupId(g);
            return (
              <div key={id} className="rounded-xl ring-1 ring-border">
                <label className="flex cursor-pointer items-center gap-3 border-b border-border px-3 py-2.5">
                  <input
                    type="checkbox"
                    checked={selected.has(id)}
                    onChange={(e) =>
                      setSelected((s) => {
                        const n = new Set(s);
                        if (e.target.checked) n.add(id);
                        else n.delete(id);
                        return n;
                      })
                    }
                    className="h-4 w-4 accent-[#ec3f17]"
                  />
                  <span className="flex items-center gap-2 text-sm font-medium">
                    {storeName(stores, g.fromStoreId)} <ArrowRight size={14} />{" "}
                    {storeName(stores, g.toStoreId)}
                  </span>
                  <span className="ml-auto text-xs text-muted-foreground">
                    {g.lines.length}{" "}
                    {g.lines.length === 1 ? "producto" : "productos"}
                  </span>
                </label>
                <ul className="divide-y divide-border">
                  {g.lines.map((l) => {
                    const info = meta.get(l.key);
                    return (
                      <li
                        key={l.key}
                        className="flex items-center justify-between gap-3 px-3 py-2 text-sm"
                      >
                        <span className="min-w-0 truncate">
                          {info?.name}
                          {info?.variant && (
                            <span className="text-muted-foreground">
                              {" "}
                              · {info.variant}
                            </span>
                          )}
                        </span>
                        <span className="font-mono tabular-nums">
                          {formatQty(l.qty)} {info?.unit}
                        </span>
                      </li>
                    );
                  })}
                </ul>
              </div>
            );
          })
        )}
      </div>
    </Modal>
  );
}
