"use client";

// Asignar (o quitar) el cobrador de uno o varios negocios (F20-11 · ADR-131).
// Sólo quien tiene la capacidad "asignar" (permiso Cobranzas: asignar, admin o
// super_admin); el servidor lo vuelve a validar.

import { useState } from "react";
import { Modal } from "@/components/ui/Modal";
import { Button } from "@/components/ui/Button";
import { Input } from "@/components/ui/Input";
import { Select } from "@/components/ui/Select";
import { useToast } from "@/components/ui/Toast";
import { billingErrorMessage } from "@/lib/billing/ledger";
import type { Collector } from "@/lib/billing/collection360";
import { useCobranza360Mutations } from "@/modules/billing/cobranza360";

const NONE = "__none";

export function AssignCollectorDialog({
  open,
  onOpenChange,
  tenantIds,
  collectors,
  currentId,
  onDone,
}: {
  open: boolean;
  onOpenChange: (o: boolean) => void;
  tenantIds: string[];
  collectors: Collector[];
  currentId?: string | null;
  onDone?: () => void;
}) {
  const { toast } = useToast();
  const { assign } = useCobranza360Mutations();
  const [value, setValue] = useState<string>(currentId ?? NONE);
  const [reason, setReason] = useState("");
  const [wasOpen, setWasOpen] = useState(false);
  if (open && !wasOpen) {
    setWasOpen(true);
    setValue(currentId ?? NONE);
    setReason("");
  } else if (!open && wasOpen) {
    setWasOpen(false);
  }

  async function submit() {
    try {
      const n = await assign.mutateAsync({ tenantIds, userId: value === NONE ? null : value, reason: reason.trim() || null });
      toast({
        title: value === NONE ? "Cobrador quitado" : "Cobrador asignado",
        description: n === 0 ? "No había nada para cambiar." : `${n} ${n === 1 ? "negocio" : "negocios"}.`,
        variant: "success",
      });
      onOpenChange(false);
      onDone?.();
    } catch (e) {
      toast({ title: "No se pudo asignar", description: billingErrorMessage(e), variant: "error" });
    }
  }

  return (
    <Modal
      open={open}
      onOpenChange={onOpenChange}
      title="Asignar cobrador"
      description={
        tenantIds.length === 1 ? "La persona responsable de gestionar la cobranza de este negocio." : `${tenantIds.length} negocios seleccionados.`
      }
      className="max-w-md"
      footer={
        <>
          <Button variant="secondary" onClick={() => onOpenChange(false)}>
            Cancelar
          </Button>
          <Button onClick={submit} loading={assign.isPending} disabled={tenantIds.length === 0}>
            Guardar
          </Button>
        </>
      }
    >
      <div className="space-y-4">
        <Select<string>
          label="Cobrador"
          value={value}
          onChange={setValue}
          options={[
            { value: NONE, label: "Sin cobrador" },
            ...collectors.map((c) => ({ value: c.id, label: c.name, description: `${c.tenants} ${c.tenants === 1 ? "negocio" : "negocios"} asignados` })),
          ]}
        />
        <Input label="Motivo (opcional)" value={reason} maxLength={500} onChange={(e) => setReason(e.target.value)} placeholder="Ej.: reparto de cartera de octubre" />
      </div>
    </Modal>
  );
}
AssignCollectorDialog.displayName = "AssignCollectorDialog";
