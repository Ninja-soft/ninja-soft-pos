"use client";

import { CreditCard, HandCoins, Wallet } from "lucide-react";
import { ThemedLogo } from "@/components/ui/ThemedLogo";
import type { LogoSource } from "@/lib/pos/tenderLogo";
import { cn } from "@/lib/utils/cn";

export type LogoFallback = "wallet" | "account" | "card";

/** Ícono neutro para un medio sin logo (cuenta corriente, tarjeta en posnet). */
export function tenderFallback(t: { flow: string }): LogoFallback {
  return t.flow === "account" ? "account" : t.flow === "card" ? "card" : "wallet";
}

// Logo de un medio de cobro con su fondo transparente, directo sobre la
// superficie del tile (sin placa blanca). ThemedLogo alterna la variante
// oficial para fondo oscuro (lib/payments/logos.ts) según data-theme, sin
// esperar a la hidratación. Sin logo: ícono neutro.
export function TenderLogo({
  source,
  alt,
  size = 32,
  fallback,
  className,
}: {
  source: LogoSource;
  alt: string;
  size?: number;
  fallback?: LogoFallback;
  className?: string;
}) {
  return (
    <span
      className={cn("grid shrink-0 place-items-center", className)}
      style={{ width: size, height: size }}
    >
      {source.logo ? (
        <ThemedLogo src={source.logo} alt={alt} loading="eager" className="h-full w-full" />
      ) : fallback === "account" ? (
        <HandCoins size={size * 0.7} className="text-muted-foreground" aria-hidden />
      ) : fallback === "card" ? (
        <CreditCard size={size * 0.7} className="text-muted-foreground" aria-hidden />
      ) : (
        <Wallet size={size * 0.7} className="text-muted-foreground" aria-hidden />
      )}
    </span>
  );
}
