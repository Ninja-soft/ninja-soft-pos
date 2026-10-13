"use client";

// Conteo cíclico por clase ABC (F14 · H64, ADR-092). Mobile-first: una fila
// por producto con la cantidad contada; al guardar, las diferencias se
// ajustan en el servidor (adjust_store_stock 'count') y queda la exactitud.

import { useEffect, useMemo, useState } from "react";
import { ClipboardCheck } from "lucide-react";
import { Badge, type BadgeTone } from "@/components/ui/Badge";
import { Button } from "@/components/ui/Button";
import { Disclosure } from "@/components/ui/Disclosure";
import { EmptyState } from "@/components/ui/EmptyState";
import { Input } from "@/components/ui/Input";
import { useToast } from "@/components/ui/Toast";
import { fmtDateTime } from "@/components/stock/transfers/shared";
import { formatCurrency, formatQty } from "@/lib/utils/format";
import {
  ABC_HINT,
  countSummary,
  cycleErrorMessage,
  policyError,
  type AbcClass,
  type CyclePolicy,
} from "@/lib/stock/cycleCount";
import { useCycleDue, useCycleHistory, useCycleMutations, useCyclePolicy } from "@/modules/stock/inventoryPro";

const ABC_TONE: Record<AbcClass, BadgeTone> = { A: "brand", B: "info", C: "neutral" };
const keyOf = (r: { product_id: string; variant_id: string | null }) => `${r.product_id}:${r.variant_id ?? ""}`;

export function CycleCountPanel({ storeId }: { storeId: string | null }) {
  const { data: due = [], isLoading } = useCycleDue(storeId);
  const { data: history = [] } = useCycleHistory(storeId);
  const m = useCycleMutations();
  const { toast } = useToast();
  const [counted, setCounted] = useState<Record<string, string>>({});
  const [notes, setNotes] = useState("");

  useEffect(() => setCounted({}), [storeId]);

  const filled = useMemo(() => due.filter((r) => (counted[keyOf(r)] ?? "").trim() !== ""), [due, counted]);
  const preview = useMemo(
    () => countSummary(filled.map((r) => ({ expected: r.system_qty, counted: Number(counted[keyOf(r)]) }))),
    [filled, counted],
  );

  async function submit() {
    if (!storeId || filled.length === 0) return;
    if (filled.some((r) => !(Number(counted[keyOf(r)]) >= 0))) {
      toast({ title: "Revisá las cantidades: no pueden ser negativas.", variant: "error" });
      return;
    }
    try {
      const res = await m.submit.mutateAsync({
        storeId,
        notes: notes.trim() || null,
        lines: filled.map((r) => ({
          product_id: r.product_id,
          variant_id: r.variant_id,
          counted: Number(counted[keyOf(r)]),
          abc_class: r.abc_class,
        })),
      });
      toast({
        title: "Conteo guardado",
        description: `Exactitud ${String(res.accuracy_pct).replace(".", ",")} % en ${res.lines} productos.`,
        variant: "success",
      });
      setCounted({});
      setNotes("");
    } catch (e) {
      toast({ title: "No se pudo guardar", description: cycleErrorMessage(e), variant: "error" });
    }
  }

  return (
    <div className="space-y-6">
      <section className="border-t-2 border-ninja-flame pt-4">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <h2 className="text-base font-semibold">Para contar hoy</h2>
          <span className="text-xs text-muted-foreground">
            A: lo que más vende · B: venta media · C: poca o ninguna venta
          </span>
        </div>
        {!isLoading && due.length === 0 ? (
          <EmptyState
            className="mt-4"
            icon={ClipboardCheck}
            title="Nada para contar hoy"
            description="Todos los productos de la sucursal están contados dentro de su frecuencia."
          />
        ) : (
          <ul className="mt-3 divide-y divide-border rounded-lg bg-card ring-1 ring-border">
            {due.map((r) => {
              const k = keyOf(r);
              const v = counted[k] ?? "";
              const diff = v.trim() === "" ? null : Number(v) - r.system_qty;
              return (
                <li key={k} className="flex items-center gap-3 p-3">
                  <div className="min-w-0 flex-1">
                    <p className="truncate font-medium">
                      {r.product_name}
                      {r.variant_label ? ` (${r.variant_label})` : ""}
                    </p>
                    <p className="flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
                      <Badge tone={ABC_TONE[r.abc_class]} title={ABC_HINT[r.abc_class]}>
                        {r.abc_class}
                      </Badge>
                      {r.last_counted_at ? `Último conteo ${fmtDateTime(r.last_counted_at)}` : "Nunca contado"}
                      {r.sku ? ` · ${r.sku}` : ""}
                    </p>
                  </div>
                  <div className="w-24 shrink-0">
                    <Input
                      type="number"
                      inputMode="decimal"
                      min={0}
                      aria-label={`Contado de ${r.product_name}`}
                      placeholder={formatQty(r.system_qty)}
                      value={v}
                      onChange={(e) => setCounted((c) => ({ ...c, [k]: e.target.value }))}
                      className="h-11 text-right"
                    />
                    {diff != null && diff !== 0 && (
                      <p className={`mt-0.5 text-right text-xs ${diff < 0 ? "text-danger" : "text-success"}`}>
                        {diff > 0 ? "+" : ""}
                        {formatQty(diff)}
                      </p>
                    )}
                  </div>
                </li>
              );
            })}
          </ul>
        )}
        {due.length > 0 && (
          <div className="mt-3 flex flex-col gap-3 sm:flex-row sm:items-end">
            <label className="block flex-1 text-sm">
              <span className="mb-1 block font-medium">Nota (opcional)</span>
              <Input value={notes} maxLength={300} onChange={(e) => setNotes(e.target.value)} />
            </label>
            <Button onClick={submit} loading={m.submit.isPending} disabled={filled.length === 0}>
              Guardar conteo{filled.length ? ` (${filled.length})` : ""}
            </Button>
          </div>
        )}
        {filled.length > 0 && (
          <p className="mt-2 text-xs text-muted-foreground">
            Exactitud hasta ahora: {String(preview.accuracyPct).replace(".", ",")} % · diferencia {formatQty(preview.unitsDiff)}{" "}
            unidades. El sistema queda con lo contado.
          </p>
        )}
      </section>

      <section>
        <h2 className="text-base font-semibold">Conteos anteriores</h2>
        {history.length === 0 ? (
          <p className="mt-2 text-sm text-muted-foreground">Todavía no hay conteos cíclicos en esta sucursal.</p>
        ) : (
          <ul className="mt-2 divide-y divide-border text-sm">
            {history.map((h) => (
              <li key={h.id} className="flex flex-wrap items-center justify-between gap-2 py-2">
                <span>
                  {fmtDateTime(h.created_at)} · {h.lines_count} productos
                  {h.notes ? <span className="block text-xs text-muted-foreground">{h.notes}</span> : null}
                </span>
                <span className="flex items-center gap-2 tabular-nums">
                  <Badge tone={(h.accuracy_pct ?? 0) >= 95 ? "success" : (h.accuracy_pct ?? 0) >= 80 ? "warning" : "danger"}>
                    {String(h.accuracy_pct ?? 0).replace(".", ",")} %
                  </Badge>
                  {formatCurrency(h.value_diff)}
                </span>
              </li>
            ))}
          </ul>
        )}
      </section>

      <Disclosure title="Frecuencia por clase">
        <PolicyForm />
      </Disclosure>
    </div>
  );
}

function PolicyForm() {
  const { data } = useCyclePolicy();
  const m = useCycleMutations();
  const { toast } = useToast();
  const [p, setP] = useState<CyclePolicy | null>(null);
  useEffect(() => {
    if (data) setP(data);
  }, [data]);
  if (!p) return null;

  const field = (k: keyof CyclePolicy, label: string) => (
    <label key={k} className="block text-sm">
      <span className="mb-1 block font-medium">{label}</span>
      <Input
        type="number"
        inputMode="numeric"
        value={p[k]}
        onChange={(e) => setP({ ...p, [k]: Number(e.target.value) })}
      />
    </label>
  );

  async function save() {
    if (!p) return;
    const err = policyError(p);
    if (err) {
      toast({ title: err, variant: "error" });
      return;
    }
    try {
      await m.savePolicy.mutateAsync(p);
      toast({ title: "Frecuencia guardada", variant: "success" });
    } catch (e) {
      toast({ title: "No se pudo guardar", description: cycleErrorMessage(e), variant: "error" });
    }
  }

  return (
    <div className="space-y-3 pt-2">
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
        {field("a_days", "A cada (días)")}
        {field("b_days", "B cada (días)")}
        {field("c_days", "C cada (días)")}
        {field("daily_items", "Productos por día")}
        {field("a_share", "A hasta (% de la venta)")}
        {field("b_share", "B hasta (% de la venta)")}
        {field("lookback_days", "Ventas de los últimos (días)")}
      </div>
      <Button onClick={save} loading={m.savePolicy.isPending}>
        Guardar
      </Button>
    </div>
  );
}
