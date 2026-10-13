"use client";

// Logo de un medio de pago para el listado y el detalle de ventas. Usa la
// fuente única de logos (lib/payments/logos.ts vía ThemedLogo) y, si el medio
// no tiene logo propio (débito/crédito sin procesador, cuenta corriente,
// saldo a favor), un ícono neutro del tema. La red de la tarjeta va aparte
// con CardBrandLogo.
import { ArrowLeftRight, Banknote, BookUser, CreditCard, QrCode, Wallet, type LucideIcon } from "lucide-react";
import { ThemedLogo, CardBrandLogo } from "@/components/ui/ThemedLogo";
import { paymentIcon, paymentIconFullBleed } from "@/lib/payments/logos";
import { cuotasLabel, type PaymentChip } from "@/lib/sales/salesList";
import { formatCurrency } from "@/lib/utils/format";
import { cn } from "@/lib/utils/cn";

const METHOD_ICON: Record<string, LucideIcon> = {
  cash: Banknote,
  debit: CreditCard,
  credit: CreditCard,
  transfer: ArrowLeftRight,
  qr: QrCode,
  account: BookUser,
  store_credit: Wallet,
};

export function PaymentLogo({
  method,
  providerKey,
  label,
  size = 28,
  className,
}: {
  method: string;
  providerKey?: string | null;
  label: string;
  size?: number;
  className?: string;
}) {
  const src = (providerKey && paymentIcon(providerKey)) || paymentIcon(method);
  const Icon = METHOD_ICON[method] ?? Wallet;
  const bleed = providerKey ? paymentIconFullBleed(providerKey) : false;
  return (
    <span
      className={cn(
        "grid shrink-0 place-items-center overflow-hidden rounded-md border border-border bg-background text-muted-foreground",
        className,
      )}
      style={{ width: size, height: size }}
      title={label}
    >
      {src ? (
        <ThemedLogo
          src={src}
          alt={label}
          loading="lazy"
          className={bleed ? "h-full w-full" : "h-[70%] w-[70%]"}
        />
      ) : (
        <Icon size={Math.round(size * 0.55)} aria-label={label} />
      )}
    </span>
  );
}
PaymentLogo.displayName = "PaymentLogo";

/** Pastilla compacta de un cobro agrupado: logo, red, cuotas y monto. */
export function PaymentChipView({ chip, showAmount = true }: { chip: PaymentChip; showAmount?: boolean }) {
  const name = chip.providerLabel && chip.method !== "cash" ? `${chip.label} · ${chip.providerLabel}` : chip.label;
  const cuotas = cuotasLabel(chip.cuotas);
  return (
    <span
      className="inline-flex max-w-full items-center gap-1.5 rounded-md bg-muted py-1 pl-1 pr-2 text-xs"
      title={[name, chip.brandLabel, cuotas, formatCurrency(chip.amount)].filter(Boolean).join(" · ")}
    >
      <PaymentLogo method={chip.method} providerKey={chip.providerKey} label={name} size={20} />
      {chip.brandKey && <CardBrandLogo brand={chip.brandKey} label={chip.brandLabel ?? undefined} height={12} />}
      <span className="truncate font-medium text-foreground">{chip.label}</span>
      {cuotas && chip.cuotas! > 1 && <span className="shrink-0 text-muted-foreground">{cuotas}</span>}
      {showAmount && <span className="shrink-0 tabular-nums text-muted-foreground">{formatCurrency(chip.amount)}</span>}
    </span>
  );
}
