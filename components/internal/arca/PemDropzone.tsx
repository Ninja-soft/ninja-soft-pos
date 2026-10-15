"use client";

import { useId, useRef, useState } from "react";
import { CheckCircle2, FileKey2, FileText, TriangleAlert, Upload, X } from "lucide-react";
import { cn } from "@/lib/utils/cn";
import { checkCertificateFile, checkKeyFile, type PemCheck } from "@/lib/arca/certUpload";

// Zona para arrastrar o elegir un archivo PEM (certificado o clave privada).
// El archivo se lee como texto EN EL NAVEGADOR y se valida que parezca PEM;
// el contenido nunca se muestra (la clave) ni se loguea. Lo que sale de acá es
// el bloque PEM limpio, que el padre manda a la Edge.

export interface PemFile {
  name: string;
  size: number;
  check: PemCheck;
}

/** Tope antes de leer: un PEM real pesa unos pocos KB. */
const MAX_BYTES = 64 * 1024;

export function readFileAsText(file: File): Promise<string> {
  if (typeof file.text === "function") return file.text();
  return new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve(String(r.result ?? ""));
    r.onerror = () => reject(r.error ?? new Error("read_failed"));
    r.readAsText(file);
  });
}

export async function loadPemFile(file: File, kind: "certificate" | "private_key"): Promise<PemFile> {
  if (file.size > MAX_BYTES) {
    return {
      name: file.name,
      size: file.size,
      check: {
        ok: false,
        code: "muy_grande",
        title: "El archivo es demasiado grande",
        action: kind === "certificate" ? "Elegí el .crt que descargaste de ARCA." : "Elegí el .key del certificado.",
      },
    };
  }
  let text = "";
  try {
    text = await readFileAsText(file);
  } catch {
    return { name: file.name, size: file.size, check: { ok: false, code: "ilegible", title: "No se pudo leer el archivo", action: "Probá elegirlo de nuevo." } };
  }
  return { name: file.name, size: file.size, check: kind === "certificate" ? checkCertificateFile(text) : checkKeyFile(text) };
}

export function PemDropzone({
  kind,
  label,
  hint,
  value,
  onChange,
  disabled,
}: {
  kind: "certificate" | "private_key";
  label: string;
  hint?: string;
  value: PemFile | null;
  onChange: (f: PemFile | null) => void;
  disabled?: boolean;
}) {
  const id = useId();
  const input = useRef<HTMLInputElement>(null);
  const [over, setOver] = useState(false);
  const Icon = kind === "certificate" ? FileText : FileKey2;
  const accept = kind === "certificate" ? ".crt,.pem,.cer,application/x-x509-ca-cert,application/x-pem-file" : ".key,.pem,application/x-pem-file";
  const okText = kind === "certificate" ? "Certificado en texto PEM" : "Clave privada en texto PEM";

  const take = async (file: File | undefined) => {
    if (!file) return;
    onChange(await loadPemFile(file, kind));
    if (input.current) input.current.value = "";
  };

  return (
    <div className="min-w-0">
      <p id={`${id}-label`} className="mb-2 text-sm font-medium text-muted-foreground">
        {label}
      </p>
      {/* Antes que la zona: el foco del input se ve en la zona (peer). */}
      <input
        ref={input}
        id={id}
        type="file"
        accept={accept}
        className="peer sr-only"
        disabled={disabled}
        aria-labelledby={`${id}-label`}
        onChange={(e) => void take(e.target.files?.[0])}
      />
      {value ? (
        <div
          className={cn("rounded-lg p-3", value.check.ok ? "bg-muted/60" : "bg-danger/10")}
          data-testid={`pem-${kind}`}
        >
          <div className="flex items-start gap-3">
            <span
              aria-hidden
              className={cn(
                "grid h-9 w-9 shrink-0 place-items-center rounded-lg bg-background",
                value.check.ok ? "text-success" : "text-danger",
              )}
            >
              {value.check.ok ? <CheckCircle2 size={18} /> : <TriangleAlert size={18} />}
            </span>
            <div className="min-w-0 flex-1">
              <p className="truncate text-sm font-medium text-foreground" title={value.name}>
                {value.name}
              </p>
              {value.check.ok ? (
                <p className="text-xs text-muted-foreground">
                  {okText} · {(value.size / 1024).toFixed(1).replace(".", ",")} KB
                </p>
              ) : (
                <div className="mt-0.5 text-xs" role="alert">
                  <p className="font-medium text-foreground">{value.check.title}</p>
                  <p className="text-muted-foreground">{value.check.action}</p>
                </div>
              )}
            </div>
            <button
              type="button"
              onClick={() => onChange(null)}
              disabled={disabled}
              aria-label={`Quitar ${value.name}`}
              className="grid h-8 w-8 shrink-0 place-items-center rounded-md text-muted-foreground hover:bg-background hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
            >
              <X size={16} aria-hidden />
            </button>
          </div>
        </div>
      ) : (
        <label
          htmlFor={id}
          onDragOver={(e) => {
            e.preventDefault();
            if (!disabled) setOver(true);
          }}
          onDragLeave={() => setOver(false)}
          onDrop={(e) => {
            e.preventDefault();
            setOver(false);
            if (!disabled) void take(e.dataTransfer.files?.[0]);
          }}
          className={cn(
            "flex min-h-[112px] cursor-pointer peer-focus-visible:ring-2 peer-focus-visible:ring-ring flex-col items-center justify-center gap-1.5 rounded-lg border border-dashed border-border px-4 py-5 text-center transition-colors",
            over ? "bg-muted" : "bg-background hover:bg-muted/50",
            disabled && "cursor-not-allowed opacity-60",
          )}
        >
          <span aria-hidden className="grid h-9 w-9 place-items-center rounded-lg bg-muted text-muted-foreground">
            {over ? <Upload size={18} /> : <Icon size={18} />}
          </span>
          <span className="text-sm font-medium text-foreground">
            Arrastrá el archivo o <span className="text-ninja-flameSoft">elegilo</span>
          </span>
          {hint && <span className="text-xs text-muted-foreground">{hint}</span>}
        </label>
      )}
    </div>
  );
}
PemDropzone.displayName = "PemDropzone";
