"use client";

import { useState } from "react";
import { startOfDay, subDays } from "date-fns";
import { LineChart } from "lucide-react";
import { Modal } from "@/components/ui/Modal";
import { Button } from "@/components/ui/Button";
import { DateRangePicker, type DateRange } from "@/components/ui/DateRangePicker";
import { useToast } from "@/components/ui/Toast";
import { promotionsApi } from "@/modules/promotions/api";
import type { Promotion } from "@/modules/promotions/api";
import { simulatePromotion, type SimResult } from "@/lib/promotions/engine";
import { formatCurrency } from "@/lib/utils/format";

// F9 · H56 — Simulador: corre la promo contra las ventas del período y muestra
// cuánto descuento HABRÍA dado, antes de activarla. Read-only; usa el motor puro.
export function PromotionSimModal({
  promo,
  onClose,
}: {
  promo: Promotion | null;
  onClose: () => void;
}) {
  const { toast } = useToast();
  const [range, setRange] = useState<DateRange | undefined>(() => ({
    from: startOfDay(subDays(new Date(), 29)),
    to: startOfDay(new Date()),
  }));
  const [result, setResult] = useState<SimResult | null>(null);
  const [loading, setLoading] = useState(false);

  async function run() {
    if (!promo) return;
    setLoading(true);
    setResult(null);
    try {
      const from = startOfDay(range?.from ?? new Date());
      const to = startOfDay(range?.to ?? range?.from ?? new Date());
      to.setDate(to.getDate() + 1); // inclusivo del día "hasta"
      const sales = await promotionsApi.simData(from.toISOString(), to.toISOString());
      setResult(simulatePromotion(promo, sales));
    } catch (e) {
      toast({
        title: "No se pudo simular",
        description: e instanceof Error ? e.message : undefined,
        variant: "error",
      });
    } finally {
      setLoading(false);
    }
  }

  const pct =
    result && result.totalSold > 0
      ? (result.totalDiscount / result.totalSold) * 100
      : null;

  return (
    <Modal
      open={promo !== null}
      onOpenChange={(o) => !o && onClose()}
      title="Simular promoción"
      description={promo ? promo.name : undefined}
    >
      <div className="space-y-4">
        <p className="text-sm text-muted-foreground">
          Calculá cuánto descuento habría dado esta promo sobre tus ventas del
          período (analiza hasta las 1000 ventas más recientes). No modifica nada.
        </p>

        <div className="flex flex-wrap items-end gap-2">
          <DateRangePicker value={range} onChange={setRange} />
          <Button onClick={run} loading={loading}>
            <LineChart size={16} /> Simular
          </Button>
        </div>

        {result && (
          <div className="grid grid-cols-2 gap-3 rounded-lg border border-border bg-muted/20 p-4">
            <Metric label="Tickets analizados" value={String(result.ticketsAnalyzed)} />
            <Metric label="Tickets con la promo" value={String(result.ticketsWithPromo)} />
            <Metric
              label="Descuento total estimado"
              value={formatCurrency(result.totalDiscount)}
              accent
            />
            <Metric
              label="Sobre lo vendido"
              value={pct != null ? `${pct.toFixed(1)}%` : "—"}
            />
            {result.ticketsAnalyzed === 0 && (
              <p className="col-span-2 text-xs text-muted-foreground">
                No hay ventas completadas en el período elegido.
              </p>
            )}
          </div>
        )}

        <div className="flex justify-end">
          <Button variant="ghost" onClick={onClose}>
            Cerrar
          </Button>
        </div>
      </div>
    </Modal>
  );
}

function Metric({
  label,
  value,
  accent,
}: {
  label: string;
  value: string;
  accent?: boolean;
}) {
  return (
    <div>
      <div className="text-xs text-muted-foreground">{label}</div>
      <div
        className={`font-price text-lg font-bold tabular-nums ${accent ? "text-ninja-flameSoft" : "text-foreground"}`}
      >
        {value}
      </div>
    </div>
  );
}
