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
//   2. Cámara (incluida la del celular): decodifica el PDF417 en vivo con ZXing
//      (`@zxing/browser`), que sí soporta el formato por JS donde el nativo
//      `BarcodeDetector` no llega (Safari iOS, muchos Android/Chrome). Si el
//      navegador trae `BarcodeDetector` con pdf417 real, se intenta primero como
//      atajo rápido y se cae a ZXing.
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
  // null = aún no se sabe; true/false = hay cámara disponible en este dispositivo.
  // La decodificación del PDF417 corre por ZXing (JS), así que alcanza con que el
  // navegador exponga getUserMedia: no dependemos del soporte nativo de pdf417.
  const [camAvailable, setCamAvailable] = useState<boolean | null>(null);

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

  // ¿Este dispositivo tiene cámara accesible? Solo chequeamos que exista la API
  // (no pedimos permiso todavía: eso pasa al abrir la cámara). El soporte de
  // pdf417 lo aporta ZXing, así que no lo consultamos acá.
  useEffect(() => {
    if (!open) return;
    const hasGetUserMedia =
      typeof navigator !== "undefined" &&
      !!navigator.mediaDevices &&
      typeof navigator.mediaDevices.getUserMedia === "function";
    setCamAvailable(hasGetUserMedia);
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

          {/* Cámara: ZXing decodifica el PDF417 por JS, así que la ofrecemos en
              cualquier dispositivo con cámara (incluido el celular). */}
          {camAvailable === true && (
            <Button
              type="button"
              variant="secondary"
              className="w-full"
              onClick={() => {
                setError(null);
                setCamOpen(true);
              }}
            >
              <Camera size={16} /> Escanear con la cámara del celular
            </Button>
          )}
          {camAvailable === false && (
            <p className="text-xs text-muted-foreground">
              Este dispositivo no expone cámara al navegador. Usá un lector 2D USB
              o pegá el código abajo. Recordá que la cámara necesita una conexión
              segura (HTTPS).
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

// Lectura del PDF417 por cámara, pensada para el celular. Camino principal:
// ZXing (`@zxing/browser`, `BrowserPDF417Reader`), que decodifica el PDF417 del
// stream de video por JS — funciona donde el `BarcodeDetector` nativo no trae el
// formato (Safari iOS, muchos Android/Chrome). Atajo opcional: si el navegador
// expone `BarcodeDetector` con pdf417 real, se intenta primero (más rápido) y se
// cae a ZXing. ZXing se carga con import dinámico (client-only, fuera del bundle
// inicial y sin tocar SSR).
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
  const [starting, setStarting] = useState(true);
  // onDetected puede cambiar de identidad entre renders; lo leemos por ref para
  // no reiniciar el escáner (y la cámara) en cada cambio.
  const onDetectedRef = useRef(onDetected);
  onDetectedRef.current = onDetected;

  useEffect(() => {
    if (!open) return;
    let stopped = false;
    // Limpieza acumulada: ZXing controls.stop(), tracks del stream y RAF nativo.
    const cleanups: Array<() => void> = [];
    setStarting(true);
    setError(null);

    // Una sola lectura buena gana: corta todo y avisa al padre.
    const emit = (raw: string) => {
      if (stopped || !raw) return;
      stopped = true;
      runCleanups();
      onDetectedRef.current(raw);
    };
    const runCleanups = () => {
      while (cleanups.length) {
        try {
          cleanups.pop()?.();
        } catch {
          // cierre best-effort.
        }
      }
    };

    // Restricciones de video: cámara trasera del celular cuando exista.
    const constraints: MediaStreamConstraints = {
      video: { facingMode: { ideal: "environment" } },
    };

    // Atajo nativo: BarcodeDetector con pdf417 SOLO si el navegador lo soporta de
    // verdad. Devuelve true si lo dejó andando (entonces no levantamos ZXing).
    const tryNativeDetector = async (): Promise<boolean> => {
      const Ctor = (
        window as unknown as { BarcodeDetector?: BarcodeDetectorCtor }
      ).BarcodeDetector;
      if (!Ctor || !Ctor.getSupportedFormats) return false;
      let formats: string[] = [];
      try {
        formats = await Ctor.getSupportedFormats();
      } catch {
        return false;
      }
      if (stopped || !formats.includes("pdf417")) return false;

      let stream: MediaStream;
      try {
        stream = await navigator.mediaDevices.getUserMedia(constraints);
      } catch {
        // Si el permiso se negó acá, dejamos que el catch de arriba lo maneje.
        throw new Error("permission");
      }
      if (stopped) {
        stream.getTracks().forEach((t) => t.stop());
        return true; // ya no importa; igual lo dimos por iniciado.
      }
      cleanups.push(() => stream.getTracks().forEach((t) => t.stop()));

      const video = videoRef.current;
      if (!video) return false;
      video.srcObject = stream;
      await video.play().catch(() => undefined);
      setStarting(false);

      const detector = new Ctor({ formats: ["pdf417"] });
      let raf = 0;
      cleanups.push(() => cancelAnimationFrame(raf));
      const tick = async () => {
        if (stopped || !videoRef.current) return;
        try {
          const codes = await detector.detect(videoRef.current);
          if (codes[0]?.rawValue) {
            emit(codes[0].rawValue);
            return;
          }
        } catch {
          // frame sin lectura; seguimos.
        }
        raf = requestAnimationFrame(tick);
      };
      raf = requestAnimationFrame(tick);
      return true;
    };

    // Camino principal: ZXing decodifica el PDF417 del stream por JS.
    const startZxing = async () => {
      const { BrowserPDF417Reader } = await import("@zxing/browser");
      const { DecodeHintType } = await import("@zxing/library");
      if (stopped) return;

      // TRY_HARDER: más preciso con la cámara del celu (frames movidos / lejos).
      const hints = new Map();
      hints.set(DecodeHintType.TRY_HARDER, true);
      const reader = new BrowserPDF417Reader(hints, {
        delayBetweenScanAttempts: 120,
      });

      const video = videoRef.current;
      if (!video) return;
      const controls = await reader.decodeFromConstraints(
        constraints,
        video,
        (result) => {
          if (result) emit(result.getText());
        },
      );
      if (stopped) {
        controls.stop();
        return;
      }
      cleanups.push(() => controls.stop());
      setStarting(false);
    };

    (async () => {
      try {
        const usedNative = await tryNativeDetector();
        if (usedNative || stopped) return;
        await startZxing();
      } catch (e) {
        if (stopped) return;
        runCleanups();
        const name = (e as { name?: string; message?: string })?.name;
        const msg = (e as { message?: string })?.message;
        if (name === "NotAllowedError" || msg === "permission") {
          setError(
            "Permiso de cámara denegado. Habilitá la cámara para este sitio y volvé a intentar.",
          );
        } else if (name === "NotFoundError" || name === "OverconstrainedError") {
          setError("No encontramos una cámara disponible en este dispositivo.");
        } else {
          setError(
            "No pudimos abrir la cámara. Revisá los permisos y que estés en una conexión segura (HTTPS).",
          );
        }
      }
    })();

    return () => {
      stopped = true;
      runCleanups();
    };
  }, [open]);

  return (
    <Modal open={open} onOpenChange={onOpenChange} title="Escanear DNI con la cámara">
      {error ? (
        <p className="py-4 text-sm text-destructive">{error}</p>
      ) : (
        <div className="relative overflow-hidden rounded-lg border border-border bg-black">
          <video
            ref={videoRef}
            className="aspect-video w-full object-cover"
            muted
            playsInline
            autoPlay
          />
          {/* Guía de encuadre: rectángulo apaisado, como el PDF417 del DNI. */}
          <div className="pointer-events-none absolute inset-0 flex items-center justify-center">
            <div className="h-[34%] w-[82%] rounded-md border-2 border-ninja-flameSoft/80 shadow-[0_0_0_9999px_rgba(0,0,0,0.35)]" />
          </div>
          {starting && (
            <div className="absolute inset-0 flex items-center justify-center bg-black/40">
              <span className="flex items-center gap-2 text-sm text-white">
                <span
                  className="h-4 w-4 animate-spin rounded-full border-2 border-white border-t-transparent"
                  aria-hidden
                />
                Abriendo la cámara…
              </span>
            </div>
          )}
        </div>
      )}
      <p className="mt-3 text-center text-xs text-muted-foreground">
        Apuntá al código de barras grande del frente del DNI (el rectángulo de
        rayas, abajo a la izquierda). Encuadralo dentro del recuadro, mantené el
        documento quieto y bien iluminado.
      </p>
    </Modal>
  );
}
