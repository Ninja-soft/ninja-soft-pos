"use client";

// H9b PR4 — Recorte simple de imágenes para el editor canvas de tickets.
// Se dibuja la imagen en un canvas y el usuario arrastra para definir el
// rectángulo de recorte. "Aplicar" genera un WebP, lo sube como archivo nuevo
// y devuelve la nueva URL pública. La imagen se carga con crossOrigin para
// poder leer el canvas (tenant-assets es público y sirve headers CORS).
import { useEffect, useRef, useState } from "react";
import { Modal } from "@/components/ui/Modal";
import { Button } from "@/components/ui/Button";
import { useToast } from "@/components/ui/Toast";
import { uploadTicketImageBlob } from "@/lib/tickets/uploadTicketImage";

interface Rect {
  x: number;
  y: number;
  w: number;
  h: number;
}

interface Props {
  open: boolean;
  onOpenChange: (o: boolean) => void;
  url: string;
  tenantId: string;
  onCropped: (newUrl: string) => void;
}

const MAX_VIEW = 420; // lado máximo del canvas de edición en px

export function ImageCropModal({ open, onOpenChange, url, tenantId, onCropped }: Props) {
  const { toast } = useToast();
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const imgRef = useRef<HTMLImageElement | null>(null);
  // Escala vista→imagen real (imagen natural / canvas mostrado).
  const scaleRef = useRef(1);
  const dragRef = useRef<{ startX: number; startY: number } | null>(null);

  const [loaded, setLoaded] = useState(false);
  const [busy, setBusy] = useState(false);
  // Rect en coordenadas del canvas mostrado (no de la imagen natural).
  const [rect, setRect] = useState<Rect | null>(null);

  // Carga la imagen (con CORS) y dibuja el canvas a tamaño de vista.
  useEffect(() => {
    if (!open || !url) return;
    setLoaded(false);
    setRect(null);
    const img = new Image();
    img.crossOrigin = "anonymous";
    img.onload = () => {
      const natW = img.naturalWidth || img.width;
      const natH = img.naturalHeight || img.height;
      const scale = Math.min(1, MAX_VIEW / Math.max(natW, natH));
      const viewW = Math.round(natW * scale);
      const viewH = Math.round(natH * scale);
      scaleRef.current = scale > 0 ? 1 / scale : 1; // vista→natural
      imgRef.current = img;
      const canvas = canvasRef.current;
      if (canvas) {
        canvas.width = viewW;
        canvas.height = viewH;
      }
      setLoaded(true);
    };
    img.onerror = () => {
      toast({ title: "No se pudo cargar la imagen", variant: "error" });
      onOpenChange(false);
    };
    img.src = url;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, url]);

  // Redibuja la imagen + overlay de recorte cada vez que cambia el rect.
  useEffect(() => {
    if (!loaded) return;
    const canvas = canvasRef.current;
    const img = imgRef.current;
    if (!canvas || !img) return;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
    if (rect && rect.w > 0 && rect.h > 0) {
      // Oscurece todo y "abre" la zona seleccionada.
      ctx.save();
      ctx.fillStyle = "rgba(0,0,0,0.5)";
      ctx.fillRect(0, 0, canvas.width, canvas.height);
      ctx.clearRect(rect.x, rect.y, rect.w, rect.h);
      ctx.drawImage(
        img,
        rect.x * scaleRef.current,
        rect.y * scaleRef.current,
        rect.w * scaleRef.current,
        rect.h * scaleRef.current,
        rect.x,
        rect.y,
        rect.w,
        rect.h,
      );
      ctx.strokeStyle = "#EC3F17";
      ctx.lineWidth = 1.5;
      ctx.strokeRect(rect.x + 0.5, rect.y + 0.5, rect.w, rect.h);
      ctx.restore();
    }
  }, [loaded, rect]);

  function pointInCanvas(e: React.PointerEvent) {
    const canvas = canvasRef.current;
    if (!canvas) return { x: 0, y: 0 };
    const r = canvas.getBoundingClientRect();
    const x = ((e.clientX - r.left) / r.width) * canvas.width;
    const y = ((e.clientY - r.top) / r.height) * canvas.height;
    return {
      x: Math.min(canvas.width, Math.max(0, x)),
      y: Math.min(canvas.height, Math.max(0, y)),
    };
  }

  function onPointerDown(e: React.PointerEvent) {
    if (!loaded) return;
    (e.target as HTMLElement).setPointerCapture(e.pointerId);
    const p = pointInCanvas(e);
    dragRef.current = { startX: p.x, startY: p.y };
    setRect({ x: p.x, y: p.y, w: 0, h: 0 });
  }

  function onPointerMove(e: React.PointerEvent) {
    const d = dragRef.current;
    if (!d) return;
    const p = pointInCanvas(e);
    setRect({
      x: Math.min(d.startX, p.x),
      y: Math.min(d.startY, p.y),
      w: Math.abs(p.x - d.startX),
      h: Math.abs(p.y - d.startY),
    });
  }

  function onPointerUp(e: React.PointerEvent) {
    if (dragRef.current) {
      try {
        (e.target as HTMLElement).releasePointerCapture(e.pointerId);
      } catch {
        /* noop */
      }
      dragRef.current = null;
    }
  }

  async function apply() {
    const img = imgRef.current;
    if (!img || !rect || rect.w < 4 || rect.h < 4) {
      toast({ title: "Dibujá un recorte primero", variant: "error" });
      return;
    }
    setBusy(true);
    try {
      const s = scaleRef.current;
      const out = document.createElement("canvas");
      out.width = Math.max(1, Math.round(rect.w * s));
      out.height = Math.max(1, Math.round(rect.h * s));
      const ctx = out.getContext("2d");
      if (!ctx) throw new Error("canvas");
      ctx.drawImage(
        img,
        rect.x * s,
        rect.y * s,
        rect.w * s,
        rect.h * s,
        0,
        0,
        out.width,
        out.height,
      );
      const blob = await new Promise<Blob | null>((resolve) =>
        out.toBlob(resolve, "image/webp", 0.82),
      );
      if (!blob) throw new Error("blob");
      const newUrl = await uploadTicketImageBlob(blob, tenantId);
      onCropped(newUrl);
      toast({ title: "Imagen recortada", variant: "success" });
      onOpenChange(false);
    } catch {
      // Tainted canvas (SecurityError) u otro fallo de recorte/subida.
      toast({ title: "No se pudo recortar esta imagen", variant: "error" });
    } finally {
      setBusy(false);
    }
  }

  return (
    <Modal open={open} onOpenChange={onOpenChange} title="Recortar imagen" className="max-w-xl">
      <div className="space-y-4">
        <p className="text-sm text-muted-foreground">
          Arrastrá sobre la imagen para dibujar el recorte.
        </p>
        <div className="flex justify-center">
          <canvas
            ref={canvasRef}
            onPointerDown={onPointerDown}
            onPointerMove={onPointerMove}
            onPointerUp={onPointerUp}
            className="max-w-full cursor-crosshair touch-none rounded-lg border border-border bg-muted/30"
          />
        </div>
        <div className="flex justify-end gap-2">
          <Button variant="secondary" onClick={() => onOpenChange(false)} disabled={busy}>
            Cancelar
          </Button>
          <Button onClick={apply} loading={busy} disabled={!rect || rect.w < 4}>
            Aplicar
          </Button>
        </div>
      </div>
    </Modal>
  );
}
