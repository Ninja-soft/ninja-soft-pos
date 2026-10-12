import { HandCoins, Wallet } from "lucide-react";
import { cn } from "@/lib/utils/cn";

// Logo oficial de un medio de pago. Los isotipos (public/images/payments) y
// los logos de red de tarjetas son de fondo transparente: se muestran tal cual,
// sin placa blanca, sobre la superficie del botón. Sin logo, ícono lucide en
// el color de texto atenuado del tema.
export function BrandIcon({
  logo,
  alt,
  size = 40,
  fallback,
  className,
}: {
  logo: string | null;
  alt: string;
  size?: number;
  fallback?: "wallet" | "account";
  className?: string;
}) {
  const Fallback = fallback === "account" ? HandCoins : Wallet;
  return (
    // Alto fijo; los logos apaisados (redes de tarjeta) crecen a lo ancho
    // hasta 1.6× en vez de achicarse dentro de un cuadrado.
    <span
      className={cn("grid shrink-0 place-items-center", className)}
      style={{ height: size, minWidth: size, maxWidth: Math.round(size * 1.6) }}
    >
      {logo ? (
        // eslint-disable-next-line @next/next/no-img-element
        <img
          src={logo}
          alt={alt}
          height={size}
          loading="lazy"
          decoding="async"
          className="h-full w-auto max-w-full object-contain"
          draggable={false}
        />
      ) : (
        <Fallback size={Math.round(size * 0.6)} className="text-muted-foreground" aria-hidden />
      )}
    </span>
  );
}
