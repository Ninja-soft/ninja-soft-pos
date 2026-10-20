"use client";

// F24 · H160 (ADR-179): campos del cobro con cheque o e-cheq (entra a la
// cartera de Tesorería) y con efectivo en dólares (cotización del día y vuelto
// en pesos) en la hoja de cobro del POS.

import { Callout } from "@/components/ui/Callout";
import { cn } from "@/lib/utils/cn";
import { formatUsd, type UsdQuote, type UsdSettle } from "@/lib/pos/usd";
import { money } from "../ui/posStyles";

const LABEL = "block text-[11px] font-semibold uppercase tracking-[0.08em] text-muted-foreground";
const INPUT =
  "mt-1.5 h-11 w-full rounded-lg border border-border bg-background px-3 text-sm font-medium text-foreground outline-none transition placeholder:text-muted-foreground focus:border-ring focus-visible:ring-2 focus-visible:ring-ring/40";

export interface ChequeDraft {
  number: string;
  bank: string;
  paymentDate: string;
  drawer: string;
  cuit: string;
}

export const EMPTY_CHEQUE: ChequeDraft = { number: "", bank: "", paymentDate: "", drawer: "", cuit: "" };

export function ChequeFields({
  value,
  onChange,
  echeq,
  cuitError,
}: {
  value: ChequeDraft;
  onChange: (v: ChequeDraft) => void;
  echeq: boolean;
  cuitError: boolean;
}) {
  const set = (k: keyof ChequeDraft) => (e: React.ChangeEvent<HTMLInputElement>) =>
    onChange({ ...value, [k]: e.target.value });
  return (
    <div className="grid grid-cols-2 gap-3">
      <div>
        <label htmlFor="chq-number" className={LABEL}>
          Número {echeq ? "de e-cheq" : "de cheque"}
        </label>
        <input id="chq-number" autoFocus value={value.number} maxLength={30} onChange={set("number")} className={INPUT} />
      </div>
      <div>
        <label htmlFor="chq-date" className={LABEL}>
          Fecha de pago
        </label>
        <input id="chq-date" type="date" value={value.paymentDate} onChange={set("paymentDate")} className={INPUT} />
      </div>
      <div>
        <label htmlFor="chq-bank" className={LABEL}>
          Banco
        </label>
        <input id="chq-bank" value={value.bank} maxLength={80} onChange={set("bank")} className={INPUT} />
      </div>
      <div>
        <label htmlFor="chq-cuit" className={LABEL}>
          CUIT del librador
        </label>
        <input
          id="chq-cuit"
          inputMode="numeric"
          value={value.cuit}
          maxLength={13}
          onChange={set("cuit")}
          aria-invalid={cuitError || undefined}
          className={cn(INPUT, cuitError && "border-destructive")}
        />
      </div>
      <div className="col-span-2">
        <label htmlFor="chq-drawer" className={LABEL}>
          Librador (opcional)
        </label>
        <input id="chq-drawer" value={value.drawer} maxLength={120} onChange={set("drawer")} className={INPUT} />
      </div>
      <p className="col-span-2 text-xs text-muted-foreground">
        {cuitError ? "Revisá el CUIT del librador." : "Entra a la cartera de cheques de Tesorería al confirmar la venta."}
      </p>
    </div>
  );
}

export function UsdFields({
  usd,
  onUsd,
  quote,
  due,
  settle,
}: {
  usd: string;
  onUsd: (v: string) => void;
  quote: UsdQuote | null | undefined;
  /** Pesos que se quieren cubrir con este medio. */
  due: number;
  settle: UsdSettle;
}) {
  if (!quote) {
    return (
      <Callout tone="warning" className="p-3 text-xs">
        No hay cotización del dólar para hoy. Cargala en Precios, cotizaciones, o esperá la oficial.
      </Callout>
    );
  }
  return (
    <div className="space-y-2">
      <div>
        <label htmlFor="usd-received" className={LABEL}>
          Dólares que entrega
        </label>
        <input
          id="usd-received"
          autoFocus
          type="number"
          inputMode="decimal"
          min="0"
          step="1"
          value={usd}
          onChange={(e) => onUsd(e.target.value)}
          placeholder={String(Math.ceil(due / quote.rate))}
          className={cn(INPUT, "text-right tabular-nums")}
        />
      </div>
      <p className="text-xs text-muted-foreground">
        Cotización {money(quote.rate)} ({quote.source === "negocio" ? "del negocio" : "oficial"}).
        {settle.ars > 0 && <> {formatUsd(Number(usd) || 0)} son {money(settle.ars)}.</>}
      </p>
      {settle.ars > 0 && settle.change > 0 && (
        <p className="text-sm font-semibold">Vuelto en pesos: {money(settle.change)}</p>
      )}
      {settle.ars > 0 && !settle.covers && (
        <p className="text-xs text-muted-foreground">
          Cubre {money(settle.amount)}; el resto se cobra con otro medio.
        </p>
      )}
    </div>
  );
}
