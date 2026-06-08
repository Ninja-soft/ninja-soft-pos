"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { Camera, IdCard, ScanLine, X } from "lucide-react";
import { Modal } from "@/components/ui/Modal";
import { Button } from "@/components/ui/Button";
import { useScanner } from "@/modules/pos/useScanner";
import { parseDni, type ParsedDni } from "@/lib/customers/dniParse";

// BarcodeDetector es nativo en Chromium; no está en los tipos de TS.
interface BarcodeDetectorLike {
  detect: (source: CanvasImageSource) => Promise<{ rawValue: string }[]>;
}
interface BarcodeDetectorCtor {
  new (opts?: { formats?: string[] }): BarcodeDetectorLike;
  getSupportedFormats?: () => Promise<string[]>;
}

const SEXO_LABEL: Record<NonNullable<ParsedDni["sexo"]>, string> = {
  M: "Masculino",
  F: "Femenino",
  X: "No binario",
};

// Escaneo del PDF417 del frente del DNI argentino (H31 · F11). Tres vías de
// captura, sin servicios ni registros gubernamentales — el dato vive en el
// propio código del documento y se parsea OFFLINE:
//   1. Lector 2D USB tipo teclado (keyboard-wedge): tipea el string con `@`;
//      lo capturamos con `useScanner` (global, por velocidad de tipeo + Enter).
//   2. Cámara, si el navegador soporta el formato `pdf417` en BarcodeDetector.
//   3. Pegado manual del código.
// Siempre se muestra una validación visual antes de confirmar (no autocompleta
// la ficha sin que el cajero confirme).
export function DniScanModal({
  open,
  onOpenChange,
  onConfirm,
}: {
  open: boolean;
  onOpenChange: (o: boolean) => void;
  onConfirm: (data: ParsedDni) => void;
}) {
  const [parsed, setParsed] = useState<ParsedDni | null>(null);
  const [manual, setManual] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [camOpen, setCamOpen] = useState(false);
  // null = aún no se sabe; true/false = soporte real de pdf417 por cámara.
  const [camSupported, setCamSupported] = useState<boolean | null>(null);

  // Procesa un string crudo (de cualquier vía) → preview o mensaje de error.
  const handleRaw = useCallback((raw: string) => {
    const r = parseDni(raw);
    if (r) {
      setParsed(r);
      setError(null);
    } else {
      setParsed(null);
      setError("Eso no parece un DNI. Probá escanear de nuevo o pegá el código completo.");
    }
  }, []);

  // Lector USB/HID (keyboard-wedge): activo solo con el modal abierto y mientras
  // la cámara no esté capturando. El DNI escanea rápido y cierra con Enter.
  useScanner(handleRaw, { enabled: open && !camOpen, minLength: 10 });

  // Detecta si la cámara puede leer pdf417 en este navegador (honesto: muchos
  // Chromium no incluyen pdf417 en BarcodeDetector aunque la API exista).
  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    const Ctor = (window as unknown as { BarcodeDetector?: BarcodeDetectorCtor })
      .BarcodeDetector;
    if (!Ctor || !Ctor.getSupportedFormats) {
      setCamSupported(false);
      return;
    }
    Ctor.getSupportedFormats()
      .then((fmts) => {
        if (!cancelled) setCamSupported(fmts.includes("pdf417"));
      })
      .catch(() => {
        if (!cancelled) setCamSupported(false);
      });
    return () => {
      cancelled = true;
    };
  }, [open]);

  // Limpia el estado al cerrar.
  useEffect(() => {
    if (!open) {
      setParsed(null);
      setManual("");
      setError(null);
      setCamOpen(false);
    }
  }, [open]);

  function confirm() {
    if (parsed) {
      onConfirm(parsed);
      onOpenChange(false);
    }
  }

  return (
    <>
      <Modal
        open={open && !camOpen}
        onOpenChange={onOpenChange}
        title="Escanear DNI"
        description="Escaneá el código de barras del frente del DNI con tu lector 2D, con la cámara o pegá el código. Validá los datos antes de guardar."
        className="max-w-lg"
      >
        <div className="space-y-4">
          {/* Estado de captura por lector */}
          <div className="flex items-center gap-3 rounded-lg border border-border bg-muted/40 px-4 py-3">
            <ScanLine className="shrink-0 text-ninja-flameSoft" size={20} />
            <p className="text-sm text-muted-foreground">
              Si tu lector 2D está conectado, escaneá ahora el código del DNI: los
              datos se cargan solos. No hace falta hacer foco en ningún campo.
            </p>
          </div>

          {/* Cámara (solo si el navegador soporta pdf417) */}
          {camSupported === true && (
            <Button
              type="button"
              variant="secondary"
              className="w-full"
              onClick={() => {
                setError(null);
                setCamOpen(true);
              }}
            >
              <Camera size={16} /> Escanear con la cámara
            </Button>
          )}
          {camSupported === false && (
            <p className="text-xs text-muted-foreground">
              Este navegador no puede leer el DNI por cámara. Usá un lector 2D USB
              o pegá el código abajo. (La lectura por cámara suele faltar en
              Firefox/Safari y en varios Chrome de escritorio.)
            </p>
          )}

          {/* Pegado manual */}
          <div>
            <label className="mb-2 block text-sm font-medium text-muted-foreground">
              Pegá o escaneá el código del DNI
            </label>
            <textarea
              value={manual}
              onChange={(e) => setManual(e.target.value)}
              rows={2}
              placeholder="00123456789@PEREZ@JUAN@M@30123456@A@15/06/1985@20/03/2015"
              className="w-full resize-none rounded-lg border border-input bg-background px-4 py-3 text-sm text-foreground outline-none transition placeholder:text-muted-foreground focus:border-ninja-flameSoft focus:ring-2 focus:ring-ninja-flameSoft/20"
            />
            <div className="mt-2 flex justify-end">
              <Button
                type="button"
                variant="secondary"
                size="sm"
                disabled={manual.trim().length < 5}
                onClick={() => handleRaw(manual)}
              >
                <IdCard size={14} /> Leer código
              </Button>
            </div>
          </div>

          {error && (
            <div className="flex items-start gap-2 rounded-lg border border-destructive/40 bg-destructive/10 px-4 py-3 text-sm text-destructive">
              <X size={16} className="mt-0.5 shrink-0" />
              <span>{error}</span>
            </div>
          )}

          {/* Validación visual de lo parseado */}
          {parsed && (
            <div className="rounded-lg border border-emerald-500/40 bg-emerald-500/10 p-4">
              <p className="mb-3 flex items-center gap-2 text-sm font-semibold text-emerald-400">
                <IdCard size={16} /> Datos leídos del DNI
              </p>
              <dl className="grid grid-cols-3 gap-x-3 gap-y-2 text-sm">
                <PreviewRow label="Nombre" value={parsed.nombre} />
                <PreviewRow label="Apellido" value={parsed.apellido} />
                <PreviewRow label="DNI" value={parsed.dni} />
                <PreviewRow
                  label="Sexo"
                  value={parsed.sexo ? SEXO_LABEL[parsed.sexo] : "—"}
                />
                <PreviewRow
                  label="Nacimiento"
                  value={parsed.fechaNac ?? "—"}
                />
              </dl>
            </div>
          )}

          <div className="flex justify-end gap-2 pt-1">
            <Button type="button" variant="secondary" onClick={() => onOpenChange(false)}>
              Cancelar
            </Button>
            <Button type="button" disabled={!parsed} onClick={confirm}>
              Usar estos datos
            </Button>
          </div>
        </div>
      </Modal>

      {camOpen && (
        <Pdf417CameraModal
          open={camOpen}
          onOpenChange={setCamOpen}
          onDetected={(raw) => {
            setCamOpen(false);
            handleRaw(raw);
          }}
        />
      )}
    </>
  );
}

function PreviewRow({ label, value }: { label: string; value: string }) {
  return (
    <div className="col-span-1">
      <dt className="text-xs text-muted-foreground">{label}</dt>
      <dd className="font-medium text-foreground">{value || "—"}</dd>
    </div>
  );
}

// Lectura del PDF417 por cámara. Mismo patrón que `BarcodeScanner` (H23) pero
// restringido al formato pdf417 del DNI. Solo se monta cuando ya verificamos que
// el navegador lo soporta.
function Pdf417CameraModal({
  open,
  onOpenChange,
  onDetected,
}: {
  open: boolean;
  onOpenChange: (o: boolean) => void;
  onDetected: (raw: string) => void;
}) {
  const videoRef = useRef<HTMLVideoElement>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!open) return;
    let stream: MediaStream | null = null;
    let raf = 0;
    let stopped = false;

    const Ctor = (window as unknown as { BarcodeDetector?: BarcodeDetectorCtor })
      .BarcodeDetector;
    if (!Ctor) {
      setError("Este navegador no puede leer el DNI por cámara. Usá un lector 2D.");
      return;
    }
    const detector = new Ctor({ formats: ["pdf417"] });

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
  }, [open, onDetected]);

  return (
    <Modal open={open} onOpenChange={onOpenChange} title="Escanear DNI con la cámara">
      {error ? (
        <p className="py-4 text-sm text-destructive">{error}</p>
      ) : (
        <div className="overflow-hidden rounded-lg border border-border bg-black">
          <video
            ref={videoRef}
            className="aspect-video w-full object-cover"
            muted
            playsInline
          />
        </div>
      )}
      <p className="mt-3 text-center text-xs text-muted-foreground">
        Apuntá la cámara al código de barras del frente del DNI (el rectángulo de
        rayas). Mantené el documento quieto y bien iluminado.
      </p>
    </Modal>
  );
}
