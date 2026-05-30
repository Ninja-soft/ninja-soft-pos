"use client";

import { useEffect, useRef, useState } from "react";
import { Modal } from "@/components/ui/Modal";

// BarcodeDetector es nativo en Chromium; no está en los tipos de TS.
interface BarcodeDetectorLike {
  detect: (source: CanvasImageSource) => Promise<{ rawValue: string }[]>;
}
interface BarcodeDetectorCtor {
  new (opts?: { formats?: string[] }): BarcodeDetectorLike;
}

export function BarcodeScanner({
  open,
  onOpenChange,
  onDetected,
}: {
  open: boolean;
  onOpenChange: (o: boolean) => void;
  onDetected: (code: string) => void;
}) {
  const videoRef = useRef<HTMLVideoElement>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!open) return;
    let stream: MediaStream | null = null;
    let raf = 0;
    let stopped = false;

    const Ctor = (
      window as unknown as { BarcodeDetector?: BarcodeDetectorCtor }
    ).BarcodeDetector;
    if (!Ctor) {
      setError(
        "Tu navegador no soporta lectura por cámara. Usá un lector USB o buscá por código.",
      );
      return;
    }
    const detector = new Ctor({
      formats: ["ean_13", "ean_8", "code_128", "upc_a", "upc_e"],
    });

    (async () => {
      try {
        stream = await navigator.mediaDevices.getUserMedia({
          video: { facingMode: "environment" },
        });
        if (stopped) return;
        if (videoRef.current) {
          videoRef.current.srcObject = stream;
          await videoRef.current.play();
        }
        const tick = async () => {
          if (stopped || !videoRef.current) return;
          try {
            const codes = await detector.detect(videoRef.current);
            if (codes[0]?.rawValue) {
              onDetected(codes[0].rawValue);
              onOpenChange(false);
              return;
            }
          } catch {
            // frame sin lectura; seguimos.
          }
          raf = requestAnimationFrame(tick);
        };
        raf = requestAnimationFrame(tick);
      } catch {
        setError("No pudimos acceder a la cámara. Revisá los permisos.");
      }
    })();

    return () => {
      stopped = true;
      cancelAnimationFrame(raf);
      stream?.getTracks().forEach((t) => t.stop());
    };
  }, [open, onDetected, onOpenChange]);

  return (
    <Modal open={open} onOpenChange={onOpenChange} title="Escanear código">
      {error ? (
        <p className="py-4 text-sm text-destructive">{error}</p>
      ) : (
        <div className="overflow-hidden rounded-ninjaLg border border-border bg-black">
          <video
            ref={videoRef}
            className="aspect-video w-full object-cover"
            muted
            playsInline
          />
        </div>
      )}
      <p className="mt-3 text-center text-xs text-muted-foreground">
        Apuntá la cámara al código de barras.
      </p>
    </Modal>
  );
}
