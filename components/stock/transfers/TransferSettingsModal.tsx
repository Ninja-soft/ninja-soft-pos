"use client";

import { useEffect, useState } from "react";
import { Modal } from "@/components/ui/Modal";
import { Button } from "@/components/ui/Button";
import { Input } from "@/components/ui/Input";
import { Switch } from "@/components/ui/Switch";
import { useToast } from "@/components/ui/Toast";
import {
  DEFAULT_TRANSFER_SETTINGS,
  transferErrorMessage,
  type TransferSettings,
} from "@/lib/stock/transfers";
import { useMyTenant } from "@/modules/tenants/hooks";
import {
  useTransferMutations,
  useTransferSettings,
} from "@/modules/stock/hooks";

function Row({
  title,
  description,
  checked,
  onChange,
}: {
  title: string;
  description: string;
  checked: boolean;
  onChange: (v: boolean) => void;
}) {
  return (
    <div className="flex items-start justify-between gap-4 px-3.5 py-3">
      <div className="min-w-0">
        <div className="text-sm font-medium">{title}</div>
        <div className="text-xs text-muted-foreground">{description}</div>
      </div>
      <Switch checked={checked} onCheckedChange={onChange} label={title} />
    </div>
  );
}

// Reglas de traslados del negocio (dueño y encargados).
export function TransferSettingsModal({
  open,
  onOpenChange,
}: {
  open: boolean;
  onOpenChange: (o: boolean) => void;
}) {
  const { toast } = useToast();
  const { data: me } = useMyTenant();
  const { data } = useTransferSettings(open);
  const { saveSettings } = useTransferMutations();
  const [s, setS] = useState<TransferSettings>(DEFAULT_TRANSFER_SETTINGS);
  const [units, setUnits] = useState("");
  const [value, setValue] = useState("");

  useEffect(() => {
    if (!open || !data) return;
    setS(data);
    setUnits(
      data.approval_min_units == null ? "" : String(data.approval_min_units),
    );
    setValue(
      data.approval_min_value == null ? "" : String(data.approval_min_value),
    );
  }, [open, data]);

  const set = <K extends keyof TransferSettings>(
    k: K,
    v: TransferSettings[K],
  ) => setS((p) => ({ ...p, [k]: v }));

  async function save() {
    if (!me?.tenantId) return;
    const toNum = (v: string) => {
      const n = Number(v);
      return v.trim() === "" || !Number.isFinite(n) || n <= 0 ? null : n;
    };
    try {
      await saveSettings.mutateAsync({
        tenantId: me.tenantId,
        settings: {
          ...s,
          approval_min_units: toNum(units),
          approval_min_value: toNum(value),
        },
      });
      toast({
        title: "Configuración de traslados guardada",
        variant: "success",
      });
      onOpenChange(false);
    } catch (e) {
      toast({
        title: "No se pudo guardar",
        description: transferErrorMessage(e),
        variant: "error",
      });
    }
  }

  return (
    <Modal
      open={open}
      onOpenChange={onOpenChange}
      title="Configuración de traslados"
      footer={
        <div className="flex justify-end gap-2">
          <Button variant="secondary" onClick={() => onOpenChange(false)}>
            Cancelar
          </Button>
          <Button
            onClick={save}
            loading={saveSettings.isPending}
            disabled={!me?.canManage}
          >
            Guardar
          </Button>
        </div>
      }
    >
      <div className="space-y-4">
        <div className="divide-y divide-border rounded-lg bg-muted">
          <Row
            title="Pedir aprobación"
            description="Los traslados que arma un encargado los aprueba el dueño u otro encargado."
            checked={s.require_approval}
            onChange={(v) => set("require_approval", v)}
          />
          {s.require_approval && (
            <div className="grid gap-3 px-3.5 py-3 sm:grid-cols-2">
              <Input
                variant="filled"
                label="Desde cuántas unidades"
                type="number"
                min={0}
                step="any"
                placeholder="Todos"
                value={units}
                onChange={(e) => setUnits(e.target.value)}
              />
              <Input
                variant="filled"
                label="Desde qué valor a costo ($)"
                type="number"
                min={0}
                step="any"
                placeholder="Todos"
                value={value}
                onChange={(e) => setValue(e.target.value)}
              />
              <p className="text-xs text-muted-foreground sm:col-span-2">
                Vacíos: todos piden aprobación. Con valores: alcanza con superar
                uno.
              </p>
            </div>
          )}
        </div>
        <div className="divide-y divide-border rounded-lg bg-muted">
          <Row
            title="El cajero puede recibir"
            description="Quien está en la sucursal de destino registra lo que llegó."
            checked={s.cashier_can_receive}
            onChange={(v) => set("cashier_can_receive", v)}
          />
          <Row
            title="El cajero puede despachar"
            description="Quien está en la sucursal de origen confirma lo que sale."
            checked={s.cashier_can_dispatch}
            onChange={(v) => set("cashier_can_dispatch", v)}
          />
        </div>
        <div className="divide-y divide-border rounded-lg bg-muted">
          <Row
            title="Exigir motivo en las diferencias"
            description="Faltantes y sobrantes quedan con motivo (dañado, vencido, error de despacho)."
            checked={s.require_difference_reason}
            onChange={(v) => set("require_difference_reason", v)}
          />
          <Row
            title="Permitir recibir de más"
            description="Si llega más de lo despachado, se suma al destino como sobrante."
            checked={s.allow_over_receive}
            onChange={(v) => set("allow_over_receive", v)}
          />
          <Row
            title="No despachar sin stock en origen"
            description="Bloquea mandar más de lo que figura en la sucursal de origen."
            checked={s.block_dispatch_without_stock}
            onChange={(v) => set("block_dispatch_without_stock", v)}
          />
        </div>
      </div>
    </Modal>
  );
}
