import { cn } from "@/lib/utils/cn";
import { cardLogo, cardLogoAspect, logoOnDark } from "@/lib/payments/logos";

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

// Logo de una red de tarjeta, sin placa, en una caja fija (alto `height`,
// ancho 2.4x, salvo `natural`) para que todas las marcas ocupen el mismo
// lugar. Dentro, cada logo se escala por su proporción para igualar el peso
// visual: Visa o Naranja X (apaisados) no quedan enormes ni Amex o Cabal
// (cuadrados) chicos.
export function CardBrandLogo({
  brand,
  label,
  height = 24,
  on = "auto",
  inverse = false,
  natural = false,
  className,
}: {
  brand: string;
  label?: string;
  height?: number;
  on?: Surface;
  inverse?: boolean;
  /** Ancho propio del logo (filas de adelanto) en vez de la caja fija. */
  natural?: boolean;
  className?: string;
}) {
  const src = cardLogo(brand);
  const scale = Math.min(1, Math.max(0.55, Math.sqrt(1.6 / cardLogoAspect(brand))));
  return (
    <span
      className={cn("inline-flex max-w-full shrink-0 items-center justify-center", className)}
      style={{ height, width: natural ? undefined : Math.round(height * 2.4) }}
    >
      {src ? (
        <span className="inline-flex max-w-full items-center justify-center" style={{ height: Math.round(height * scale) }}>
          <ThemedLogo src={src} alt={label ?? brand} on={on} inverse={inverse} className="h-full w-auto max-w-full" />
        </span>
      ) : (
        <span className="truncate text-[11px] font-bold">{label ?? brand}</span>
      )}
    </span>
  );
}
