"use client";

import { useMemo, useState } from "react";
import {
  AlertTriangle,
  CalendarDays,
  CheckCircle2,
  Clock,
  Plus,
  ReceiptText,
  Tag,
  Trash2,
} from "lucide-react";
import { Card, CardContent } from "@/components/ui/Card";
import { Button } from "@/components/ui/Button";
import { Input } from "@/components/ui/Input";
import { Modal } from "@/components/ui/Modal";
import { Segmented } from "@/components/ui/Segmented";
import { ConfirmDialog } from "@/components/ui/ConfirmDialog";
import { useToast } from "@/components/ui/Toast";
import {
  useBillingRecords,
  useBillingMutations,
  usePlanPrices,
  useTenantDiscounts,
  useDiscountMutations,
} from "@/modules/internal/hooks";
import {
  effectiveMonthlyPrice,
  type BillingRecord,
  type TenantDiscount,
} from "@/modules/internal/api";
import { formatCurrency } from "@/lib/utils/format";

function discountLabel(d: TenantDiscount): string {
  return d.kind === "percent"
    ? `-${d.value}%`
    : `-${formatCurrency(d.value)}`;
}

function discountState(
  d: TenantDiscount,
): { label: string; cls: string } {
  const today = new Date().toISOString().slice(0, 10);
  if (d.valid_from > today)
    return {
      label: "Programado",
      cls: "bg-sky-400/15 text-sky-300",
    };
  if (d.valid_until && d.valid_until < today)
    return {
      label: "Vencido",
      cls: "bg-muted text-muted-foreground",
    };
  return {
    label: "Vigente",
    cls: "bg-emerald-400/15 text-emerald-300",
  };
}

const MEDIUM_LABELS: Record<string, string> = {
  mp: "Mercado Pago",
  bank_transfer: "Transferencia bancaria",
  cash: "Efectivo",
  other: "Otro",
};

const EXTEND_OPTIONS = [7, 14, 30, 60, 90];

type TrialAction = "converted" | "lost" | "set_end";

interface Props {
  tenantId: string;
  trialEndsAt: string | null;
  subStatus: string | null;
  planKey: string | null;
}

export function BillingCard({ tenantId, trialEndsAt, subStatus, planKey }: Props) {
  const { toast } = useToast();
  const { data: records, isLoading } = useBillingRecords(tenantId);
  const { add, extendTrial, setTrialEnd, trialOutcome } =
    useBillingMutations(tenantId);
  const { data: planPrices } = usePlanPrices();
  const { data: discounts } = useTenantDiscounts(tenantId);
  const discountMut = useDiscountMutations(tenantId);
  const [addOpen, setAddOpen] = useState(false);

  // Descuentos comerciales.
  const [discKind, setDiscKind] = useState<"percent" | "fixed">("percent");
  const [discValue, setDiscValue] = useState("");
  const [discReason, setDiscReason] = useState("");
  const [discFrom, setDiscFrom] = useState(
    new Date().toISOString().slice(0, 10),
  );
  const [discUntil, setDiscUntil] = useState("");
  const [removeId, setRemoveId] = useState<string | null>(null);
  const [amount, setAmount] = useState("");
  const [medium, setMedium] = useState<string>("bank_transfer");
  const [periodStart, setPeriodStart] = useState("");
  const [periodEnd, setPeriodEnd] = useState("");
  const [receiptRef, setReceiptRef] = useState("");
  const [notes, setNotes] = useState("");
  const [action, setAction] = useState<TrialAction | null>(null);
  const [actionDate, setActionDate] = useState("");
  const [actionReason, setActionReason] = useState("");

  const isTrial = subStatus === "trial";
  const trialDate = trialEndsAt ? new Date(trialEndsAt) : null;
  const trialExpired = trialDate && trialDate < new Date();

  // Cobertura: último period_end registrado → próximo vencimiento. Si quedó
  // en el pasado, hay deuda (estimada con el precio mensual del plan).
  const coveredUntil = useMemo(() => {
    const ends = (records ?? [])
      .map((r) => r.period_end)
      .filter(Boolean) as string[];
    if (ends.length === 0) return null;
    return ends.reduce((a, b) => (a > b ? a : b));
  }, [records]);
  const basePrice = planKey ? planPrices?.get(planKey) ?? null : null;
  // Precio efectivo = precio del plan − descuentos vigentes (percent y luego fixed).
  const effectivePrice = useMemo(() => {
    if (basePrice == null) return null;
    return effectiveMonthlyPrice(basePrice, discounts ?? []);
  }, [basePrice, discounts]);
  const isDiscounted =
    basePrice != null &&
    effectivePrice != null &&
    effectivePrice < basePrice;
  const monthlyPrice = effectivePrice;
  const overdueDays = useMemo(() => {
    if (!coveredUntil) return 0;
    const end = new Date(`${coveredUntil}T23:59:59`);
    return Math.max(0, Math.floor((Date.now() - end.getTime()) / 86_400_000));
  }, [coveredUntil]);
  const estimatedDebt =
    overdueDays > 0 && monthlyPrice
      ? Math.ceil(overdueDays / 30) * monthlyPrice
      : null;

  async function handleAdd() {
    const amt = Number(amount);
    if (!amt || amt <= 0) {
      toast({ title: "Ingresá un monto válido", variant: "error" });
      return;
    }
    try {
      await add.mutateAsync({
        tenant_id: tenantId,
        amount: amt,
        medium,
        period_start: periodStart || null,
        period_end: periodEnd || null,
        receipt_ref: receiptRef || null,
        notes: notes || null,
      });
      toast({ title: "Pago registrado", variant: "success" });
      setAddOpen(false);
      setAmount("");
      setMedium("bank_transfer");
      setPeriodStart("");
      setPeriodEnd("");
      setReceiptRef("");
      setNotes("");
    } catch (e) {
      toast({
        title: "No se pudo registrar",
        description: e instanceof Error ? e.message : undefined,
        variant: "error",
      });
    }
  }

  async function handleAddDiscount() {
    const val = Number(discValue);
    if (!Number.isFinite(val) || val <= 0) {
      toast({ title: "Ingresá un valor válido", variant: "error" });
      return;
    }
    if (discKind === "percent" && val > 100) {
      toast({ title: "El porcentaje no puede superar 100", variant: "error" });
      return;
    }
    if (discUntil && discUntil < discFrom) {
      toast({ title: "La vigencia hasta es anterior al desde", variant: "error" });
      return;
    }
    try {
      await discountMut.add.mutateAsync({
        kind: discKind,
        value: val,
        reason: discReason.trim() || null,
        valid_from: discFrom,
        valid_until: discUntil || null,
      });
      toast({ title: "Descuento agregado", variant: "success" });
      setDiscValue("");
      setDiscReason("");
      setDiscUntil("");
    } catch (e) {
      toast({
        title: "No se pudo agregar",
        description: e instanceof Error ? e.message : undefined,
        variant: "error",
      });
    }
  }

  async function handleRemoveDiscount() {
    if (!removeId) return;
    try {
      await discountMut.remove.mutateAsync(removeId);
      toast({ title: "Descuento dado de baja", variant: "success" });
      setRemoveId(null);
    } catch (e) {
      toast({
        title: "No se pudo dar de baja",
        description: e instanceof Error ? e.message : undefined,
        variant: "error",
      });
    }
  }

  async function handleExtend(days: number) {
    try {
      const newEnd = await extendTrial.mutateAsync(days);
      toast({
        title: `Trial extendido ${days} días`,
        description: `Nuevo vencimiento: ${new Date(newEnd).toLocaleDateString("es-AR")}`,
        variant: "success",
      });
    } catch (e) {
      toast({
        title: "No se pudo extender",
        description: e instanceof Error ? e.message : undefined,
        variant: "error",
      });
    }
  }

  function openAction(a: TrialAction) {
    setActionDate(new Date().toISOString().slice(0, 10));
    setActionReason("");
    setAction(a);
  }

  async function handleAction() {
    if (!action) return;
    try {
      if (action === "set_end") {
        if (!actionDate) {
          toast({ title: "Elegí la fecha de fin", variant: "error" });
          return;
        }
        const newEnd = await setTrialEnd.mutateAsync({
          endsAt: new Date(`${actionDate}T23:59:59`).toISOString(),
          reason: actionReason || null,
        });
        toast({
          title: "Fin del trial actualizado",
          description: `Nuevo vencimiento: ${new Date(newEnd).toLocaleDateString("es-AR")}`,
          variant: "success",
        });
      } else {
        await trialOutcome.mutateAsync({
          outcome: action,
          reason: actionReason || null,
        });
        toast({
          title:
            action === "converted"
              ? "Convertido a pago (suscripción activa)"
              : "Trial marcado como perdido",
          variant: "success",
        });
      }
      setAction(null);
    } catch (e) {
      toast({
        title: "No se pudo aplicar",
        description: e instanceof Error ? e.message : undefined,
        variant: "error",
      });
    }
  }

  const ACTION_TITLES: Record<TrialAction, string> = {
    converted: "Convertir a pago",
    lost: "Marcar trial como perdido",
    set_end: "Fijar fin del trial",
  };

  return (
    <>
      <Card>
        <CardContent className="p-5 space-y-4">
          <div className="flex items-center justify-between">
            <h3 className="flex items-center gap-1.5 font-display text-base font-bold">
              <ReceiptText size={16} /> Facturación
            </h3>
            <Button size="sm" onClick={() => setAddOpen(true)}>
              <Plus size={14} /> Registrar pago
            </Button>
          </div>

          {/* Trial info */}
          {isTrial && (
            <div className={`rounded-lg border p-3 text-sm ${trialExpired ? "border-red-400/30 bg-red-400/5 text-red-300" : "border-yellow-400/30 bg-yellow-400/5 text-yellow-300"}`}>
              <div className="flex items-center gap-1.5 font-medium">
                <Clock size={14} />
                {trialExpired ? "Trial vencido" : "En período de prueba"}
              </div>
              {trialDate && (
                <div className="mt-0.5 text-xs opacity-80">
                  {trialExpired ? "Venció" : "Vence"} el{" "}
                  {trialDate.toLocaleDateString("es-AR")}
                </div>
              )}
              <div className="mt-2 flex flex-wrap gap-1">
                <span className="text-xs opacity-70">Extender:</span>
                {EXTEND_OPTIONS.map((d) => (
                  <button
                    key={d}
                    disabled={extendTrial.isPending}
                    onClick={() => handleExtend(d)}
                    className="rounded border border-yellow-400/40 bg-yellow-400/10 px-2 py-0.5 text-xs font-medium transition hover:bg-yellow-400/20 disabled:opacity-50"
                  >
                    +{d}d
                  </button>
                ))}
                <button
                  disabled={setTrialEnd.isPending}
                  onClick={() => openAction("set_end")}
                  className="rounded border border-yellow-400/40 bg-yellow-400/10 px-2 py-0.5 text-xs font-medium transition hover:bg-yellow-400/20 disabled:opacity-50"
                >
                  Fijar fin…
                </button>
              </div>
              <div className="mt-1.5 flex flex-wrap gap-1">
                <span className="text-xs opacity-70">Desenlace:</span>
                <button
                  disabled={trialOutcome.isPending}
                  onClick={() => openAction("converted")}
                  className="rounded border border-emerald-400/40 bg-emerald-400/10 px-2 py-0.5 text-xs font-medium text-emerald-300 transition hover:bg-emerald-400/20 disabled:opacity-50"
                >
                  Convertir a pago
                </button>
                <button
                  disabled={trialOutcome.isPending}
                  onClick={() => openAction("lost")}
                  className="rounded border border-red-400/40 bg-red-400/10 px-2 py-0.5 text-xs font-medium text-red-300 transition hover:bg-red-400/20 disabled:opacity-50"
                >
                  Marcar perdido
                </button>
              </div>
            </div>
          )}

          {/* Estado de cobranza (próximo vencimiento / deuda estimada) */}
          {!isTrial && coveredUntil && (
            <div
              className={`rounded-lg border p-3 text-sm ${
                overdueDays > 0
                  ? "border-red-400/30 bg-red-400/5 text-red-300"
                  : "border-emerald-400/30 bg-emerald-400/5 text-emerald-300"
              }`}
            >
              <div className="flex items-center gap-1.5 font-medium">
                {overdueDays > 0 ? (
                  <>
                    <AlertTriangle size={14} /> Vencido hace {overdueDays} día
                    {overdueDays === 1 ? "" : "s"}
                  </>
                ) : (
                  <>
                    <CheckCircle2 size={14} /> Cubierto
                  </>
                )}
              </div>
              <div className="mt-0.5 text-xs opacity-80">
                {overdueDays > 0 ? "Venció" : "Próximo vencimiento"} el{" "}
                {new Date(`${coveredUntil}T00:00:00`).toLocaleDateString("es-AR")}
                {estimatedDebt != null && (
                  <span className="ml-2 font-semibold">
                    Deuda estimada: {formatCurrency(estimatedDebt)}
                  </span>
                )}
              </div>
            </div>
          )}
          {!isTrial && !coveredUntil && (records ?? []).length > 0 && (
            <p className="text-xs text-muted-foreground">
              Los pagos registrados no tienen período: cargá &ldquo;Período
              hasta&rdquo; para calcular el próximo vencimiento.
            </p>
          )}

          {/* Precio mensual efectivo (plan − descuentos vigentes) */}
          {basePrice != null && (
            <div className="text-xs text-muted-foreground">
              Precio efectivo:{" "}
              {isDiscounted && (
                <span className="mr-1 line-through opacity-60">
                  {formatCurrency(basePrice)}
                </span>
              )}
              <span className="font-semibold text-foreground">
                {formatCurrency(effectivePrice ?? basePrice)}/mes
              </span>
            </div>
          )}

          {/* Billing records */}
          {isLoading ? (
            <p className="text-sm text-muted-foreground">Cargando…</p>
          ) : (records ?? []).length === 0 ? (
            <p className="text-sm text-muted-foreground">
              Sin pagos registrados.
            </p>
          ) : (
            <div className="divide-y divide-border">
              {(records ?? []).map((r: BillingRecord) => (
                <div key={r.id} className="flex items-start justify-between py-2.5 text-sm">
                  <div>
                    <span className="font-semibold text-foreground">
                      {formatCurrency(r.amount)}
                    </span>
                    <span className="ml-2 text-muted-foreground">
                      {MEDIUM_LABELS[r.medium] ?? r.medium}
                    </span>
                    {r.receipt_ref && (
                      <span className="ml-2 rounded bg-muted px-1.5 py-0.5 text-xs font-mono text-muted-foreground">
                        {r.receipt_ref}
                      </span>
                    )}
                    {r.period_start && (
                      <div className="mt-0.5 flex items-center gap-1 text-xs text-muted-foreground">
                        <CalendarDays size={11} />
                        {r.period_start}{r.period_end ? ` → ${r.period_end}` : ""}
                      </div>
                    )}
                    {r.notes && (
                      <div className="mt-0.5 text-xs text-muted-foreground italic">{r.notes}</div>
                    )}
                  </div>
                  <div className="shrink-0 text-xs text-muted-foreground">
                    {new Date(r.created_at).toLocaleDateString("es-AR")}
                  </div>
                </div>
              ))}
            </div>
          )}

          {/* ── Descuentos comerciales ──────────────────────────────────── */}
          <div className="border-t border-border pt-4">
            <h4 className="flex items-center gap-1.5 text-sm font-bold text-foreground">
              <Tag size={14} /> Descuentos comerciales
            </h4>

            {(discounts ?? []).length === 0 ? (
              <p className="mt-2 text-sm text-muted-foreground">
                Sin descuentos cargados.
              </p>
            ) : (
              <div className="mt-2 divide-y divide-border">
                {(discounts ?? []).map((d) => {
                  const st = discountState(d);
                  return (
                    <div
                      key={d.id}
                      className="flex items-start justify-between gap-3 py-2.5 text-sm"
                    >
                      <div className="min-w-0">
                        <div className="flex flex-wrap items-center gap-2">
                          <span className="font-semibold text-foreground">
                            {discountLabel(d)}
                          </span>
                          <span
                            className={`rounded px-1.5 py-0.5 text-xs font-medium ${st.cls}`}
                          >
                            {st.label}
                          </span>
                        </div>
                        {d.reason && (
                          <div className="mt-0.5 text-xs text-muted-foreground">
                            {d.reason}
                          </div>
                        )}
                        <div className="mt-0.5 flex items-center gap-1 text-xs text-muted-foreground">
                          <CalendarDays size={11} />
                          {d.valid_from}
                          {d.valid_until ? ` → ${d.valid_until}` : " → sin fin"}
                        </div>
                      </div>
                      <button
                        onClick={() => setRemoveId(d.id)}
                        title="Dar de baja"
                        className="shrink-0 rounded-md p-1.5 text-muted-foreground transition hover:bg-red-400/15 hover:text-red-300"
                      >
                        <Trash2 size={15} />
                      </button>
                    </div>
                  );
                })}
              </div>
            )}

            {/* Form de alta */}
            <div className="mt-3 space-y-2 rounded-lg border border-border p-3">
              <Segmented
                value={discKind}
                onChange={(v) => setDiscKind(v)}
                options={[
                  { value: "percent", label: "Porcentaje" },
                  { value: "fixed", label: "Monto fijo" },
                ]}
              />
              <div className="grid grid-cols-2 gap-2">
                <Input
                  label={discKind === "percent" ? "Porcentaje (%)" : "Monto (ARS)"}
                  type="number"
                  min="0"
                  step={discKind === "percent" ? "1" : "0.01"}
                  value={discValue}
                  onChange={(e) => setDiscValue(e.target.value)}
                />
                <Input
                  label="Motivo"
                  value={discReason}
                  onChange={(e) => setDiscReason(e.target.value)}
                />
              </div>
              <div className="grid grid-cols-2 gap-2">
                <Input
                  label="Vigente desde"
                  type="date"
                  value={discFrom}
                  onChange={(e) => setDiscFrom(e.target.value)}
                />
                <Input
                  label="Hasta (opcional)"
                  type="date"
                  value={discUntil}
                  onChange={(e) => setDiscUntil(e.target.value)}
                />
              </div>
              <div className="flex justify-end">
                <Button
                  size="sm"
                  loading={discountMut.add.isPending}
                  onClick={handleAddDiscount}
                >
                  <Plus size={14} /> Agregar descuento
                </Button>
              </div>
            </div>
          </div>
        </CardContent>
      </Card>

      <ConfirmDialog
        open={removeId !== null}
        onOpenChange={(o) => !o && setRemoveId(null)}
        title="Dar de baja descuento"
        description="El descuento dejará de aplicarse al precio efectivo. Queda registrado (baja lógica)."
        confirmLabel="Dar de baja"
        danger
        loading={discountMut.remove.isPending}
        onConfirm={handleRemoveDiscount}
      />

      <Modal
        open={addOpen}
        onOpenChange={setAddOpen}
        title="Registrar pago"
        className="max-w-sm"
      >
        <div className="space-y-3">
          <Input
            label="Monto (ARS)"
            type="number"
            step="0.01"
            min="0"
            value={amount}
            onChange={(e) => setAmount(e.target.value)}
          />
          <div>
            <label className="mb-1.5 block text-sm font-medium text-muted-foreground">
              Medio
            </label>
            <select
              value={medium}
              onChange={(e) => setMedium(e.target.value)}
              className="h-11 w-full rounded-lg border border-input bg-background px-4 text-sm text-foreground outline-none focus:border-ninja-flameSoft"
            >
              {Object.entries(MEDIUM_LABELS).map(([k, v]) => (
                <option key={k} value={k} className="bg-ninja-deepViolet">
                  {v}
                </option>
              ))}
            </select>
          </div>
          <div className="grid grid-cols-2 gap-2">
            <Input
              label="Período desde"
              type="date"
              value={periodStart}
              onChange={(e) => setPeriodStart(e.target.value)}
            />
            <Input
              label="Período hasta"
              type="date"
              value={periodEnd}
              onChange={(e) => setPeriodEnd(e.target.value)}
            />
          </div>
          <Input
            label="N° comprobante / referencia"
            placeholder="MP-123456 / TRF-789"
            value={receiptRef}
            onChange={(e) => setReceiptRef(e.target.value)}
          />
          <Input
            label="Notas (opcional)"
            value={notes}
            onChange={(e) => setNotes(e.target.value)}
          />
          <div className="flex justify-end gap-2 pt-1">
            <Button variant="secondary" onClick={() => setAddOpen(false)}>
              Cancelar
            </Button>
            <Button loading={add.isPending} onClick={handleAdd}>
              Registrar
            </Button>
          </div>
        </div>
      </Modal>

      <Modal
        open={action !== null}
        onOpenChange={(o) => !o && setAction(null)}
        title={action ? ACTION_TITLES[action] : ""}
        className="max-w-sm"
      >
        <div className="space-y-3">
          {action === "converted" && (
            <p className="text-sm text-muted-foreground">
              Termina el trial ahora y deja la suscripción <b>activa</b>.
              Registrá el pago aparte con &ldquo;Registrar pago&rdquo;.
            </p>
          )}
          {action === "lost" && (
            <p className="text-sm text-muted-foreground">
              Termina el trial y deja la suscripción <b>cancelada</b>. Queda
              auditado con el motivo.
            </p>
          )}
          {action === "set_end" && (
            <Input
              label="Nueva fecha de fin"
              type="date"
              value={actionDate}
              onChange={(e) => setActionDate(e.target.value)}
            />
          )}
          <Input
            label={action === "lost" ? "Motivo (recomendado)" : "Motivo (opcional)"}
            placeholder={
              action === "lost"
                ? "No respondió / eligió competencia / precio…"
                : "Acuerdo comercial, seguimiento…"
            }
            value={actionReason}
            onChange={(e) => setActionReason(e.target.value)}
          />
          <div className="flex justify-end gap-2 pt-1">
            <Button variant="secondary" onClick={() => setAction(null)}>
              Cancelar
            </Button>
            <Button
              loading={setTrialEnd.isPending || trialOutcome.isPending}
              onClick={handleAction}
            >
              Confirmar
            </Button>
          </div>
        </div>
      </Modal>
    </>
  );
}
