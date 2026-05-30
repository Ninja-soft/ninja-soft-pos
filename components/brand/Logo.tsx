import Image from "next/image";
import { cn } from "@/lib/utils/cn";

// Logos oficiales de NinjaSoft (assets en /public/brand). No re-tipografiar:
// el wordmark es una imagen de marca. Los wordmarks tienen "Ninja" en blanco,
// por eso solo deben usarse sobre fondos oscuros.

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
      priority={priority}
      className={cn("h-8 w-auto", className)}
    />
  );
}

export function WordmarkPos({
  className,
  priority,
}: {
  className?: string;
  priority?: boolean;
}) {
  return (
    <Image
      src="/brand/ninjapos-wordmark.webp"
      alt="NinjaPos"
      width={367}
      height={100}
      priority={priority}
      className={cn("h-8 w-auto", className)}
    />
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
      priority={priority}
      className={cn("h-8 w-auto", className)}
    />
  );
}
