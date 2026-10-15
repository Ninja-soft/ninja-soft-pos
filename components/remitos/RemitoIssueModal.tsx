"use client";

// Emitir un remito de entrega o de envío (ADR-136) para una entrega de
// Expedición o una venta. El servidor arma los ítems (los de la entrega o los
// de la venta), el emisor y el número del punto de venta interno; acá se
// cargan receptor, domicilio, bultos, transporte y COT.

import { useEffect, useMemo, useState } from "react";
import { Modal } from "@/components/ui/Modal";
import { Button } from "@/components/ui/Button";
import { Input } from "@/components/ui/Input";
import { Segmented } from "@/components/ui/Segmented";
import { Switch } from "@/components/ui/Switch";
import { useToast } from "@/components/ui/Toast";
import { cn } from "@/lib/utils/cn";
import {
  COT_JURISDICTION_LABEL,
  cotRequired,
  remitoErrorMessage,
  remitoFormErrors,
  remitoIssuePayload,
  type CotJurisdiction,
  type RemitoFormInput,
  type RemitoKind,
} from "@/lib/remitos/logic";
import { useRemitoConfig, useRemitoMutations } from "@/modules/remitos/api";

const selectCls =
  "h-11 w-full rounded-lg border border-input bg-background px-3 text-sm focus:outline-none focus:ring-2 focus:ring-ring";

export interface RemitoSource {
  dispatchId: string | null;
  saleId: string | null;
  /** "Entrega N° 12 · Venta #340" */
  label: string;
  kind: RemitoKind;
  receiverName?: string | null;
  deliveryAddress?: string | null;
}

export function RemitoIssueModal({
  source,
  onClose,
  onIssued,
}: {
  source: RemitoSource | null;
  onClose: () => void;
  onIssued: (id: string) => void;
}) {
  const { toast } = useToast();
  const m = useRemitoMutations();
  const { data: cfg } = useRemitoConfig(Boolean(source));
  const [id, setId] = useState("");
  const [f, setF] = useState<RemitoFormInput>(() => empty("entrega", "pba"));

  useEffect(() => {
    if (!source) return;
    setId(crypto.randomUUID());
    setF({
      ...empty(source.kind, cfg?.cot_jurisdiction ?? "pba"),
      receiver_name: source.receiverName ?? "",
      delivery_address: source.deliveryAddress ?? "",
      show_prices: cfg?.show_prices ?? false,
    });
    // Sólo al abrir con otra entrega.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [source?.dispatchId, source?.saleId]);

  const errors = useMemo(() => remitoFormErrors(f), [f]);
  const declared = f.declared_value.trim() ? Number(f.declared_value.replace(",", ".")) : null;
  const cotWarn =
    declared != null && !f.cot_number.trim() && cotRequired(cfg?.cot_threshold ?? null, f.cot_jurisdiction, declared);

  if (!source) return null;
  const set = <K extends keyof RemitoFormInput>(k: K, v: RemitoFormInput[K]) => setF((cur) => ({ ...cur, [k]: v }));

  async function submit() {
    if (!source) return;
    try {
      const r = await m.issue.mutateAsync({ id, data: remitoIssuePayload({ dispatchId: source.dispatchId, saleId: source.saleId }, f) });
      toast({
        title: `Remito ${String(r.pto_vta).padStart(4, "0")}-${String(r.number).padStart(8, "0")} emitido`,
        description: r.cot_required ? "Supera tu monto de aviso: cargá el COT antes de despachar." : undefined,
        variant: r.cot_required ? "info" : "success",
      });
      onIssued(r.id);
    } catch (e) {
      toast({ title: "No se pudo emitir el remito", description: remitoErrorMessage(e), variant: "error" });
    }
  }

  return (
    <Modal
      open
      onOpenChange={(o) => !o && onClose()}
      title="Emitir remito"
      description={source.label}
      className="sm:max-w-xl"
      footer={
        <>
          <Button variant="secondary" onClick={onClose}>
            Cancelar
          </Button>
          <Button onClick={submit} disabled={errors.length > 0} loading={m.issue.isPending}>
            Emitir
          </Button>
        </>
      }
    >
      <div className="space-y-5">
        <Segmented<RemitoKind>
          aria-label="Tipo de remito"
          size="sm"
          value={f.kind}
          onChange={(v) => set("kind", v)}
          options={[
            { value: "entrega", label: "De entrega" },
            { value: "envio", label: "De envío" },
          ]}
        />

        <fieldset className="space-y-3">
          <legend className="text-sm font-semibold">Destinatario</legend>
          <Input label="Nombre o razón social" placeholder="El cliente de la venta" value={f.receiver_name} onChange={(e) => set("receiver_name", e.target.value)} maxLength={120} />
          <div className="grid gap-3 sm:grid-cols-2">
            <Input label="Documento" placeholder="El del cliente" value={f.receiver_doc} onChange={(e) => set("receiver_doc", e.target.value)} maxLength={40} />
            <Input label="Domicilio del destinatario" value={f.receiver_address} onChange={(e) => set("receiver_address", e.target.value)} maxLength={300} />
          </div>
          <Input
            label={f.kind === "envio" ? "Domicilio de entrega" : "Domicilio de entrega (opcional)"}
            value={f.delivery_address}
            onChange={(e) => set("delivery_address", e.target.value)}
            maxLength={300}
          />
        </fieldset>

        <fieldset className="space-y-3">
          <legend className="text-sm font-semibold">Carga</legend>
          <div className="grid grid-cols-3 gap-3">
            <Input label="Bultos" inputMode="numeric" value={f.packages} onChange={(e) => set("packages", e.target.value.replace(/\D/g, "").slice(0, 4))} />
            <Input label="Peso (kg)" inputMode="decimal" value={f.weight_kg} onChange={(e) => set("weight_kg", e.target.value)} />
            <Input label="Valor declarado" inputMode="decimal" placeholder="El de la venta" value={f.declared_value} onChange={(e) => set("declared_value", e.target.value)} />
          </div>
          <label className="flex items-center justify-between gap-3 text-sm">
            <span>Mostrar precios en el remito</span>
            <Switch label="Mostrar precios" checked={f.show_prices} onCheckedChange={(v) => set("show_prices", v)} />
          </label>
        </fieldset>

        <fieldset className="space-y-3">
          <legend className="text-sm font-semibold">Transporte (opcional)</legend>
          <div className="grid gap-3 sm:grid-cols-2">
            <Input label="Empresa" value={f.carrier_name} onChange={(e) => set("carrier_name", e.target.value)} maxLength={120} />
            <Input label="CUIT" inputMode="numeric" value={f.carrier_cuit} onChange={(e) => set("carrier_cuit", e.target.value)} maxLength={13} />
            <Input label="Patente" value={f.vehicle_plate} onChange={(e) => set("vehicle_plate", e.target.value.toUpperCase())} maxLength={20} />
            <Input label="Chofer" value={f.driver_name} onChange={(e) => set("driver_name", e.target.value)} maxLength={120} />
          </div>
        </fieldset>

        <fieldset className="space-y-3">
          <legend className="text-sm font-semibold">COT (Código de Operación de Traslado)</legend>
          <p className="text-xs text-muted-foreground">
            Lo pedís en ARBA o AGIP con los datos del remito y lo cargás acá. También lo podés cargar después de emitir.
          </p>
          <div className="grid gap-3 sm:grid-cols-[1fr_1fr]">
            <Input label="Número de COT" value={f.cot_number} onChange={(e) => set("cot_number", e.target.value.trim())} maxLength={40} />
            <Input label="Válido hasta" type="date" value={f.cot_valid_until} onChange={(e) => set("cot_valid_until", e.target.value)} />
          </div>
          <select
            aria-label="Jurisdicción del COT"
            className={cn(selectCls)}
            value={f.cot_jurisdiction}
            onChange={(e) => set("cot_jurisdiction", e.target.value as CotJurisdiction)}
          >
            {(Object.keys(COT_JURISDICTION_LABEL) as CotJurisdiction[]).map((j) => (
              <option key={j} value={j} className="bg-popover text-popover-foreground">
                {COT_JURISDICTION_LABEL[j]}
              </option>
            ))}
          </select>
          {cotWarn && <p className="text-xs text-warning">El valor declarado supera tu monto de aviso: este traslado suele necesitar COT.</p>}
        </fieldset>

        <Input label="Observaciones" value={f.notes} onChange={(e) => set("notes", e.target.value)} maxLength={500} />

        {errors.length > 0 && (
          <ul className="space-y-1 text-xs text-warning" role="status">
            {errors.map((e) => (
              <li key={e}>{e}</li>
            ))}
          </ul>
        )}
      </div>
    </Modal>
  );
}

function empty(kind: RemitoKind, j: CotJurisdiction): RemitoFormInput {
  return {
    kind,
    receiver_name: "",
    receiver_doc: "",
    receiver_address: "",
    delivery_address: "",
    packages: "1",
    weight_kg: "",
    declared_value: "",
    carrier_name: "",
    carrier_cuit: "",
    vehicle_plate: "",
    driver_name: "",
    cot_number: "",
    cot_jurisdiction: j,
    cot_valid_until: "",
    notes: "",
    show_prices: false,
  };
}
