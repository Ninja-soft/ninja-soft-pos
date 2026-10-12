import { cn } from "@/lib/utils/cn";
import { cardAppIcon, logoOnDark } from "@/lib/payments/logos";

type Surface = "auto" | "light" | "dark";

// Logo de marca transparente que se adapta al tema: si la marca tiene variante
// para fondo oscuro, renderiza las dos y el CSS global (.logo-on-light /
// .logo-on-dark, app/globals.css) muestra la que corresponde al data-theme.
//   on="light" | "dark" → fuerza la superficie (p. ej. /pagar, siempre claro).
//   inverse             → el logo está sobre una superficie invertida
//                         (chip seleccionado bg-foreground).
export function ThemedLogo({
  src,
  alt,
  on = "auto",
  inverse = false,
  className,
  loading,
}: {
  src: string;
  alt: string;
  on?: Surface;
  inverse?: boolean;
  className?: string;
  loading?: "lazy" | "eager";
}) {
  const dark = logoOnDark(src);
  const img = (s: string, extra?: string) => (
    // eslint-disable-next-line @next/next/no-img-element
    <img
      key={s}
      src={s}
      alt={alt}
      loading={loading}
      draggable={false}
      className={cn("select-none object-contain", className, extra)}
    />
  );
  if (on === "light" || dark === src) return img(src);
  if (on === "dark") return img(dark);
  return (
    <>
      {img(src, inverse ? "logo-on-dark" : "logo-on-light")}
      {img(dark, inverse ? "logo-on-light" : "logo-on-dark")}
    </>
  );
}

// Logo de una red de tarjeta como ícono de app, igual que en soft.ninja:
// placa blanca cuadrada y redondeada (radio 22.5%) con el ícono de la red
// (cardAppIcon). Es la excepción a "sin placa": así se reconocen las redes en
// cualquier tema. El lado de la placa es ~1.35x `height`, para que entre en
// el mismo renglón que antes ocupaba el logo apaisado.
export function CardBrandLogo({
  brand,
  label,
  height = 24,
  className,
}: {
  brand: string;
  label?: string;
  height?: number;
  /** Compatibilidad: la placa ya tiene ancho propio. */
  natural?: boolean;
  on?: Surface;
  inverse?: boolean;
  className?: string;
}) {
  const src = cardAppIcon(brand);
  const side = Math.max(20, Math.round(height * 1.35));
  if (!src) {
    return <span className={cn("truncate text-[11px] font-bold", className)}>{label ?? brand}</span>;
  }
  return (
    <span
      className={cn(
        "grid shrink-0 place-items-center overflow-hidden rounded-[22.5%] bg-white shadow-[0_1px_2px_rgba(0,0,0,.12)] ring-1 ring-black/[.06]",
        className,
      )}
      style={{ width: side, height: side }}
    >
      {/* eslint-disable-next-line @next/next/no-img-element */}
      <img src={src} alt={label ?? brand} draggable={false} className="h-full w-full select-none object-contain" />
    </span>
  );
}
