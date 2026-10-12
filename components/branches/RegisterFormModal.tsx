"use client";

import { useEffect, useState } from "react";
import { Modal } from "@/components/ui/Modal";
import { Button } from "@/components/ui/Button";
import { Input } from "@/components/ui/Input";
import { useToast } from "@/components/ui/Toast";
import { useBranchMutations } from "@/modules/branches/hooks";
import {
  branchErrorMessage,
  REGISTER_KIND_LABEL,
  type Branch,
  type BranchRegister,
  type RegisterKind,
} from "@/modules/branches/logic";
import { cn } from "@/lib/utils/cn";

const KIND_DESC: Record<RegisterKind, string> = {
  fixed: "Mostrador con su puesto y cajón.",
  mobile: "Tablet o celular que se mueve por el local.",
  self_service: "Terminal de autoservicio del cliente.",
};

export function RegisterFormModal({
  open,
  onOpenChange,
  register,
  storeId,
  branches,
}: {
  open: boolean;
  onOpenChange: (o: boolean) => void;
  register: BranchRegister | null; // null = nueva
  storeId: string; // sucursal donde se crea (o la actual)
  branches: Branch[]; // sucursales vivas, para mover la caja
}) {
  const { toast } = useToast();
  const m = useBranchMutations();
  const [name, setName] = useState("");
  const [code, setCode] = useState("");
  const [kind, setKind] = useState<RegisterKind>("fixed");
  const [store, setStore] = useState(storeId);
  const [device, setDevice] = useState("");
  const [printer, setPrinter] = useState("");
  const [pos, setPos] = useState("");
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!open) return;
    const target = branches.find((b) => b.id === storeId);
    const next = (target?.registers.filter((r) => !r.deleted_at).length ?? 0) + 1;
    setName(register?.name ?? `Caja ${next}`);
    setCode(register?.code ?? "");
    setKind(register?.kind ?? "fixed");
    setStore(register?.store_id ?? storeId);
    setDevice(register?.device_notes ?? "");
    setPrinter(register?.printer_notes ?? "");
    setPos(register?.afip_pos_number ? String(register.afip_pos_number) : "");
    setError(null);
  }, [open, register, storeId, branches]);

  async function save() {
    if (name.trim().length < 2) {
      setError("Poné un nombre de al menos 2 letras");
      return;
    }
    const posNum = pos.trim() ? Number(pos) : null;
    if (posNum !== null && (posNum < 1 || posNum > 99998)) {
      setError("El punto de venta va de 1 a 99998");
      return;
    }
    const patch = {
      name: name.trim(),
      code: code.trim() || null,
      kind,
      device_notes: device.trim() || null,
      printer_notes: printer.trim() || null,
      afip_pos_number: posNum,
    };
    try {
      if (register) await m.updateRegister.mutateAsync({ id: register.id, patch: { ...patch, store_id: store } });
      else await m.createRegister.mutateAsync({ ...patch, store_id: store });
      toast({ title: register ? "Caja actualizada" : "Caja creada", variant: "success" });
      onOpenChange(false);
    } catch (e) {
      toast({ title: branchErrorMessage(e), variant: "error" });
    }
  }

  return (
    <Modal
      open={open}
      onOpenChange={onOpenChange}
      title={register ? `Editar ${register.name}` : "Nueva caja"}
      footer={
        <>
          <Button variant="secondary" onClick={() => onOpenChange(false)}>
            Cancelar
          </Button>
          <Button loading={m.createRegister.isPending || m.updateRegister.isPending} onClick={save}>
            {register ? "Guardar" : "Crear caja"}
          </Button>
        </>
      }
    >
      <div className="space-y-4">
        <div className="grid gap-3 sm:grid-cols-[1fr_120px]">
          <Input label="Nombre" value={name} onChange={(e) => setName(e.target.value)} error={error ?? undefined} autoFocus />
          <Input label="Código" value={code} onChange={(e) => setCode(e.target.value.toUpperCase())} placeholder="C1" />
        </div>

        <div>
          <div className="mb-2 text-sm font-medium text-muted-foreground">Tipo</div>
          <div className="grid gap-2 sm:grid-cols-3" role="radiogroup" aria-label="Tipo de caja">
            {(Object.keys(REGISTER_KIND_LABEL) as RegisterKind[]).map((k) => (
              <button
                key={k}
                type="button"
                role="radio"
                aria-checked={kind === k}
                onClick={() => setKind(k)}
                className={cn(
                  "rounded-lg border px-3 py-2.5 text-left transition",
                  kind === k ? "border-ninja-flame/50 bg-ninja-flame/10" : "border-border hover:bg-muted",
                )}
              >
                <span className="block text-sm font-semibold">{REGISTER_KIND_LABEL[k]}</span>
                <span className="block text-xs text-muted-foreground">{KIND_DESC[k]}</span>
              </button>
            ))}
          </div>
        </div>

        {register && branches.length > 1 && (
          <label className="block">
            <span className="mb-2 block text-sm font-medium text-muted-foreground">Sucursal</span>
            <select
              value={store}
              onChange={(e) => setStore(e.target.value)}
              className="h-11 w-full rounded-lg border border-input bg-background px-3 text-sm"
            >
              {branches.map((b) => (
                <option key={b.id} value={b.id}>
                  {b.name}
                </option>
              ))}
            </select>
            <span className="mt-1.5 block text-xs text-muted-foreground">
              Mover la caja no cambia la historia: los turnos y ventas anteriores siguen en su sucursal.
            </span>
          </label>
        )}

        <Input label="Dispositivo" value={device} onChange={(e) => setDevice(e.target.value)} placeholder="Ej.: PC mostrador, lector Zebra, balanza Systel" />
        <Input label="Impresora" value={printer} onChange={(e) => setPrinter(e.target.value)} placeholder="Ej.: Hasar 80 mm por USB" />
        <Input
          label="Punto de venta fiscal propio (opcional)"
          value={pos}
          onChange={(e) => setPos(e.target.value.replace(/\D/g, ""))}
          inputMode="numeric"
          hint="Vacío = usa el de la sucursal."
        />
      </div>
    </Modal>
  );
}
