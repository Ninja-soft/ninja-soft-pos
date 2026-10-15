"use client";

// Alertas de margen (F14 · H67, ADR-092): productos bajo costo, bajo el
// precio mínimo o con margen menor al mínimo del negocio, con el precio
// sugerido. Dueño y encargado (el costo no lo ve el cajero).

import { useEffect, useMemo, useState } from "react";
import { TrendingDown } from "lucide-react";
import { Badge, type BadgeTone } from "@/components/ui/Badge";
import { Button } from "@/components/ui/Button";
import { EmptyState } from "@/components/ui/EmptyState";
import { Input } from "@/components/ui/Input";
import { Segmented } from "@/components/ui/Segmented";
import { Switch } from "@/components/ui/Switch";
import { TableStateRow, TableWrap } from "@/components/ui/Table";
import { useToast } from "@/components/ui/Toast";
import { formatCurrency } from "@/lib/utils/format";
import { MARGIN_LEVEL_LABEL, marginErrorMessage, type MarginAlertRow } from "@/lib/commercial/margins";
import {
  useMarginAlerts,
  useMarginSettings,
  useMarginSummary,
  useSaveMarginSettings,
} from "@/modules/commercial/api";

type Filter = "all" | MarginAlertRow["level"];

const LEVEL_TONE: Record<MarginAlertRow["level"], BadgeTone> = {
  negative: "danger",
  below_min_price: "warning",
  low: "warning",
};

const pct = (n: number) => `${String(Math.round(n * 10) / 10).replace(".", ",")} %`;

export function MarginAlertsPanel() {
  const { data: settings } = useMarginSettings();
  const { data: summary } = useMarginSummary();
  const { data: rows = [], isLoading } = useMarginAlerts();
  const save = useSaveMarginSettings();
  const { toast } = useToast();
  const [min, setMin] = useState("20");
  const [notify, setNotify] = useState(true);
  const [filter, setFilter] = useState<Filter>("all");

  useEffect(() => {
    if (!settings) return;
    setMin(String(settings.min_margin_pct));
    setNotify(settings.notify);
  }, [settings]);

  const shown = useMemo(() => (filter === "all" ? rows : rows.filter((r) => r.level === filter)), [rows, filter]);

  async function onSave() {
    try {
      await save.mutateAsync({ min: Number(min), notify });
      toast({ title: "Margen mínimo guardado", variant: "success" });
    } catch (e) {
      toast({ title: "No se pudo guardar", description: marginErrorMessage(e), variant: "error" });
    }
  }

  return (
    <div className="space-y-6">
      {summary && (
        <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
          {[
            { label: "Bajo costo", value: summary.negative },
            { label: "Margen bajo", value: summary.low },
            { label: "Bajo el precio mínimo", value: summary.below_min_price },
            { label: "Sin costo cargado", value: summary.without_cost },
          ].map((k) => (
            <div key={k.label} className="rounded-lg bg-card p-3 ring-1 ring-border">
              <p className="text-xs text-muted-foreground">{k.label}</p>
              <p className="mt-1 text-xl font-semibold tabular-nums">{k.value}</p>
            </div>
          ))}
        </div>
      )}

      <section className="border-t-2 border-ninja-flame pt-4">
        <h2 className="text-base font-semibold">Margen mínimo</h2>
        <div className="mt-3 flex flex-col gap-3 sm:flex-row sm:items-end">
          <label className="block text-sm sm:w-48">
            <span className="mb-1 block font-medium">Sobre el precio de venta (%)</span>
            <Input type="number" inputMode="decimal" min={0} max={99} value={min} onChange={(e) => setMin(e.target.value)} />
          </label>
          <label className="flex items-center gap-3 text-sm sm:pb-2">
            <Switch label="Avisar" checked={notify} onCheckedChange={setNotify} />
            Avisar cuando un costo nuevo deja un producto debajo
          </label>
          <Button onClick={onSave} loading={save.isPending}>
            Guardar
          </Button>
        </div>
      </section>

      <section>
        <Segmented<Filter> scrollOnMobile
          aria-label="Filtro"
          size="sm"
          value={filter}
          onChange={setFilter}
          options={[
            { value: "all", label: `Todos (${rows.length})` },
            { value: "negative", label: "Bajo costo" },
            { value: "low", label: "Margen bajo" },
            { value: "below_min_price", label: "Precio mínimo" },
          ]}
        />
        {!isLoading && rows.length === 0 ? (
          <EmptyState
            className="mt-4"
            icon={TrendingDown}
            title="Todos los márgenes están bien"
            description="Ningún producto con costo cargado está debajo del margen mínimo."
          />
        ) : (
          <TableWrap className="mt-3">
            <table className="w-full min-w-[640px] text-sm">
              <thead>
                <tr className="border-b border-border text-left text-xs text-muted-foreground">
                  <th className="px-3 py-2 font-medium">Producto</th>
                  <th className="px-3 py-2 text-right font-medium">Costo</th>
                  <th className="px-3 py-2 text-right font-medium">Precio</th>
                  <th className="px-3 py-2 text-right font-medium">Margen</th>
                  <th className="px-3 py-2 text-right font-medium">Precio sugerido</th>
                </tr>
              </thead>
              <tbody>
                {isLoading ? (
                  <TableStateRow colSpan={5} loading />
                ) : (
                  shown.map((r) => (
                    <tr key={r.product_id} className="border-b border-border last:border-0">
                      <td className="px-3 py-2">
                        <p className="font-medium">{r.name}</p>
                        <p className="flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
                          <Badge tone={LEVEL_TONE[r.level]}>{MARGIN_LEVEL_LABEL[r.level]}</Badge>
                          {r.sku}
                        </p>
                      </td>
                      <td className="px-3 py-2 text-right tabular-nums">{formatCurrency(r.cost)}</td>
                      <td className="px-3 py-2 text-right tabular-nums">{formatCurrency(r.price)}</td>
                      <td className="px-3 py-2 text-right tabular-nums">{pct(r.margin_pct)}</td>
                      <td className="px-3 py-2 text-right font-medium tabular-nums">{formatCurrency(r.suggested_price)}</td>
                    </tr>
                  ))
                )}
              </tbody>
            </table>
          </TableWrap>
        )}
        <p className="mt-2 text-xs text-muted-foreground">
          El costo es el que usa el negocio para el margen (último, promedio o reposición, según Compras). Cambiá el precio
          desde Productos o con un cambio masivo de precios.
        </p>
      </section>
    </div>
  );
}
