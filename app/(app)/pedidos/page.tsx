"use client";

import { useEffect, useMemo, useState } from "react";
import Link from "next/link";
import type { Route } from "next";
import { ClipboardList, Lock, PackageCheck, ShoppingCart } from "lucide-react";
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
import { formatCurrency, formatQty } from "@/lib/utils/format";
import {
  DELIVERY_TYPE_LABEL,
  ORDER_STATUS_LABEL,
  orderErrorMessage,
  orderIsOpen,
  orderReservationState,
  reservationLabel,
  type OrderStatus,
} from "@/lib/orders/logic";
import { readPausedCart } from "@/modules/paused-sales/logic";
import { whatsappUrl } from "@/lib/quotes/logic";
import { useFeature } from "@/modules/saas/gating";
import { useMyTenant } from "@/modules/tenants/hooks";
import { useBranchContext } from "@/modules/branches/hooks";
import { useStores } from "@/modules/stock/hooks";
import { useOrderMutations, useSaleOrders, type SaleOrder } from "@/modules/orders/hooks";
import { fmtDateTime, selectCls } from "@/components/stock/transfers/shared";

type Tab = "open" | "history";

const STATUS_TONE: Record<OrderStatus, BadgeTone> = {
  abierto: "info",
  tomado: "brand",
  cobrado: "success",
  anulado: "neutral",
  vencido: "warning",
};

// Pedidos de salón (F11 · H32, ADR-129): lo que armaron los vendedores y
// espera caja, con la reserva de stock y su vencimiento; la caja los cobra
// desde el POS. Historial con cobrados, anulados y vencidos. Los pedidos que
// hizo el cliente en el catálogo público (ADR-130) llevan la marca, su email y
// el WhatsApp para escribirle.
export default function PedidosPage() {
  const enabled = useFeature("pedidos_despacho");
  const { toast } = useToast();
  const { data: me } = useMyTenant();
  const canOperate = Boolean(me && me.role !== "viewer");
  const ctx = useBranchContext();
  const { data: stores = [] } = useStores();
  const [storeId, setStoreId] = useState<string | null>(null);
  const [tab, setTab] = useState<Tab>("open");
  const [upgradeOpen, setUpgradeOpen] = useState(false);
  const [cancelling, setCancelling] = useState<SaleOrder | null>(null);
  const [reason, setReason] = useState("");
  const m = useOrderMutations();

  useEffect(() => {
    if (storeId === null && ctx.ready) setStoreId(ctx.filterStoreId ?? "");
  }, [ctx.ready, ctx.filterStoreId, storeId]);

  const { data: list = [], isLoading } = useSaleOrders(storeId || null, tab === "open", enabled === true);
  const now = useMemo(() => new Date(), [list]); // eslint-disable-line react-hooks/exhaustive-deps
  const storeName = (id: string | null) => stores.find((s) => s.id === id)?.name ?? "Sucursal";

  async function confirmCancel() {
    if (!cancelling) return;
    try {
      await m.cancel.mutateAsync({ id: cancelling.id, reason: reason.trim() });
      toast({ title: `Pedido N° ${cancelling.number} anulado`, description: "El stock reservado quedó libre.", variant: "success" });
      setCancelling(null);
      setReason("");
    } catch (e) {
      toast({ title: "No se pudo anular", description: orderErrorMessage(e), variant: "error" });
    }
  }

  const header = (
    <PageHeader
      eyebrow="Operación"
      title="Pedidos de salón"
      icon={ClipboardList}
      description="El vendedor arma el pedido en el POS, la caja lo levanta y lo cobra, y expedición lo entrega."
      actions={
        enabled ? (
          <>
            <Link href={"/pos" as Route} className={buttonVariants({})}>
              <ShoppingCart size={16} /> Armar un pedido
            </Link>
            <Link href={"/expedicion" as Route} className={buttonVariants({ variant: "secondary" })}>
              <PackageCheck size={16} /> Expedición
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
        <div className="mt-8 rounded-lg bg-muted/40 p-8 text-center">
          <Lock className="mx-auto text-ninja-flameSoft" size={28} />
          <p className="mt-3 font-semibold">Los pedidos de salón no están incluidos en tu plan</p>
          <p className="mx-auto mt-1 max-w-md text-sm text-muted-foreground">
            Que el vendedor arme el pedido con el stock reservado y la caja lo cobre, con la entrega organizada en expedición.
          </p>
          <Button className="mt-4" onClick={() => setUpgradeOpen(true)}>
            Ver planes
          </Button>
          <UpgradeModal
            open={upgradeOpen}
            onOpenChange={setUpgradeOpen}
            featureKey="pedidos_despacho"
            featureLabel="Pedidos de salón"
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
        <Segmented<Tab>
          scrollOnMobile
          aria-label="Vista"
          value={tab}
          onChange={setTab}
          size="sm"
          options={[
            { value: "open", label: "Esperando caja" },
            { value: "history", label: "Historial" },
          ]}
        />
      </div>

      <section className="mt-6">
        {isLoading ? (
          <p className="py-8 text-center text-sm text-muted-foreground">Cargando pedidos…</p>
        ) : list.length === 0 ? (
          <EmptyState
            icon={ClipboardList}
            title={tab === "open" ? "No hay pedidos esperando caja" : "Todavía no hay historial"}
            description="Desde el POS, tocá Pedido para guardar el carrito: queda acá con el stock reservado hasta que la caja lo cobre."
          />
        ) : (
          <ul className="divide-y divide-border">
            {list.map((o) => {
              const cart = readPausedCart(o.cart);
              const lines = cart?.lines ?? [];
              const open = orderIsOpen(o);
              const res = orderReservationState(o, now);
              const cross = o.fulfillment_store_id !== o.store_id;
              return (
                <li key={o.id} className="py-4">
                  <div className="flex flex-wrap items-start justify-between gap-2">
                    <div className="min-w-0">
                      <p className="font-semibold">
                        <span className="tabular-nums">N° {o.number}</span>
                        {o.customer_name || o.pickup_name ? ` · ${o.customer_name ?? o.pickup_name}` : ""}
                      </p>
                      <p className="text-xs text-muted-foreground">
                        {o.seller_name ? `Vendedor: ${o.seller_name} · ` : ""}
                        {storeName(o.store_id)}
                        {cross ? ` · se entrega en ${storeName(o.fulfillment_store_id)}` : ""} · {fmtDateTime(o.created_at)}
                      </p>
                    </div>
                    <div className="flex flex-wrap items-center gap-2">
                      {o.source === "catalogo_publico" && <Badge tone="info">Catálogo web</Badge>}
                      <Badge tone="neutral">{DELIVERY_TYPE_LABEL[o.delivery_type]}</Badge>
                      <Badge tone={STATUS_TONE[o.status]}>{ORDER_STATUS_LABEL[o.status]}</Badge>
                    </div>
                  </div>
                  <ul className="mt-2 space-y-0.5 text-sm">
                    {lines.slice(0, 4).map((l) => (
                      <li key={l.lineId} className="flex justify-between gap-3">
                        <span className="truncate">
                          {l.name}
                          {l.variantLabel ? ` (${l.variantLabel})` : ""}
                        </span>
                        <span className="tabular-nums text-muted-foreground">
                          {formatQty(l.quantity)} {l.unit === "kg" ? "kg" : "u"}
                        </span>
                      </li>
                    ))}
                    {lines.length > 4 && <li className="text-xs text-muted-foreground">+{lines.length - 4} productos más</li>}
                  </ul>
                  <div className="mt-1 flex flex-wrap items-center gap-x-2 text-xs text-muted-foreground">
                    <span className="font-price text-sm font-semibold tabular-nums text-foreground">{formatCurrency(o.total)}</span>
                    {open && (
                      <span className={cn(res.kind === "active" && res.msLeft < 5 * 60_000 && "font-medium text-warning")}>
                        · {reservationLabel(o, now)}
                      </span>
                    )}
                    {o.ship_address && <span>· {o.ship_address}</span>}
                    {o.customer_phone && (
                      <span>
                        ·{" "}
                        {o.source === "catalogo_publico" ? (
                          <a
                            href={whatsappUrl(o.customer_phone, `Hola ${o.customer_name ?? ""}, te escribimos por tu pedido N° ${o.number}.`)}
                            target="_blank"
                            rel="noopener noreferrer"
                            className="underline underline-offset-2 hover:text-foreground"
                          >
                            {o.customer_phone}
                          </a>
                        ) : (
                          o.customer_phone
                        )}
                      </span>
                    )}
                    {o.customer_email && <span>· {o.customer_email}</span>}
                    {o.payment_preference === "link" && open && (
                      <span className="font-medium text-foreground">· Quiere pagar con link: mandáselo desde Cobrar</span>
                    )}
                    {o.cancel_reason && <span>· Motivo: {o.cancel_reason}</span>}
                    {o.notes && <span>· {o.notes}</span>}
                  </div>
                  {open && canOperate && (
                    <div className="mt-3 flex flex-wrap gap-2">
                      <Link href={`/pos?order=${o.id}` as Route} className={buttonVariants({ size: "sm" })}>
                        Cobrar en el POS
                      </Link>
                      <Button size="sm" variant="ghost" className="text-danger" onClick={() => setCancelling(o)}>
                        Anular
                      </Button>
                    </div>
                  )}
                </li>
              );
            })}
          </ul>
        )}
      </section>

      <Modal
        open={cancelling != null}
        onOpenChange={(o) => {
          if (!o) {
            setCancelling(null);
            setReason("");
          }
        }}
        title={cancelling ? `Anular el pedido N° ${cancelling.number}` : "Anular pedido"}
        description="El stock reservado vuelve a quedar disponible. Queda registrado con el motivo."
        footer={
          <>
            <Button variant="secondary" onClick={() => setCancelling(null)}>
              Volver
            </Button>
            <Button variant="destructive" onClick={confirmCancel} disabled={reason.trim().length < 3} loading={m.cancel.isPending}>
              Anular pedido
            </Button>
          </>
        }
      >
        <Input label="Motivo" value={reason} onChange={(e) => setReason(e.target.value)} maxLength={300} />
      </Modal>
    </PageContainer>
  );
}
