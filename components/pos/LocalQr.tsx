"use client";

import { useMemo } from "react";
import { encodeQr, qrSvgPath } from "@/lib/qr/qrcode";

// QR dibujado local (SVG) a partir del texto: el qr_data EMVCo de MP o el
// link de pago. Sin servicios externos de imágenes.
export function LocalQr({ value, label, size = 260 }: { value: string; label: string; size?: number }) {
  const svg = useMemo(() => {
    try {
      const qr = encodeQr(value, "M");
      return { path: qrSvgPath(qr, 4), dim: qr.size + 8 };
    } catch {
      return null;
    }
  }, [value]);
  if (!svg) return null;
  return (
    <svg
      role="img"
      aria-label={label}
      viewBox={`0 0 ${svg.dim} ${svg.dim}`}
      width={size}
      height={size}
      shapeRendering="crispEdges"
      className="rounded-lg border border-border bg-white"
    >
      <rect width={svg.dim} height={svg.dim} fill="#fff" />
      <path d={svg.path} fill="#000" />
    </svg>
  );
}
