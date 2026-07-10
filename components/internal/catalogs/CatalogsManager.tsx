"use client";

import { useRef, useState } from "react";
import {
  Boxes,
  ChevronDown,
  Gift,
  ImagePlus,
  Package,
  Pencil,
  Plus,
  Store,
  UploadCloud,
  FileSpreadsheet,
  Check,
} from "lucide-react";
import { Card, CardContent } from "@/components/ui/Card";
import { Heading } from "@/components/ui/Typography";
import { Button } from "@/components/ui/Button";
import { useToast } from "@/components/ui/Toast";
import { createClient } from "@/lib/supabase/client";
import { resizeToWebp } from "@/lib/utils/image";
import { formatCurrency } from "@/lib/utils/format";
import { cn } from "@/lib/utils/cn";
import {
  useCatalogs,
  useCatalogStores,
  useSetStoreLogo,
} from "@/modules/internal/catalogsHooks";
import { CATALOG_ASSETS_BUCKET, type Catalog } from "@/modules/internal/catalogs";
import { CatalogEditorModal } from "./CatalogEditorModal";
import { CatalogGrantsModal } from "./CatalogGrantsModal";

const CATALOG_IMPORTS_BUCKET = "catalog-imports";

export function CatalogsManager() {
  const { toast } = useToast();
  const { data: stores } = useCatalogStores();
  const { data: catalogs, isLoading } = useCatalogs();

  const [editorOpen, setEditorOpen] = useState(false);
  const [editing, setEditing] = useState<Catalog | null>(null);
  const [grantsOpen, setGrantsOpen] = useState(false);
  const [grantsCatalog, setGrantsCatalog] = useState<Catalog | null>(null);

  const [uploading, setUploading] = useState(false);
  const [lastUpload, setLastUpload] = useState<string | null>(null);
  const fileRef = useRef<HTMLInputElement>(null);

  // Foto/logo por tienda de origen: subo al bucket público catalog-assets y
  // persisto la URL en catalog_stores.logo_url vía RPC (gateada a internal).
  const setStoreLogo = useSetStoreLogo();
  const [logoStoreKey, setLogoStoreKey] = useState<string | null>(null);
  const storeLogoRef = useRef<HTMLInputElement>(null);

  function pickStoreLogo(storeKey: string) {
    setLogoStoreKey(storeKey);
    storeLogoRef.current?.click();
  }

  async function onPickStoreLogo(file: File | undefined) {
    const storeKey = logoStoreKey;
    if (!file || !storeKey) {
      setLogoStoreKey(null);
      return;
    }
    try {
      const supabase = createClient();
      const webp = await resizeToWebp(file, 400, 0.9);
      const path = `stores/${storeKey}-${crypto.randomUUID()}.webp`;
      const up = await supabase.storage
        .from(CATALOG_ASSETS_BUCKET)
        .upload(path, webp, { contentType: "image/webp", upsert: false });
      if (up.error) throw up.error;
      const { data: pub } = supabase.storage
        .from(CATALOG_ASSETS_BUCKET)
        .getPublicUrl(path);
      await setStoreLogo.mutateAsync({ storeKey, logoUrl: pub.publicUrl });
      toast({ title: "Foto de la tienda actualizada", variant: "success" });
    } catch (e) {
      toast({
        title: "No se pudo actualizar la foto",
        description: e instanceof Error ? e.message : undefined,
        variant: "error",
      });
    } finally {
      setLogoStoreKey(null);
      if (storeLogoRef.current) storeLogoRef.current.value = "";
    }
  }

  function openCreate() {
    setEditing(null);
    setEditorOpen(true);
  }
  function openEdit(c: Catalog) {
    setEditing(c);
    setEditorOpen(true);
  }
  function openGrants(c: Catalog) {
    setGrantsCatalog(c);
    setGrantsOpen(true);
  }

  // Sube el Excel al bucket privado catalog-imports. El import masivo a
  // catalog_products lo corre el script server-side (ver instrucciones); acá
  // sólo dejamos el archivo disponible y registrado.
  async function onPickExcel(file: File | undefined) {
    if (!file) return;
    setUploading(true);
    try {
      const supabase = createClient();
      const safe = file.name.replace(/[^a-zA-Z0-9._-]/g, "_");
      const path = `${new Date().toISOString().slice(0, 10)}/${Date.now()}-${safe}`;
      const up = await supabase.storage
        .from(CATALOG_IMPORTS_BUCKET)
        .upload(path, file, { upsert: false });
      if (up.error) throw up.error;
      setLastUpload(file.name);
      toast({
        title: "Excel subido",
        description: "Corré el import por script para cargarlo (ver instrucciones).",
        variant: "success",
      });
    } catch (e) {
      toast({
        title: "No se pudo subir el Excel",
        description: e instanceof Error ? e.message : undefined,
        variant: "error",
      });
    } finally {
      setUploading(false);
      if (fileRef.current) fileRef.current.value = "";
    }
  }

  return (
    <div className="space-y-10">
      {/* Tiendas de origen */}
      <section>
        <Heading as="h2" className="flex items-center gap-2 text-base">
          <Store size={18} /> Tiendas de origen
        </Heading>
        <p className="mt-1 max-w-2xl text-sm text-muted-foreground">
          Cada hoja del Excel que sube NinjaSoft es una tienda. Los catálogos
          vendibles se arman agrupando estas tiendas.
        </p>
        <div className="mt-3 grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
          {(stores ?? []).map((s) => {
            const busy =
              setStoreLogo.isPending && logoStoreKey === s.key;
            return (
              <Card key={s.key}>
                <CardContent className="flex items-center gap-3 p-4">
                  <span className="grid h-11 w-11 shrink-0 place-items-center overflow-hidden rounded-lg border border-border bg-background">
                    {s.logoUrl ? (
                      // eslint-disable-next-line @next/next/no-img-element
                      <img
                        src={s.logoUrl}
                        alt={s.name}
                        className="h-full w-full object-contain p-1"
                      />
                    ) : (
                      <Store size={18} className="text-muted-foreground" />
                    )}
                  </span>
                  <div className="min-w-0 flex-1">
                    <span className="block truncate text-sm font-semibold text-foreground">
                      {s.name}
                    </span>
                    <span className="block text-xs text-muted-foreground">
                      {s.productCount.toLocaleString("es-AR")} productos
                      {s.lastImportAt &&
                        ` · ${new Date(s.lastImportAt).toLocaleDateString("es-AR")}`}
                    </span>
                  </div>
                  <Button
                    variant="ghost"
                    size="sm"
                    className="shrink-0 px-2"
                    loading={busy}
                    disabled={setStoreLogo.isPending}
                    onClick={() => pickStoreLogo(s.key)}
                    title={s.logoUrl ? "Cambiar foto" : "Subir foto"}
                  >
                    {!busy && <ImagePlus size={14} />}
                    <span className="hidden sm:inline">
                      {s.logoUrl ? "Cambiar" : "Subir foto"}
                    </span>
                  </Button>
                </CardContent>
              </Card>
            );
          })}
        </div>
        <input
          ref={storeLogoRef}
          type="file"
          accept="image/*"
          hidden
          onChange={(e) => onPickStoreLogo(e.target.files?.[0])}
        />
      </section>

      {/* Catálogos vendibles */}
      <section>
        <div className="flex flex-wrap items-center justify-between gap-3">
          <Heading as="h2" className="flex items-center gap-2 text-base">
            <Boxes size={18} /> Catálogos vendibles
          </Heading>
          <Button size="sm" onClick={openCreate}>
            <Plus size={15} /> Nuevo catálogo
          </Button>
        </div>
        <p className="mt-1 max-w-2xl text-sm text-muted-foreground">
          Agrupá tiendas en un catálogo con nombre, carátula y precio único. El
          cliente lo compra y puede buscar/agregar sus productos.
        </p>

        <div className="mt-3 space-y-3">
          {isLoading ? (
            <p className="text-sm text-muted-foreground">Cargando catálogos…</p>
          ) : (catalogs?.length ?? 0) === 0 ? (
            <Card>
              <CardContent className="p-6 text-center text-sm text-muted-foreground">
                Todavía no hay catálogos. Creá el primero con “Nuevo catálogo”.
              </CardContent>
            </Card>
          ) : (
            (catalogs ?? []).map((c) => (
              <Card key={c.id}>
                <CardContent className="flex flex-col gap-4 p-4 sm:flex-row sm:items-center">
                  <span className="grid h-16 w-24 shrink-0 place-items-center overflow-hidden rounded-md border border-border bg-background">
                    {c.coverUrl ? (
                      // eslint-disable-next-line @next/next/no-img-element
                      <img
                        src={c.coverUrl}
                        alt={c.name}
                        className="h-full w-full object-cover"
                      />
                    ) : (
                      <Package size={22} className="text-muted-foreground" />
                    )}
                  </span>

                  <div className="min-w-0 flex-1">
                    <div className="flex flex-wrap items-center gap-2">
                      <span className="text-sm font-semibold text-foreground">
                        {c.name}
                      </span>
                      <span
                        className={cn(
                          "rounded px-1.5 py-0.5 text-[10px] font-medium uppercase",
                          c.isActive
                            ? "bg-emerald-500/15 text-success"
                            : "bg-muted text-muted-foreground",
                        )}
                      >
                        {c.isActive ? "Activo" : "Inactivo"}
                      </span>
                      {c.dedupeByEan && (
                        <span className="rounded bg-ninja-flame/15 px-1.5 py-0.5 text-[10px] font-medium uppercase text-ninja-flameSoft">
                          Paquete
                        </span>
                      )}
                    </div>
                    {c.description && (
                      <p className="mt-0.5 line-clamp-1 text-xs text-muted-foreground">
                        {c.description}
                      </p>
                    )}
                    <div className="mt-1.5 flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-muted-foreground">
                      <span className="inline-flex items-center gap-1">
                        <Store size={12} /> {c.storeKeys.join(", ") || "sin tiendas"}
                      </span>
                      <span className="inline-flex items-center gap-1">
                        <Package size={12} />{" "}
                        {c.productCount.toLocaleString("es-AR")} productos
                      </span>
                      <span className="inline-flex items-center gap-1">
                        <Gift size={12} /> {c.purchaseCount} con acceso
                      </span>
                    </div>
                  </div>

                  <div className="flex shrink-0 items-center gap-2">
                    <span className="font-price text-base font-bold text-foreground">
                      {formatCurrency(c.priceArs)}
                    </span>
                    <Button
                      variant="secondary"
                      size="sm"
                      onClick={() => openGrants(c)}
                    >
                      <Gift size={14} /> Accesos
                    </Button>
                    <Button variant="ghost" size="sm" onClick={() => openEdit(c)}>
                      <Pencil size={14} /> Editar
                    </Button>
                  </div>
                </CardContent>
              </Card>
            ))
          )}
        </div>
      </section>

      {/* Importar Excel */}
      <section>
        <Heading as="h2" className="flex items-center gap-2 text-base">
          <FileSpreadsheet size={18} /> Importar Excel de productos
        </Heading>
        <Card className="mt-3">
          <CardContent className="space-y-4 p-5">
            <div className="flex flex-wrap items-center gap-3">
              <Button
                loading={uploading}
                onClick={() => fileRef.current?.click()}
              >
                <UploadCloud size={16} /> Subir Excel
              </Button>
              <input
                ref={fileRef}
                type="file"
                accept=".xlsx,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
                hidden
                onChange={(e) => onPickExcel(e.target.files?.[0])}
              />
              {lastUpload ? (
                <span className="inline-flex items-center gap-1 text-xs text-success">
                  <Check size={13} /> Subido: {lastUpload}
                </span>
              ) : (
                <span className="text-xs text-muted-foreground">
                  Una hoja por tienda. Se guarda en el almacenamiento seguro.
                </span>
              )}
            </div>

            <details className="group rounded-lg border border-border bg-muted/30">
              <summary className="flex cursor-pointer list-none items-center gap-2 p-3 text-xs font-semibold uppercase tracking-wide text-muted-foreground transition hover:text-foreground">
                <ChevronDown
                  size={14}
                  className="transition-transform group-open:rotate-180"
                />
                Ver detalles técnicos / correr el import server-side
              </summary>
              <div className="border-t border-border px-3 pb-3 pt-3">
                <p className="mb-2 text-xs text-muted-foreground">
                  La carga masiva a la base la corre un{" "}
                  <strong>script server-side</strong> con la service key, porque
                  el archivo es enorme y no entra en una función web.
                </p>
                <pre className="overflow-x-auto rounded-md bg-background/70 p-3 text-xs leading-relaxed text-foreground">
{`SUPABASE_URL=…  SUPABASE_SERVICE_ROLE_KEY=…  \\
  node scripts/import_catalog.cjs <archivo.xlsx>`}
                </pre>
                <p className="mt-2 text-xs text-muted-foreground">
                  Hace UPSERT batcheado en <code>catalog_products</code> por
                  (tienda, EAN), actualiza el conteo por tienda y notifica a los
                  negocios que compraron cada catálogo. El sample inicial ya está
                  cargado para la demo.
                </p>
              </div>
            </details>
          </CardContent>
        </Card>
      </section>

      <CatalogEditorModal
        open={editorOpen}
        onOpenChange={setEditorOpen}
        catalog={editing}
        stores={stores ?? []}
      />
      <CatalogGrantsModal
        open={grantsOpen}
        onOpenChange={setGrantsOpen}
        catalog={grantsCatalog}
      />
    </div>
  );
}
