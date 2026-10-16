"use client";

// Firma en pantalla (ADR-161): canvas con eventos de puntero (dedo, lápiz o
// mouse), trazo suavizado con curvas, fondo blanco para que la firma salga
// igual en el remito. Devuelve un PNG con toBlob al confirmar. Sin librerías.

import { forwardRef, useCallback, useEffect, useImperativeHandle, useRef, useState } from "react";
import { Eraser } from "lucide-react";
import { cn } from "@/lib/utils/cn";

export interface SignaturePadHandle {
  /** PNG de la firma, o null si está vacía. */
  toBlob: () => Promise<Blob | null>;
  clear: () => void;
  isEmpty: () => boolean;
}

export const SignaturePad = forwardRef<
  SignaturePadHandle,
  { onChange?: (empty: boolean) => void; className?: string; height?: number; label?: string }
>(function SignaturePad({ onChange, className, height = 180, label = "Firma de quien recibe" }, ref) {
  const canvas = useRef<HTMLCanvasElement>(null);
  const drawing = useRef(false);
  const last = useRef<{ x: number; y: number } | null>(null);
  const strokes = useRef(0);
  const [empty, setEmpty] = useState(true);

  const setup = useCallback(() => {
    const c = canvas.current;
    if (!c) return;
    const ratio = Math.max(1, Math.min(3, typeof window !== "undefined" ? window.devicePixelRatio || 1 : 1));
    const w = c.clientWidth || 320;
    c.width = Math.round(w * ratio);
    c.height = Math.round(height * ratio);
    const ctx = c.getContext("2d");
    if (!ctx) return;
    ctx.setTransform(ratio, 0, 0, ratio, 0, 0);
    ctx.fillStyle = "#ffffff";
    ctx.fillRect(0, 0, w, height);
    ctx.lineCap = "round";
    ctx.lineJoin = "round";
    ctx.strokeStyle = "#111827";
    ctx.lineWidth = 2.4;
  }, [height]);

  useEffect(() => {
    setup();
  }, [setup]);

  const mark = (v: boolean) => {
    setEmpty(v);
    onChange?.(v);
  };

  function point(e: React.PointerEvent<HTMLCanvasElement>) {
    const r = e.currentTarget.getBoundingClientRect();
    return { x: e.clientX - r.left, y: e.clientY - r.top };
  }

  function down(e: React.PointerEvent<HTMLCanvasElement>) {
    e.preventDefault();
    e.currentTarget.setPointerCapture?.(e.pointerId);
    drawing.current = true;
    last.current = point(e);
    const ctx = canvas.current?.getContext("2d");
    if (ctx && last.current) {
      ctx.beginPath();
      ctx.arc(last.current.x, last.current.y, 1.2, 0, Math.PI * 2);
      ctx.fillStyle = "#111827";
      ctx.fill();
    }
  }

  function move(e: React.PointerEvent<HTMLCanvasElement>) {
    if (!drawing.current || !last.current) return;
    e.preventDefault();
    const ctx = canvas.current?.getContext("2d");
    if (!ctx) return;
    const p = point(e);
    const mid = { x: (last.current.x + p.x) / 2, y: (last.current.y + p.y) / 2 };
    ctx.beginPath();
    ctx.moveTo(last.current.x, last.current.y);
    ctx.quadraticCurveTo(last.current.x, last.current.y, mid.x, mid.y);
    ctx.lineTo(p.x, p.y);
    ctx.stroke();
    last.current = p;
  }

  function up() {
    if (!drawing.current) return;
    drawing.current = false;
    last.current = null;
    strokes.current += 1;
    if (empty) mark(false);
  }

  function clear() {
    strokes.current = 0;
    setup();
    mark(true);
  }

  useImperativeHandle(ref, () => ({
    clear,
    isEmpty: () => strokes.current === 0,
    toBlob: () =>
      new Promise<Blob | null>((resolve) => {
        const c = canvas.current;
        if (!c || strokes.current === 0) return resolve(null);
        c.toBlob((b) => resolve(b), "image/png");
      }),
  }));

  return (
    <div className={cn("space-y-1.5", className)}>
      <div className="flex items-center justify-between">
        <span className="text-sm font-medium">{label}</span>
        <button
          type="button"
          onClick={clear}
          disabled={empty}
          className="inline-flex h-9 items-center gap-1.5 rounded-lg px-2.5 text-sm text-muted-foreground transition hover:bg-muted disabled:opacity-40"
        >
          <Eraser size={15} aria-hidden /> Borrar
        </button>
      </div>
      <div className="relative overflow-hidden rounded-lg border border-border bg-white">
        <canvas
          ref={canvas}
          role="img"
          aria-label={empty ? `${label}: vacía` : `${label}: firmada`}
          data-testid="signature-canvas"
          style={{ height, touchAction: "none" }}
          className="block w-full cursor-crosshair"
          onPointerDown={down}
          onPointerMove={move}
          onPointerUp={up}
          onPointerLeave={up}
          onPointerCancel={up}
        />
        {empty && (
          <span className="pointer-events-none absolute inset-x-0 bottom-3 text-center text-xs text-neutral-400">
            Firmá acá con el dedo
          </span>
        )}
        <span className="pointer-events-none absolute inset-x-6 bottom-9 border-t border-dashed border-neutral-300" aria-hidden />
      </div>
    </div>
  );
});
SignaturePad.displayName = "SignaturePad";
