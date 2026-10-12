import { HandCoins, Wallet } from "lucide-react";
import { cn } from "@/lib/utils/cn";
import { ThemedLogo } from "@/components/ui/ThemedLogo";
import { logoSrcFullBleed } from "@/lib/payments/logos";

// Logo oficial de un medio de pago (fuente única lib/payments/logos.ts). Los
// isotipos (public/images/payments) y los logos de red de tarjetas son de fondo
// transparente: se muestran tal cual, sin placa blanca, sobre la superficie del
// botón, con la variante para fondo oscuro en los temas oscuros (ThemedLogo).
// Los isotipos que ya son un cuadrado lleno (Fiserv) se redondean. Sin logo,
// ícono lucide en el color de texto atenuado del tema.
export function BrandIcon({
  logo,
  alt,
  size = 40,
  fallback,
  inverse,
  className,
}: {
  logo: string | null;
  alt: string;
  size?: number;
  fallback?: "wallet" | "account";
  /** El logo está sobre una superficie invertida (bg-foreground). */
  inverse?: boolean;
  className?: string;
}) {
  const Fallback = fallback === "account" ? HandCoins : Wallet;
  const fullBleed = logo ? logoSrcFullBleed(logo) : false;
  return (
    // Alto fijo; los logos apaisados (redes de tarjeta) crecen a lo ancho
    // hasta 1.6× en vez de achicarse dentro de un cuadrado.
    <span
      className={cn("grid shrink-0 place-items-center", className)}
      style={{ height: size, minWidth: size, maxWidth: Math.round(size * 1.6) }}
    >
      {logo ? (
        <ThemedLogo
          src={logo}
          alt={alt}
          loading="lazy"
          inverse={inverse}
          className={cn("h-full w-auto max-w-full", fullBleed && "rounded-[24%]")}
        />
      ) : (
        <Fallback size={Math.round(size * 0.6)} className="text-muted-foreground" aria-hidden />
      )}
    </span>
  );
}
