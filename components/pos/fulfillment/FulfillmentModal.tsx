"use client";

// Entregas de la venta en el POS (ADR-136). Por cada producto del carrito, de
// dónde sale (salón, un depósito vendible de esta sucursal o un depósito o
// salón de otra sucursal habilitado) y cómo se entrega (se lo lleva ahora,
// retira en una sucursal o envío). Se puede partir un renglón en varias
// partes. Las partes se agrupan en entregas, cada una con su dato (quién
// retira o el domicilio). El servidor vuelve a validar todo al cobrar.

import { useEffect, useMemo, useState } from "react";
import { Plus, Trash2, Truck } from "lucide-react";
import { Modal } from "@/components/ui/Modal";
import { Button } from "@/components/ui/Button";
import { Input } from "@/components/ui/Input";
import { Badge } from "@/components/ui/Badge";
import { cn } from "@/lib/utils/cn";
import { formatQty } from "@/lib/utils/format";
import {
  FULFILLMENT_MODE_LABEL,
  buildPlan,
  checkAllocations,
  groupDeliveries,
  groupKeyOf,
  isTrivialPlan,
  sourceLabel,
  sourcesFor,
  suggestAllocations,
  type Allocation,
  type DeliveryInfo,
  type FulfillmentLine,
  type FulfillmentMode,
  type FulfillmentRules,
  type FulfillmentSource,
  type PlanPayload,
} from "@/lib/stock/fulfillment";

const selectCls =
  "h-11 w-full min-w-0 rounded-lg border border-input bg-background px-3 text-sm focus:outline-none focus:ring-2 focus:ring-ring";

export interface FulfillmentState {
  allocations: Allocation[];
  info: Record<string, DeliveryInfo>;
}

export function FulfillmentModal({
  open,
  onOpenChange,
  lines,
  sources,
  loading,
  rules,
  stores,
  customerName,
  initial,
  onConfirm,
  onClear,
}: {
  open: boolean;
  onOpenChange: (o: boolean) => void;
  lines: FulfillmentLine[];
  sources: FulfillmentSource[];
  loading: boolean;
  rules: FulfillmentRules;
  stores: { id: string; name: string }[];
  customerName: string | null;
  initial: FulfillmentState | null;
  /** plan null = todo se lleva ahora desde el salón (venta normal). */
  onConfirm: (state: FulfillmentState, plan: PlanPayload | null) => void;
  onClear: () => void;
}) {
  const [allocs, setAllocs] = useState<Allocation[]>([]);
  const [info, setInfo] = useState<Record<string, DeliveryInfo>>({});
  const linesKey = lines.map((l) => `${l.key}:${l.quantity}`).join(",");

  // Al abrir: lo guardado si sigue cuadrando con el carrito, o la sugerencia.
  useEffect(() => {
    if (!open || loading) return;
    const fits =
      initial &&
      lines.every(
        (l) =>
          Math.abs(initial.allocations.filter((a) => a.key === l.key).reduce((t, a) => t + a.qty, 0) - l.quantity) < 0.0005,
      ) &&
      initial.allocations.every((a) => lines.some((l) => l.key === a.key));
    if (fits && initial) {
      setAllocs(initial.allocations.map((a) => ({ ...a })));
      setInfo({ ...initial.info });
    } else {
      setAllocs(suggestAllocations(lines, sources, rules.storeId));
      setInfo({});
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, loading, linesKey]);

  const storeName = (id: string) => stores.find((s) => s.id === id)?.name ?? "Sucursal";
  const groups = useMemo(() => groupDeliveries(allocs, rules.storeId), [allocs, rules.storeId]);
  const errors = useMemo(() => checkAllocations(lines, allocs, rules, info), [lines, allocs, rules, info]);

  function patch(id: string, p: Partial<Allocation>) {
    setAllocs((cur) => cur.map((a) => (a.id === id ? { ...a, ...p } : a)));
  }
  function split(line: FulfillmentLine) {
    const used = allocs.filter((a) => a.key === line.key).reduce((t, a) => t + a.qty, 0);
    const rest = Math.max(Math.round((line.quantity - used) * 1000) / 1000, 0);
    setAllocs((cur) => [
      ...cur,
      {
        id: `n${Date.now()}${Math.random().toString(36).slice(2, 5)}`,
        key: line.key,
        qty: rest,
        sourceStoreId: rules.storeId,
        sourceWarehouseId: null,
        mode: "ahora",
        fulfillmentStoreId: null,
      },
    ]);
  }

  function confirm() {
    const state = { allocations: allocs, info };
    onConfirm(state, isTrivialPlan(allocs, rules.storeId) ? null : buildPlan(lines, allocs, rules.storeId, withDefaults(info)));
  }

  // Quien retira: por defecto, el cliente elegido.
  function withDefaults(i: Record<string, DeliveryInfo>): Record<string, DeliveryInfo> {
    const out = { ...i };
    for (const g of groups) {
      if (g.mode === "retiro" && !out[g.groupKey]?.pickupName?.trim() && customerName) {
        out[g.groupKey] = { ...out[g.groupKey], pickupName: customerName };
      }
    }
    return out;
  }

  const pickupMissing = groups.some(
    (g) => g.mode === "retiro" && !(info[g.groupKey]?.pickupName?.trim() || customerName),
  );

  return (
    <Modal
      open={open}
      onOpenChange={onOpenChange}
      title="Entregas de la venta"
      description="Elegí de dónde sale cada producto y cómo se entrega. Podés partir un renglón: una parte se la lleva ahora y otra la retira o se envía."
      className="sm:max-w-2xl"
      footer={
        <>
          <Button variant="ghost" onClick={onClear}>
            Todo se lleva ahora
          </Button>
          <Button onClick={confirm} disabled={loading || errors.length > 0 || pickupMissing}>
            Usar este reparto
          </Button>
        </>
      }
    >
      {loading ? (
        <p className="py-8 text-center text-sm text-muted-foreground">Buscando stock en depósitos y sucursales…</p>
      ) : (
        <div className="space-y-5">
          <ul className="space-y-3">
            {lines.map((line) => {
              const mine = allocs.filter((a) => a.key === line.key);
              const srcs = sourcesFor(sources, line);
              const sum = Math.round(mine.reduce((t, a) => t + a.qty, 0) * 1000) / 1000;
              const ok = Math.abs(sum - line.quantity) < 0.0005;
              return (
                <li key={line.key} className="rounded-lg bg-muted/40 p-3">
                  <div className="flex items-start justify-between gap-2">
                    <p className="min-w-0 text-sm font-medium">{line.name}</p>
                    <Badge tone={ok ? "success" : "warning"}>
                      {formatQty(sum)} de {formatQty(line.quantity)}
                    </Badge>
                  </div>
                  <div className="mt-2 space-y-2">
                    {mine.map((a) => {
                      const remote = a.sourceStoreId !== rules.storeId;
                      const modeValue = a.mode === "retiro" ? `retiro:${a.fulfillmentStoreId ?? a.sourceStoreId}` : a.mode;
                      return (
                        <div key={a.id} className="grid grid-cols-[5rem_1fr] gap-2 sm:grid-cols-[5rem_1fr_1fr_auto]">
                          <Input
                            aria-label="Cantidad"
                            inputMode="decimal"
                            value={String(a.qty)}
                            onChange={(e) => patch(a.id, { qty: Number(e.target.value.replace(",", ".")) || 0 })}
                          />
                          <select
                            aria-label="De dónde sale"
                            className={selectCls}
                            value={`${a.sourceStoreId}|${a.sourceWarehouseId ?? ""}`}
                            onChange={(e) => {
                              const [st, wh] = e.target.value.split("|");
                              const toRemote = st !== rules.storeId;
                              patch(a.id, {
                                sourceStoreId: st!,
                                sourceWarehouseId: wh || null,
                                mode: toRemote && a.mode === "ahora" ? "retiro" : a.mode,
                                fulfillmentStoreId: toRemote ? st! : a.fulfillmentStoreId,
                              });
                            }}
                          >
                            {srcs.map((s) => {
                              const v = `${s.store_id}|${s.own_store && s.kind === "principal" ? "" : (s.warehouse_id ?? "")}`;
                              return (
                                <option key={v} value={v} className="bg-popover text-popover-foreground">
                                  {sourceLabel(s)} ({formatQty(Math.max(Number(s.available), 0))})
                                </option>
                              );
                            })}
                          </select>
                          <select
                            aria-label="Cómo se entrega"
                            className={cn(selectCls, "col-span-2 sm:col-span-1")}
                            value={modeValue}
                            onChange={(e) => {
                              const v = e.target.value;
                              if (v.startsWith("retiro:")) patch(a.id, { mode: "retiro", fulfillmentStoreId: v.slice(7) });
                              else patch(a.id, { mode: v as FulfillmentMode, fulfillmentStoreId: null });
                            }}
                          >
                            {!remote && <option value="ahora">{FULFILLMENT_MODE_LABEL.ahora}</option>}
                            {rules.retiroEnabled &&
                              stores
                                .filter((s) => s.id === a.sourceStoreId || rules.retiroCrossBranch)
                                .map((s) => (
                                  <option key={s.id} value={`retiro:${s.id}`}>
                                    Retira en {s.name}
                                  </option>
                                ))}
                            {rules.envioEnabled && <option value="envio">Envío desde {storeName(a.sourceStoreId)}</option>}
                          </select>
                          {mine.length > 1 && (
                            <Button
                              size="icon"
                              variant="ghost"
                              aria-label="Quitar esta parte"
                              className="col-span-2 justify-self-end sm:col-span-1"
                              onClick={() => setAllocs((cur) => cur.filter((x) => x.id !== a.id))}
                            >
                              <Trash2 size={15} />
                            </Button>
                          )}
                        </div>
                      );
                    })}
                  </div>
                  {!line.localOnly && (
                    <Button size="sm" variant="ghost" className="mt-1" onClick={() => split(line)}>
                      <Plus size={14} /> Partir
                    </Button>
                  )}
                </li>
              );
            })}
          </ul>

          {groups.length > 0 && (
            <section>
              <h3 className="text-sm font-semibold">
                {groups.length === 1 ? "1 entrega" : `${groups.length} entregas`}
              </h3>
              <ul className="mt-2 space-y-2">
                {groups.map((g, i) => {
                  const units = g.allocations.reduce((t, a) => t + a.qty, 0);
                  const title =
                    g.mode === "ahora"
                      ? "Se lo lleva ahora"
                      : g.mode === "envio"
                        ? `Envío desde ${storeName(g.originStoreId)}`
                        : g.fulfillmentStoreId === g.originStoreId
                          ? `Retira en ${storeName(g.fulfillmentStoreId)}`
                          : `Sale de ${storeName(g.originStoreId)}, retira en ${storeName(g.fulfillmentStoreId)}`;
                  return (
                    <li key={g.groupKey} className="rounded-lg bg-card p-3 ring-1 ring-border">
                      <p className="flex items-center gap-2 text-sm font-medium">
                        <span className="tabular-nums text-muted-foreground">{i + 1}.</span>
                        {g.mode === "envio" && <Truck size={15} aria-hidden />}
                        {title}
                        <span className="ml-auto text-xs font-normal text-muted-foreground">{formatQty(units)} u.</span>
                      </p>
                      {g.mode === "retiro" && (
                        <Input
                          className="mt-2"
                          label="Retira a nombre de"
                          placeholder={customerName ?? "Nombre y apellido"}
                          value={info[groupKeyOf(g.allocations[0]!)]?.pickupName ?? ""}
                          onChange={(e) => setInfo((cur) => ({ ...cur, [g.groupKey]: { ...cur[g.groupKey], pickupName: e.target.value } }))}
                          maxLength={120}
                        />
                      )}
                      {g.mode === "envio" && (
                        <Input
                          className="mt-2"
                          label="Domicilio de entrega"
                          value={info[g.groupKey]?.shipAddress ?? ""}
                          onChange={(e) => setInfo((cur) => ({ ...cur, [g.groupKey]: { ...cur[g.groupKey], shipAddress: e.target.value } }))}
                          maxLength={300}
                        />
                      )}
                    </li>
                  );
                })}
              </ul>
            </section>
          )}

          {(errors.length > 0 || pickupMissing) && (
            <ul className="space-y-1 text-xs text-warning" role="status">
              {errors.map((e) => (
                <li key={e}>{e}</li>
              ))}
              {pickupMissing && <li>Cargá quién retira (o elegí un cliente).</li>}
            </ul>
          )}
        </div>
      )}
    </Modal>
  );
}
