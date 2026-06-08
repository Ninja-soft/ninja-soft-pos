"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import Cropper, { type Area } from "react-easy-crop";
import { Download, Eye, Trash2, Upload, ZoomIn, ZoomOut } from "lucide-react";
import { createClient } from "@/lib/supabase/client";
import { useToast } from "@/components/ui/Toast";
import { Modal } from "@/components/ui/Modal";
import { Button } from "@/components/ui/Button";
import { Avatar } from "@/components/ui/Avatar";
import { cropToWebp } from "@/lib/utils/image";

/**
 * Uploader de avatar reutilizable: elegir imagen → recorte cuadrado (modal) →
 * conversión a WebP → subida a Storage → devuelve la URL pública.
 * Tras subir, permite VER (zoom) y DESCARGAR la foto, además de quitarla.
 *
 * Se usa tanto en "Editar mi perfil" (bucket user-avatars) como en el panel del
 * dueño / equipo (bucket tenant-assets).
 */
export function AvatarUploader({
  value,
  onChange,
  name,
  bucket,
  pathPrefix,
  size = 64,
  disabled,
}: {
  value: string | null;
  onChange: (url: string | null) => void;
  name: string;
  /** Bucket de Storage donde se guarda el WebP. */
  bucket: string;
  /** Carpeta destino (sin slash final), ej. `${userId}` o `${tenantId}/members`. */
  pathPrefix: string;
  size?: number;
  disabled?: boolean;
}) {
  const supabase = createClient();
  const { toast } = useToast();
  const inputRef = useRef<HTMLInputElement>(null);

  const [srcUrl, setSrcUrl] = useState<string | null>(null); // objectURL para recortar
  const [crop, setCrop] = useState({ x: 0, y: 0 });
  const [zoom, setZoom] = useState(1);
  const [areaPixels, setAreaPixels] = useState<Area | null>(null);
  const [uploading, setUploading] = useState(false);
  const [viewing, setViewing] = useState(false);
  const [downloading, setDownloading] = useState(false);

  // Liberar el objectURL al desmontar o cambiar de archivo.
  useEffect(() => {
    return () => {
      if (srcUrl) URL.revokeObjectURL(srcUrl);
    };
  }, [srcUrl]);

  const onCropComplete = useCallback((_a: Area, px: Area) => {
    setAreaPixels(px);
  }, []);

  function pickFile(file: File | undefined) {
    if (!file) return;
    if (srcUrl) URL.revokeObjectURL(srcUrl);
    setCrop({ x: 0, y: 0 });
    setZoom(1);
    setAreaPixels(null);
    setSrcUrl(URL.createObjectURL(file));
    if (inputRef.current) inputRef.current.value = "";
  }

  function closeCropper() {
    if (srcUrl) URL.revokeObjectURL(srcUrl);
    setSrcUrl(null);
  }

  async function confirmCrop() {
    if (!srcUrl || !areaPixels) return;
    setUploading(true);
    try {
      const webp = await cropToWebp(srcUrl, areaPixels, 256, 0.85);
      const path = `${pathPrefix}/${crypto.randomUUID()}.webp`;
      const up = await supabase.storage
        .from(bucket)
        .upload(path, webp, { contentType: "image/webp", upsert: false });
      if (up.error) throw up.error;
      const { data: pub } = supabase.storage.from(bucket).getPublicUrl(path);
      onChange(pub.publicUrl);
      toast({ title: "Foto lista", variant: "success" });
      closeCropper();
    } catch (e) {
      toast({
        title: "No se pudo subir la foto",
        description: e instanceof Error ? e.message : undefined,
        variant: "error",
      });
    } finally {
      setUploading(false);
    }
  }

  async function download() {
    if (!value) return;
    setDownloading(true);
    try {
      const res = await fetch(value);
      if (!res.ok) throw new Error("descarga falló");
      const blob = await res.blob();
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      const safe = (name || "foto").trim().replace(/[^\p{L}\p{N}]+/gu, "-") || "foto";
      a.download = `${safe.toLowerCase()}.webp`;
      document.body.appendChild(a);
      a.click();
      a.remove();
      URL.revokeObjectURL(url);
    } catch {
      toast({ title: "No se pudo descargar la foto", variant: "error" });
    } finally {
      setDownloading(false);
    }
  }

  const hasPhoto = !!value && /^https?:\/\//.test(value);

  return (
    <div className="flex flex-wrap items-center gap-3">
      <Avatar name={name || "?"} avatar={value} size={size} />

      <div className="flex flex-wrap items-center gap-2">
        <Button
          type="button"
          variant="secondary"
          size="sm"
          disabled={disabled || uploading}
          onClick={() => inputRef.current?.click()}
        >
          <Upload size={15} /> {hasPhoto ? "Cambiar foto" : "Subir foto"}
        </Button>

        {hasPhoto && (
          <>
            <Button
              type="button"
              variant="ghost"
              size="sm"
              disabled={disabled}
              onClick={() => setViewing(true)}
            >
              <Eye size={15} /> Ver
            </Button>
            <Button
              type="button"
              variant="ghost"
              size="sm"
              disabled={disabled || downloading}
              onClick={download}
            >
              <Download size={15} /> Descargar
            </Button>
            <Button
              type="button"
              variant="ghost"
              size="sm"
              className="text-destructive"
              disabled={disabled}
              onClick={() => onChange(null)}
            >
              <Trash2 size={15} /> Quitar
            </Button>
          </>
        )}
      </div>

      <input
        ref={inputRef}
        type="file"
        accept="image/*"
        hidden
        onChange={(e) => pickFile(e.target.files?.[0])}
      />

      {/* Modal de recorte */}
      <Modal
        open={!!srcUrl}
        onOpenChange={(o) => {
          if (!o && !uploading) closeCropper();
        }}
        title="Recortá tu foto"
        description="Arrastrá y usá el zoom para encuadrar. Se guarda cuadrada."
      >
        <div className="space-y-4">
          <div className="relative h-72 w-full overflow-hidden rounded-lg border border-border bg-black/70">
            {srcUrl && (
              <Cropper
                image={srcUrl}
                crop={crop}
                zoom={zoom}
                aspect={1}
                cropShape="round"
                showGrid={false}
                onCropChange={setCrop}
                onZoomChange={setZoom}
                onCropComplete={onCropComplete}
              />
            )}
          </div>
          <div className="flex items-center gap-3">
            <ZoomOut size={16} className="shrink-0 text-muted-foreground" />
            <input
              type="range"
              min={1}
              max={3}
              step={0.01}
              value={zoom}
              onChange={(e) => setZoom(Number(e.target.value))}
              className="h-1.5 w-full cursor-pointer accent-ninja-flame"
              aria-label="Zoom"
            />
            <ZoomIn size={16} className="shrink-0 text-muted-foreground" />
          </div>
          <div className="flex justify-end gap-2">
            <Button
              type="button"
              variant="secondary"
              onClick={closeCropper}
              disabled={uploading}
            >
              Cancelar
            </Button>
            <Button
              type="button"
              onClick={confirmCrop}
              disabled={uploading || !areaPixels}
              loading={uploading}
            >
              {uploading ? "Subiendo…" : "Usar esta foto"}
            </Button>
          </div>
        </div>
      </Modal>

      {/* Modal de vista (zoom) */}
      <Modal
        open={viewing}
        onOpenChange={setViewing}
        title="Tu foto"
        className="max-w-md"
      >
        <div className="flex flex-col items-center gap-4">
          {hasPhoto && (
            // eslint-disable-next-line @next/next/no-img-element
            <img
              src={value!}
              alt={name || "Foto de perfil"}
              className="max-h-[60vh] w-auto rounded-lg border border-border object-contain"
            />
          )}
          <div className="flex justify-center">
            <Button
              type="button"
              variant="secondary"
              onClick={download}
              disabled={downloading}
            >
              <Download size={15} /> Descargar
            </Button>
          </div>
        </div>
      </Modal>
    </div>
  );
}
