"use client";

import { CreditCard, HandCoins, Wallet } from "lucide-react";
import { THEMES, useTheme } from "@/lib/theme/ThemeProvider";
import { tenderLogoSrc, type LogoSource } from "@/lib/pos/tenderLogo";
import { cn } from "@/lib/utils/cn";

function useLogoTone(): "light" | "dark" {
  const { theme } = useTheme();
  return THEMES.find((t) => t.name === theme)?.dark ? "dark" : "light";
}

export type LogoFallback = "wallet" | "account" | "card";

/** Ícono neutro para un medio sin logo (cuenta corriente, tarjeta en posnet). */
export function tenderFallback(t: { flow: string }): LogoFallback {
  return t.flow === "account" ? "account" : t.flow === "card" ? "card" : "wallet";
}

// Logo de un medio de cobro con su fondo transparente, directo sobre la
// superficie del tile (sin placa blanca). Sin logo: ícono neutro.
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
  const tone = useLogoTone();
  const src = tenderLogoSrc(source, tone);
  return (
    <span
      className={cn("grid shrink-0 place-items-center", className)}
      style={{ width: size, height: size }}
    >
      {src ? (
        // eslint-disable-next-line @next/next/no-img-element
        <img
          src={src}
          alt={alt}
          loading="eager"
          draggable={false}
          className="h-full w-full object-contain"
        />
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
