"use client";

// Período del servicio y vencimiento del pago de la venta (ADR-116). ARCA los
// exige en la factura de servicios (concepto 2 o 3): se piden en el POS cuando
// el carrito tiene servicios. Por defecto, hoy.

import { useEffect, useState } from "react";
import { CalendarRange } from "lucide-react";
import { Modal } from "@/components/ui/Modal";
import { Input } from "@/components/ui/Input";
import { Button } from "@/components/ui/Button";
import { servicePeriodError, todayAr, type ServicePeriod } from "@/lib/catalog/mode";

const fmt = (iso: string) => {
  const [y, m, d] = iso.split("-");
  return d && m && y ? `${d}/${m}/${y.slice(2)}` : iso;
};

export function servicePeriodText(p: ServicePeriod): { period: string; due: string } {
  const range = p.from === p.to ? fmt(p.from) : `${fmt(p.from)} al ${fmt(p.to)}`;
  return { period: `Servicio ${range}`, due: `Vence el pago ${fmt(p.due)}` };
}

export function ServicePeriodBar({ period, onChange }: { period: ServicePeriod; onChange: (p: ServicePeriod) => void }) {
  const [open, setOpen] = useState(false);
  const [draft, setDraft] = useState(period);
  useEffect(() => {
    if (open) setDraft(period);
  }, [open, period]);
  const error = servicePeriodError(draft, todayAr());

  return (
    <>
      <button
        type="button"
        onClick={() => setOpen(true)}
        className="flex min-h-11 w-full items-center gap-2.5 rounded-lg bg-fg-4 px-3 py-1.5 text-left text-[13px] transition-colors hover:bg-fg-6"
      >
        <CalendarRange size={16} className="shrink-0 text-muted-foreground" aria-hidden />
        <span className="min-w-0 flex-1 tabular-nums">
          <span className="block truncate font-medium">{servicePeriodText(period).period}</span>
          <span className="block truncate text-xs text-muted-foreground">{servicePeriodText(period).due}</span>
        </span>
        <span className="shrink-0 text-xs font-medium text-muted-foreground">Cambiar</span>
      </button>

      <Modal
        open={open}
        onOpenChange={setOpen}
        title="Período del servicio"
        description="Sale en la factura y se informa a ARCA junto con el vencimiento del pago."
        className="sm:max-w-md"
        footer={
          <>
            <Button type="button" variant="secondary" onClick={() => setOpen(false)}>
              Cancelar
            </Button>
            <Button
              type="button"
              disabled={Boolean(error)}
              onClick={() => {
                onChange(draft);
                setOpen(false);
              }}
            >
              Guardar
            </Button>
          </>
        }
      >
        <div className="space-y-4">
          <div className="grid grid-cols-2 gap-3">
            <Input
              label="Desde"
              type="date"
              value={draft.from}
              onChange={(e) => setDraft((d) => ({ ...d, from: e.target.value, to: d.to < e.target.value ? e.target.value : d.to }))}
            />
            <Input label="Hasta" type="date" min={draft.from} value={draft.to} onChange={(e) => setDraft((d) => ({ ...d, to: e.target.value }))} />
          </div>
          <Input
            label="Vencimiento del pago"
            type="date"
            min={todayAr()}
            value={draft.due}
            onChange={(e) => setDraft((d) => ({ ...d, due: e.target.value }))}
          />
          {error && <p className="text-xs text-danger">{error}</p>}
        </div>
      </Modal>
    </>
  );
}
