import { HandCoins, Wallet } from "lucide-react";
import { cn } from "@/lib/utils/cn";

// Logo oficial de un medio de pago en un "ícono de app" blanco (estilo iOS):
// los logos de marca están pensados para fondo claro, así se leen igual en los
// temas oscuros sin invertir colores ni teñir la marca.
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
  return (
    <span
      className={cn(
        "grid shrink-0 place-items-center overflow-hidden rounded-[28%] bg-white shadow-[0_1px_2px_rgba(0,0,0,0.18),inset_0_0_0_1px_rgba(11,7,32,0.06)]",
        className,
      )}
      style={{ width: size, height: size }}
    >
      {logo ? (
        // eslint-disable-next-line @next/next/no-img-element
        <img
          src={logo}
          alt={alt}
          loading="lazy"
          className="h-[72%] w-[72%] object-contain"
          draggable={false}
        />
      ) : fallback === "account" ? (
        <HandCoins size={size * 0.5} className="text-[#3B237A]" aria-hidden />
      ) : (
        <Wallet size={size * 0.5} className="text-[#3B237A]" aria-hidden />
      )}
    </span>
  );
}
