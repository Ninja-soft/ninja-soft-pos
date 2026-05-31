"use client";

import { useRef, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { ImagePlus, Star, Trash2 } from "lucide-react";
import { createClient } from "@/lib/supabase/client";
import { useToast } from "@/components/ui/Toast";
import { resizeToWebp } from "@/lib/utils/image";
import { cn } from "@/lib/utils/cn";

const BUCKET = "product-images";

type Img = {
  id: string;
  path: string;
  url: string;
  is_primary: boolean;
};

export function ProductImages({
  productId,
  tenantId,
}: {
  productId: string;
  tenantId: string;
}) {
  const supabase = createClient();
  const qc = useQueryClient();
  const { toast } = useToast();
  const inputRef = useRef<HTMLInputElement>(null);
  const [busy, setBusy] = useState(false);

  const { data: images = [] } = useQuery({
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

  function refresh() {
    qc.invalidateQueries({ queryKey: ["product-images", productId] });
    qc.invalidateQueries({ queryKey: ["products"] });
  }

  async function onFiles(files: FileList | null) {
    if (!files || files.length === 0) return;
    setBusy(true);
    try {
      let hadPrimary = images.some((i) => i.is_primary);
      for (const file of Array.from(files)) {
        const webp = await resizeToWebp(file, 900, 0.82);
        const path = `${tenantId}/${productId}/${crypto.randomUUID()}.webp`;
        const up = await supabase.storage
          .from(BUCKET)
          .upload(path, webp, { contentType: "image/webp", upsert: false });
        if (up.error) throw up.error;
        const { data: pub } = supabase.storage.from(BUCKET).getPublicUrl(path);
        const isPrimary = !hadPrimary;
        const { error } = await supabase.from("product_images").insert({
          tenant_id: tenantId,
          product_id: productId,
          path,
          url: pub.publicUrl,
          is_primary: isPrimary,
          sort: images.length,
        });
        if (error) throw error;
        if (isPrimary) {
          await supabase
            .from("products")
            .update({ image_url: pub.publicUrl })
            .eq("id", productId);
          hadPrimary = true;
        }
      }
      toast({ title: "Imagen subida", variant: "success" });
      refresh();
    } catch (e) {
      toast({
        title: "No se pudo subir la imagen",
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
      await supabase
        .from("product_images")
        .update({ is_primary: false })
        .eq("product_id", productId);
      await supabase
        .from("product_images")
        .update({ is_primary: true })
        .eq("id", img.id);
      await supabase
        .from("products")
        .update({ image_url: img.url })
        .eq("id", productId);
    },
    onSuccess: () => {
      toast({ title: "Foto principal actualizada", variant: "success" });
      refresh();
    },
    onError: () => toast({ title: "No se pudo cambiar la principal", variant: "error" }),
  });

  const remove = useMutation({
    mutationFn: async (img: Img) => {
      await supabase.storage.from(BUCKET).remove([img.path]);
      await supabase.from("product_images").delete().eq("id", img.id);
      if (img.is_primary) {
        const next = images.find((i) => i.id !== img.id);
        await supabase
          .from("products")
          .update({ image_url: next?.url ?? null })
          .eq("id", productId);
        if (next) {
          await supabase
            .from("product_images")
            .update({ is_primary: true })
            .eq("id", next.id);
        }
      }
    },
    onSuccess: () => {
      toast({ title: "Imagen eliminada", variant: "success" });
      refresh();
    },
    onError: () => toast({ title: "No se pudo eliminar", variant: "error" }),
  });

  return (
    <div>
      <span className="mb-2 block text-sm font-medium text-muted-foreground">
        Fotos
      </span>
      <div className="flex flex-wrap gap-3">
        {images.map((img) => (
          <div
            key={img.id}
            className="group relative h-20 w-20 overflow-hidden rounded-lg border border-border"
          >
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img src={img.url} alt="" className="h-full w-full object-cover" />
            {img.is_primary && (
              <span className="absolute left-1 top-1 rounded bg-ninja-flame px-1 py-0.5 text-[9px] font-bold text-white">
                Principal
              </span>
            )}
            <div className="absolute inset-x-0 bottom-0 flex justify-center gap-1 bg-black/45 p-1 opacity-0 transition group-hover:opacity-100">
              {!img.is_primary && (
                <button
                  type="button"
                  onClick={() => setPrimary.mutate(img)}
                  className="rounded p-1 text-white hover:bg-white/20"
                  title="Marcar como principal"
                >
                  <Star size={14} />
                </button>
              )}
              <button
                type="button"
                onClick={() => remove.mutate(img)}
                className="rounded p-1 text-white hover:bg-white/20"
                title="Eliminar"
              >
                <Trash2 size={14} />
              </button>
            </div>
          </div>
        ))}

        <button
          type="button"
          onClick={() => inputRef.current?.click()}
          disabled={busy}
          className={cn(
            "grid h-20 w-20 place-items-center rounded-lg border border-dashed border-border text-muted-foreground transition hover:border-ninja-flameSoft hover:text-foreground",
            busy && "opacity-50",
          )}
        >
          <ImagePlus size={20} />
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
      <p className="mt-2 text-xs text-muted-foreground">
        Se convierten a WebP automáticamente para que pesen poco.
      </p>
    </div>
  );
}
