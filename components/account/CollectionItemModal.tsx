"use client";

import { useEffect, useState } from "react";
import { Modal } from "@/components/ui/Modal";
import { Button } from "@/components/ui/Button";
import { Input } from "@/components/ui/Input";
import { useToast } from "@/components/ui/Toast";
import { addDays, todayIso } from "@/lib/account/terms";
import { accountErrorMessage } from "@/modules/customers/account";
import { useAccountMutations, useTeamMembers } from "@/modules/customers/hooks";

export type CollectionItemType = "promise" | "note" | "task";

const TITLES: Record<CollectionItemType, string> = {
  promise: "Promesa de pago",
  note: "Nota de cobranza",
  task: "Tarea de cobranza",
};

// Alta de promesa de pago / nota / tarea (cc_cobranza).
export function CollectionItemModal({
  type,
  customerId,
  customerName,
  suggestedAmount,
  onOpenChange,
}: {
  type: CollectionItemType | null;
  customerId: string | null;
  customerName: string;
  suggestedAmount?: number;
  onOpenChange: (o: boolean) => void;
}) {
  const { toast } = useToast();
  const { addItem } = useAccountMutations();
  const { data: team } = useTeamMembers(type === "task");
  const [body, setBody] = useState("");
  const [date, setDate] = useState("");
  const [amount, setAmount] = useState("");
  const [assignee, setAssignee] = useState("");

  useEffect(() => {
    if (!type) return;
    setBody("");
    setDate(addDays(todayIso(), type === "promise" ? 7 : 1));
    setAmount(suggestedAmount && suggestedAmount > 0 ? String(suggestedAmount) : "");
    setAssignee("");
  }, [type, suggestedAmount]);

  const amt = Number(amount) || 0;
  const valid =
    type === "promise" ? Boolean(date) && amt > 0 : body.trim().length > 1;

  async function submit() {
    if (!type || !customerId) return;
    try {
      await addItem.mutateAsync({
        customerId,
        type,
        body: body.trim() || null,
        promiseDate: type === "promise" ? date : null,
        promiseAmount: type === "promise" ? amt : null,
        dueAt: type === "task" && date ? new Date(`${date}T12:00:00`).toISOString() : null,
        assignee: type === "task" ? assignee || null : null,
      });
      toast({ title: `${TITLES[type]} registrada`, variant: "success" });
      onOpenChange(false);
    } catch (e) {
      toast({ title: "No se pudo guardar", description: accountErrorMessage(e), variant: "error" });
    }
  }

  return (
    <Modal
      open={type !== null}
      onOpenChange={onOpenChange}
      title={type ? `${TITLES[type]} · ${customerName}` : ""}
      className="max-w-md"
    >
      {type && (
        <div className="space-y-4">
          {type === "promise" && (
            <div className="grid grid-cols-2 gap-2">
              <Input label="Paga el" type="date" value={date} onChange={(e) => setDate(e.target.value)} />
              <Input
                label="Monto"
                type="number"
                inputMode="decimal"
                step="0.01"
                min="0"
                value={amount}
                onChange={(e) => setAmount(e.target.value)}
              />
            </div>
          )}
          {type === "task" && (
            <div className="grid grid-cols-2 gap-2">
              <Input label="Para el" type="date" value={date} onChange={(e) => setDate(e.target.value)} />
              <label className="block text-sm">
                <span className="mb-1.5 block font-medium text-muted-foreground">Responsable</span>
                <select
                  value={assignee}
                  onChange={(e) => setAssignee(e.target.value)}
                  className="h-11 w-full rounded-lg border border-input bg-background px-3 text-sm text-foreground outline-none focus:border-ninja-flameSoft"
                >
                  <option value="">Sin asignar</option>
                  {(team ?? []).map((m) => (
                    <option key={m.user_id} value={m.user_id}>
                      {m.name}
                    </option>
                  ))}
                </select>
              </label>
            </div>
          )}
          <Input
            label={type === "promise" ? "Comentario (opcional)" : type === "task" ? "Qué hay que hacer" : "Nota"}
            value={body}
            onChange={(e) => setBody(e.target.value)}
            maxLength={500}
          />
          <div className="flex justify-end gap-2">
            <Button variant="secondary" onClick={() => onOpenChange(false)}>
              Cancelar
            </Button>
            <Button loading={addItem.isPending} disabled={!valid} onClick={submit}>
              Guardar
            </Button>
          </div>
        </div>
      )}
    </Modal>
  );
}
