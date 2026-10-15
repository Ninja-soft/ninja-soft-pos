"use client";

import { useEffect, useRef, useState } from "react";
import { cn } from "@/lib/utils/cn";

/** px CSS por mm (96 dpi). */
export const PX_PER_MM = 96 / 25.4;

/**
 * Muestra un documento de etiquetas (el mismo HTML que se imprime) en un
 * iframe aislado: los estilos del impreso no se mezclan con los de la app y
 * lo que se ve es lo que sale. El alto se ajusta al contenido.
 */
export function LabelFrame({
  html,
  title,
  className,
  minHeight = 80,
  maxHeight,
}: {
  html: string;
  title: string;
  className?: string;
  minHeight?: number;
  maxHeight?: number;
}) {
  const ref = useRef<HTMLIFrameElement>(null);
  const [h, setH] = useState(minHeight);

  useEffect(() => {
    const frame = ref.current;
    if (!frame) return;
    let ro: ResizeObserver | null = null;
    const measure = () => {
      const doc = frame.contentDocument;
      if (!doc?.body) return;
      const next = Math.max(minHeight, Math.ceil(doc.documentElement.scrollHeight));
      setH(maxHeight ? Math.min(maxHeight, next) : next);
    };
    const onLoad = () => {
      measure();
      const body = frame.contentDocument?.body;
      if (body && typeof ResizeObserver !== "undefined") {
        ro = new ResizeObserver(measure);
        ro.observe(body);
      }
    };
    frame.addEventListener("load", onLoad);
    return () => {
      frame.removeEventListener("load", onLoad);
      ro?.disconnect();
    };
  }, [html, minHeight, maxHeight]);

  return (
    <iframe
      ref={ref}
      title={title}
      srcDoc={html}
      sandbox="allow-same-origin"
      className={cn("block w-full border-0 bg-transparent", className)}
      style={{ height: h }}
    />
  );
}
