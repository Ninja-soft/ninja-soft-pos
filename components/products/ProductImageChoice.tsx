"use client";

// Imagen del producto o servicio desde la pestaña General (ADR-122): al crear,
// el dueño elige si la portada se genera con IA (estilo de Configuración ›
// Imágenes con IA), si la sube él o si va sin imagen. Con el producto ya
// guardado muestra la imagen actual y atajos a Generar con IA o a Imágenes.
// Sirve para cualquier rubro, no sólo servicios.
import { Camera, ImageOff, ImagePlus, Sparkles } from "lucide-react";
import { Button } from "@/components/ui/Button";
import { Segmented } from "@/components/ui/Segmented";

export type ImageMode = "ai" | "upload" | "none";

export function ProductImageChoice({
  mode,
  onMode,
  aiEnabled,
  styleName,
  saved,
  imageUrl,
  noun,
  generating,
  onGenerate,
  onGoImages,
}: {
  mode: ImageMode;
  onMode: (m: ImageMode) => void;
  /** Complemento Asistente IA activo y usuario que administra. */
  aiEnabled: boolean;
  /** Nombre del estilo configurado (p. ej. "Ícono plano"). */
  styleName: string | null;
  /** El producto ya existe (edición o recién creado). */
  saved: boolean;
  imageUrl: string | null;
  /** "producto" o "servicio". */
  noun: string;
  generating: boolean;
  onGenerate: () => void;
  onGoImages: () => void;
}) {
  if (saved) {
    return (
      <div className="flex items-center gap-3">
        <div className="grid h-16 w-16 shrink-0 place-items-center overflow-hidden rounded-lg bg-muted">
          {imageUrl ? (
            // eslint-disable-next-line @next/next/no-img-element
            <img src={imageUrl} alt="" className="h-full w-full object-cover" />
          ) : (
            <ImageOff size={20} className="text-muted-foreground" aria-hidden />
          )}
        </div>
        <div className="min-w-0 flex-1 space-y-2">
          <p className="text-xs text-muted-foreground">
            {generating
              ? "Generando la imagen con IA. Aparece en Imágenes en unos segundos."
              : imageUrl
                ? "Imagen principal. La cambiás, regenerás o agregás más en Imágenes."
                : `Este ${noun} todavía no tiene imagen.`}
          </p>
          <div className="flex flex-wrap gap-2">
            {aiEnabled && (
              <Button type="button" size="sm" variant="secondary" onClick={onGenerate} loading={generating}>
                <Sparkles size={14} aria-hidden /> {imageUrl ? "Regenerar con IA" : "Generar con IA"}
              </Button>
            )}
            <Button type="button" size="sm" variant="ghost" onClick={onGoImages}>
              <Camera size={14} aria-hidden /> Ir a Imágenes
            </Button>
          </div>
        </div>
      </div>
    );
  }

  const help: Record<ImageMode, string> = {
    ai: `Al guardar se genera con IA${styleName ? ` en estilo ${styleName}` : ""}, a partir del nombre y la descripción. Después la podés regenerar o cambiar por una foto en Imágenes.`,
    upload: "Al guardar te llevamos a Imágenes para que subas tus fotos.",
    none: "Se guarda sin imagen. La podés agregar cuando quieras desde Imágenes.",
  };

  return (
    <div className="space-y-2">
      {aiEnabled ? (
        <Segmented<ImageMode>
          value={mode}
          onChange={onMode}
          aria-label="Imagen"
          size="sm"
          scrollOnMobile
          options={[
            { value: "ai", label: "Generar con IA", icon: <Sparkles size={14} aria-hidden /> },
            { value: "upload", label: "Subir foto", icon: <ImagePlus size={14} aria-hidden /> },
            { value: "none", label: "Sin imagen", icon: <ImageOff size={14} aria-hidden /> },
          ]}
        />
      ) : null}
      <p className="text-xs text-muted-foreground">
        {aiEnabled
          ? help[mode]
          : "Guardá y subí tus fotos en la pestaña Imágenes. Con el complemento Asistente IA también las podés generar con IA."}
      </p>
    </div>
  );
}
