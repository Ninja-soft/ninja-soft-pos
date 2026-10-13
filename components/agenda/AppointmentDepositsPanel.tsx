"use client";

import { useState } from "react";
import { HandCoins, Undo2 } from "lucide-react";
import { Button } from "@/components/ui/Button";
import { Input } from "@/components/ui/Input";
import { Select } from "@/components/ui/Select";
import { useToast } from "@/components/ui/Toast";
import { useAppointmentDepositMutations, useAppointmentDeposits } from "@/modules/agenda/hooks";
import {
  DEPOSIT_METHODS,
  depositAvailable,
  depositErrorMessage,
  depositLeft,
  type DepositMethod,
} from "@/modules/agenda/deposits";
import { PAYMENT_METHOD_LABELS } from "@/lib/utils/paymentMethods";
import { formatCurrency } from "@/lib/utils/format";
import type { Appointment } from "@/modules/agenda/api";

// Seña del turno (ADR-088): se cobra al reservar en la caja propia y el POS la
// descuenta sola al cobrar el turno. Lo que sobra (o la seña de un turno
// cancelado) se devuelve con motivo. Feature agenda_senas (el servidor la exige).
const errMsg = (e: unknown) =>
  e && typeof e === "object" && "message" in e ? String((e as { message: unknown }).message) : String(e);

export function AppointmentDepositsPanel({ appointment }: { appointment: Appointment }) {
  const { toast } = useToast();
  const { data: deposits } = useAppointmentDeposits(appointment.id);
  const { register, refund } = useAppointmentDepositMutations();
  const [adding, setAdding] = useState(false);
  const [amount, setAmount] = useState("");
  const [method, setMethod] = useState<DepositMethod>("cash");
  const [reference, setReference] = useState("");
  const [refunding, setRefunding] = useState<string | null>(null);
  const [reason, setReason] = useState("");

  const list = deposits ?? [];
  const available = depositAvailable(list);
  const canAdd = !appointment.sale_id && appointment.status !== "cancelado" && appointment.status !== "no_show";

  async function save() {
    const n = Number(amount.replace(",", "."));
    if (!(n > 0)) {
      toast({ title: "Ingresá el monto de la seña", variant: "error" });
      return;
    }
    try {
      await register.mutateAsync({ appointmentId: appointment.id, amount: n, method, reference: reference.trim() || null });
      toast({ title: `Seña de ${formatCurrency(n)} cobrada`, variant: "success" });
      setAdding(false);
      setAmount("");
      setReference("");
    } catch (e) {
      toast({ title: depositErrorMessage(errMsg(e)), variant: "error" });
    }
  }

  async function doRefund(id: string) {
    try {
      await refund.mutateAsync({ depositId: id, reason });
      toast({ title: "Seña devuelta", variant: "success" });
      setRefunding(null);
      setReason("");
    } catch (e) {
      toast({ title: depositErrorMessage(errMsg(e)), variant: "error" });
    }
  }

  if (list.length === 0 && !canAdd) return null;

  return (
    <div className="space-y-2 rounded-lg border border-border p-3 text-sm">
      <div className="flex items-center justify-between gap-2">
        <span className="flex items-center gap-2 font-semibold">
          <HandCoins size={15} /> Seña
        </span>
        {available > 0 && (
          <span className="text-xs text-muted-foreground">
            Disponible {formatCurrency(available)}: se descuenta al cobrar
          </span>
        )}
      </div>

      {list.map((d) => {
        const left = depositLeft(d);
        return (
          <div key={d.id} className="space-y-2 border-t border-border pt-2">
            <div className="flex items-center justify-between gap-2">
              <span>
                {formatCurrency(Number(d.amount))} · {PAYMENT_METHOD_LABELS[d.method] ?? d.method}
                {d.reference ? ` · ${d.reference}` : ""}
              </span>
              <span className="text-xs text-muted-foreground">
                {Number(d.applied_amount) > 0 ? `Aplicada ${formatCurrency(Number(d.applied_amount))}` : ""}
                {Number(d.refunded_amount) > 0 ? ` Devuelta ${formatCurrency(Number(d.refunded_amount))}` : ""}
              </span>
            </div>
            {left > 0 && d.status === "held" && refunding !== d.id && (
              <Button variant="ghost" size="sm" onClick={() => setRefunding(d.id)}>
                <Undo2 size={14} /> Devolver {formatCurrency(left)}
              </Button>
            )}
            {refunding === d.id && (
              <div className="space-y-2">
                <Input
                  label="Motivo de la devolución"
                  value={reason}
                  onChange={(e) => setReason(e.target.value)}
                  placeholder="Turno cancelado / sobrante de la seña"
                  autoFocus
                />
                <div className="flex justify-end gap-2">
                  <Button variant="ghost" size="sm" onClick={() => setRefunding(null)}>
                    Volver
                  </Button>
                  <Button
                    variant="destructive"
                    size="sm"
                    loading={refund.isPending}
                    disabled={reason.trim().length < 3}
                    onClick={() => doRefund(d.id)}
                  >
                    Devolver
                  </Button>
                </div>
              </div>
            )}
          </div>
        );
      })}

      {canAdd &&
        (adding ? (
          <div className="space-y-2 border-t border-border pt-2">
            <Input
              label="Monto"
              inputMode="decimal"
              value={amount}
              onChange={(e) => setAmount(e.target.value)}
              placeholder="0"
              autoFocus
            />
            <Select
              label="Medio"
              value={method}
              options={DEPOSIT_METHODS}
              onChange={(v) => setMethod(v)}
            />
            {method !== "cash" && (
              <Input
                label="N° de operación (opcional)"
                value={reference}
                onChange={(e) => setReference(e.target.value)}
              />
            )}
            <p className="text-xs text-muted-foreground">Entra a tu caja abierta.</p>
            <div className="flex justify-end gap-2">
              <Button variant="ghost" size="sm" onClick={() => setAdding(false)}>
                Volver
              </Button>
              <Button size="sm" loading={register.isPending} onClick={save}>
                Cobrar seña
              </Button>
            </div>
          </div>
        ) : (
          <Button variant="secondary" size="sm" onClick={() => setAdding(true)}>
            <HandCoins size={15} /> {list.length > 0 ? "Sumar seña" : "Cobrar seña"}
          </Button>
        ))}
    </div>
  );
}
