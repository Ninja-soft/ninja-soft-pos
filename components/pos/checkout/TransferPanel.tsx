"use client";

import { useState } from "react";
import { Check, Copy } from "lucide-react";
import { BankLogo, BankWordmark } from "@/components/payments/BankLogo";
import { cn } from "@/lib/utils/cn";
import { cbuLabel, formatCbu, formatCuit, type TransferAccount } from "@/lib/payments/transfer";
import { formatCurrency } from "@/lib/utils/format";

// Pantalla de transferencia de la hoja de cobro (ADR-055): cuenta donde el
// cliente transfiere (selector si hay varias), titular, CUIT, CBU / CVU y
// alias con botón de copiar, y el monto. La confirmación ("Ya transfirió") es
// el botón principal de la hoja.

function CopyField({ label, value, display, mono }: { label: string; value: string; display?: string; mono?: boolean }) {
  const [done, setDone] = useState(false);
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(value);
      setDone(true);
      setTimeout(() => setDone(false), 1500);
    } catch {
      /* sin permiso de portapapeles: el dato queda a la vista */
    }
  };
  return (
    <div className="flex items-center justify-between gap-3 px-3 py-2.5">
      <div className="min-w-0">
        <p className="text-[11px] font-semibold uppercase tracking-[0.08em] text-muted-foreground">{label}</p>
        <p className={cn("break-all font-semibold text-foreground", mono ? "font-mono text-[13px]" : "text-[15px]")}>
          {display ?? value}
        </p>
      </div>
      <button
        type="button"
        onClick={copy}
        aria-label={`Copiar ${label}`}
        className="inline-flex h-9 shrink-0 items-center gap-1.5 rounded-lg bg-fg-6 px-2.5 text-xs font-semibold text-foreground transition hover:bg-fg-10 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
      >
        {done ? <Check size={14} aria-hidden /> : <Copy size={14} aria-hidden />}
        {done ? "Copiado" : "Copiar"}
      </button>
    </div>
  );
}

export function TransferPanel({
  accounts,
  selectedId,
  onSelect,
  amount,
}: {
  accounts: TransferAccount[];
  selectedId: string | null;
  onSelect: (id: string) => void;
  amount: number;
}) {
  const acc = accounts.find((a) => a.id === selectedId) ?? accounts[0];
  if (!acc) return null;
  return (
    <div className="space-y-2.5">
      {accounts.length > 1 && (
        <div className="flex flex-wrap gap-1.5" role="radiogroup" aria-label="Cuenta para transferir">
          {accounts.map((a) => (
            <button
              key={a.id}
              type="button"
              role="radio"
              aria-checked={a.id === acc.id}
              onClick={() => onSelect(a.id)}
              className={cn(
                "inline-flex h-10 items-center gap-2 rounded-lg px-2.5 text-[13px] font-medium transition focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
                a.id === acc.id ? "bg-fg-10 text-foreground" : "bg-fg-4 text-muted-foreground hover:text-foreground",
              )}
            >
              <BankLogo slug={a.bank_slug} customUrl={a.custom_logo_url} name={a.bank_name} size={22} />
              <span className="max-w-[9rem] truncate">{a.bank_name}</span>
            </button>
          ))}
        </div>
      )}

      <div className="overflow-hidden rounded-lg border border-border bg-card">
        <div className="flex items-center gap-3 border-b border-border px-3 py-3">
          <BankLogo slug={acc.bank_slug} customUrl={acc.custom_logo_url} name={acc.bank_name} size={40} />
          <div className="min-w-0 flex-1">
            <BankWordmark slug={acc.bank_slug} name={acc.bank_name} className="h-6 w-auto max-w-full object-left" />
            <p className={cn("truncate", acc.bank_slug ? "text-xs text-muted-foreground" : "text-sm font-semibold")}>
              {acc.bank_name}
            </p>
          </div>
          <div className="shrink-0 text-right">
            <p className="text-[11px] font-semibold uppercase tracking-[0.08em] text-muted-foreground">
              Monto{acc.currency === "USD" ? " USD" : ""}
            </p>
            <p className="font-price text-lg font-bold tabular-nums">{formatCurrency(amount)}</p>
          </div>
        </div>
        <div className="divide-y divide-border">
          <div className="px-3 py-2.5">
            <p className="text-[11px] font-semibold uppercase tracking-[0.08em] text-muted-foreground">Titular</p>
            <p className="text-[15px] font-semibold">{acc.holder_name}</p>
            {acc.cuit && <p className="text-xs text-muted-foreground">CUIT {formatCuit(acc.cuit)}</p>}
          </div>
          {acc.alias && <CopyField label="Alias" value={acc.alias} />}
          {acc.cbu && <CopyField label={cbuLabel(acc.cbu)} value={acc.cbu} display={formatCbu(acc.cbu)} mono />}
        </div>
        {acc.note && <p className="border-t border-border px-3 py-2 text-xs text-muted-foreground">{acc.note}</p>}
      </div>
      <p className="text-xs text-muted-foreground">
        Confirmá en tu banco o billetera que la plata llegó antes de tocar Ya transfirió.
      </p>
    </div>
  );
}
