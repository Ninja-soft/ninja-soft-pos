import Image from "next/image";
import { cn } from "@/lib/utils/cn";

// Logos oficiales de NinjaSoft (assets en /public/brand). No re-tipografiar:
// el wordmark es una imagen de marca. Los wordmarks tienen "Ninja" en blanco,
// por eso solo deben usarse sobre fondos oscuros.
//
// `sizes`: el ancho intrínseco de los wordmarks es ~1100px pero se muestran a
// 100-300px de ancho. Sin `sizes`, next/image arma un srcset 1x/2x a partir del
// width (1200w / 3840w) y el login bajaba una imagen de 3840px como LCP. Con
// `sizes` el navegador elige la variante chica (≈640w en pantallas 2x).
const WORDMARK_SIZES = "320px";

export function Isotype({
  className,
  priority,
}: {
  className?: string;
  priority?: boolean;
}) {
  return (
    <Image
      src="/brand/ninja-isotype.webp"
      alt="NinjaSoft"
      width={81}
      height={100}
      sizes="64px"
      priority={priority}
      className={cn("h-8 w-auto", className)}
    />
  );
}

export function WordmarkPos({
  className,
  priority,
  variant = "auto",
}: {
  className?: string;
  priority?: boolean;
  /**
   * "auto": swap por CSS según data-theme (versión dark-mode en temas oscuros,
   * light-mode en temas claros), sin flash ni JS.
   * "dark": siempre la versión para fondo oscuro, ignora el tema seleccionado
   * (p. ej. login, cuyo fondo es siempre void).
   */
  variant?: "auto" | "dark";
}) {
  if (variant === "dark") {
    return (
      <Image
        src="/brand/ninjapos-wordmark.webp"
        alt="NinjaPos"
        width={1134}
        height={321}
        sizes={WORDMARK_SIZES}
        priority={priority}
        className={cn("h-8 w-auto", className)}
      />
    );
  }
  return (
    <>
      <Image
        src="/brand/ninjapos-logo-dark-mode.webp"
        alt="NinjaPos"
        width={1071}
        height={253}
        sizes={WORDMARK_SIZES}
        priority={priority}
        className={cn("wordmark-on-dark h-8 w-auto", className)}
      />
      <Image
        src="/brand/ninjapos-logo-light-mode.webp"
        alt="NinjaPos"
        width={1071}
        height={253}
        sizes={WORDMARK_SIZES}
        // Sólo el del tema por defecto (oscuro) se precarga: el otro se baja
        // únicamente si el tema claro lo muestra.
        className={cn("wordmark-on-light h-8 w-auto", className)}
      />
    </>
  );
}

export function WordmarkSoft({
  className,
  priority,
}: {
  className?: string;
  priority?: boolean;
}) {
  return (
    <Image
      src="/brand/ninjasoft-wordmark.webp"
      alt="NinjaSoft"
      width={367}
      height={100}
      sizes={WORDMARK_SIZES}
      priority={priority}
      className={cn("h-8 w-auto", className)}
    />
  );
}

// Logos OFICIALES (public/brand/oficial, ver su README): `*-light` lleva
// "Ninja" en blanco (fondos oscuros), `*-dark` lleva "Ninja" oscuro (fondos
// claros). El swap es por CSS según data-theme (.wordmark-on-dark/-light), sin
// JS ni flash. `variant="dark"` fuerza la versión para fondo oscuro.
function OfficialLogo({
  name,
  alt,
  width,
  sizes,
  className,
  priority,
  variant = "auto",
}: {
  name: "ninja-pos" | "ninja-soft";
  alt: string;
  width: number;
  sizes: string;
  className?: string;
  priority?: boolean;
  variant?: "auto" | "dark";
}) {
  const onDark = (
    <Image
      src={`/brand/oficial/${name}-light.webp`}
      alt={alt}
      width={width}
      height={255}
      sizes={sizes}
      priority={priority}
      className={cn(variant === "auto" && "wordmark-on-dark", className)}
    />
  );
  if (variant === "dark") return onDark;
  return (
    <>
      {onDark}
      <Image
        src={`/brand/oficial/${name}-dark.webp`}
        alt={alt}
        width={width}
        height={255}
        sizes={sizes}
        className={cn("wordmark-on-light", className)}
      />
    </>
  );
}

/** Logo oficial Ninja POS (1059x255). */
export function LogoNinjaPos({
  className,
  priority,
  variant,
}: {
  className?: string;
  priority?: boolean;
  variant?: "auto" | "dark";
}) {
  return (
    <OfficialLogo
      name="ninja-pos"
      alt="Ninja POS"
      width={1059}
      sizes={WORDMARK_SIZES}
      priority={priority}
      variant={variant}
      className={cn("h-8 w-auto", className)}
    />
  );
}

/** Logo oficial Ninja Soft (1130x255), para firmas "Un producto de Ninja Soft". */
export function LogoNinjaSoft({ className }: { className?: string }) {
  return (
    <OfficialLogo
      name="ninja-soft"
      alt="Ninja Soft"
      width={1130}
      sizes="160px"
      className={cn("h-4 w-auto", className)}
    />
  );
}
