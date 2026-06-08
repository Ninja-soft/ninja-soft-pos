"use client";

import { useEffect, useRef, useState } from "react";
import { ImagePlus, Link2, Trash2, Store } from "lucide-react";
import { Modal } from "@/components/ui/Modal";
import { Button } from "@/components/ui/Button";
import { Input } from "@/components/ui/Input";
import { Switch } from "@/components/ui/Switch";
import { useToast } from "@/components/ui/Toast";
import { createClient } from "@/lib/supabase/client";
import { resizeToWebp } from "@/lib/utils/image";
import { formatCurrency } from "@/lib/utils/format";
import { cn } from "@/lib/utils/cn";
import {
  CATALOG_ASSETS_BUCKET,
  type Catalog,
  type CatalogStore,
} from "@/modules/internal/catalogs";
import { useSaveCatalog } from "@/modules/internal/catalogsHooks";

export function CatalogEditorModal({
  open,
  onOpenChange,
  catalog,
  stores,
}: {
  open: boolean;
  onOpenChange: (o: boolean) => void;
  // null = crear; objeto = editar.
  catalog: Catalog | null;
  stores: CatalogStore[];
}) {
  const { toast } = useToast();
  const save = useSaveCatalog();
  const fileRef = useRef<HTMLInputElement>(null);
  const isEdit = catalog !== null;

  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [coverUrl, setCoverUrl] = useState("");
  const [price, setPrice] = useState("");
  const [dedupe, setDedupe] = useState(true);
  const [active, setActive] = useState(true);
  const [storeKeys, setStoreKeys] = useState<string[]>([]);
  const [uploading, setUploading] = useState(false);

  useEffect(() => {
    if (!open) return;
    if (catalog) {
      setName(catalog.name);
      setDescription(catalog.description ?? "");
      setCoverUrl(catalog.coverUrl ?? "");
      setPrice(String(catalog.priceArs));
      setDedupe(catalog.dedupeByEan);
      setActive(catalog.isActive);
      setStoreKeys([...catalog.storeKeys]);
    } else {
      setName("");
      setDescription("");
      setCoverUrl("");
      setPrice("");
      setDedupe(true);
      setActive(true);
      setStoreKeys([]);
    }
  }, [open, catalog]);

  function toggleStore(key: string) {
    setStoreKeys((prev) =>
      prev.includes(key) ? prev.filter((k) => k !== key) : [...prev, key],
    );
  }

  // Conteo aproximado: suma de productos de las tiendas elegidas (sin dedupe
  // exacto; el real lo computa la RPC tras guardar). Sirve de referencia.
  const approxProducts = stores
    .filter((s) => storeKeys.includes(s.key))
    .reduce((acc, s) => acc + s.productCount, 0);

  async function onPickImage(file: File | undefined) {
    if (!file) return;
    setUploading(true);
    try {
      const supabase = createClient();
      const webp = await resizeToWebp(file, 800, 0.9);
      const path = `covers/cat-${crypto.randomUUID()}.webp`;
      const up = await supabase.storage
        .from(CATALOG_ASSETS_BUCKET)
        .upload(path, webp, { contentType: "image/webp", upsert: false });
      if (up.error) throw up.error;
      const { data: pub } = supabase.storage
        .from(CATALOG_ASSETS_BUCKET)
        .getPublicUrl(path);
      setCoverUrl(pub.publicUrl);
      toast({ title: "Carátula cargada", variant: "success" });
    } catch (e) {
      toast({
        title: "No se pudo subir la imagen",
        description: e instanceof Error ? e.message : undefined,
        variant: "error",
      });
    } finally {
      setUploading(false);
      if (fileRef.current) fileRef.current.value = "";
    }
  }

  async function handleSave() {
    const p = Number(price);
    if (!name.trim()) {
      toast({ title: "Ingresá un nombre", variant: "error" });
      return;
    }
    if (!Number.isFinite(p) || p < 0) {
      toast({ title: "Precio inválido", variant: "error" });
      return;
    }
    if (storeKeys.length === 0) {
      toast({ title: "Elegí al menos una tienda", variant: "error" });
      return;
    }
    try {
      await save.mutateAsync({
        id: catalog?.id ?? null,
        key: catalog?.key ?? null,
        name: name.trim(),
        description: description.trim(),
        coverUrl: coverUrl.trim(),
        priceArs: p,
        dedupeByEan: dedupe,
        isActive: active,
        storeKeys,
      });
      toast({
        title: isEdit ? "Catálogo actualizado" : "Catálogo creado",
        variant: "success",
      });
      onOpenChange(false);
    } catch (e) {
      toast({
        title: "No se pudo guardar",
        description: e instanceof Error ? e.message : undefined,
        variant: "error",
      });
    }
  }

  return (
    <Modal
      open={open}
      onOpenChange={onOpenChange}
      title={isEdit ? "Editar catálogo" : "Nuevo catálogo"}
      className="max-w-2xl"
    >
      <div className="space-y-5">
        {/* Nombre + precio */}
        <div className="grid gap-3 sm:grid-cols-2">
          <Input
            label="Nombre"
            placeholder="Supermercado"
            value={name}
            onChange={(e) => setName(e.target.value)}
          />
          <Input
            label="Precio único (ARS)"
            type="number"
            min="0"
            step="0.01"
            hint="Pago único, no mensual"
            value={price}
            onChange={(e) => setPrice(e.target.value)}
          />
        </div>

        {/* Descripción */}
        <div>
          <label
            htmlFor="cat-desc"
            className="mb-2 block text-sm font-medium text-muted-foreground"
          >
            Descripción
          </label>
          <textarea
            id="cat-desc"
            value={description}
            onChange={(e) => setDescription(e.target.value)}
            rows={3}
            placeholder="Qué incluye el catálogo y para qué rubro sirve."
            className="w-full resize-y rounded-lg border border-input bg-background p-3 text-sm text-foreground outline-none transition placeholder:text-muted-foreground focus:border-ninja-flameSoft focus:ring-2 focus:ring-ninja-flameSoft/20"
          />
        </div>

        {/* Carátula */}
        <div className="rounded-lg border border-border p-3">
          <div className="mb-2 flex items-center justify-between">
            <span className="text-sm font-medium text-muted-foreground">
              Carátula (opcional)
            </span>
            {coverUrl && (
              <button
                type="button"
                onClick={() => setCoverUrl("")}
                className="inline-flex items-center gap-1 text-xs text-destructive transition hover:underline"
              >
                <Trash2 size={12} /> Quitar
              </button>
            )}
          </div>
          <div className="flex flex-wrap items-center gap-4">
            <div className="grid h-16 w-28 place-items-center overflow-hidden rounded-md border border-border bg-background">
              {coverUrl ? (
                // eslint-disable-next-line @next/next/no-img-element
                <img
                  src={coverUrl}
                  alt="Carátula del catálogo"
                  className="h-full w-full object-cover"
                />
              ) : (
                <ImagePlus size={20} className="text-muted-foreground" />
              )}
            </div>
            <Button
              type="button"
              variant="secondary"
              size="sm"
              loading={uploading}
              onClick={() => fileRef.current?.click()}
            >
              {coverUrl ? "Cambiar" : "Subir imagen"}
            </Button>
            <input
              ref={fileRef}
              type="file"
              accept="image/*"
              hidden
              onChange={(e) => onPickImage(e.target.files?.[0])}
            />
          </div>
          <div className="mt-3 flex items-center gap-2">
            <Link2 size={14} className="shrink-0 text-muted-foreground" />
            <Input
              placeholder="…o pegá una URL de imagen"
              value={coverUrl}
              onChange={(e) => setCoverUrl(e.target.value)}
              className="h-9"
            />
          </div>
          <p className="mt-2 text-xs text-muted-foreground">
            Se convierte a WebP (máx. 800px).
          </p>
        </div>

        {/* Tiendas que componen el catálogo */}
        <div>
          <div className="mb-2 flex items-center justify-between">
            <span className="text-sm font-medium text-muted-foreground">
              Tiendas que lo componen
            </span>
            <span className="text-xs text-muted-foreground">
              ~{approxProducts.toLocaleString("es-AR")} productos
            </span>
          </div>
          <div className="grid gap-2 sm:grid-cols-2">
            {stores.map((s) => {
              const checked = storeKeys.includes(s.key);
              return (
                <button
                  key={s.key}
                  type="button"
                  onClick={() => toggleStore(s.key)}
                  className={cn(
                    "flex items-center gap-3 rounded-lg border p-3 text-left transition",
                    checked
                      ? "border-ninja-flameSoft bg-ninja-flame/10"
                      : "border-border hover:bg-muted",
                  )}
                >
                  <span className="grid h-9 w-9 shrink-0 place-items-center overflow-hidden rounded-md border border-border bg-background">
                    {s.logoUrl ? (
                      // eslint-disable-next-line @next/next/no-img-element
                      <img
                        src={s.logoUrl}
                        alt={s.name}
                        className="h-full w-full object-contain p-1"
                      />
                    ) : (
                      <Store size={16} className="text-muted-foreground" />
                    )}
                  </span>
                  <span className="min-w-0 flex-1">
                    <span className="block truncate text-sm font-medium text-foreground">
                      {s.name}
                    </span>
                    <span className="block text-xs text-muted-foreground">
                      {s.productCount.toLocaleString("es-AR")} productos
                    </span>
                  </span>
                  <input
                    type="checkbox"
                    checked={checked}
                    readOnly
                    className="h-4 w-4 accent-ninja-flame"
                  />
                </button>
              );
            })}
          </div>
        </div>

        {/* Dedupe + Activo */}
        <div className="grid gap-3 sm:grid-cols-2">
          <div className="flex items-start justify-between gap-3 rounded-lg border border-border p-3">
            <div>
              <span className="block text-sm font-medium text-foreground">
                Vender como paquete
              </span>
              <p className="mt-0.5 text-xs text-muted-foreground">
                Deduplica por código de barras (un solo EAN, el más completo).
              </p>
            </div>
            <Switch
              checked={dedupe}
              onCheckedChange={setDedupe}
              label="Vender como paquete"
            />
          </div>
          <div className="flex items-start justify-between gap-3 rounded-lg border border-border p-3">
            <div>
              <span className="block text-sm font-medium text-foreground">
                Catálogo activo
              </span>
              <p className="mt-0.5 text-xs text-muted-foreground">
                Visible en la oferta para que los negocios lo compren.
              </p>
            </div>
            <Switch checked={active} onCheckedChange={setActive} label="Catálogo activo" />
          </div>
        </div>

        <div className="flex items-center justify-between gap-2 pt-1">
          <span className="text-sm text-muted-foreground">
            Precio:{" "}
            <span className="font-price font-semibold text-foreground">
              {price.trim() !== "" && Number.isFinite(Number(price))
                ? formatCurrency(Number(price))
                : "—"}
            </span>
          </span>
          <div className="flex gap-2">
            <Button variant="secondary" onClick={() => onOpenChange(false)}>
              Cancelar
            </Button>
            <Button loading={save.isPending} onClick={handleSave}>
              {isEdit ? "Guardar cambios" : "Crear catálogo"}
            </Button>
          </div>
        </div>
      </div>
    </Modal>
  );
}
