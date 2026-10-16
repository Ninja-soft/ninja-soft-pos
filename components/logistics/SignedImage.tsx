"use client";

// Imagen del bucket privado logistics-media (ADR-161) con URL firmada de 10
// minutos. Mientras carga, un bloque neutro; sin foto, el ícono del vehículo.

import { ImageOff } from "lucide-react";
import { useSignedUrl } from "@/modules/logistics/api";
import { cn } from "@/lib/utils/cn";

export function SignedImage({
  path,
  alt,
  className,
  fallback,
  contain = false,
}: {
  path: string | null | undefined;
  alt: string;
  className?: string;
  fallback?: React.ReactNode;
  contain?: boolean;
}) {
  const { data: url, isLoading } = useSignedUrl(path);
  if (!path || (!isLoading && !url)) {
    return (
      <div className={cn("grid place-items-center bg-muted text-muted-foreground", className)} aria-label={alt} role="img">
        {fallback ?? <ImageOff size={20} aria-hidden />}
      </div>
    );
  }
  if (!url) return <div className={cn("animate-pulse bg-muted", className)} aria-hidden />;
  return (
    // eslint-disable-next-line @next/next/no-img-element
    <img src={url} alt={alt} loading="lazy" className={cn(contain ? "object-contain" : "object-cover", "bg-muted", className)} />
  );
}
SignedImage.displayName = "SignedImage";
