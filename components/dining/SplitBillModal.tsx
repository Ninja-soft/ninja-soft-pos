"use client";

import { useEffect, useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import { CreditCard, Minus, Plus, Undo2, Users } from "lucide-react";
import { Modal } from "@/components/ui/Modal";
import { Button } from "@/components/ui/Button";
import { Segmented } from "@/components/ui/Segmented";
import { useToast } from "@/components/ui/Toast";
import { useTableOrderMutations, useTableSplits } from "@/modules/dining/hooks";
import type { TableOrderItem } from "@/modules/dining/api";
import {
  MAX_DINERS,
  dinerLabel,
  dinerLines,
  dinerSummary,
  equalShareLines,
  linesTotal,
  nextEqualPart,
  partLabel,
} from "@/lib/gastro/splitBill";
import { diningErrorMessage } from "@/lib/gastro/tableOps";
import { formatCurrency, formatQty } from "@/lib/utils/format";
import { cn } from "@/lib/utils/cn";

type Mode = "comensal" | "iguales";

// Ticket separado por comensal (F13 · H44, ADR-097). Cada cuenta separada es un
// pedido hijo que se cobra en el POS como una venta propia con sus ítems; la
// mesa sigue ocupada hasta cobrar lo último. Pensado para el celular del mozo:
// chips grandes para asignar cada plato y un botón de cobro por comensal.
export function SplitBillModal({
  open,
  onOpenChange,
  orderId,
  tableLabel,
  items,
}: {
  open: boolean;
  onOpenChange: (o: boolean) => void;
  orderId: string | null;
  tableLabel: string | null;
  items: TableOrderItem[];
}) {
  const router = useRouter();
  const { toast } = useToast();
  const { setItemsDiner, split } = useTableOrderMutations();
  const { data: splits } = useTableSplits(open ? orderId : null);
  const [mode, setMode] = useState<Mode>("comensal");
  const maxAssigned = useMemo(() => Math.max(0, ...items.map((i) => i.diner ?? 0)), [items]);
  const [diners, setDiners] = useState(2);
  const [parts, setParts] = useState(2);

  useEffect(() => {
    if (open) setDiners((d) => Math.min(MAX_DINERS, Math.max(d, maxAssigned, 2)));
  }, [open, maxAssigned]);

  const summary = useMemo(() => dinerSummary(items), [items]);
  const equal = useMemo(() => nextEqualPart(splits ?? [], parts), [splits, parts]);
  const equalLines = useMemo(() => equalShareLines(items, equal.remaining), [items, equal.remaining]);
  const equalAmount = useMemo(() => linesTotal(items, equalLines), [items, equalLines]);
  const runStarted = equal.part > 1;

  async function assign(item: TableOrderItem, diner: number | null) {
    if (item.diner === diner) return;
    try {
      await setItemsDiner.mutateAsync({ itemIds: [item.id], diner });
    } catch (e) {
      toast({ title: "No se pudo asignar", description: diningErrorMessage(e), variant: "error" });
    }
  }

  async function charge(lines: { item_id: string; qty: number | null }[], label: string) {
    if (!orderId || lines.length === 0) return;
    try {
      const r = await split.mutateAsync({ orderId, lines, label });
      onOpenChange(false);
      router.push(`/pos?table=${r.order_id}`);
    } catch (e) {
      toast({ title: "No se pudo separar la cuenta", description: diningErrorMessage(e), variant: "error" });
    }
  }

  return (
    <Modal
      open={open}
      onOpenChange={onOpenChange}
      title={tableLabel ? `Separar cuenta · Mesa ${tableLabel}` : "Separar cuenta"}
      description="Cada parte se cobra como un ticket propio. La mesa queda abierta hasta cobrar lo último."
    >
      <div className="space-y-4">
        <Segmented<Mode>
          value={mode}
          onChange={setMode}
          fill
          aria-label="Cómo separar"
          options={[
            { value: "comensal", label: "Por comensal" },
            { value: "iguales", label: "Partes iguales" },
          ]}
        />

        {items.length === 0 ? (
          <p className="rounded-md border border-dashed border-border p-4 text-center text-sm text-muted-foreground">
            No queda nada por cobrar en la cuenta de la mesa.
          </p>
        ) : mode === "comensal" ? (
          <>
            <div className="flex items-center justify-between gap-3">
              <span className="flex items-center gap-1.5 text-sm font-medium">
                <Users size={15} /> Comensales
              </span>
              <div className="flex items-center gap-1">
                <button
                  type="button"
                  onClick={() => setDiners((d) => Math.max(Math.max(2, maxAssigned), d - 1))}
                  className="grid h-10 w-10 place-items-center rounded-md border border-border text-muted-foreground hover:bg-muted"
                  aria-label="Menos comensales"
                >
                  <Minus size={16} />
                </button>
                <span className="w-8 text-center text-base font-semibold tabular-nums">{diners}</span>
                <button
                  type="button"
                  onClick={() => setDiners((d) => Math.min(MAX_DINERS, d + 1))}
                  className="grid h-10 w-10 place-items-center rounded-md border border-border text-muted-foreground hover:bg-muted"
                  aria-label="Más comensales"
                >
                  <Plus size={16} />
                </button>
              </div>
            </div>

            {/* Platos: un chip por comensal (y "Comp." para lo compartido). */}
            <ul className="max-h-[38vh] space-y-2 overflow-y-auto">
              {items.map((it) => (
                <li key={it.id} className="rounded-md border border-border bg-card px-3 py-2">
                  <div className="flex items-baseline justify-between gap-2">
                    <span className="min-w-0 truncate text-sm font-medium">
                      {formatQty(it.qty)}× {it.name}
                    </span>
                    <span className="shrink-0 text-sm font-semibold tabular-nums">
                      {formatCurrency(it.qty * it.unit_price)}
                    </span>
                  </div>
                  <div className="mt-2 flex flex-wrap gap-1.5" role="group" aria-label={`Comensal de ${it.name}`}>
                    <DinerChip active={it.diner == null} onClick={() => assign(it, null)} label="Comp." />
                    {Array.from({ length: diners }, (_, i) => i + 1).map((d) => (
                      <DinerChip key={d} active={it.diner === d} onClick={() => assign(it, d)} label={String(d)} />
                    ))}
                  </div>
                </li>
              ))}
            </ul>

            {/* Cobro por comensal */}
            <div className="space-y-2 border-t border-border pt-3">
              {summary.diners.length === 0 && (
                <p className="text-sm text-muted-foreground">Asigná cada plato a un comensal para cobrarlo aparte.</p>
              )}
              {summary.diners.map((g) => (
                <div key={g.diner} className="flex items-center justify-between gap-2">
                  <span className="text-sm">
                    {dinerLabel(g.diner)}{" "}
                    <span className="text-muted-foreground">· {g.items.length} ítems</span>
                  </span>
                  <Button
                    size="sm"
                    onClick={() => charge(dinerLines(items, g.diner), dinerLabel(g.diner))}
                    disabled={split.isPending}
                    className="min-h-10"
                  >
                    <CreditCard size={15} /> Cobrar {formatCurrency(g.total)}
                  </Button>
                </div>
              ))}
              {summary.shared.items.length > 0 && (
                <p className="text-xs text-muted-foreground">
                  Compartido o sin asignar: {formatCurrency(summary.shared.total)}. Queda en la cuenta de la mesa:
                  cobralo al final o dividilo en partes iguales.
                </p>
              )}
            </div>
          </>
        ) : (
          <div className="space-y-3">
            <div className="flex items-center justify-between gap-3">
              <span className="text-sm font-medium">
                {runStarted ? "Reparto en curso" : "Partes"}
              </span>
              {runStarted ? (
                <span className="text-sm font-semibold tabular-nums">
                  {partLabel(equal.part, equal.parts)}
                </span>
              ) : (
                <div className="flex items-center gap-1">
                  <button
                    type="button"
                    onClick={() => setParts((p) => Math.max(2, p - 1))}
                    className="grid h-10 w-10 place-items-center rounded-md border border-border text-muted-foreground hover:bg-muted"
                    aria-label="Menos partes"
                  >
                    <Minus size={16} />
                  </button>
                  <span className="w-8 text-center text-base font-semibold tabular-nums">{parts}</span>
                  <button
                    type="button"
                    onClick={() => setParts((p) => Math.min(MAX_DINERS, p + 1))}
                    className="grid h-10 w-10 place-items-center rounded-md border border-border text-muted-foreground hover:bg-muted"
                    aria-label="Más partes"
                  >
                    <Plus size={16} />
                  </button>
                </div>
              )}
            </div>
            <p className="text-xs text-muted-foreground">
              Cada parte lleva la fracción de cada plato (por ejemplo 0,5 de una milanesa). La última toma el resto y
              cuadra al centavo.
            </p>
            <Button
              onClick={() => charge(equalLines, partLabel(equal.part, equal.parts))}
              disabled={split.isPending || equalLines.length === 0}
              className="min-h-11 w-full"
            >
              <CreditCard size={16} /> Cobrar {partLabel(equal.part, equal.parts)} · {formatCurrency(equalAmount)}
            </Button>
          </div>
        )}

        <PendingSplits orderId={orderId} onClose={() => onOpenChange(false)} />
      </div>
    </Modal>
  );
}

function DinerChip({ active, onClick, label }: { active: boolean; onClick: () => void; label: string }) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-pressed={active}
      className={cn(
        "h-10 min-w-10 rounded-md border px-2.5 text-sm font-semibold tabular-nums transition",
        active ? "border-foreground bg-muted text-foreground" : "border-border text-muted-foreground hover:bg-muted/50",
      )}
    >
      {label}
    </button>
  );
}

// Cuentas separadas abiertas (hechas y sin cobrar) y las ya cobradas de la mesa.
export function PendingSplits({ orderId, onClose }: { orderId: string | null; onClose?: () => void }) {
  const router = useRouter();
  const { toast } = useToast();
  const { data: splits } = useTableSplits(orderId);
  const { unsplit } = useTableOrderMutations();
  const list = splits ?? [];
  if (list.length === 0) return null;

  async function undo(id: string) {
    try {
      await unsplit.mutateAsync(id);
      toast({ title: "Cuenta separada deshecha: los ítems volvieron a la mesa", variant: "success" });
    } catch (e) {
      toast({ title: "No se pudo deshacer", description: diningErrorMessage(e), variant: "error" });
    }
  }

  return (
    <div className="space-y-2 border-t border-border pt-3">
      <span className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">Cuentas separadas</span>
      {list.map((s) => (
        <div key={s.id} className="flex flex-wrap items-center justify-between gap-2">
          <span className="text-sm">
            <span className={cn("mr-1.5 inline-block h-2 w-2 rounded-full", s.status === "cobrada" ? "bg-success" : "bg-warning")} />
            {s.split_label ?? "Cuenta separada"} · {formatCurrency(s.total)}
            {s.status === "cobrada" && <span className="text-muted-foreground"> · cobrada</span>}
          </span>
          {s.status === "abierta" && (
            <div className="flex gap-1.5">
              <Button
                size="sm"
                variant="ghost"
                onClick={() => undo(s.id)}
                disabled={unsplit.isPending}
                className="min-h-10"
              >
                <Undo2 size={14} /> Deshacer
              </Button>
              <Button
                size="sm"
                onClick={() => {
                  onClose?.();
                  router.push(`/pos?table=${s.id}`);
                }}
                className="min-h-10"
              >
                <CreditCard size={14} /> Cobrar
              </Button>
            </div>
          )}
        </div>
      ))}
    </div>
  );
}
