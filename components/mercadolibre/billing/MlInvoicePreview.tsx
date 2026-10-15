"use client";

import { useMemo } from "react";
import { Eye } from "lucide-react";
import { Badge } from "@/components/ui/Badge";
import { Segmented } from "@/components/ui/Segmented";
import { Switch } from "@/components/ui/Switch";
import {
  PLAN_STATUS_LABELS,
  SAMPLE_LOGISTICS,
  STRATEGY_LABELS,
  planStatusTone,
  previewPtoVta,
  sampleInvoiceInput,
  warningLabel,
  type SampleBuyer,
  type SampleLogistic,
  type SampleOptions,
} from "@/lib/mercadolibre/billing";
import { buildInvoicePlan, type PlanSettings } from "@/supabase/functions/_shared/mercadolibre/invoicePlan";
import { jurisdictionName } from "@/supabase/functions/_shared/mercadolibre/perceptionLink";
import { invoiceNotesText, moneyAr, type LogisticStores } from "@/supabase/functions/_shared/mercadolibre/billingConfig";

const MODE_TEXT: Record<string, string> = {
  on_paid: "Sale apenas Mercado Libre confirma el pago.",
  on_shipped: "Sale cuando el envío se despacha.",
  on_delivered: "Sale cuando el comprador recibe.",
  manual: "Queda en la bandeja hasta que la factures.",
  none: "Esta cuenta no factura las ventas.",
};

// Vista previa de la configuración (ADR-145): arma con buildInvoicePlan (el
// mismo armado que usa el worker) la factura de una venta de ejemplo con lo
// elegido en pantalla, y la recalcula con cada cambio.
export function MlInvoicePreview({
  settings,
  emitter,
  canPerceive,
  sample,
  onSample,
  invoiceMode,
  upload,
  pdfFormat,
  ptoVta,
  stores,
  accountStore,
  logisticStores,
  notes,
}: {
  settings: PlanSettings;
  emitter: { iva_condition: string | null; issues_m: boolean };
  canPerceive: boolean;
  sample: SampleOptions;
  onSample: (s: SampleOptions) => void;
  invoiceMode: string;
  upload: boolean;
  pdfFormat: "a4" | "ticket";
  ptoVta: number | null;
  stores: Array<{ id: string; name: string; pto_vta: number | null }>;
  accountStore: { store_id: string | null; warehouse_id: string | null } | null;
  logisticStores: LogisticStores;
  notes: { enabled: boolean; template: string };
}) {
  const plan = useMemo(
    () => buildInvoicePlan(sampleInvoiceInput(settings, emitter, sample, canPerceive)),
    [settings, emitter, sample, canPerceive],
  );
  const rec = plan.receptors[plan.choice];
  const perc = plan.perception;
  const pv = previewPtoVta({ logistic: plan.logistic, rules: logisticStores, accountStore, accountPtoVta: ptoVta, stores });
  const legend = notes.enabled
    ? invoiceNotesText(notes.template, { venta: "2000012345678901", comprador: rec.name.split(" ")[0] ?? "", envio: SAMPLE_LOGISTICS.find((l) => l.key === sample.logistic)?.label ?? "", fecha: "15/10/2026" })
    : null;
  const percLink = plan.choice === "billing" && perc.applies && perc.strategy === "link";

  return (
    <section aria-label="Vista previa de la factura" className="space-y-3 rounded-xl border border-border bg-card p-4">
      <div className="flex items-center gap-2">
        <Eye size={16} className="text-muted-foreground" />
        <h3 className="text-sm font-semibold">Así queda la factura de una venta de ejemplo</h3>
      </div>
      <p className="text-xs text-muted-foreground">Cambiá la venta de ejemplo para ver cómo responde cada regla.</p>
      <div className="space-y-2">
        <Segmented<SampleLogistic>
          size="sm"
          scroll
          aria-label="Envío de la venta de ejemplo"
          value={sample.logistic}
          onChange={(v) => onSample({ ...sample, logistic: v })}
          options={SAMPLE_LOGISTICS.map((l) => ({ value: l.key, label: l.label }))}
        />
        <Segmented<SampleBuyer>
          size="sm"
          aria-label="Comprador de la venta de ejemplo"
          value={sample.buyer}
          onChange={(v) => onSample({ ...sample, buyer: v })}
          options={[
            { value: "ri", label: "Empresa con CUIT" },
            { value: "cf", label: "Consumidor final" },
          ]}
        />
        <div className="flex flex-wrap gap-4 text-xs">
          <label className="flex items-center gap-2">
            <Switch checked={sample.coupon} label="Con cupón" onCheckedChange={(v) => onSample({ ...sample, coupon: v })} />
            Con cupón
          </label>
          <label className="flex items-center gap-2">
            <Switch checked={sample.shippingPaid} label="Envío pagado por el comprador" onCheckedChange={(v) => onSample({ ...sample, shippingPaid: v })} />
            Envío pagado
          </label>
        </div>
      </div>

      <div className="rounded-lg bg-muted/40 p-3 text-sm" data-testid="invoice-preview">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <span className="font-semibold">
            Factura {rec.letter ?? "?"}
            {pv.pto_vta ? ` · PV ${String(pv.pto_vta).padStart(5, "0")}` : " · sin punto de venta"}
          </span>
          <Badge tone={planStatusTone(plan.status)}>{PLAN_STATUS_LABELS[plan.status] ?? plan.status}</Badge>
        </div>
        <p className="mt-1 text-xs text-muted-foreground">
          {rec.name}
          {rec.doc_number ? ` · ${(rec.doc_type ?? "doc").toUpperCase()} ${rec.doc_number}` : ""}
          {pv.store ? ` · Sucursal ${pv.store}` : ""}
        </p>
        <ul className="mt-3 space-y-1.5" aria-label="Renglones de la factura de ejemplo">
          {plan.items.map((it) => (
            <li key={it.ml_item_id} className="flex justify-between gap-3">
              <span className="min-w-0 truncate">
                {it.quantity} × {it.title}
              </span>
              <span className="tabular-nums">{moneyAr(it.gross)}</span>
            </li>
          ))}
          {plan.coupon.discount > 0 && (
            <li className="flex justify-between gap-3 text-muted-foreground">
              <span>Descuento cupón</span>
              <span className="tabular-nums">{moneyAr(-plan.coupon.discount)}</span>
            </li>
          )}
          {plan.shipping.line && (
            <li className="flex justify-between gap-3">
              <span>{plan.shipping.label}</span>
              <span className="tabular-nums">{moneyAr(plan.shipping.amount)}</span>
            </li>
          )}
        </ul>
        <div className="mt-3 flex justify-between gap-3 border-t border-border pt-2 font-semibold">
          <span>Total</span>
          <span className="tabular-nums">{moneyAr(plan.totals.invoice + (percLink ? perc.total : 0))}</span>
        </div>
        {percLink && (
          <p className="mt-1 text-xs text-muted-foreground">
            Incluye la percepción de {perc.lines.map((l) => jurisdictionName(l.jurisdiction)).join(", ")} por {moneyAr(perc.total)}, que se cobra antes por link de pago.
          </p>
        )}
        <ul className="mt-3 space-y-1 text-xs text-muted-foreground">
          {plan.coupon.total > 0 && plan.coupon.mode === "prorate" && <li>El cupón de {moneyAr(plan.coupon.total)} quedó repartido en los precios.</li>}
          {plan.coupon.total > 0 && plan.coupon.mode === "none" && <li>El cupón de {moneyAr(plan.coupon.total)} no se descuenta.</li>}
          {plan.shipping.kind === "buyer_paid" && !plan.shipping.line && <li>El envío que pagó el comprador no va en la factura.</li>}
          {plan.shipping.kind === "a_convenir" && <li>Envío a convenir: si te lo pagan aparte, se factura aparte.</li>}
          {perc.applies && perc.strategy && plan.choice === "billing" && (
            <li>Percepción: {STRATEGY_LABELS[perc.strategy]}.</li>
          )}
          {perc.applies && perc.strategy === "invoice_b" && <li>Percepción: con este envío sale factura B sin percepción.</li>}
          {plan.warnings.filter((w) => w !== "shipping_a_convenir").map((w) => (
            <li key={w} className="text-warning">{warningLabel(w)}</li>
          ))}
        </ul>
        {legend && <p className="mt-3 rounded-md bg-background/60 px-2 py-1.5 text-xs italic">{legend}</p>}
      </div>

      <ul className="space-y-1 text-xs text-muted-foreground">
        <li>{MODE_TEXT[invoiceMode] ?? ""}</li>
        <li>
          PDF {pdfFormat === "ticket" ? "ticket de 80 mm" : "hoja A4"}
          {upload ? ", subido solo a la venta en Mercado Libre." : ", sin subir a Mercado Libre."}
        </li>
        {pv.source !== "account" && <li>Factura y descuenta stock desde la sucursal de la regla de este envío.</li>}
        {sample.logistic === "full" && <li>El stock sale del depósito virtual Full, no de tu sucursal.</li>}
      </ul>
    </section>
  );
}
