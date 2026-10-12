"use client";

import { useEffect, useState } from "react";
import { Modal } from "@/components/ui/Modal";
import { Button } from "@/components/ui/Button";
import { Input } from "@/components/ui/Input";
import { Segmented } from "@/components/ui/Segmented";
import { useToast } from "@/components/ui/Toast";
import { formatCurrency } from "@/lib/utils/format";
import { todayIso } from "@/lib/account/terms";
import { accountErrorMessage } from "@/modules/customers/account";
import { useAccountMutations } from "@/modules/customers/hooks";

export type AccountAction =
  | { type: "adjust"; customerId: string }
  | { type: "waive"; movementId: string; open: number }
  | { type: "void"; movementId: string; amount: number; receiptNo: number | null };

const TITLES = {
  adjust: "Ajuste de cuenta",
  waive: "Condonar punitorio",
  void: "Anular cobro",
} as const;

// Acciones de dueño/encargado sobre la cuenta. Todas piden motivo (queda en
// audit_logs). Texto arriba, botones abajo; sin confirm() del navegador.
export function AccountActionModal({
  action,
  onOpenChange,
}: {
  action: AccountAction | null;
  onOpenChange: (o: boolean) => void;
}) {
  const { toast } = useToast();
  const m = useAccountMutations();
  const [kind, setKind] = useState<"adjust_debit" | "adjust_credit">("adjust_credit");
  const [amount, setAmount] = useState("");
  const [reason, setReason] = useState("");
  const [due, setDue] = useState("");

  useEffect(() => {
    if (!action) return;
    setKind("adjust_credit");
    setReason("");
    setDue(todayIso());
    setAmount(action.type === "waive" ? String(action.open) : "");
  }, [action]);

  const amt = Math.round((Number(amount) || 0) * 100) / 100;
  const pending = m.adjust.isPending || m.waiveInterest.isPending || m.voidPayment.isPending;
  const valid =
    reason.trim().length > 2 &&
    (action?.type === "void" ||
      (amt > 0 && (action?.type !== "waive" || amt <= (action?.open ?? 0) + 0.001)));

  async function submit() {
    if (!action) return;
    try {
      if (action.type === "adjust") {
        await m.adjust.mutateAsync({
          customerId: action.customerId,
          kind,
          amount: amt,
          reason: reason.trim(),
          dueDate: kind === "adjust_debit" ? due : null,
        });
        toast({ title: "Ajuste registrado", variant: "success" });
      } else if (action.type === "waive") {
        await m.waiveInterest.mutateAsync({ id: action.movementId, amount: amt, reason: reason.trim() });
        toast({ title: "Punitorio condonado", variant: "success" });
      } else {
        await m.voidPayment.mutateAsync({ id: action.movementId, reason: reason.trim() });
        toast({ title: "Cobro anulado", variant: "success" });
      }
      onOpenChange(false);
    } catch (e) {
      toast({ title: "No se pudo completar", description: accountErrorMessage(e), variant: "error" });
    }
  }

  return (
    <Modal open={action !== null} onOpenChange={onOpenChange} title={action ? TITLES[action.type] : ""} className="max-w-md">
      {action && (
        <div className="space-y-4">
          {action.type === "adjust" && (
            <>
              <p className="text-sm text-muted-foreground">
                Un ajuste crédito baja la deuda (nota de crédito interna); un ajuste débito la sube y vence en la
                fecha que elijas.
              </p>
              <Segmented
                value={kind}
                onChange={setKind}
                options={[
                  { value: "adjust_credit", label: "Crédito (baja deuda)" },
                  { value: "adjust_debit", label: "Débito (sube deuda)" },
                ]}
              />
            </>
          )}
          {action.type === "waive" && (
            <p className="text-sm text-muted-foreground">
              Saldo del punitorio: <span className="font-semibold text-foreground">{formatCurrency(action.open)}</span>.
              Podés condonarlo total o parcialmente.
            </p>
          )}
          {action.type === "void" && (
            <p className="text-sm text-muted-foreground">
              Se anula el cobro {action.receiptNo ? `recibo #${action.receiptNo} ` : ""}por{" "}
              <span className="font-semibold text-foreground">{formatCurrency(action.amount)}</span>. La deuda vuelve
              a quedar pendiente y se registra el contramovimiento en la caja abierta.
            </p>
          )}

          {action.type !== "void" && (
            <Input
              label="Monto"
              type="number"
              inputMode="decimal"
              step="0.01"
              min="0"
              value={amount}
              onChange={(e) => setAmount(e.target.value)}
            />
          )}
          {action.type === "adjust" && kind === "adjust_debit" && (
            <Input label="Vence" type="date" value={due} onChange={(e) => setDue(e.target.value)} />
          )}
          <Input
            label="Motivo"
            value={reason}
            onChange={(e) => setReason(e.target.value)}
            maxLength={200}
            hint="Queda registrado en la auditoría."
          />

          <div className="flex justify-end gap-2">
            <Button variant="secondary" onClick={() => onOpenChange(false)}>
              Cancelar
            </Button>
            <Button
              variant={action.type === "void" ? "destructive" : "primary"}
              loading={pending}
              disabled={!valid}
              onClick={submit}
            >
              {action.type === "void" ? "Anular cobro" : action.type === "waive" ? "Condonar" : "Registrar ajuste"}
            </Button>
          </div>
        </div>
      )}
    </Modal>
  );
}
