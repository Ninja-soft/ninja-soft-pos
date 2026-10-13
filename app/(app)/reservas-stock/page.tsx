"use client";

import { useEffect, useMemo, useState } from "react";
import { Lock, PackageCheck, PackageSearch, Plus } from "lucide-react";
import { PageContainer, PageHeader } from "@/components/ui/PageHeader";
import { Button } from "@/components/ui/Button";
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
  RESERVATION_CHANNEL_LABEL,
  RESERVATION_STATUS_LABEL,
  effectiveStatus,
  expiresLabel,
  reservationErrorMessage,
  type ReservationStatus,
  type StockReservation,
} from "@/lib/stock/reservations";
import { useFeature } from "@/modules/saas/gating";
import { useMyTenant } from "@/modules/tenants/hooks";
import { useBranchContext } from "@/modules/branches/hooks";
import { useStores } from "@/modules/stock/hooks";
import { useReservationMutations, useStockReservations } from "@/modules/stock/reservations";
import { fmtDateTime, selectCls } from "@/components/stock/transfers/shared";
import { ReservationFormModal } from "@/components/stock/reservations/ReservationFormModal";
import { ReservationDeliverModal } from "@/components/stock/reservations/ReservationDeliverModal";

type Tab = "open" | "history";

const STATUS_TONE: Record<ReservationStatus, BadgeTone> = {
  reservada: "info",
  preparada: "success",
  entregada: "neutral",
  cancelada: "neutral",
  vencida: "warning",
};

// Reservas de stock y retiro en tienda (F16 · H77, ADR-091): apartar
// mercadería para un cliente en una sucursal, prepararla y entregarla con
// código o documento contra la venta cobrada en el POS.
export default function ReservasStockPage() {
  const enabled = useFeature("reservas_stock");
  const { toast } = useToast();
  const { data: me } = useMyTenant();
  const canOperate = Boolean(me && me.role !== "viewer");
  const canOverride = Boolean(me?.canManage);
  const ctx = useBranchContext();
  const { data: stores = [] } = useStores();
  const [storeId, setStoreId] = useState<string | null>(null);
  const [tab, setTab] = useState<Tab>("open");
  const [upgradeOpen, setUpgradeOpen] = useState(false);
  const [formOpen, setFormOpen] = useState(false);
  const [created, setCreated] = useState<{ number: number; pickup_code: string; customer: string; store: string } | null>(null);
  const [delivering, setDelivering] = useState<StockReservation | null>(null);
  const [cancelling, setCancelling] = useState<StockReservation | null>(null);
  const [cancelReason, setCancelReason] = useState("");
  const m = useReservationMutations();

  const myStoreId = ctx.posStoreId ?? ctx.filterStoreId ?? stores.find((s) => s.is_default)?.id ?? null;
  useEffect(() => {
    if (storeId === null && ctx.ready) setStoreId(ctx.filterStoreId ?? "");
  }, [ctx.ready, ctx.filterStoreId, storeId]);

  const filter = storeId ? storeId : null;
  const { data: list = [], isLoading } = useStockReservations(filter, tab === "open", enabled === true);
  const now = useMemo(() => new Date(), [list]); // eslint-disable-line react-hooks/exhaustive-deps
  const storeName = (id: string | null) => stores.find((s) => s.id === id)?.name ?? "Sucursal";

  async function prepare(r: StockReservation) {
    try {
      await m.prepare.mutateAsync(r.id);
      toast({ title: `Reserva #${r.number} lista para retirar`, variant: "success" });
    } catch (e) {
      toast({ title: "No se pudo marcar", description: reservationErrorMessage(e), variant: "error" });
    }
  }

  async function confirmCancel() {
    if (!cancelling) return;
    try {
      await m.cancel.mutateAsync({ id: cancelling.id, reason: cancelReason });
      toast({ title: `Reserva #${cancelling.number} cancelada`, variant: "success" });
      setCancelling(null);
      setCancelReason("");
    } catch (e) {
      toast({ title: "No se pudo cancelar", description: reservationErrorMessage(e), variant: "error" });
    }
  }

  const header = (
    <PageHeader
      eyebrow="Operación"
      title="Reservas y retiros"
      icon={PackageCheck}
      description="Apartá stock para un cliente en cualquier sucursal y entregalo cuando retira, con código o documento."
      actions={
        enabled && canOperate ? (
          <Button onClick={() => setFormOpen(true)}>
            <Plus size={16} /> Nueva reserva
          </Button>
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
          <p className="mt-3 font-semibold">Las reservas de stock no están incluidas en tu plan</p>
          <p className="mx-auto mt-1 max-w-md text-sm text-muted-foreground">
            Apartá mercadería para tus clientes y entregala en la sucursal que elijan, sin vender dos veces lo mismo.
          </p>
          <Button className="mt-4" onClick={() => setUpgradeOpen(true)}>
            Ver planes
          </Button>
          <UpgradeModal
            open={upgradeOpen}
            onOpenChange={setUpgradeOpen}
            featureKey="reservas_stock"
            featureLabel="Reservas de stock"
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
          aria-label="Vista"
          value={tab}
          onChange={setTab}
          size="sm"
          options={[
            { value: "open", label: "Vigentes" },
            { value: "history", label: "Historial" },
          ]}
        />
      </div>

      <section className="mt-6 border-t-2 border-ninja-flame pt-4">
        {isLoading ? (
          <p className="py-8 text-center text-sm text-muted-foreground">Cargando reservas…</p>
        ) : list.length === 0 ? (
          <EmptyState
            icon={PackageSearch}
            title={tab === "open" ? "No hay reservas vigentes" : "Todavía no hay historial"}
            description="Las reservas comprometen el stock de la sucursal hasta que se entregan, se cancelan o vencen."
          />
        ) : (
          <ul className="divide-y divide-border">
            {list.map((r) => {
              const status = effectiveStatus(r, now);
              const open = status === "reservada" || status === "preparada";
              return (
                <li key={r.id} className="py-4">
                  <div className="flex flex-wrap items-start justify-between gap-2">
                    <div className="min-w-0">
                      <p className="font-semibold">
                        #{r.number} · {r.customer_name}
                      </p>
                      <p className="text-xs text-muted-foreground">
                        Retira en {storeName(r.store_id)}
                        {r.origin_store_id ? ` · pedida desde ${storeName(r.origin_store_id)}` : ""} ·{" "}
                        {RESERVATION_CHANNEL_LABEL[r.channel]} · {fmtDateTime(r.created_at)}
                      </p>
                    </div>
                    <div className="flex items-center gap-2">
                      {open && <span className="text-xs text-muted-foreground">{expiresLabel(r.expires_at, now)}</span>}
                      <Badge tone={STATUS_TONE[status]}>{RESERVATION_STATUS_LABEL[status]}</Badge>
                    </div>
                  </div>
                  <ul className="mt-2 space-y-0.5 text-sm">
                    {r.items.map((it) => (
                      <li key={it.id} className="flex justify-between gap-3">
                        <span className="truncate">
                          {it.product_name}
                          {it.variant_label ? ` (${it.variant_label})` : ""}
                        </span>
                        <span className="tabular-nums text-muted-foreground">
                          {formatQty(it.qty)} {it.unit}
                        </span>
                      </li>
                    ))}
                  </ul>
                  <div className="mt-1 text-xs text-muted-foreground">
                    Valor de referencia {formatCurrency(r.total_value)}
                    {r.customer_phone ? ` · ${r.customer_phone}` : ""}
                    {r.cancel_reason ? ` · Motivo: ${r.cancel_reason}` : ""}
                  </div>
                  {open && canOperate && (
                    <div className="mt-3 flex flex-wrap gap-2">
                      {status === "reservada" && (
                        <Button size="sm" variant="secondary" onClick={() => prepare(r)} loading={m.prepare.isPending}>
                          Marcar lista
                        </Button>
                      )}
                      <Button size="sm" onClick={() => setDelivering(r)}>
                        Entregar
                      </Button>
                      <Button size="sm" variant="ghost" className="text-danger" onClick={() => setCancelling(r)}>
                        Cancelar
                      </Button>
                    </div>
                  )}
                </li>
              );
            })}
          </ul>
        )}
      </section>

      <ReservationFormModal
        open={formOpen}
        onOpenChange={setFormOpen}
        stores={stores}
        defaultStoreId={storeId || myStoreId}
        myStoreId={myStoreId}
        onCreated={setCreated}
      />

      <ReservationDeliverModal
        reservation={delivering}
        onOpenChange={(o) => !o && setDelivering(null)}
        canOverride={canOverride}
      />

      <Modal
        open={created != null}
        onOpenChange={(o) => !o && setCreated(null)}
        title={created ? `Reserva #${created.number} creada` : "Reserva creada"}
        description="Pasale el código al cliente: lo vas a ver una sola vez."
        footer={<Button onClick={() => setCreated(null)}>Listo</Button>}
      >
        {created && (
          <div className="space-y-2 text-center">
            <p className="text-sm text-muted-foreground">
              {created.customer} retira en {created.store}
            </p>
            <p className="font-mono text-4xl font-bold tracking-[0.3em] tabular-nums">{created.pickup_code}</p>
          </div>
        )}
      </Modal>

      <Modal
        open={cancelling != null}
        onOpenChange={(o) => {
          if (!o) {
            setCancelling(null);
            setCancelReason("");
          }
        }}
        title={cancelling ? `Cancelar reserva #${cancelling.number}` : "Cancelar reserva"}
        description="El stock vuelve a quedar disponible."
        footer={
          <>
            <Button variant="secondary" onClick={() => setCancelling(null)}>
              Volver
            </Button>
            <Button
              variant="destructive"
              onClick={confirmCancel}
              disabled={cancelReason.trim().length < 3}
              loading={m.cancel.isPending}
            >
              Cancelar reserva
            </Button>
          </>
        }
      >
        <Input label="Motivo" value={cancelReason} onChange={(e) => setCancelReason(e.target.value)} maxLength={300} />
      </Modal>
    </PageContainer>
  );
}
