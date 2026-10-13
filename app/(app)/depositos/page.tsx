"use client";

import { useEffect, useMemo, useState } from "react";
import { ArrowRightLeft, Archive, Lightbulb, Lock, Pencil, Plus, Search, Warehouse as WarehouseIcon } from "lucide-react";
import { PageContainer, PageHeader } from "@/components/ui/PageHeader";
import { Button } from "@/components/ui/Button";
import { Badge } from "@/components/ui/Badge";
import { Input } from "@/components/ui/Input";
import { Modal } from "@/components/ui/Modal";
import { Segmented } from "@/components/ui/Segmented";
import { ConfirmDialog } from "@/components/ui/ConfirmDialog";
import { EmptyState } from "@/components/ui/EmptyState";
import { TableStateRow, TableWrap } from "@/components/ui/Table";
import { useToast } from "@/components/ui/Toast";
import { UpgradeModal } from "@/components/saas/UpgradeModal";
import { cn } from "@/lib/utils/cn";
import { formatQty } from "@/lib/utils/format";
import {
  MOVE_REASON_LABEL,
  MOVE_STATUS_LABEL,
  WAREHOUSE_KIND_LABEL,
  groupSuggestionsBySource,
  qtyIn,
  replenishSuggestions,
  salonStatus,
  sortWarehouses,
  warehouseErrorMessage,
  type Warehouse,
} from "@/lib/stock/warehouses";
import { useFeature } from "@/modules/saas/gating";
import { useMyTenant } from "@/modules/tenants/hooks";
import { useCurrentStoreId, useStores } from "@/modules/stock/hooks";
import {
  useWarehouseMoves,
  useWarehouseMutations,
  useWarehouseOverview,
  useWarehouses,
  type WarehouseMove,
} from "@/modules/stock/warehouses";
import { fmtDateTime, selectCls } from "@/components/stock/transfers/shared";
import { WarehouseMoveModal, type MoveInitial } from "@/components/stock/warehouses/WarehouseMoveModal";
import { WarehouseReceiveModal } from "@/components/stock/warehouses/WarehouseReceiveModal";
import { WarehouseCountModal, WarehouseFormModal } from "@/components/stock/warehouses/WarehouseFormModal";

type Tab = "stock" | "open" | "history";

// Depósitos internos de la sucursal (F11 · H33, ADR-085): salón de ventas,
// reserva, devoluciones y merma, con movimientos internos en tránsito y
// reposición del salón por mínimos.
export default function DepositosPage() {
  const enabled = useFeature("depositos");
  const { toast } = useToast();
  const { data: me } = useMyTenant();
  const canManage = Boolean(me?.canManage);
  const { data: stores = [] } = useStores();
  const currentStoreId = useCurrentStoreId();
  const [storeId, setStoreId] = useState<string | null>(null);
  const [tab, setTab] = useState<Tab>("stock");
  const [search, setSearch] = useState("");
  const [upgradeOpen, setUpgradeOpen] = useState(false);
  const [form, setForm] = useState<{ open: boolean; warehouse: Warehouse | null }>({ open: false, warehouse: null });
  const [archiving, setArchiving] = useState<Warehouse | null>(null);
  const [move, setMove] = useState<{ open: boolean; initial: MoveInitial | null }>({ open: false, initial: null });
  const [receiving, setReceiving] = useState<WarehouseMove | null>(null);
  const [cancelling, setCancelling] = useState<WarehouseMove | null>(null);
  const [count, setCount] = useState<React.ComponentProps<typeof WarehouseCountModal>["target"]>(null);
  const [replenishOpen, setReplenishOpen] = useState(false);
  const m = useWarehouseMutations();

  useEffect(() => {
    if (!storeId && currentStoreId) setStoreId(currentStoreId);
  }, [currentStoreId, storeId]);

  const ready = enabled === true && Boolean(storeId);
  const { data: rawWarehouses = [], isLoading: whLoading } = useWarehouses(ready ? storeId : null);
  const warehouses = useMemo(() => sortWarehouses(rawWarehouses), [rawWarehouses]);
  const others = warehouses.filter((w) => w.kind !== "principal");
  const { data: overview = [], isLoading: ovLoading } = useWarehouseOverview(
    ready ? storeId : null,
    search,
    warehouses.length > 0,
  );
  const { data: openMoves = [] } = useWarehouseMoves(ready ? storeId : null, true);
  const { data: pastMoves = [] } = useWarehouseMoves(ready && tab === "history" ? storeId : null, false);

  const suggestions = useMemo(() => replenishSuggestions(overview, warehouses), [overview, warehouses]);
  const whName = (id: string) => warehouses.find((w) => w.id === id)?.name ?? "Depósito";

  async function confirmReplenish() {
    const principal = warehouses.find((w) => w.kind === "principal");
    if (!principal) return;
    try {
      for (const [from, list] of groupSuggestionsBySource(suggestions)) {
        await m.createMove.mutateAsync({
          origin: from,
          dest: principal.id,
          reason: "reposicion",
          receiveNow: true,
          items: list.map((s) => ({ product_id: s.product_id, variant_id: s.variant_id, qty: s.qty })),
        });
      }
      toast({ title: "Salón repuesto", variant: "success" });
      setReplenishOpen(false);
    } catch (e) {
      toast({ title: "No se pudo reponer", description: warehouseErrorMessage(e), variant: "error" });
    }
  }

  const header = (
    <PageHeader
      eyebrow="Catálogo"
      title="Depósitos"
      icon={WarehouseIcon}
      description="El stock de cada sucursal separado en salón de ventas, reserva, devoluciones y merma. Mové entre depósitos y reponé el salón."
      actions={
        ready && canManage && warehouses.length > 0 ? (
          <>
            <Button onClick={() => setMove({ open: true, initial: null })}>
              <ArrowRightLeft size={16} /> Mover
            </Button>
            <Button variant="secondary" onClick={() => setReplenishOpen(true)} disabled={suggestions.length === 0}>
              <Lightbulb size={16} /> Reponer salón{suggestions.length > 0 ? ` (${suggestions.length})` : ""}
            </Button>
          </>
        ) : undefined
      }
    />
  );

  if (enabled === false) {
    return (
      <PageContainer>
        {header}
        <div className="mt-8 rounded-lg bg-muted/40 p-8 text-center">
          <Lock className="mx-auto text-ninja-flameSoft" size={28} />
          <p className="mt-3 font-semibold">Los depósitos internos no están incluidos en tu plan</p>
          <p className="mx-auto mt-1 max-w-md text-sm text-muted-foreground">
            Separá el salón de la reserva, seguí lo que está en camino entre depósitos y reponé el salón por mínimos.
          </p>
          <Button className="mt-4" onClick={() => setUpgradeOpen(true)}>
            Ver planes
          </Button>
          <UpgradeModal
            open={upgradeOpen}
            onOpenChange={setUpgradeOpen}
            featureKey="depositos"
            featureLabel="Depósitos internos"
          />
        </div>
      </PageContainer>
    );
  }

  return (
    <PageContainer>
      {header}

      <div className="mt-6 flex flex-col gap-3 sm:flex-row sm:items-center">
        {stores.length > 1 && (
          <select
            aria-label="Sucursal"
            className={cn(selectCls, "h-10 sm:max-w-[14rem]")}
            value={storeId ?? ""}
            onChange={(e) => setStoreId(e.target.value)}
          >
            {stores.map((s) => (
              <option key={s.id} value={s.id} className="bg-popover text-popover-foreground">
                {s.name}
              </option>
            ))}
          </select>
        )}
        <Segmented<Tab>
          aria-label="Vista"
          value={tab}
          onChange={setTab}
          size="sm"
          options={[
            { value: "stock", label: "Stock" },
            { value: "open", label: `En tránsito${openMoves.length ? ` (${openMoves.length})` : ""}` },
            { value: "history", label: "Historial" },
          ]}
        />
      </div>

      {/* Depósitos de la sucursal */}
      <section className="mt-6 border-t-2 border-ninja-flame pt-4">
        <div className="flex items-center justify-between gap-2">
          <h2 className="text-base font-semibold">Depósitos de la sucursal</h2>
          {canManage && ready && (
            <Button size="sm" variant="secondary" onClick={() => setForm({ open: true, warehouse: null })}>
              <Plus size={15} /> Nuevo depósito
            </Button>
          )}
        </div>
        {!whLoading && warehouses.length === 0 ? (
          <EmptyState
            className="mt-4"
            icon={WarehouseIcon}
            title="Todavía no separaste el stock"
            description="Creá un depósito (por ejemplo, Reserva). El salón de ventas se crea solo y queda con todo el stock de la sucursal."
          />
        ) : (
          <ul className="mt-3 flex flex-wrap gap-2">
            {warehouses.map((w) => (
              <li key={w.id} className="flex items-center gap-1 rounded-lg bg-muted/50 py-1 pl-3 pr-1 text-sm">
                <span className="font-medium">{w.name}</span>
                <span className="text-xs text-muted-foreground">{WAREHOUSE_KIND_LABEL[w.kind]}</span>
                {canManage && (
                  <>
                    <Button
                      size="icon"
                      variant="ghost"
                      aria-label={`Editar ${w.name}`}
                      onClick={() => setForm({ open: true, warehouse: w })}
                    >
                      <Pencil size={14} />
                    </Button>
                    <Button size="icon" variant="ghost" aria-label={`Dar de baja ${w.name}`} onClick={() => setArchiving(w)}>
                      <Archive size={14} />
                    </Button>
                  </>
                )}
              </li>
            ))}
          </ul>
        )}
      </section>

      {tab === "stock" && warehouses.length > 0 && (
        <section className="mt-6">
          <div className="relative max-w-md">
            <Search
              size={16}
              className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-muted-foreground"
            />
            <Input
              placeholder="Buscar por nombre, SKU o código"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              className="pl-9"
            />
          </div>
          <TableWrap className="mt-3">
            <table className="w-full min-w-[640px] text-sm">
              <thead>
                <tr className="border-b border-border text-left text-xs text-muted-foreground">
                  <th className="px-3 py-2 font-medium">Producto</th>
                  {warehouses.map((w) => (
                    <th key={w.id} className="px-3 py-2 text-right font-medium">
                      {w.name}
                    </th>
                  ))}
                  <th className="px-3 py-2 text-right font-medium">En tránsito</th>
                  <th className="px-3 py-2 text-right font-medium">Sucursal</th>
                </tr>
              </thead>
              <tbody>
                {ovLoading ? (
                  <TableStateRow colSpan={warehouses.length + 3} loading />
                ) : overview.length === 0 ? (
                  <TableStateRow colSpan={warehouses.length + 3}>
                    <span className="text-muted-foreground">Sin stock en esta sucursal.</span>
                  </TableStateRow>
                ) : (
                  overview.map((r) => {
                    const st = salonStatus(r);
                    return (
                      <tr key={`${r.product_id}:${r.variant_id ?? ""}`} className="border-b border-border last:border-0">
                        <td className="px-3 py-2">
                          <p className="font-medium">
                            {r.product_name}
                            {r.variant_label ? ` (${r.variant_label})` : ""}
                          </p>
                          {r.sku && <p className="text-xs text-muted-foreground">{r.sku}</p>}
                        </td>
                        {warehouses.map((w) => {
                          const q = qtyIn(r, w);
                          const principal = w.kind === "principal";
                          return (
                            <td key={w.id} className="px-3 py-2 text-right tabular-nums">
                              {principal ? (
                                <span className="inline-flex items-center gap-1.5">
                                  {st !== "ok" && (
                                    <Badge tone={st === "negative" ? "danger" : "warning"}>
                                      {st === "negative" ? "Reponer" : "Bajo mínimo"}
                                    </Badge>
                                  )}
                                  <span className={cn(q < 0 && "text-danger")}>{formatQty(q)}</span>
                                </span>
                              ) : canManage ? (
                                <button
                                  type="button"
                                  className="min-h-9 rounded px-2 hover:bg-muted"
                                  title="Contar"
                                  onClick={() =>
                                    setCount({
                                      warehouse: w,
                                      productId: r.product_id,
                                      variantId: r.variant_id,
                                      name: r.variant_label ? `${r.product_name} (${r.variant_label})` : r.product_name,
                                      current: q,
                                    })
                                  }
                                >
                                  {q ? formatQty(q) : "-"}
                                </button>
                              ) : q ? (
                                formatQty(q)
                              ) : (
                                "-"
                              )}
                            </td>
                          );
                        })}
                        <td className="px-3 py-2 text-right tabular-nums text-muted-foreground">
                          {r.in_transit ? formatQty(r.in_transit) : "-"}
                        </td>
                        <td className="px-3 py-2 text-right font-medium tabular-nums">{formatQty(r.store_qty)}</td>
                      </tr>
                    );
                  })
                )}
              </tbody>
            </table>
          </TableWrap>
          {canManage && others.length > 0 && (
            <p className="mt-2 text-xs text-muted-foreground">
              Tocá la cantidad de un depósito para contarlo. Para productos que todavía no están en la tabla, buscalos.
            </p>
          )}
        </section>
      )}

      {tab !== "stock" && (
        <section className="mt-6 space-y-3">
          {(tab === "open" ? openMoves : pastMoves).length === 0 ? (
            <EmptyState
              icon={ArrowRightLeft}
              title={tab === "open" ? "Nada en tránsito" : "Sin movimientos"}
              description={
                tab === "open"
                  ? "Cuando envíes mercadería sin recibirla en el acto, aparece acá hasta que llegue."
                  : "Los movimientos recibidos y cancelados de la sucursal."
              }
            />
          ) : (
            (tab === "open" ? openMoves : pastMoves).map((mv) => (
              <article key={mv.id} className="rounded-lg bg-card p-4 ring-1 ring-border">
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <div>
                    <p className="font-semibold">
                      #{mv.number} · {whName(mv.origin_warehouse_id)} → {whName(mv.dest_warehouse_id)}
                    </p>
                    <p className="text-xs text-muted-foreground">
                      {MOVE_REASON_LABEL[mv.reason]} · {fmtDateTime(mv.created_at)} · {formatQty(mv.total_units)} u.
                    </p>
                  </div>
                  <div className="flex items-center gap-2">
                    <Badge
                      tone={
                        mv.status === "received"
                          ? mv.has_differences
                            ? "warning"
                            : "success"
                          : mv.status === "cancelled"
                            ? "neutral"
                            : "brand"
                      }
                    >
                      {MOVE_STATUS_LABEL[mv.status]}
                      {mv.status === "received" && mv.has_differences ? " con diferencias" : ""}
                    </Badge>
                    {tab === "open" && me?.role !== "viewer" && (
                      <Button size="sm" onClick={() => setReceiving(mv)}>
                        Recibir
                      </Button>
                    )}
                    {tab === "open" && canManage && mv.status === "in_transit" && (
                      <Button size="sm" variant="ghost" onClick={() => setCancelling(mv)}>
                        Cancelar
                      </Button>
                    )}
                  </div>
                </div>
                <ul className="mt-2 text-sm text-muted-foreground">
                  {mv.items.map((i) => (
                    <li key={i.id}>
                      {i.product_name}
                      {i.variant_label ? ` (${i.variant_label})` : ""}: {formatQty(i.qty_received)} de{" "}
                      {formatQty(i.qty_sent)}
                    </li>
                  ))}
                </ul>
              </article>
            ))
          )}
        </section>
      )}

      {storeId && (
        <WarehouseFormModal
          open={form.open}
          onOpenChange={(o) => setForm((f) => ({ ...f, open: o }))}
          storeId={storeId}
          warehouse={form.warehouse}
        />
      )}
      <WarehouseMoveModal
        open={move.open}
        onOpenChange={(o) => setMove((s) => ({ ...s, open: o }))}
        warehouses={warehouses}
        overview={overview}
        initial={move.initial}
      />
      <WarehouseReceiveModal move={receiving} onOpenChange={(o) => !o && setReceiving(null)} canClose={canManage} />
      <WarehouseCountModal target={count} onOpenChange={(o) => !o && setCount(null)} />

      <ConfirmDialog
        open={Boolean(archiving)}
        onOpenChange={(o) => !o && setArchiving(null)}
        title={`Dar de baja ${archiving?.name ?? ""}`}
        description="Sólo se puede si no tiene stock ni movimientos en tránsito."
        confirmLabel="Dar de baja"
        danger
        loading={m.archive.isPending}
        onConfirm={async () => {
          if (!archiving) return;
          try {
            await m.archive.mutateAsync(archiving.id);
            toast({ title: "Depósito dado de baja", variant: "success" });
            setArchiving(null);
          } catch (e) {
            toast({ title: "No se pudo dar de baja", description: warehouseErrorMessage(e), variant: "error" });
          }
        }}
      />
      <ConfirmDialog
        open={Boolean(cancelling)}
        onOpenChange={(o) => !o && setCancelling(null)}
        title={`Cancelar movimiento #${cancelling?.number ?? ""}`}
        description="Todo lo enviado vuelve al depósito de origen."
        confirmLabel="Cancelar movimiento"
        danger
        withReason
        loading={m.cancel.isPending}
        onConfirm={async (reason) => {
          if (!cancelling) return;
          try {
            await m.cancel.mutateAsync({ moveId: cancelling.id, reason });
            toast({ title: "Movimiento cancelado", variant: "success" });
            setCancelling(null);
          } catch (e) {
            toast({ title: "No se pudo cancelar", description: warehouseErrorMessage(e), variant: "error" });
          }
        }}
      />

      <Modal
        open={replenishOpen}
        onOpenChange={setReplenishOpen}
        title="Reponer el salón"
        description="Productos con el salón en negativo o bajo su mínimo, traídos desde la reserva hasta el máximo (o el mínimo)."
        className="sm:max-w-lg"
        footer={
          <>
            <Button variant="secondary" onClick={() => setReplenishOpen(false)}>
              Cancelar
            </Button>
            <Button onClick={confirmReplenish} loading={m.createMove.isPending} disabled={suggestions.length === 0}>
              Mover ahora
            </Button>
          </>
        }
      >
        <ul className="divide-y divide-border text-sm">
          {suggestions.map((s) => (
            <li key={`${s.product_id}:${s.variant_id ?? ""}:${s.from_warehouse_id}`} className="flex justify-between gap-3 py-2">
              <span className="min-w-0 truncate">
                {s.name}
                <span className="block text-xs text-muted-foreground">desde {whName(s.from_warehouse_id)}</span>
              </span>
              <span className="shrink-0 tabular-nums">
                {formatQty(s.qty)} <span className="text-xs text-muted-foreground">(queda {formatQty(s.principal_after)})</span>
              </span>
            </li>
          ))}
        </ul>
      </Modal>
    </PageContainer>
  );
}
