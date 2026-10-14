"use client";

// Datos de una cuenta para transferir (ADR-120): logo del banco, titular,
// CUIT, CBU / CVU y alias con botón para copiar. Lo usan la configuración de
// cobro del panel interno y "Cómo pagar" del panel del negocio.

import { useState } from "react";
import { Check, Copy } from "lucide-react";
import { BankLogo } from "@/components/payments/BankLogo";
import { Badge } from "@/components/ui/Badge";
import { cn } from "@/lib/utils/cn";
import { formatCuit } from "@/lib/payments/transfer";
import { groupCbu } from "@/lib/billing/paymentNotice";

export function CopyValue({
  value,
  label,
  display,
  mono = true,
}: {
  value: string;
  label: string;
  /** Texto a mostrar si difiere de lo que se copia (CBU agrupado). */
  display?: string;
  mono?: boolean;
}) {
  const [done, setDone] = useState(false);
  return (
    <button
      type="button"
      onClick={() => {
        void navigator.clipboard?.writeText(value).then(() => {
          setDone(true);
          setTimeout(() => setDone(false), 1500);
        });
      }}
      aria-label={`Copiar ${label}`}
      title={`Copiar ${label}`}
      className="group inline-flex min-w-0 max-w-full items-center gap-1.5 rounded-md px-1.5 py-1 text-left transition hover:bg-muted focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
    >
      <span className={cn("min-w-0 truncate text-sm font-semibold text-foreground", mono && "font-mono tracking-wide")}>{display ?? value}</span>
      {done ? (
        <Check size={14} className="shrink-0 text-success" aria-hidden />
      ) : (
        <Copy size={14} className="shrink-0 text-muted-foreground group-hover:text-foreground" aria-hidden />
      )}
    </button>
  );
}

export interface BankAccountLike {
  bank_slug: string | null;
  bank_name: string;
  holder_name: string;
  cuit: string | null;
  cbu: string | null;
  alias: string | null;
  note?: string | null;
  is_default?: boolean;
  is_active?: boolean;
}

export function BankAccountDetails({
  account,
  actions,
  className,
}: {
  account: BankAccountLike;
  actions?: React.ReactNode;
  className?: string;
}) {
  const isCvu = Boolean(account.cbu?.startsWith("000"));
  return (
    <div className={cn("min-w-0 rounded-xl bg-muted/50 p-4", className)}>
      <div className="flex items-start gap-3">
        <BankLogo slug={account.bank_slug} name={account.bank_name} size={40} />
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-2">
            <p className="truncate text-sm font-semibold text-foreground">{account.bank_name}</p>
            {account.is_default && <Badge tone="brand">Por defecto</Badge>}
            {account.is_active === false && <Badge tone="neutral">Inactiva</Badge>}
          </div>
          <p className="truncate text-xs text-muted-foreground">
            {account.holder_name}
            {account.cuit ? ` · CUIT ${formatCuit(account.cuit)}` : ""}
          </p>
        </div>
        {actions && <div className="flex shrink-0 items-center gap-1">{actions}</div>}
      </div>
      <dl className="mt-3 grid gap-x-4 gap-y-1 sm:grid-cols-2">
        {account.cbu && (
          <div className="min-w-0">
            <dt className="px-1.5 text-xs text-muted-foreground">{isCvu ? "CVU" : "CBU"}</dt>
            <dd className="min-w-0">
              <CopyValue value={account.cbu} display={groupCbu(account.cbu)} label={isCvu ? "CVU" : "CBU"} />
            </dd>
          </div>
        )}
        {account.alias && (
          <div className="min-w-0">
            <dt className="px-1.5 text-xs text-muted-foreground">Alias</dt>
            <dd className="min-w-0">
              <CopyValue value={account.alias} label="alias" />
            </dd>
          </div>
        )}
      </dl>
      {account.note && <p className="mt-2 px-1.5 text-xs text-muted-foreground">{account.note}</p>}
    </div>
  );
}
BankAccountDetails.displayName = "BankAccountDetails";
