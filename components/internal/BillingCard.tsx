"use client";

import { useState } from "react";
import { CalendarDays, Clock, Plus, ReceiptText } from "lucide-react";
import { Card, CardContent } from "@/components/ui/Card";
import { Button } from "@/components/ui/Button";
import { Input } from "@/components/ui/Input";
import { Modal } from "@/components/ui/Modal";
import { useToast } from "@/components/ui/Toast";
import { useBillingRecords, useBillingMutations } from "@/modules/internal/hooks";
import type { BillingRecord } from "@/modules/internal/api";
import { formatCurrency } from "@/lib/utils/format";

const MEDIUM_LABELS: Record<string, string> = {
  mp: "Mercado Pago",
  bank_transfer: "Transferencia bancaria",
  cash: "Efectivo",
  other: "Otro",
};

const EXTEND_OPTIONS = [7, 14, 30, 60, 90];

interface Props {
  tenantId: string;
  trialEndsAt: string | null;
  subStatus: string | null;
}

export function BillingCard({ tenantId, trialEndsAt, subStatus }: Props) {
  const { toast } = useToast();
  const { data: records, isLoading } = useBillingRecords(tenantId);
  const { add, extendTrial } = useBillingMutations(tenantId);
  const [addOpen, setAddOpen] = useState(false);
  const [amount, setAmount] = useState("");
  const [medium, setMedium] = useState<string>("bank_transfer");
  const [periodStart, setPeriodStart] = useState("");
  const [periodEnd, setPeriodEnd] = useState("");
  const [receiptRef, setReceiptRef] = useState("");
  const [notes, setNotes] = useState("");

  const isTrial = subStatus === "trial";
  const trialDate = trialEndsAt ? new Date(trialEndsAt) : null;
  const trialExpired = trialDate && trialDate < new Date();

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
              </div>
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
        </CardContent>
      </Card>

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
    </>
  );
}
