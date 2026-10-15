"use client";

import { useEffect, useMemo, useState } from "react";
import {
  ArrowRightLeft,
  Archive,
  Lightbulb,
  Lock,
  Pencil,
  Plus,
  Search,
  SlidersHorizontal,
  Store as StoreIcon,
  Warehouse as WarehouseIcon,
} from "lucide-react";
import { PageContainer, PageHeader } from "@/components/ui/PageHeader";
import { Button } from "@/components/ui/Button";
import { Badge } from "@/components/ui/Badge";
import { Input } from "@/components/ui/Input";
import { Modal } from "@/components/ui/Modal";
import { Segmented } from "@/components/ui/Segmented";
import { Switch } from "@/components/ui/Switch";
import { ConfirmDialog } from "@/components/ui/ConfirmDialog";
import { EmptyState } from "@/components/ui/EmptyState";
import { useToast } from "@/components/ui/Toast";
import { UpgradeModal } from "@/components/saas/UpgradeModal";
import { cn } from "@/lib/utils/cn";
import { formatQty } from "@/lib/utils/format";
import {
  MOVE_REASON_LABEL,
  MOVE_STATUS_LABEL,
  WAREHOUSE_KIND_LABEL,
  groupSuggestionsBySource,
  isSellable,
  replenishSuggestions,
  sortWarehouses,
  warehouseErrorMessage,
  warehouseUsedBy,
  type Warehouse,
} from "@/lib/stock/warehouses";
import { useFeature } from "@/modules/saas/gating";
import { useMyTenant } from "@/modules/tenants/hooks";
import { useCurrentStoreId, useStores } from "@/modules/stock/hooks";
import {
  useProductThumbs,
  useSaveSellFromReserve,
  useSellFromReserve,
  useWarehouseLinks,
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
import { WarehouseConfigModal } from "@/components/stock/warehouses/WarehouseConfigModal";
import { WarehouseStockView } from "@/components/stock/warehouses/WarehouseStockView";

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
  const [configuring, setConfiguring] = useState<Warehouse | null>(null);
  const m = useWarehouseMutations();
  // ADR-136: vender el stock de un depósito desde otras sucursales.
  const branchStock = useFeature("stock_sucursales");
  const multiStore = branchStock === true && stores.length > 1;
  // ADR-088: vender de la reserva cuando el salón no alcanza (dueño o encargado).
  const { data: sellFromReserve = false } = useSellFromReserve(canManage);
  const saveSellFromReserve = useSaveSellFromReserve();

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
  const storeName = (id: string) => stores.find((s) => s.id === id)?.name;
  const { data: links } = useWarehouseLinks(ready ? storeId : null);
  const ownLinks = links?.own ?? [];
  const incoming = links?.incoming ?? [];
  const { data: thumbs = {} } = useProductThumbs(overview.map((r) => r.product_id));

  async function setupSalon() {
    if (!storeId) return;
    try {
      const id = await m.setupPrincipal.mutateAsync(storeId);
      setConfiguring({ id, store_id: storeId, name: "Salón de ventas", code: null, kind: "principal", sort: 0, sellable: true });
    } catch (e) {
      toast({ title: "No se pudo preparar el salón", description: warehouseErrorMessage(e), variant: "error" });
    }
  }

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
      description="El stock de cada sucursal separado en salón de ventas, reserva, devoluciones y merma. Elegí qué se vende y desde qué sucursales, mové entre depósitos y reponé el salón."
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
          scrollOnMobile
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
        {canManage && ready && warehouses.length > 0 && (
          <div className="mt-3 flex items-start justify-between gap-3 rounded-lg bg-muted/40 p-3 text-sm">
            <span>
              <span className="block font-medium">Vender de los depósitos si el salón no alcanza</span>
              <span className="block text-xs text-muted-foreground">
                {sellFromReserve
                  ? "La venta toma lo que falta de los depósitos que se venden, por prioridad, y te avisa para reponer el salón."
                  : "Apagado: si el salón no alcanza y no permitís vender sin stock, la venta se frena hasta que repongas."}
              </span>
            </span>
            <Switch
              label="Vender de la reserva"
              checked={sellFromReserve}
              disabled={saveSellFromReserve.isPending}
              onCheckedChange={(v) =>
                saveSellFromReserve.mutate(v, {
                  onError: (e) =>
                    toast({
                      title: warehouseErrorMessage(e),
                      variant: "error",
                    }),
                })
              }
            />
          </div>
        )}
        {!whLoading && warehouses.length === 0 ? (
          <EmptyState
            className="mt-4"
            icon={WarehouseIcon}
            title="Todavía no separaste el stock"
            description="Creá un depósito (por ejemplo, Reserva). El salón de ventas se crea solo y queda con todo el stock de la sucursal."
            action={
              canManage && ready && multiStore ? (
                <Button size="sm" variant="secondary" onClick={setupSalon} loading={m.setupPrincipal.isPending}>
                  <StoreIcon size={15} /> Vender el salón desde otras sucursales
                </Button>
              ) : undefined
            }
          />
        ) : (
          <ul className="mt-3 grid gap-2 sm:grid-cols-2 xl:grid-cols-3" aria-label="Depósitos">
            {warehouses.map((w) => {
              const sellable = isSellable(w);
              const usedBy = warehouseUsedBy(w, ownLinks, storeName);
              return (
                <li key={w.id} className="flex items-start gap-2 rounded-lg bg-muted/50 p-3 text-sm">
                  <div className="min-w-0 flex-1">
                    <p className="flex flex-wrap items-center gap-x-2 gap-y-1">
                      <span className="truncate font-medium">{w.name}</span>
                      <span className="text-xs text-muted-foreground">{WAREHOUSE_KIND_LABEL[w.kind]}</span>
                    </p>
                    <p className="mt-1.5 flex flex-wrap items-center gap-1.5">
                      <Badge tone={sellable ? "success" : "neutral"}>{sellable ? "Se vende" : "No se vende"}</Badge>
                      {sellable && w.kind !== "principal" && (
                        <Badge tone="neutral">Prioridad {w.sale_priority ?? 100}</Badge>
                      )}
                    </p>
                    <p className="mt-1.5 text-xs text-muted-foreground">
                      {usedBy.length > 0 ? `También lo venden: ${usedBy.join(", ")}` : "Sólo esta sucursal"}
                    </p>
                  </div>
                  {canManage && (
                    <div className="flex shrink-0 items-center">
                      <Button size="icon" variant="ghost" aria-label={`Configurar ${w.name}`} onClick={() => setConfiguring(w)}>
                        <SlidersHorizontal size={14} />
                      </Button>
                      <Button size="icon" variant="ghost" aria-label={`Editar ${w.name}`} onClick={() => setForm({ open: true, warehouse: w })}>
                        <Pencil size={14} />
                      </Button>
                      <Button size="icon" variant="ghost" aria-label={`Dar de baja ${w.name}`} onClick={() => setArchiving(w)}>
                        <Archive size={14} />
                      </Button>
                    </div>
                  )}
                </li>
              );
            })}
          </ul>
        )}
        {incoming.length > 0 && (
          <div className="mt-4">
            <h3 className="text-sm font-semibold">Disponibles desde otras sucursales</h3>
            <p className="mt-0.5 text-xs text-muted-foreground">
              Su stock se ve en el POS de esta sucursal y se vende con retiro o envío desde allá.
            </p>
            <ul className="mt-2 flex flex-wrap gap-2">
              {incoming.map((w) => (
                <li key={w.id} className="inline-flex items-center gap-1.5 rounded-md bg-muted/50 px-2.5 py-1.5 text-xs">
                  <StoreIcon size={13} className="text-muted-foreground" aria-hidden />
                  <span className="font-medium">{w.store_name}</span>
                  <span className="text-muted-foreground">· {w.kind === "principal" ? "Salón de ventas" : w.name}</span>
                </li>
              ))}
            </ul>
          </div>
        )}
      </section>

      {tab === "stock" && warehouses.length > 0 && (
        <section className="mt-6">
          <div className="relative mb-3 max-w-md">
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
          <WarehouseStockView
            rows={overview}
            warehouses={warehouses}
            thumbs={thumbs}
            loading={ovLoading}
            canManage={canManage}
            onCount={setCount}
          />
          {canManage && others.length > 0 && (
            <p className="mt-2 text-xs text-muted-foreground">
              Tocá la cantidad de un depósito para contarlo. Vendible es el salón más los depósitos que se venden. Para productos que todavía no están en la tabla, buscalos.
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
      {configuring && (
        <WarehouseConfigModal
          warehouse={configuring}
          linkedStoreIds={ownLinks.filter((l) => l.warehouse_id === configuring.id).map((l) => l.store_id)}
          stores={stores}
          multiStore={multiStore}
          onOpenChange={(o) => !o && setConfiguring(null)}
        />
      )}

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
