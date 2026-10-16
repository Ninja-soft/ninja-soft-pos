"use client";

import { useEffect, useMemo, useState } from "react";
import Link from "next/link";
import type { Route } from "next";
import { ArrowLeftRight, ArrowRight, FileText, Lock, PackageCheck, PackageX, Plus, ScanLine, Send, Split, Truck, Wrench } from "lucide-react";
import { RemitoIssueModal, type RemitoSource } from "@/components/remitos/RemitoIssueModal";
import { RemitoDetailModal } from "@/components/remitos/RemitoDetailModal";
import { LogisticsNav } from "@/components/logistics/LogisticsNav";
import { ShipmentFormModal } from "@/components/shipping/ShipmentFormModal";
import { DispatchScanModal } from "@/components/logistics/expedition/ScanModal";
import { DamageModal, PartialDeliverModal, RequestStockModal, ResolveIssueModal } from "@/components/logistics/expedition/ExpeditionModals";
import { useExpeditionSettings } from "@/modules/logistics/expedition";
import { Switch } from "@/components/ui/Switch";
import { shippingApi } from "@/modules/shipping/api";
import { shippingErrorMessage } from "@/lib/shipping/form";
import { statusLabel as shipmentStatusLabel } from "@/lib/shipping/status";
import type { DispatchShipmentSource } from "@/lib/shipping/fromDispatch";
import { remitosApi } from "@/modules/remitos/api";
import { remitoErrorMessage } from "@/lib/remitos/logic";
import { PageContainer, PageHeader } from "@/components/ui/PageHeader";
import { Button, buttonVariants } from "@/components/ui/Button";
import { Badge, type BadgeTone } from "@/components/ui/Badge";
import { Input } from "@/components/ui/Input";
import { Modal } from "@/components/ui/Modal";
import { Segmented } from "@/components/ui/Segmented";
import { EmptyState } from "@/components/ui/EmptyState";
import { useToast } from "@/components/ui/Toast";
import { UpgradeModal } from "@/components/saas/UpgradeModal";
import { cn } from "@/lib/utils/cn";
import { formatQty } from "@/lib/utils/format";
import {
  DELIVERY_TYPE_LABEL,
  DISPATCH_ACTION_LABEL,
  DISPATCH_PROBLEM_LABEL,
  dispatchProblems,
  DISPATCH_STATUS_LABEL,
  EXPEDITION_TABS,
  crossBranchAllowed,
  enabledDeliveryTypes,
  expeditionCounts,
  expeditionList,
  orderErrorMessage,
  pickupFailureText,
  primaryDispatchAction,
  type DeliveryFilter,
  type DeliveryType,
  type DispatchStatus,
  type ExpeditionTab,
} from "@/lib/orders/logic";
import { useFeature } from "@/modules/saas/gating";
import { useMyTenant } from "@/modules/tenants/hooks";
import { useBranchContext } from "@/modules/branches/hooks";
import { useStores } from "@/modules/stock/hooks";
import { useDispatches, useOrderConfig, useOrderMutations, useSalePending, type Dispatch } from "@/modules/orders/hooks";
import { fmtDateTime, selectCls } from "@/components/stock/transfers/shared";
import type { GeoAddress } from "@/lib/geo/address";

const STATUS_TONE: Record<DispatchStatus, BadgeTone> = {
  pendiente: "info",
  armando: "brand",
  listo: "success",
  en_transito: "warning",
  entregado: "neutral",
  despachado: "neutral",
  cancelado: "neutral",
};

const MODE_OPTIONS: { value: DeliveryFilter; label: string }[] = [
  { value: "todos", label: "Todo" },
  { value: "retiro", label: "Retiro" },
  { value: "envio", label: "Envío" },
];

// Expedición (F11 · H32, ADR-129; ordenada en ADR-149 · L0): ventas pagadas
// con entrega pendiente. Pestañas por estado (Pendientes, Armando, Listos, En
// camino, Entregados), filtro por sucursal y por modo. Mobile-first: una
// tarjeta por entrega con lo que hay que armar, a quién y dónde, y un botón
// grande con el paso siguiente. Cada paso queda con quién y cuándo.
export default function ExpedicionPage() {
  const enabled = useFeature("pedidos_despacho");
  const { toast } = useToast();
  const { data: me } = useMyTenant();
  const canOperate = Boolean(me && me.role !== "viewer");
  const canManage = Boolean(me?.canManage);
  const ctx = useBranchContext();
  const { data: stores = [] } = useStores();
  const [storeId, setStoreId] = useState<string | null>(null);
  const [tab, setTab] = useState<ExpeditionTab>("pendientes");
  const [mode, setMode] = useState<DeliveryFilter>("todos");
  const [showImmediate, setShowImmediate] = useState(false);
  const [upgradeOpen, setUpgradeOpen] = useState(false);
  const [delivering, setDelivering] = useState<Dispatch | null>(null);
  const [shipping, setShipping] = useState<Dispatch | null>(null);
  const [cancelling, setCancelling] = useState<Dispatch | null>(null);
  const [adding, setAdding] = useState(false);
  const m = useOrderMutations();
  // ADR-165 (L5): escaneo, roturas, entrega parcial, problemas y pedido de stock.
  const { data: exp } = useExpeditionSettings(enabled === true);
  const traslados = useFeature("traslados") === true;
  const [scanning, setScanning] = useState<{ d: Dispatch; stage: "armado" | "entrega" } | null>(null);
  const [damaging, setDamaging] = useState<Dispatch | null>(null);
  const [partial, setPartial] = useState<Dispatch | null>(null);
  const [resolving, setResolving] = useState<Dispatch | null>(null);
  const [requesting, setRequesting] = useState<Dispatch | null>(null);
  const hasItems = (d: Dispatch) => (d.items ?? []).some((i) => Boolean(i.id) && i.qty > 0);
  const scanStage = (d: Dispatch): "armado" | "entrega" | null => {
    if (!exp || !hasItems(d)) return null;
    if (exp.scan_on_pick !== "no" && (d.status === "pendiente" || d.status === "armando")) return "armado";
    if (exp.scan_on_deliver !== "no" && d.status === "listo" && d.delivery_type === "retiro" && !d.route_id) return "entrega";
    return null;
  };
  const canPartial = (d: Dispatch) =>
    hasItems(d) &&
    !d.route_id &&
    ((d.status === "listo" && d.delivery_type === "retiro" && !d.has_pickup_code && (d.fulfillment_store_id === d.store_id || Boolean(d.arrived_at))) ||
      (d.status === "despachado" && d.delivery_type === "envio" && !d.shipment_id));
  const canDamage = (d: Dispatch) => hasItems(d) && ["pendiente", "armando", "listo"].includes(d.status);
  const canRequest = (d: Dispatch) =>
    traslados && canManage && stores.length > 1 && hasItems(d) && ["pendiente", "armando"].includes(d.status) && !d.awaiting_transfer_id;
  // ADR-149 (A11): crear el envío con logística desde la entrega, precargado.
  const enviosOn = useFeature("envios") === true;
  const [shipSource, setShipSource] = useState<DispatchShipmentSource | null>(null);
  const [shipBusy, setShipBusy] = useState<string | null>(null);
  // Sólo envíos a domicilio que todavía no salieron y no tienen uno vivo.
  const canCreateShipment = (d: Dispatch) =>
    enviosOn && canOperate && d.delivery_type === "envio" && !d.shipment_id && ["pendiente", "armando", "listo"].includes(d.status);

  async function openShipment(d: Dispatch) {
    setShipBusy(d.id);
    try {
      setShipSource(await shippingApi.dispatchSource(d.id));
    } catch (e) {
      toast({ title: "No se pudo preparar el envío", description: shippingErrorMessage(e), variant: "error" });
    } finally {
      setShipBusy(null);
    }
  }
  // ADR-136: remito de cada entrega.
  const remitosOn = useFeature("entregas_remitos") === true;
  const [remitoIssue, setRemitoIssue] = useState<RemitoSource | null>(null);
  const [remitoOpen, setRemitoOpen] = useState<string | null>(null);
  const [remitoBusy, setRemitoBusy] = useState<string | null>(null);

  async function openRemito(d: Dispatch) {
    setRemitoBusy(d.id);
    try {
      const existing = await remitosApi.forDispatch(d.id);
      if (existing) setRemitoOpen(existing.id);
      else
        setRemitoIssue({
          dispatchId: d.id,
          saleId: d.sale_id,
          label: `Entrega N° ${d.number} · Venta #${d.sale?.number ?? "-"}`,
          kind: d.delivery_type === "envio" ? "envio" : "entrega",
          receiverName: d.pickup_name ?? d.customer_name,
          deliveryAddress: d.ship_address,
        });
    } catch (e) {
      toast({ title: "No se pudo abrir el remito", description: remitoErrorMessage(e), variant: "error" });
    } finally {
      setRemitoBusy(null);
    }
  }

  useEffect(() => {
    if (storeId === null && ctx.ready) setStoreId(ctx.posStoreId ?? ctx.filterStoreId ?? "");
  }, [ctx.ready, ctx.posStoreId, ctx.filterStoreId, storeId]);

  const open = tab !== "entregados";
  const { data: all = [], isLoading } = useDispatches(storeId || null, open, enabled === true);
  const list = useMemo(
    () => expeditionList(all, { tab, storeId: storeId || null, mode, showImmediate }),
    [all, tab, storeId, mode, showImmediate],
  );
  // Los números de las pestañas abiertas (Entregados no lleva número).
  const counts = useMemo(() => expeditionCounts(open ? all : [], storeId || null, mode), [all, open, storeId, mode]);
  const storeName = (id: string | null) => stores.find((s) => s.id === id)?.name ?? "Sucursal";

  async function advance(d: Dispatch, to: "armando" | "listo" | "en_transito" | "pendiente") {
    try {
      await m.advance.mutateAsync({ id: d.id, to });
      toast({ title: `Entrega N° ${d.number}: ${DISPATCH_STATUS_LABEL[to === "listo" && d.status === "en_transito" ? "listo" : to].toLowerCase()}`, variant: "success" });
    } catch (e) {
      toast({ title: "No se pudo actualizar", description: orderErrorMessage(e), variant: "error" });
    }
  }

  function primary(d: Dispatch) {
    const a = primaryDispatchAction(d);
    if (a === "armando") return advance(d, "armando");
    if (a === "listo") return advance(d, "listo");
    if (a === "en_transito") return advance(d, "en_transito");
    if (a === "recibir") return advance(d, "listo");
    if (a === "entregar") return setDelivering(d);
    if (a === "despachar") return setShipping(d);
  }

  const header = (
    <PageHeader
      eyebrow="Operación"
      title="Expedición"
      icon={PackageCheck}
      description="Ventas cobradas que esperan armado y entrega: retiro en la sucursal o envío a domicilio."
      actions={
        enabled && canOperate ? (
          <>
            <Button onClick={() => setAdding(true)}>
              <Plus size={16} /> Agregar una entrega
            </Button>
            <Link href={"/pedidos" as Route} className={buttonVariants({ variant: "secondary" })}>
              Pedidos de salón
            </Link>
          </>
        ) : undefined
      }
    />
  );

  if (enabled === false) {
    return (
      <PageContainer>
        {header}
        <LogisticsNav className="mt-4" />
        <div className="mt-8 rounded-lg bg-muted/40 p-8 text-center">
          <Lock className="mx-auto text-ninja-flameSoft" size={28} />
          <p className="mt-3 font-semibold">La expedición no está incluida en tu plan</p>
          <p className="mx-auto mt-1 max-w-md text-sm text-muted-foreground">
            Organizá el armado y la entrega de lo que ya cobraste, con quién y cuándo en cada paso.
          </p>
          <Button className="mt-4" onClick={() => setUpgradeOpen(true)}>
            Ver planes
          </Button>
          <UpgradeModal open={upgradeOpen} onOpenChange={setUpgradeOpen} featureKey="pedidos_despacho" featureLabel="Pedidos de salón y expedición" />
        </div>
      </PageContainer>
    );
  }

  return (
    <PageContainer>
      {header}
      <LogisticsNav className="mt-4" />

      <div className="mt-5 flex flex-col gap-3 lg:flex-row lg:items-center">
        {stores.length > 1 && (
          <select
            aria-label="Sucursal"
            className={cn(selectCls, "h-10 sm:max-w-[14rem]")}
            value={storeId ?? ""}
            onChange={(e) => setStoreId(e.target.value)}
          >
            <option value="" className="bg-popover text-popover-foreground">
              Todas las sucursales
            </option>
            {stores.map((s) => (
              <option key={s.id} value={s.id} className="bg-popover text-popover-foreground">
                {s.name}
              </option>
            ))}
          </select>
        )}
        <Segmented<ExpeditionTab>
          scrollOnMobile
          aria-label="Estado"
          value={tab}
          onChange={setTab}
          size="sm"
          options={EXPEDITION_TABS.map((t) => ({
            value: t.value,
            label: t.value !== "entregados" && counts[t.value] ? `${t.label} (${counts[t.value]})` : t.label,
          }))}
        />
        <Segmented<DeliveryFilter> aria-label="Modo de entrega" value={mode} onChange={setMode} size="sm" options={MODE_OPTIONS} />
      </div>
      {tab === "entregados" && (
        <div className="mt-3 flex items-center gap-3 text-sm text-muted-foreground">
          <Switch label="Mostrar lo que se llevó en el momento" checked={showImmediate} onCheckedChange={setShowImmediate} />
          <span>Mostrar lo que se llevó en el momento</span>
        </div>
      )}

      <section className="mt-6">
        {isLoading ? (
          <p className="py-8 text-center text-sm text-muted-foreground">Cargando entregas…</p>
        ) : list.length === 0 ? (
          <EmptyState
            icon={PackageCheck}
            title={tab === "entregados" ? "Todavía no hay entregas cerradas" : tab === "problemas" ? "Nada con problemas" : "No hay nada acá"}
            description="Cuando la caja cobra con retiro o envío, la entrega aparece en Pendientes. También podés sumar una entrega a una venta ya cobrada."
          />
        ) : (
          <ul className="grid gap-3 md:grid-cols-2">
            {list.map((d) => {
              const action = primaryDispatchAction(d);
              const cross = d.fulfillment_store_id !== d.store_id;
              // ADR-136: una entrega de una venta partida trae sus propios renglones.
              const partItems = d.items ?? [];
              const items =
                partItems.length > 0
                  ? partItems.map((i) => ({
                      product_name: i.variant_label ? `${i.product_name} (${i.variant_label})` : i.product_name,
                      quantity: i.qty,
                      returned_qty: 0,
                      unit_label: i.unit,
                    }))
                  : (d.sale?.items ?? []).filter((i) => Number(i.quantity) - Number(i.returned_qty ?? 0) > 0);
              const soldElsewhere = Boolean(d.sale_store_id && d.sale_store_id !== d.store_id);
              return (
                <li key={d.id} className="flex flex-col rounded-xl bg-card p-4">
                  <div className="flex items-start justify-between gap-2">
                    <div className="min-w-0">
                      <p className="font-semibold">
                        <span className="tabular-nums">N° {d.number}</span>
                        {d.pickup_name || d.customer_name ? ` · ${d.pickup_name ?? d.customer_name}` : ""}
                      </p>
                      <p className="text-xs text-muted-foreground">
                        Venta #{d.sale?.number ?? "-"}
                        {(d.parts_total ?? 1) > 1 ? ` · entrega ${d.part} de ${d.parts_total}` : ""} · {fmtDateTime(d.created_at)}
                      </p>
                    </div>
                    <Badge tone={STATUS_TONE[d.status]}>{DISPATCH_STATUS_LABEL[d.status]}</Badge>
                  </div>
                  <div className="mt-2 flex flex-wrap items-center gap-1.5 text-xs text-muted-foreground">
                    <Badge tone="neutral">{DELIVERY_TYPE_LABEL[d.delivery_type]}</Badge>
                    {cross ? (
                      <span className="inline-flex items-center gap-1">
                        {storeName(d.store_id)} <ArrowRight size={12} aria-hidden /> {storeName(d.fulfillment_store_id)}
                        {d.arrived_at ? " (llegó)" : ""}
                      </span>
                    ) : (
                      stores.length > 1 && <span>{storeName(d.store_id)}</span>
                    )}
                    {d.has_pickup_code && d.delivery_type === "retiro" && <span>· pide código</span>}
                    {soldElsewhere && <span>· vendida en {storeName(d.sale_store_id ?? null)}</span>}
                    {d.route && d.status !== "entregado" && (
                      <Link href={`/logistica/reparto?hoja=${d.route_id}` as Route} className="font-semibold text-ninja-flameSoft hover:underline">
                        En hoja N° {d.route.number}
                      </Link>
                    )}
                    {d.parent && <span>· reprogramada de la N° {d.parent.number}</span>}
                    {d.issue_open && d.issue_summary && <Badge tone="danger">{d.issue_summary}</Badge>}
                    {d.awaiting_transfer_id && <Badge tone="info">Esperando stock de otra sucursal</Badge>}
                    {!d.awaiting_transfer_id && d.stock_arrived_at && ["pendiente", "armando"].includes(d.status) && <Badge tone="success">Llegó el stock</Badge>}
                    {(d.scan_alerts ?? 0) > 0 && !["entregado", "cancelado"].includes(d.status) && (
                      <Badge tone="warning">{d.scan_alerts === 1 ? "1 lectura ajena" : `${d.scan_alerts} lecturas ajenas`}</Badge>
                    )}
                    {(d.delivery_attempts ?? 0) > 0 && d.status !== "entregado" && (
                      <Badge tone="danger">
                        {d.delivery_attempts === 1 ? "1 intento" : `${d.delivery_attempts} intentos`}
                        {d.last_failure_reason ? `: ${d.last_failure_reason}` : ""}
                      </Badge>
                    )}
                  </div>
                  <ul className="mt-3 space-y-0.5 text-sm">
                    {items.slice(0, 6).map((i, idx) => (
                      <li key={idx} className="flex justify-between gap-3">
                        <span className="truncate">{i.product_name}</span>
                        <span className="tabular-nums text-muted-foreground">
                          {formatQty(Number(i.quantity) - Number(i.returned_qty ?? 0))} {i.unit_label ?? "u"}
                        </span>
                      </li>
                    ))}
                    {items.length > 6 && <li className="text-xs text-muted-foreground">+{items.length - 6} renglones más</li>}
                  </ul>
                  {(d.ship_address || d.notes || d.tracking || d.delivered_to || d.cancel_reason || d.shipment_status) && (
                    <div className="mt-2 space-y-0.5 text-xs text-muted-foreground">
                      {d.ship_address && <p>Domicilio: {d.ship_address}</p>}
                      <ShipToExtra shipTo={d.ship_to} />
                      {d.notes && <p>Nota: {d.notes}</p>}
                      {d.shipment_status && <p>Envío con logística: {shipmentStatusLabel(d.shipment_status).toLowerCase()}</p>}
                      {d.shipped_at && d.status === "despachado" && <p>Despachado {fmtDateTime(d.shipped_at)}</p>}
                      {d.tracking && <p>Seguimiento: {d.tracking}</p>}
                      {d.delivered_to && <p>Entregado a {d.delivered_to}{d.delivered_at ? ` · ${fmtDateTime(d.delivered_at)}` : ""}</p>}
                      {d.cancel_reason && <p>Motivo: {d.cancel_reason}</p>}
                    </div>
                  )}
                  {tab === "problemas" && (
                    <ul className="mt-2 space-y-0.5 text-xs text-warning">
                      {dispatchProblems(d).map((p) => (
                        <li key={p}>{DISPATCH_PROBLEM_LABEL[p]}</li>
                      ))}
                    </ul>
                  )}
                  {canOperate && d.status !== "cancelado" && (remitosOn || canCreateShipment(d) || hasItems(d) || d.issue_open) && (
                    <div className={cn("flex flex-wrap gap-1 pt-3", !action && "mt-auto")}>
                      {d.issue_open && (
                        <Button size="sm" variant="secondary" onClick={() => setResolving(d)}>
                          <Wrench size={15} /> Resolver
                        </Button>
                      )}
                      {scanStage(d) && (
                        <Button size="sm" variant="ghost" onClick={() => setScanning({ d, stage: scanStage(d)! })}>
                          <ScanLine size={15} /> Escanear
                        </Button>
                      )}
                      {canPartial(d) && (
                        <Button size="sm" variant="ghost" onClick={() => setPartial(d)}>
                          <Split size={15} /> Entrega parcial
                        </Button>
                      )}
                      {canDamage(d) && (
                        <Button size="sm" variant="ghost" onClick={() => setDamaging(d)}>
                          <PackageX size={15} /> Algo se rompió
                        </Button>
                      )}
                      {canRequest(d) && (
                        <Button size="sm" variant="ghost" onClick={() => setRequesting(d)}>
                          <ArrowLeftRight size={15} /> Pedir a otra sucursal
                        </Button>
                      )}
                      {remitosOn && (
                        <Button size="sm" variant="ghost" onClick={() => void openRemito(d)} loading={remitoBusy === d.id}>
                          <FileText size={15} /> Remito
                        </Button>
                      )}
                      {canCreateShipment(d) && (
                        <Button size="sm" variant="ghost" onClick={() => void openShipment(d)} loading={shipBusy === d.id}>
                          <Truck size={15} /> Crear envío con logística
                        </Button>
                      )}
                    </div>
                  )}
                  {action && canOperate && (
                    <div className="mt-auto flex flex-col gap-2 pt-4 sm:flex-row">
                      <Button className="w-full sm:flex-1" onClick={() => void primary(d)} loading={m.advance.isPending && m.advance.variables?.id === d.id}>
                        {action === "despachar" ? <Send size={16} /> : null}
                        {DISPATCH_ACTION_LABEL[action]}
                      </Button>
                      {d.status === "pendiente" && (
                        <Button variant="secondary" className="w-full sm:w-auto" onClick={() => void advance(d, "listo")}>
                          Ya está listo
                        </Button>
                      )}
                      {canManage && d.status !== "despachado" && (
                        <Button variant="ghost" className="w-full text-danger sm:w-auto" onClick={() => setCancelling(d)}>
                          Cancelar
                        </Button>
                      )}
                    </div>
                  )}
                </li>
              );
            })}
          </ul>
        )}
      </section>

      <DeliverModal dispatch={delivering} onClose={() => setDelivering(null)} canOverride={canManage} />
      <ShipModal
        dispatch={shipping}
        onClose={() => setShipping(null)}
        onCreateShipment={
          shipping && canCreateShipment(shipping)
            ? () => {
                const d = shipping;
                setShipping(null);
                void openShipment(d);
              }
            : null
        }
      />
      {enviosOn && (
        <ShipmentFormModal
          open={Boolean(shipSource)}
          onOpenChange={(o) => !o && setShipSource(null)}
          stores={ctx.allowed}
          defaultStoreId={shipSource?.storeId ?? null}
          fromDispatch={shipSource}
          onCreated={(s) =>
            toast({
              title: "Envío creado y enganchado a la entrega",
              description: s.tracking_number ? `Seguimiento ${s.tracking_number}` : "Cuando esté la etiqueta, marcá la entrega como despachada.",
              variant: "success",
            })
          }
        />
      )}
      <CancelDispatchModal dispatch={cancelling} onClose={() => setCancelling(null)} />
      <DispatchScanModal dispatch={scanning?.d ?? null} stage={scanning?.stage ?? "armado"} onClose={() => setScanning(null)} />
      <DamageModal dispatch={damaging} onClose={() => setDamaging(null)} />
      <PartialDeliverModal dispatch={partial} onClose={() => setPartial(null)} />
      <ResolveIssueModal dispatch={resolving} onClose={() => setResolving(null)} />
      <RequestStockModal dispatch={requesting} onClose={() => setRequesting(null)} />
      <AddSaleModal open={adding} onOpenChange={setAdding} stores={stores} defaultStoreId={storeId || null} />
      <RemitoIssueModal
        source={remitoIssue}
        onClose={() => setRemitoIssue(null)}
        onIssued={(id) => {
          setRemitoIssue(null);
          setRemitoOpen(id);
        }}
      />
      <RemitoDetailModal id={remitoOpen} canManage={canManage} onClose={() => setRemitoOpen(null)} />
    </PageContainer>
  );
}

function DeliverModal({ dispatch, onClose, canOverride }: { dispatch: Dispatch | null; onClose: () => void; canOverride: boolean }) {
  const { toast } = useToast();
  const m = useOrderMutations();
  const [code, setCode] = useState("");
  const [to, setTo] = useState("");
  const [override, setOverride] = useState(false);
  const [reason, setReason] = useState("");
  useEffect(() => {
    setCode("");
    setTo(dispatch?.pickup_name ?? dispatch?.customer_name ?? "");
    setOverride(false);
    setReason("");
  }, [dispatch]);
  if (!dispatch) return null;
  const needsCode = dispatch.has_pickup_code;
  const needsName = dispatch.delivery_type === "retiro";
  const ready =
    (!needsName || to.trim().length >= 2) &&
    (!needsCode || (override ? reason.trim().length >= 3 : /^[0-9]{6}$/.test(code.trim())));

  async function submit() {
    if (!dispatch) return;
    try {
      const r = await m.deliver.mutateAsync({
        id: dispatch.id,
        code: needsCode && !override ? code.trim() : null,
        deliveredTo: to.trim() || null,
        overrideReason: needsCode && override ? reason.trim() : null,
      });
      if (!r.ok) {
        toast({ title: "No se entregó", description: pickupFailureText(r.error ?? "", r.attempts_left ?? 0), variant: "error" });
        return;
      }
      toast({ title: `Entrega N° ${dispatch.number} entregada`, variant: "success" });
      onClose();
    } catch (e) {
      toast({ title: "No se pudo entregar", description: orderErrorMessage(e), variant: "error" });
    }
  }

  return (
    <Modal
      open
      onOpenChange={(o) => !o && onClose()}
      title={`Entregar N° ${dispatch.number}`}
      description={
        needsCode
          ? "Pedile al cliente el código de 6 dígitos que le dieron al comprar."
          : dispatch.status === "despachado"
            ? "Confirmá que el envío llegó a destino."
            : "Confirmá a quién se lo entregás."
      }
      footer={
        <>
          <Button variant="secondary" onClick={onClose}>
            Volver
          </Button>
          <Button onClick={submit} disabled={!ready} loading={m.deliver.isPending}>
            Entregar
          </Button>
        </>
      }
    >
      <div className="space-y-4">
        {needsCode && !override && (
          <Input
            label="Código de retiro"
            value={code}
            onChange={(e) => setCode(e.target.value.replace(/\D/g, "").slice(0, 6))}
            inputMode="numeric"
            autoComplete="one-time-code"
            className="font-mono text-lg tracking-[0.3em]"
          />
        )}
        <Input label={needsName ? "Retira" : "Entregado a (opcional)"} value={to} onChange={(e) => setTo(e.target.value)} maxLength={120} />
        {needsCode && canOverride && (
          <label className="flex items-center gap-2 text-sm">
            <input type="checkbox" checked={override} onChange={(e) => setOverride(e.target.checked)} />
            El cliente no tiene el código (entrega con motivo)
          </label>
        )}
        {override && <Input label="Motivo" value={reason} onChange={(e) => setReason(e.target.value)} maxLength={300} />}
        {dispatch.failed_attempts > 0 && (
          <p className="text-xs text-warning">Intentos fallidos: {dispatch.failed_attempts} de 5.</p>
        )}
      </div>
    </Modal>
  );
}

function ShipModal({
  dispatch,
  onClose,
  onCreateShipment,
}: {
  dispatch: Dispatch | null;
  onClose: () => void;
  onCreateShipment: (() => void) | null;
}) {
  const { toast } = useToast();
  const m = useOrderMutations();
  const [tracking, setTracking] = useState("");
  useEffect(() => setTracking(dispatch?.tracking ?? ""), [dispatch]);
  if (!dispatch) return null;
  async function submit() {
    if (!dispatch) return;
    try {
      // A5: con el envío de esta entrega (si tiene); el servidor no adivina.
      await m.ship.mutateAsync({ id: dispatch.id, tracking: tracking.trim() || null, shipmentId: dispatch.shipment_id });
      toast({ title: `Entrega N° ${dispatch.number} despachada`, variant: "success" });
      onClose();
    } catch (e) {
      toast({ title: "No se pudo despachar", description: orderErrorMessage(e), variant: "error" });
    }
  }
  return (
    <Modal
      open
      onOpenChange={(o) => !o && onClose()}
      title={`Despachar N° ${dispatch.number}`}
      description={
        dispatch.shipment_id
          ? "Sale con el envío con logística de esta entrega: se cierra sola cuando la logística lo entrega."
          : "Sin logística (cadete propio): queda En camino hasta que la marques entregada."
      }
      footer={
        <>
          {onCreateShipment && (
            <Button variant="secondary" onClick={onCreateShipment}>
              <Truck size={16} /> Crear envío con logística
            </Button>
          )}
          <Button onClick={submit} loading={m.ship.isPending}>
            Marcar despachado
          </Button>
        </>
      }
    >
      <div className="space-y-3">
        {dispatch.ship_address && <p className="text-sm">Domicilio: {dispatch.ship_address}</p>}
        <ShipToExtra shipTo={dispatch.ship_to} />
        <Input label="Seguimiento (opcional)" value={tracking} onChange={(e) => setTracking(e.target.value)} maxLength={120} />
      </div>
    </Modal>
  );
}

function CancelDispatchModal({ dispatch, onClose }: { dispatch: Dispatch | null; onClose: () => void }) {
  const { toast } = useToast();
  const m = useOrderMutations();
  const [reason, setReason] = useState("");
  useEffect(() => setReason(""), [dispatch]);
  if (!dispatch) return null;
  async function submit() {
    if (!dispatch) return;
    try {
      await m.cancelDispatch.mutateAsync({ id: dispatch.id, reason: reason.trim() });
      toast({ title: `Entrega N° ${dispatch.number} cancelada`, description: "La venta no cambia: para devolver, usá Devoluciones.", variant: "success" });
      onClose();
    } catch (e) {
      toast({ title: "No se pudo cancelar", description: orderErrorMessage(e), variant: "error" });
    }
  }
  return (
    <Modal
      open
      onOpenChange={(o) => !o && onClose()}
      title={`Cancelar la entrega N° ${dispatch.number}`}
      description="Sale de la cola de expedición. La venta queda como está."
      footer={
        <>
          <Button variant="secondary" onClick={onClose}>
            Volver
          </Button>
          <Button variant="destructive" onClick={submit} disabled={reason.trim().length < 3} loading={m.cancelDispatch.isPending}>
            Cancelar entrega
          </Button>
        </>
      }
    >
      <Input label="Motivo" value={reason} onChange={(e) => setReason(e.target.value)} maxLength={300} />
    </Modal>
  );
}

function AddSaleModal({
  open,
  onOpenChange,
  stores,
  defaultStoreId,
}: {
  open: boolean;
  onOpenChange: (o: boolean) => void;
  stores: { id: string; name: string }[];
  defaultStoreId: string | null;
}) {
  const { toast } = useToast();
  const m = useOrderMutations();
  const { config } = useOrderConfig(open);
  const types = enabledDeliveryTypes(config).filter((t) => t !== "inmediato");
  const [saleNumber, setSaleNumber] = useState("");
  const [type, setType] = useState<DeliveryType>("retiro");
  const [ful, setFul] = useState("");
  const [name, setName] = useState("");
  const [address, setAddress] = useState("");
  const [code, setCode] = useState<{ number: number; code: string } | null>(null);
  useEffect(() => {
    if (!open) return;
    setSaleNumber("");
    setType(types[0] ?? "retiro");
    setFul("");
    setName("");
    setAddress("");
    setCode(null);
    // Sólo al abrir.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);
  const cross = crossBranchAllowed(config, type) && stores.length > 1;
  const n = Number(saleNumber);
  // ADR-149 (A1): lo que falta entregar de la venta, con una pausa al tipear.
  const [lookup, setLookup] = useState<number | null>(null);
  useEffect(() => {
    const t = setTimeout(() => setLookup(Number.isInteger(n) && n > 0 ? n : null), 400);
    return () => clearTimeout(t);
  }, [n]);
  const pending = useSalePending(open ? lookup : null);
  const pendingItems = (pending.data?.items ?? []).filter((i) => Number(i.pending) > 0);
  const nothingLeft = Boolean(pending.data && pending.data.items.length > 0 && pendingItems.length === 0);
  const ready =
    Number.isInteger(n) &&
    n > 0 &&
    !nothingLeft &&
    pending.data?.status !== "voided" &&
    (type !== "retiro" || name.trim().length >= 2) &&
    (type !== "envio" || address.trim().length >= 5);

  async function submit() {
    try {
      const r = await m.forSale.mutateAsync({
        saleNumber: n,
        delivery_type: type,
        fulfillment_store_id: cross && ful ? ful : null,
        pickup_name: type === "retiro" ? name.trim() : null,
        ship_address: type === "envio" ? address.trim() : null,
      });
      if (r.pickup_code) setCode({ number: r.number, code: r.pickup_code });
      else {
        toast({ title: `Entrega N° ${r.number} agregada a la venta #${n}`, variant: "success" });
        onOpenChange(false);
      }
    } catch (e) {
      toast({ title: "No se pudo agregar", description: orderErrorMessage(e), variant: "error" });
    }
  }

  if (code) {
    return (
      <Modal
        open={open}
        onOpenChange={onOpenChange}
        title={`Entrega N° ${code.number} creada`}
        description="Pasale el código al cliente: lo vas a ver una sola vez."
        footer={<Button onClick={() => onOpenChange(false)}>Listo</Button>}
      >
        <p className="text-center font-mono text-4xl font-bold tracking-[0.3em] tabular-nums">{code.code}</p>
      </Modal>
    );
  }

  return (
    <Modal
      open={open}
      onOpenChange={onOpenChange}
      title="Agregar una entrega"
      description="Para una venta ya cobrada: suma una entrega con lo que todavía falta entregar, aunque ya se haya llevado una parte."
      footer={
        <>
          <Button variant="secondary" onClick={() => onOpenChange(false)}>
            Cancelar
          </Button>
          <Button onClick={submit} disabled={!ready || types.length === 0} loading={m.forSale.isPending}>
            Agregar
          </Button>
        </>
      }
    >
      <div className="space-y-4">
        <Input label="Número de venta" value={saleNumber} onChange={(e) => setSaleNumber(e.target.value.replace(/\D/g, ""))} inputMode="numeric" />
        {lookup && (
          <div className="rounded-lg bg-muted/50 p-3 text-sm" aria-live="polite">
            {pending.isLoading ? (
              <p className="text-muted-foreground">Buscando la venta…</p>
            ) : pending.error ? (
              <p className="text-warning">{orderErrorMessage(pending.error)}</p>
            ) : pending.data?.status === "voided" ? (
              <p className="text-warning">Esa venta está anulada.</p>
            ) : nothingLeft ? (
              <p className="text-muted-foreground">De esa venta ya no queda nada por entregar.</p>
            ) : pendingItems.length > 0 ? (
              <>
                <p className="mb-1 font-medium">Falta entregar</p>
                <ul className="space-y-0.5">
                  {pendingItems.map((i) => (
                    <li key={`${i.product_id}:${i.variant_id ?? ""}`} className="flex justify-between gap-3">
                      <span className="truncate">{i.name}</span>
                      <span className="tabular-nums text-muted-foreground">
                        {formatQty(Number(i.pending))} de {formatQty(Number(i.sold))}
                      </span>
                    </li>
                  ))}
                </ul>
              </>
            ) : null}
          </div>
        )}
        {types.length > 1 && (
          <Segmented<DeliveryType>
            scrollOnMobile
            size="sm"
            aria-label="Tipo de entrega"
            value={type}
            onChange={setType}
            options={types.map((t) => ({ value: t, label: DELIVERY_TYPE_LABEL[t] }))}
          />
        )}
        {types.length === 0 && <p className="text-sm text-muted-foreground">Habilitá el retiro o el envío en Configuración.</p>}
        {cross && (
          <select
            aria-label={type === "envio" ? "Sale desde" : "Retira en"}
            className={cn(selectCls, "h-11 w-full")}
            value={ful || defaultStoreId || ""}
            onChange={(e) => setFul(e.target.value)}
          >
            {stores.map((s) => (
              <option key={s.id} value={s.id} className="bg-popover text-popover-foreground">
                {type === "envio" ? `Sale desde ${s.name}` : `Retira en ${s.name}`}
              </option>
            ))}
          </select>
        )}
        {type === "retiro" && <Input label="Retira a nombre de" value={name} onChange={(e) => setName(e.target.value)} maxLength={120} />}
        {type === "envio" && <Input label="Domicilio de entrega" value={address} onChange={(e) => setAddress(e.target.value)} maxLength={300} />}
      </div>
    </Modal>
  );
}

// ADR-157: lo que suma la dirección estructurada (referencia, contacto y mapa).
function ShipToExtra({ shipTo }: { shipTo?: GeoAddress | null }) {
  if (!shipTo) return null;
  const hasPin = shipTo.lat != null && shipTo.lng != null;
  return (
    <>
      {(shipTo.reference || shipTo.between_streets) && <p>Referencia: {[shipTo.between_streets, shipTo.reference].filter(Boolean).join(" · ")}</p>}
      {(shipTo.contact_name || shipTo.contact_phone) && <p>Recibe: {[shipTo.contact_name, shipTo.contact_phone].filter(Boolean).join(" · ")}</p>}
      {hasPin && (
        <p>
          <a
            href={`https://www.openstreetmap.org/?mlat=${shipTo.lat}&mlon=${shipTo.lng}#map=18/${shipTo.lat}/${shipTo.lng}`}
            target="_blank"
            rel="noopener noreferrer"
            className="font-medium text-foreground underline-offset-2 hover:underline"
          >
            Ver en el mapa
          </a>
        </p>
      )}
    </>
  );
}
