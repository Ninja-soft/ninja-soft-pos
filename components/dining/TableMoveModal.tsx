"use client";

import { useEffect, useMemo, useState } from "react";
import { ArrowRightLeft, Merge } from "lucide-react";
import { Modal } from "@/components/ui/Modal";
import { Button } from "@/components/ui/Button";
import { Segmented } from "@/components/ui/Segmented";
import { Checkbox } from "@/components/ui/Checkbox";
import { useToast } from "@/components/ui/Toast";
import { useDiningAreas, useDiningTables, useTableOrderMutations } from "@/modules/dining/hooks";
import type { DiningTable, TableOrderItem } from "@/modules/dining/api";
import { diningErrorMessage, moveTargets } from "@/lib/gastro/tableOps";
import { formatQty } from "@/lib/utils/format";
import { cn } from "@/lib/utils/cn";

type Scope = "all" | "some";

// Mover / unir / transferir (F13 · H44). "Toda la mesa": a una mesa libre se
// muda el pedido; a una ocupada se unen las cuentas. "Algunos ítems": las líneas
// elegidas pasan a la mesa destino (si está libre, se abre). Todo audita en el
// servidor. Pensado para el celular del mozo: tiles grandes, una sola columna
// de ítems y acción fija abajo.
export function TableMoveModal({
  open,
  onOpenChange,
  table,
  items,
  onDone,
}: {
  open: boolean;
  onOpenChange: (o: boolean) => void;
  table: DiningTable | null;
  items: TableOrderItem[];
  onDone: () => void;
}) {
  const { toast } = useToast();
  const { data: tables } = useDiningTables();
  const { data: areas } = useDiningAreas();
  const { move, transferItems } = useTableOrderMutations();
  const [scope, setScope] = useState<Scope>("all");
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [targetId, setTargetId] = useState<string | null>(null);

  useEffect(() => {
    if (open) {
      setScope("all");
      setSelected(new Set());
      setTargetId(null);
    }
  }, [open]);

  const targets = useMemo(
    () => (table ? moveTargets(tables ?? [], table.id) : []),
    [tables, table],
  );
  const target = targets.find((t) => t.table.id === targetId) ?? null;
  const areaName = (id: string | null) => (id ? areas?.find((a) => a.id === id)?.name ?? null : null);

  const pending = move.isPending || transferItems.isPending;
  const canSubmit =
    Boolean(table?.current_order_id) &&
    target !== null &&
    (scope === "all" || selected.size > 0);

  function toggle(id: string) {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  async function submit() {
    if (!table?.current_order_id || !target) return;
    try {
      if (scope === "all") {
        const r = await move.mutateAsync({
          orderId: table.current_order_id,
          targetTableId: target.table.id,
        });
        toast({
          title:
            r.mode === "merged"
              ? `Mesa ${table.label} unida a la mesa ${target.table.label}`
              : `Pedido movido a la mesa ${target.table.label}`,
          variant: "success",
        });
      } else {
        const r = await transferItems.mutateAsync({
          itemIds: [...selected],
          targetTableId: target.table.id,
        });
        toast({
          title: `${r.items_moved} ítem${r.items_moved === 1 ? "" : "s"} a la mesa ${target.table.label}`,
          variant: "success",
        });
      }
      onOpenChange(false);
      onDone();
    } catch (e) {
      toast({ title: "No se pudo mover", description: diningErrorMessage(e), variant: "error" });
    }
  }

  const actionLabel = !target
    ? "Elegí la mesa destino"
    : scope === "some"
      ? `Pasar ${selected.size} a la mesa ${target.table.label}`
      : target.mode === "unir"
        ? `Unir con la mesa ${target.table.label}`
        : `Mover a la mesa ${target.table.label}`;

  return (
    <Modal
      open={open}
      onOpenChange={onOpenChange}
      title={table ? `Mover mesa ${table.label}` : "Mover mesa"}
      description="Mové el pedido, uní cuentas o pasá algunos ítems a otra mesa."
    >
      <div className="space-y-4">
        <Segmented<Scope>
          value={scope}
          onChange={setScope}
          fill
          aria-label="Qué mover"
          options={[
            { value: "all", label: "Toda la mesa" },
            { value: "some", label: "Algunos ítems" },
          ]}
        />

        {scope === "some" && (
          <div className="max-h-[30vh] space-y-1 overflow-y-auto">
            {items.length === 0 ? (
              <p className="text-sm text-muted-foreground">La mesa no tiene ítems.</p>
            ) : (
              items.map((it) => (
                <label
                  key={it.id}
                  className="flex min-h-11 cursor-pointer items-center gap-3 rounded-md px-2 py-1.5 hover:bg-muted/50"
                >
                  <Checkbox checked={selected.has(it.id)} onCheckedChange={() => toggle(it.id)} />
                  <span className="w-8 text-sm font-semibold tabular-nums">{formatQty(it.qty)}×</span>
                  <span className="min-w-0 flex-1 truncate text-sm">{it.name}</span>
                </label>
              ))
            )}
          </div>
        )}

        <div>
          <p className="mb-2 text-xs font-medium uppercase tracking-wide text-muted-foreground">
            Mesa destino
          </p>
          {targets.length === 0 ? (
            <p className="text-sm text-muted-foreground">No hay otras mesas disponibles.</p>
          ) : (
            <div className="grid max-h-[34vh] grid-cols-3 gap-2 overflow-y-auto sm:grid-cols-4">
              {targets.map(({ table: t, mode }) => {
                const active = t.id === targetId;
                return (
                  <button
                    key={t.id}
                    type="button"
                    onClick={() => setTargetId(t.id)}
                    aria-pressed={active}
                    className={cn(
                      "flex min-h-16 flex-col items-start justify-between rounded-md border px-2.5 py-2 text-left transition",
                      active
                        ? "border-foreground bg-muted"
                        : "border-border bg-card hover:bg-muted/50",
                    )}
                  >
                    <span className="text-base font-bold">{t.label}</span>
                    <span className="flex items-center gap-1 text-[11px] text-muted-foreground">
                      <span
                        className={cn(
                          "h-1.5 w-1.5 rounded-full",
                          mode === "unir" ? "bg-amber-400" : "bg-ninja-flame",
                        )}
                      />
                      {mode === "unir" ? "Unir" : "Libre"}
                      {areaName(t.area_id) ? ` · ${areaName(t.area_id)}` : ""}
                    </span>
                  </button>
                );
              })}
            </div>
          )}
        </div>

        <Button onClick={submit} disabled={!canSubmit || pending} loading={pending} className="w-full">
          {target?.mode === "unir" && scope === "all" ? <Merge size={16} /> : <ArrowRightLeft size={16} />}
          {actionLabel}
        </Button>
      </div>
    </Modal>
  );
}
