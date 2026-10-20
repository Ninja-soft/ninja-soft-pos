"use client";

// Saldo inicial y ajustes manuales de la cuenta del proveedor (F24 · H167,
// ADR-178). Entran en el saldo, la antigüedad de deuda y el resumen de cuenta.
// Siempre con motivo y auditados; se anulan, nunca se borran. No generan
// asiento automático (se registra con un asiento manual si hace falta).

import { useEffect, useState } from "react";
import { Modal } from "@/components/ui/Modal";
import { Button } from "@/components/ui/Button";
import { Segmented } from "@/components/ui/Segmented";
import { useToast } from "@/components/ui/Toast";
import { cn } from "@/lib/utils/cn";
import { purchaseErrorMessage } from "@/lib/purchases/orders";
import { usePurchasesProMutations } from "@/modules/purchases/pro";
import { ErrorList, FormField, inputCls, parseNum, textareaCls, today } from "./shared";

type Kind = "opening" | "adjustment";
type Sign = "1" | "-1";

export function SupplierAdjustmentModal({
  open,
  onOpenChange,
  supplierId,
  hasOpening,
}: {
  open: boolean;
  onOpenChange: (o: boolean) => void;
  supplierId: string;
  hasOpening: boolean;
}) {
  const { toast } = useToast();
  const m = usePurchasesProMutations();
  const [kind, setKind] = useState<Kind>("adjustment");
  const [sign, setSign] = useState<Sign>("1");
  const [amount, setAmount] = useState("");
  const [date, setDate] = useState(today());
  const [due, setDue] = useState("");
  const [reason, setReason] = useState("");

  useEffect(() => {
    if (!open) return;
    setKind(hasOpening ? "adjustment" : "opening");
    setSign("1");
    setAmount("");
    setDate(today());
    setDue("");
    setReason("");
  }, [open, hasOpening]);

  const errors = [
    ...(!(parseNum(amount) > 0) ? ["Cargá el importe."] : []),
    ...(reason.trim().length < 3 ? ["Escribí el motivo."] : []),
    ...(kind === "opening" && hasOpening ? ["El proveedor ya tiene saldo inicial: anulalo para cargar otro."] : []),
    ...(due && due < date ? ["El vencimiento no puede ser anterior a la fecha."] : []),
  ];

  async function save() {
    if (errors.length > 0) return;
    try {
      await m.createAdjustment.mutateAsync({
        supplier_id: supplierId,
        kind,
        sign: sign === "1" ? 1 : -1,
        amount: parseNum(amount),
        adj_date: date,
        due_date: due || null,
        reason: reason.trim(),
      });
      toast({ title: kind === "opening" ? "Saldo inicial cargado" : "Ajuste cargado", variant: "success" });
      onOpenChange(false);
    } catch (e) {
      toast({ title: "No se pudo guardar", description: purchaseErrorMessage(e), variant: "error" });
    }
  }

  return (
    <Modal
      open={open}
      onOpenChange={onOpenChange}
      title="Saldo inicial o ajuste"
      description="Para arrancar con lo que ya le debías al proveedor o corregir la cuenta. Queda registrado con el motivo."
      footer={
        <>
          <Button variant="secondary" onClick={() => onOpenChange(false)}>
            Cancelar
          </Button>
          <Button onClick={() => void save()} loading={m.createAdjustment.isPending} disabled={errors.length > 0}>
            Guardar
          </Button>
        </>
      }
    >
      <div className="space-y-4">
        <Segmented<Kind>
          aria-label="Tipo"
          value={kind}
          onChange={setKind}
          size="sm"
          options={[
            { value: "opening", label: "Saldo inicial" },
            { value: "adjustment", label: "Ajuste" },
          ]}
        />
        <Segmented<Sign>
          aria-label="Sentido"
          value={sign}
          onChange={setSign}
          size="sm"
          options={[
            { value: "1", label: "Le debemos más" },
            { value: "-1", label: "Le debemos menos (a favor)" },
          ]}
        />
        <div className="grid gap-3 sm:grid-cols-3">
          <FormField label="Importe en pesos">
            <input
              inputMode="decimal"
              className={cn(inputCls, "h-11 text-right")}
              value={amount}
              onChange={(e) => setAmount(e.target.value)}
            />
          </FormField>
          <FormField label="Fecha">
            <input type="date" className={cn(inputCls, "h-11")} value={date} onChange={(e) => setDate(e.target.value)} />
          </FormField>
          <FormField label="Vencimiento (opcional)">
            <input type="date" className={cn(inputCls, "h-11")} value={due} onChange={(e) => setDue(e.target.value)} />
          </FormField>
        </div>
        <FormField label="Motivo">
          <textarea
            className={textareaCls}
            maxLength={300}
            value={reason}
            placeholder="Saldo al pasar a NinjaSoft, diferencia conciliada con el proveedor..."
            onChange={(e) => setReason(e.target.value)}
          />
        </FormField>
        <ErrorList errors={amount || reason ? errors : []} />
      </div>
    </Modal>
  );
}
