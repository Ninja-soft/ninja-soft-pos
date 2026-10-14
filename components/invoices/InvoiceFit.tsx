"use client";

// Achica la hoja A4 (794 px) al ancho disponible en pantalla con `zoom`, sin
// tocar el layout real: al imprimir vuelve a tamaño natural (ADR-112).
import { useEffect, useRef, useState, type ReactNode } from "react";
import { A4_W } from "./parts";

export function InvoiceFit({ children, width = A4_W, max = 1 }: { children: ReactNode; width?: number; max?: number }) {
  const ref = useRef<HTMLDivElement>(null);
  const [zoom, setZoom] = useState(0.5);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const update = () => setZoom(Math.min(max, Math.max(0.2, el.clientWidth / width)));
    update();
    if (typeof ResizeObserver === "undefined") return;
    const ro = new ResizeObserver(update);
    ro.observe(el);
    return () => ro.disconnect();
  }, [width, max]);
  return (
    <div ref={ref} style={{ width: "100%", overflow: "hidden" }}>
      <style>{`@media print{[data-invoice-zoom]{zoom:1!important}}`}</style>
      <div data-invoice-zoom style={{ zoom, width }}>
        {children}
      </div>
    </div>
  );
}
