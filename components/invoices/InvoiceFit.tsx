"use client";

// Achica la hoja A4 (794 px) al ancho disponible en pantalla sin tocar el
// layout real (ADR-112): la hoja se arma siempre a su ancho natural y se
// escala con `transform`, y el marco toma el alto ya escalado. Antes usaba
// `zoom`, que en Safari de iPhone rearmaba el texto (tabla cortada a la
// derecha, "ARCA" encima de la leyenda). Al imprimir vuelve a tamaño natural.
import { useEffect, useRef, useState, type ReactNode } from "react";
import { A4_W } from "./parts";

export function InvoiceFit({ children, width = A4_W, max = 1 }: { children: ReactNode; width?: number; max?: number }) {
  const frameRef = useRef<HTMLDivElement>(null);
  const sheetRef = useRef<HTMLDivElement>(null);
  const [scale, setScale] = useState(0.5);
  const [height, setHeight] = useState<number | null>(null);
  useEffect(() => {
    const frame = frameRef.current;
    const sheet = sheetRef.current;
    if (!frame || !sheet) return;
    const update = () => {
      const s = Math.min(max, Math.max(0.2, frame.clientWidth / width));
      setScale(s);
      // offsetHeight no incluye el transform: es el alto natural de la hoja.
      setHeight(Math.ceil(sheet.offsetHeight * s));
    };
    update();
    if (typeof ResizeObserver === "undefined") return;
    const ro = new ResizeObserver(update);
    ro.observe(frame);
    ro.observe(sheet);
    return () => ro.disconnect();
  }, [width, max]);
  return (
    <div
      ref={frameRef}
      data-invoice-fit
      style={{ width: "100%", overflow: "hidden", height: height ?? undefined }}
    >
      <style>{`@media print{[data-invoice-fit]{height:auto!important}[data-invoice-zoom]{transform:none!important}}`}</style>
      <div
        ref={sheetRef}
        data-invoice-zoom
        style={{
          width,
          transform: `scale(${scale})`,
          transformOrigin: "top left",
          WebkitTextSizeAdjust: "100%",
          textSizeAdjust: "100%",
        }}
      >
        {children}
      </div>
    </div>
  );
}
