"use client";

// Foto con la cámara del teléfono (ADR-161): input con capture, redimensión
// a WebP en el navegador (lib/utils/image) y miniaturas para quitar. Las
// fotos quedan como Blob: la app del repartidor las guarda en la cola offline
// y las sube cuando hay señal.

import { useEffect, useId, useRef, useState } from "react";
import { Camera, X } from "lucide-react";
import { resizeToWebp } from "@/lib/utils/image";
import { cn } from "@/lib/utils/cn";

export interface PhotoValue {
  id: string;
  blob: Blob;
  type: string;
}

async function toWebp(file: File): Promise<{ blob: Blob; type: string }> {
  try {
    const blob = await resizeToWebp(file, 1280, 0.78);
    return { blob, type: "image/webp" };
  } catch {
    return { blob: file, type: file.type || "image/jpeg" };
  }
}

function Thumb({ photo, onRemove, disabled }: { photo: PhotoValue; onRemove: () => void; disabled?: boolean }) {
  const [url, setUrl] = useState<string | null>(null);
  useEffect(() => {
    if (typeof URL === "undefined" || !URL.createObjectURL) return;
    const u = URL.createObjectURL(photo.blob);
    setUrl(u);
    return () => URL.revokeObjectURL(u);
  }, [photo.blob]);
  return (
    <div className="relative h-20 w-20 shrink-0 overflow-hidden rounded-lg bg-muted">
      {url && (
        // eslint-disable-next-line @next/next/no-img-element
        <img src={url} alt="Foto tomada" className="h-full w-full object-cover" />
      )}
      {!disabled && (
        <button
          type="button"
          onClick={onRemove}
          aria-label="Quitar la foto"
          className="absolute right-1 top-1 grid h-7 w-7 place-items-center rounded-md bg-black/60 text-white"
        >
          <X size={14} aria-hidden />
        </button>
      )}
    </div>
  );
}

export function PhotoInput({
  value,
  onChange,
  max = 3,
  label = "Foto",
  hint,
  required = false,
  disabled = false,
  className,
}: {
  value: PhotoValue[];
  onChange: (v: PhotoValue[]) => void;
  max?: number;
  label?: string;
  hint?: string;
  required?: boolean;
  disabled?: boolean;
  className?: string;
}) {
  const inputId = useId();
  const ref = useRef<HTMLInputElement>(null);
  const [busy, setBusy] = useState(false);

  async function add(files: FileList | null) {
    if (!files?.length) return;
    setBusy(true);
    try {
      const next = [...value];
      for (const f of Array.from(files).slice(0, Math.max(0, max - value.length))) {
        const { blob, type } = await toWebp(f);
        next.push({ id: typeof crypto !== "undefined" && crypto.randomUUID ? crypto.randomUUID() : String(Date.now() + next.length), blob, type });
      }
      onChange(next);
    } finally {
      setBusy(false);
      if (ref.current) ref.current.value = "";
    }
  }

  return (
    <div className={cn("space-y-1.5", className)}>
      <div className="flex items-baseline justify-between gap-2">
        <label htmlFor={inputId} className="text-sm font-medium">
          {label}
          {required && <span className="ml-1 text-xs font-normal text-muted-foreground">(obligatoria)</span>}
        </label>
        {hint && <span className="text-xs text-muted-foreground">{hint}</span>}
      </div>
      <div className="flex gap-2 overflow-x-auto pb-1">
        {value.map((p) => (
          <Thumb key={p.id} photo={p} disabled={disabled} onRemove={() => onChange(value.filter((x) => x.id !== p.id))} />
        ))}
        {value.length < max && !disabled && (
          <button
            type="button"
            onClick={() => ref.current?.click()}
            disabled={busy}
            className="grid h-20 w-20 shrink-0 place-items-center rounded-lg bg-muted text-muted-foreground transition hover:bg-muted/70 disabled:opacity-60"
          >
            <span className="flex flex-col items-center gap-1 text-xs font-medium">
              <Camera size={20} aria-hidden />
              {busy ? "Procesando" : "Sacar foto"}
            </span>
          </button>
        )}
      </div>
      <input
        ref={ref}
        id={inputId}
        type="file"
        accept="image/*"
        capture="environment"
        multiple={max > 1}
        className="sr-only"
        disabled={disabled}
        onChange={(e) => void add(e.target.files)}
      />
    </div>
  );
}
PhotoInput.displayName = "PhotoInput";
