"use client";

// Ajustes de stock (ADR-137): la regla de aprobación en una línea, los
// pendientes arriba (con Aprobar y Rechazar para quien puede, y Retirar para
// quien lo pidió) y el historial con quién pidió, quién aprobó, motivo, foto
// y valor. La configuración de la aprobación y los auditores, para el dueño.

import { useMemo, useState } from "react";
import { Check, ClipboardList, Plus, ShieldCheck, X } from "lucide-react";
import { Badge } from "@/components/ui/Badge";
import { Button } from "@/components/ui/Button";
import { Callout } from "@/components/ui/Callout";
import { Disclosure } from "@/components/ui/Disclosure";
import { EmptyState } from "@/components/ui/EmptyState";
import { Input } from "@/components/ui/Input";
import { Modal } from "@/components/ui/Modal";
import { Segmented } from "@/components/ui/Segmented";
import { SpinnerBlock } from "@/components/ui/Spinner";
import { useToast } from "@/components/ui/Toast";
import { ProductThumb } from "@/components/products/ProductThumb";
import { formatCurrency } from "@/lib/utils/format";
import {
  ADJUST_MODE_LABEL,
  ADJUST_REASON_LABEL,
  ADJUST_STATUS_LABEL,
  ADJUST_STATUS_TONE,
  adjustmentErrorMessage,
  approvalRuleText,
  type AdjustStatus,
} from "@/lib/stock/adjustments";
import { fmtDateTimeAR } from "@/lib/stock/inventorySheet";
import {
  useAdjustmentMutations,
  useAdjustmentPolicy,
  useStockAdjustments,
  type StockAdjustmentRow,
} from "@/modules/stock/adjustments";
import { useCurrentUserId } from "@/modules/stock/hooks";
import { ApprovalSettings } from "./ApprovalSettings";
import { AdjustmentPhotoButton, DeltaText } from "./shared";

type Filter = "all" | Exclude<AdjustStatus, "pending">;

export function AdjustmentsTab({
  storeId,
  role,
  canAdjust,
  canApproveCap,
  canConfigure,
  onNew,
}: {
  storeId: string | null;
  role: string | null;
  canAdjust: boolean;
  /** Tiene stock.adjust.approve (la política decide si alcanza). */
  canApproveCap: boolean;
  canConfigure: boolean;
  onNew: () => void;
}) {
  const { toast } = useToast();
  const { data: policy } = useAdjustmentPolicy();
  const { data: me } = useCurrentUserId();
  const { data: all = [], isLoading } = useStockAdjustments(storeId, null);
  const m = useAdjustmentMutations();
  const [filter, setFilter] = useState<Filter>("all");
  const [rejecting, setRejecting] = useState<{ ids: string[] } | null>(null);
  const [rejectNotes, setRejectNotes] = useState("");

  // Quién aprueba: el dueño siempre; con "auditor", quien tenga el permiso y
  // la feature en el plan. Nadie aprueba lo que pidió.
  const canApprove =
    role === "owner" || (policy?.approver === "auditor" && Boolean(policy?.feature) && canApproveCap);

  const pending = useMemo(() => all.filter((a) => a.status === "pending"), [all]);
  const history = useMemo(
    () => all.filter((a) => a.status !== "pending" && (filter === "all" || a.status === filter)),
    [all, filter],
  );
  const approvable = pending.filter((a) => canApprove && a.requested_by !== me);

  async function approve(ids: string[]) {
    try {
      if (ids.length === 1) {
        await m.decide.mutateAsync({ id: ids[0]!, approve: true });
        toast({ title: "Ajuste aprobado", description: "El stock ya cambió.", variant: "success" });
      } else {
        const r = await m.decideMany.mutateAsync({ ids, approve: true });
        toast({
          title: `${r.ok} ajustes aprobados`,
          description: r.errors.length ? `${r.errors.length} no se pudieron aprobar.` : undefined,
          variant: r.errors.length ? "info" : "success",
        });
      }
    } catch (e) {
      toast({ title: "No se pudo aprobar", description: adjustmentErrorMessage(e), variant: "error" });
    }
  }

  async function reject() {
    if (!rejecting) return;
    if (rejectNotes.trim() === "") {
      toast({ title: "Contá por qué lo rechazás", variant: "error" });
      return;
    }
    try {
      if (rejecting.ids.length === 1) {
        await m.decide.mutateAsync({ id: rejecting.ids[0]!, approve: false, notes: rejectNotes.trim() });
      } else {
        await m.decideMany.mutateAsync({ ids: rejecting.ids, approve: false, notes: rejectNotes.trim() });
      }
      toast({ title: "Rechazado", description: "El stock no cambió.", variant: "info" });
      setRejecting(null);
      setRejectNotes("");
    } catch (e) {
      toast({ title: "No se pudo rechazar", description: adjustmentErrorMessage(e), variant: "error" });
    }
  }

  async function cancel(id: string) {
    try {
      await m.cancel.mutateAsync(id);
      toast({ title: "Pedido retirado", variant: "info" });
    } catch (e) {
      toast({ title: "No se pudo retirar", description: adjustmentErrorMessage(e), variant: "error" });
    }
  }

  return (
    <div className="space-y-6">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
        <p className="flex items-start gap-2 text-sm text-muted-foreground">
          <ShieldCheck size={16} className="mt-0.5 shrink-0" aria-hidden />
          {policy && policy.feature
            ? approvalRuleText(policy, formatCurrency)
            : "Los ajustes se aplican en el momento y quedan en el historial con quién los hizo."}
        </p>
        {canAdjust && (
          <Button onClick={onNew} className="shrink-0">
            <Plus size={16} /> Nuevo ajuste
          </Button>
        )}
      </div>

      {pending.length > 0 && (
        <section className="border-t-2 border-warning pt-4">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <h2 className="text-base font-semibold">Esperando aprobación ({pending.length})</h2>
            {approvable.length > 1 && (
              <div className="flex gap-2">
                <Button size="sm" variant="secondary" onClick={() => setRejecting({ ids: approvable.map((a) => a.id) })}>
                  Rechazar todos
                </Button>
                <Button size="sm" onClick={() => approve(approvable.map((a) => a.id))} loading={m.decideMany.isPending}>
                  Aprobar todos ({approvable.length})
                </Button>
              </div>
            )}
          </div>
          <ul className="mt-3 divide-y divide-border overflow-hidden rounded-lg bg-card ring-1 ring-border">
            {pending.map((a) => (
              <AdjustmentItem key={a.id} a={a}>
                <div className="mt-2 flex flex-wrap gap-2">
                  {canApprove && a.requested_by !== me && (
                    <>
                      <Button size="sm" onClick={() => approve([a.id])} loading={m.decide.isPending && m.decide.variables?.id === a.id}>
                        <Check size={14} /> Aprobar
                      </Button>
                      <Button size="sm" variant="secondary" onClick={() => setRejecting({ ids: [a.id] })}>
                        <X size={14} /> Rechazar
                      </Button>
                    </>
                  )}
                  {(a.requested_by === me || role === "owner") && (
                    <Button size="sm" variant="ghost" onClick={() => cancel(a.id)}>
                      Retirar pedido
                    </Button>
                  )}
                  {canApprove && a.requested_by === me && (
                    <span className="self-center text-xs text-muted-foreground">Lo pediste vos: lo aprueba otra persona.</span>
                  )}
                </div>
              </AdjustmentItem>
            ))}
          </ul>
        </section>
      )}

      <section>
        <div className="flex flex-wrap items-center justify-between gap-2">
          <h2 className="text-base font-semibold">Historial</h2>
          <Segmented<Filter>
            size="sm"
            aria-label="Filtrar historial"
            value={filter}
            onChange={setFilter}
            scrollOnMobile
            options={[
              { value: "all", label: "Todos" },
              { value: "applied", label: "Aplicados" },
              { value: "rejected", label: "Rechazados" },
              { value: "cancelled", label: "Retirados" },
            ]}
          />
        </div>
        {isLoading ? (
          <SpinnerBlock label="Cargando ajustes" />
        ) : history.length === 0 ? (
          <EmptyState
            compact
            className="mt-3"
            icon={ClipboardList}
            title={filter === "all" ? "Acá vas a ver cada ajuste de stock" : "No hay ajustes con este filtro"}
            description={
              filter === "all"
                ? "Cuando algo se rompe, vence o falta, cargá un ajuste con el motivo: queda quién lo hizo, cuándo y la foto si la sacaste."
                : undefined
            }
            action={
              canAdjust && filter === "all" ? (
                <Button size="sm" onClick={onNew}>
                  <Plus size={15} /> Cargar el primero
                </Button>
              ) : undefined
            }
          />
        ) : (
          <ul className="mt-3 divide-y divide-border overflow-hidden rounded-lg bg-card ring-1 ring-border">
            {history.map((a) => (
              <AdjustmentItem key={a.id} a={a} />
            ))}
          </ul>
        )}
      </section>

      {canConfigure && (
        <Disclosure title="Aprobación de ajustes y auditores" icon={<ShieldCheck size={16} />}>
          <ApprovalSettings />
        </Disclosure>
      )}

      <Modal
        open={rejecting !== null}
        onOpenChange={(o) => !o && setRejecting(null)}
        title={rejecting && rejecting.ids.length > 1 ? `Rechazar ${rejecting.ids.length} ajustes` : "Rechazar ajuste"}
        footer={
          <>
            <Button variant="secondary" onClick={() => setRejecting(null)}>
              Volver
            </Button>
            <Button variant="destructive" onClick={reject} loading={m.decide.isPending || m.decideMany.isPending}>
              Rechazar
            </Button>
          </>
        }
      >
        <label className="block text-sm">
          <span className="mb-1 block font-medium">¿Por qué lo rechazás?</span>
          <Input
            value={rejectNotes}
            maxLength={300}
            autoFocus
            onChange={(e) => setRejectNotes(e.target.value)}
            placeholder="Ej.: contalo de nuevo, no coincide con el remito"
          />
          <span className="mt-1 block text-xs text-muted-foreground">Lo ve quien lo pidió. El stock no cambia.</span>
        </label>
      </Modal>
    </div>
  );
}

function AdjustmentItem({ a, children }: { a: StockAdjustmentRow; children?: React.ReactNode }) {
  const shown = a.status === "applied" && a.applied_delta != null ? a.applied_delta : a.delta;
  return (
    <li className="flex items-start gap-3 p-3">
      <ProductThumb src={a.image_url} size={44} />
      <div className="min-w-0 flex-1">
        <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
          <p className="min-w-0 truncate font-medium">
            {a.product_name}
            {a.variant_label ? <span className="text-muted-foreground"> · {a.variant_label}</span> : null}
          </p>
          <Badge tone={ADJUST_STATUS_TONE[a.status]}>{ADJUST_STATUS_LABEL[a.status]}</Badge>
          {a.source === "import" && <Badge tone="neutral">Excel</Badge>}
        </div>
        <p className="mt-0.5 text-xs text-muted-foreground">
          {ADJUST_REASON_LABEL[a.reason]} · {ADJUST_MODE_LABEL[a.mode]} {a.qty.toLocaleString("es-AR")} · {a.store_name}
          {a.warehouse_name ? ` · ${a.warehouse_name}` : ""}
        </p>
        <p className="mt-0.5 text-xs text-muted-foreground">
          Pidió {a.requested_by_name ?? "alguien"} el {fmtDateTimeAR(a.requested_at)}
          {a.decided_by_name && a.status !== "cancelled"
            ? ` · ${a.status === "rejected" ? "rechazó" : "aprobó"} ${a.decided_by_name}`
            : ""}
          {a.status === "applied" && !a.needs_approval ? " · sin aprobación" : ""}
        </p>
        {(a.notes || a.decision_notes) && (
          <p className="mt-1 text-sm">
            {a.notes}
            {a.decision_notes ? <span className="block text-muted-foreground">Respuesta: {a.decision_notes}</span> : null}
          </p>
        )}
        {a.photo_path && <AdjustmentPhotoButton path={a.photo_path} />}
        {children}
      </div>
      <div className="shrink-0 text-right">
        <DeltaText value={shown} unit={a.unit} className="text-base" />
        {a.value != null && a.value !== 0 && (
          <p className="text-xs tabular-nums text-muted-foreground">{formatCurrency(a.value)}</p>
        )}
      </div>
    </li>
  );
}

export function PendingBanner({ count, onOpen }: { count: number; onOpen: () => void }) {
  if (count === 0) return null;
  return (
    <Callout
      tone="warning"
      icon={ShieldCheck}
      title={count === 1 ? "Hay 1 ajuste esperando aprobación" : `Hay ${count} ajustes esperando aprobación`}
      actions={
        <Button size="sm" variant="secondary" onClick={onOpen}>
          Revisar
        </Button>
      }
    />
  );
}
