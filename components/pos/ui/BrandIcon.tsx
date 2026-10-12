import { HandCoins, Wallet } from "lucide-react";
import { cn } from "@/lib/utils/cn";
import { ThemedLogo } from "@/components/ui/ThemedLogo";
import { logoSrcFullBleed } from "@/lib/payments/logos";

// Logo oficial de un medio de pago, transparente y sin placa: se apoya directo
// sobre la superficie y usa la variante para fondo oscuro en los temas oscuros
// (ThemedLogo). Los isotipos que ya son un cuadrado lleno (Fiserv) se redondean.
export function BrandIcon({
  logo,
  alt,
  size = 40,
  fallback,
  inverse = false,
  className,
}: {
  logo: string | null;
  alt: string;
  size?: number;
  fallback?: "wallet" | "account";
  inverse?: boolean;
  className?: string;
}) {
  const fullBleed = logo ? logoSrcFullBleed(logo) : false;
  return (
    <span
      className={cn(
        "grid shrink-0 place-items-center",
        !logo && "rounded-[28%] bg-fg-6 text-foreground",
        className,
      )}
      style={{ width: size, height: size }}
    >
      {logo ? (
        <ThemedLogo
          src={logo}
          alt={alt}
          loading="lazy"
          inverse={inverse}
          className={fullBleed ? "h-[86%] w-[86%] rounded-[24%]" : "h-[86%] w-[86%]"}
        />
      ) : fallback === "account" ? (
        <HandCoins size={size * 0.5} aria-hidden />
      ) : (
        <Wallet size={size * 0.5} aria-hidden />
      )}
    </span>
  );
}
