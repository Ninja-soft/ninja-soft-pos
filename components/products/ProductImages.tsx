"use client";

import { useRef, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { ImagePlus, Star, Trash2 } from "lucide-react";
import { createClient } from "@/lib/supabase/client";
import { useToast } from "@/components/ui/Toast";
import { Spinner } from "@/components/ui/Spinner";
import { cn } from "@/lib/utils/cn";
import {
  removeStoredFile,
  uploadProductImage,
  type ProductImageRow,
} from "@/modules/products/images";

type Img = ProductImageRow;

// Galería de fotos del producto (WebP). La primera es la principal (la que se
// ve en el POS y el catálogo). Las fotos externas importadas de Tiendita
// (path vacío) se muestran igual y nunca se pisan al subir otra.
export function ProductImages({
  productId,
  tenantId,
  legacyUrl,
}: {
  productId: string;
  tenantId: string;
  /** products.image_url: foto previa sin fila en la galería (se preserva). */
  legacyUrl?: string | null;
}) {
  const supabase = createClient();
  const qc = useQueryClient();
  const { toast } = useToast();
  const inputRef = useRef<HTMLInputElement>(null);
  const [busy, setBusy] = useState(false);
  const [confirmId, setConfirmId] = useState<string | null>(null);

  const { data: rows = [], isLoading } = useQuery({
    queryKey: ["product-images", productId],
    queryFn: async (): Promise<Img[]> => {
      const { data } = await supabase
        .from("product_images")
        .select("id, path, url, is_primary")
        .eq("product_id", productId)
        .is("deleted_at", null)
        .order("sort", { ascending: true });
      return (data ?? []) as Img[];
    },
  });

  // Foto previa (image_url) sin fila: se muestra como principal "virtual".
  const legacy = rows.length === 0 && legacyUrl ? legacyUrl : null;

  function refresh() {
    qc.invalidateQueries({ queryKey: ["product-images", productId] });
    qc.invalidateQueries({ queryKey: ["products"] });
  }

  async function onFiles(files: FileList | null) {
    if (!files || files.length === 0) return;
    setBusy(true);
    try {
      let count = rows.length;
      let hadPrimary = rows.some((i) => i.is_primary);
      // Antes de sumar, la foto previa pasa a la galería como principal (así
      // no se pierde, que era el bug de las importadas).
      if (legacy) {
        const { error } = await supabase.from("product_images").insert({
          tenant_id: tenantId,
          product_id: productId,
          path: "",
          url: legacy,
          is_primary: true,
          sort: 0,
        });
        if (error) throw error;
        count = 1;
        hadPrimary = true;
      }
      for (const file of Array.from(files)) {
        await uploadProductImage({
          tenantId,
          productId,
          file,
          primary: !hadPrimary,
          sort: count,
        });
        hadPrimary = true;
        count += 1;
      }
      toast({ title: files.length > 1 ? "Fotos subidas" : "Foto subida", variant: "success" });
      refresh();
    } catch (e) {
      toast({
        title: "No se pudo subir la foto",
        description: e instanceof Error ? e.message : undefined,
        variant: "error",
      });
    } finally {
      setBusy(false);
      if (inputRef.current) inputRef.current.value = "";
    }
  }

  const setPrimary = useMutation({
    mutationFn: async (img: Img) => {
      await supabase.from("product_images").update({ is_primary: false }).eq("product_id", productId);
      await supabase.from("product_images").update({ is_primary: true }).eq("id", img.id);
      await supabase.from("products").update({ image_url: img.url }).eq("id", productId);
    },
    onSuccess: () => {
      toast({ title: "Foto principal actualizada", variant: "success" });
      refresh();
    },
    onError: () => toast({ title: "No se pudo cambiar la principal", variant: "error" }),
  });

  const remove = useMutation({
    mutationFn: async (img: Img) => {
      await removeStoredFile(img.path);
      await supabase.from("product_images").delete().eq("id", img.id);
      if (img.is_primary) {
        const next = rows.find((i) => i.id !== img.id);
        await supabase.from("products").update({ image_url: next?.url ?? null }).eq("id", productId);
        if (next) {
          await supabase.from("product_images").update({ is_primary: true }).eq("id", next.id);
        }
      }
    },
    onSuccess: () => {
      setConfirmId(null);
      toast({ title: "Foto eliminada", variant: "success" });
      refresh();
    },
    onError: () => toast({ title: "No se pudo eliminar", variant: "error" }),
  });

  const tiles: (Img & { virtual?: boolean })[] = legacy
    ? [{ id: "legacy", path: "", url: legacy, is_primary: true, virtual: true }]
    : rows;

  return (
    <div>
      <div className="grid grid-cols-3 gap-2.5 sm:grid-cols-4">
        {isLoading ? (
          <div className="col-span-3 grid h-24 place-items-center sm:col-span-4">
            <Spinner />
          </div>
        ) : (
          tiles.map((img) => (
            <div key={img.id} className="relative aspect-square overflow-hidden rounded-2xl bg-white">
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img src={img.url} alt="" className="h-full w-full object-contain p-1.5" />
              {img.is_primary && (
                <span className="absolute left-1.5 top-1.5 rounded-full bg-black/60 px-2 py-0.5 text-[10px] font-semibold text-white backdrop-blur">
                  Principal
                </span>
              )}
              {confirmId === img.id ? (
                <div className="absolute inset-0 flex flex-col justify-between bg-black/70 p-2 text-white backdrop-blur-sm">
                  <p className="text-xs font-semibold">¿Borrar foto?</p>
                  <div className="flex gap-1.5">
                    <button
                      type="button"
                      onClick={() => setConfirmId(null)}
                      className="h-7 flex-1 rounded-lg bg-white/15 text-[11px] font-semibold"
                    >
                      No
                    </button>
                    <button
                      type="button"
                      onClick={() => remove.mutate(img)}
                      disabled={remove.isPending}
                      className="h-7 flex-1 rounded-lg bg-danger text-[11px] font-semibold text-white"
                    >
                      Borrar
                    </button>
                  </div>
                </div>
              ) : (
                !img.virtual && (
                  <div className="absolute bottom-1.5 right-1.5 flex gap-1">
                    {!img.is_primary && (
                      <button
                        type="button"
                        onClick={() => setPrimary.mutate(img)}
                        className="grid h-7 w-7 place-items-center rounded-full bg-black/55 text-white backdrop-blur transition hover:bg-black/70"
                        aria-label="Marcar como principal"
                      >
                        <Star size={13} />
                      </button>
                    )}
                    <button
                      type="button"
                      onClick={() => setConfirmId(img.id)}
                      className="grid h-7 w-7 place-items-center rounded-full bg-black/55 text-white backdrop-blur transition hover:bg-black/70"
                      aria-label="Eliminar foto"
                    >
                      <Trash2 size={13} />
                    </button>
                  </div>
                )
              )}
            </div>
          ))
        )}

        <button
          type="button"
          onClick={() => inputRef.current?.click()}
          disabled={busy}
          className={cn(
            "flex aspect-square flex-col items-center justify-center gap-1.5 rounded-2xl bg-muted text-muted-foreground transition hover:bg-secondary hover:text-foreground",
            busy && "opacity-60",
          )}
        >
          {busy ? <Spinner size={20} /> : <ImagePlus size={22} />}
          <span className="text-[11px] font-medium">Agregar</span>
        </button>
        <input
          ref={inputRef}
          type="file"
          accept="image/*"
          multiple
          hidden
          onChange={(e) => onFiles(e.target.files)}
        />
      </div>
      <p className="mt-2.5 text-xs text-muted-foreground">
        Se convierten a WebP automáticamente para que pesen poco. La principal es la que se ve en el POS.
      </p>
    </div>
  );
}
