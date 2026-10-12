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
        priority={priority}
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
