"use client";

import { cn } from "@/lib/utils/cn";
import { bankBySlug, bankIcon, bankWordmark } from "@/lib/payments/banks";
import { initialsOf } from "@/lib/payments/transfer";

// Logo de un banco o billetera (ADR-055): isotipo del catálogo
// (public/images/banks), logo propio subido por el negocio o un monograma
// neutro si no hay ninguno. Transparente y sin placa; en los temas oscuros
// alterna a la variante `-on-dark` cuando la marca la tiene (mismas clases
// logo-on-light / logo-on-dark que ThemedLogo). `on` fuerza una superficie.

type Surface = "auto" | "light" | "dark";

function Themed({ light, dark, alt, className, on }: { light: string; dark: string; alt: string; className?: string; on: Surface }) {
  const img = (src: string, extra?: string) => (
    // eslint-disable-next-line @next/next/no-img-element
    <img key={src} src={src} alt={alt} draggable={false} className={cn("select-none object-contain", className, extra)} />
  );
  if (light === dark || on === "light") return img(light);
  if (on === "dark") return img(dark);
  return (
    <>
      {img(light, "logo-on-light")}
      {img(dark, "logo-on-dark")}
    </>
  );
}

export function BankLogo({
  slug,
  customUrl,
  name,
  size = 40,
  on = "auto",
  className,
}: {
  slug: string | null;
  customUrl?: string | null;
  name: string;
  size?: number;
  on?: Surface;
  className?: string;
}) {
  const bank = bankBySlug(slug);
  const light = bank ? bankIcon(bank.slug) : null;
  const dark = bank ? bankIcon(bank.slug, { on: "dark" }) : null;
  const src = light ?? customUrl ?? null;
  return (
    <span
      className={cn("flex shrink-0 items-center justify-center", !src && "rounded-md bg-fg-6", className)}
      style={{ width: size, height: size }}
      aria-hidden={src ? undefined : true}
    >
      {light ? (
        <Themed
          light={light}
          dark={dark ?? light}
          alt={name}
          on={on}
          className={cn("h-full w-full", bank?.iconFullBleed && "rounded-[22%]")}
        />
      ) : src ? (
        // eslint-disable-next-line @next/next/no-img-element
        <img src={src} alt={name} draggable={false} className="h-full w-full select-none object-contain" />
      ) : (
        <span className="font-semibold text-muted-foreground" style={{ fontSize: Math.max(10, size * 0.36) }}>
          {initialsOf(name)}
        </span>
      )}
    </span>
  );
}

/** Logo horizontal del catálogo (o null si no hay: el que llama muestra el nombre). */
export function BankWordmark({
  slug,
  name,
  on = "auto",
  className,
}: {
  slug: string | null;
  name: string;
  on?: Surface;
  className?: string;
}) {
  const bank = bankBySlug(slug);
  const light = bank ? bankWordmark(bank.slug) : null;
  if (!bank || !light || bank.fallback) return null;
  return <Themed light={light} dark={bankWordmark(bank.slug, { on: "dark" }) ?? light} alt={name} on={on} className={className} />;
}
