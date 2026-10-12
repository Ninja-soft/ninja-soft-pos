"use client";

import { useState } from "react";
import { Package } from "lucide-react";
import { Spinner } from "@/components/ui/Spinner";
import { cn } from "@/lib/utils/cn";

// Miniatura de producto para listados del panel. Siempre ocupa el mismo
// cuadrado: con foto muestra un spinner hasta que carga (lazy), y sin foto o si
// falla la carga cae a un ícono neutro.
export function ProductThumb({
  src,
  size = 40,
  className,
}: {
  src?: string | null;
  size?: number;
  className?: string;
}) {
  const url = src?.trim() || null;
  // Se guarda la URL que cargó / falló para que, si cambia la foto, vuelva el
  // spinner sin necesidad de un efecto que resetee el estado.
  const [loadedUrl, setLoadedUrl] = useState<string | null>(null);
  const [failedUrl, setFailedUrl] = useState<string | null>(null);

  const showImage = url !== null && failedUrl !== url;
  const loaded = showImage && loadedUrl === url;

  return (
    <span
      className={cn(
        "relative inline-flex shrink-0 items-center justify-center overflow-hidden rounded-md bg-muted text-muted-foreground",
        className,
      )}
      style={{ width: size, height: size }}
    >
      {showImage ? (
        <>
          {!loaded && <Spinner size={16} label="Cargando foto" className="absolute" />}
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img
            src={url}
            alt=""
            width={size}
            height={size}
            loading="lazy"
            decoding="async"
            draggable={false}
            onLoad={() => setLoadedUrl(url)}
            onError={() => setFailedUrl(url)}
            className={cn(
              "h-full w-full object-cover transition-opacity",
              loaded ? "opacity-100" : "opacity-0",
            )}
          />
        </>
      ) : (
        <Package size={Math.round(size * 0.45)} aria-hidden />
      )}
    </span>
  );
}
ProductThumb.displayName = "ProductThumb";
