"use client";

// Tiendas de origen: llegan solas con la sincronización. Por tienda: logo
// (baldosa clara), productos, ofertas de la tienda y de otros vendedores,
// disponibles (catalog_dedupe_stats), última sincronización, si está en venta
// en algún catálogo o sólo sirve para comparar, y la foto propia.
import { useRef, useState } from "react";
import { ImagePlus, Store } from "lucide-react";
import { Card } from "@/components/ui/Card";
import { Badge } from "@/components/ui/Badge";
import { Button } from "@/components/ui/Button";
import { EmptyState } from "@/components/ui/EmptyState";
import { Skeleton } from "@/components/ui/Skeleton";
import { useToast } from "@/components/ui/Toast";
import { StoreLogo } from "@/components/catalog/StoreLogo";
import { createClient } from "@/lib/supabase/client";
import { resizeToWebp } from "@/lib/utils/image";
import { useCatalogDedupeStats, useCatalogStores, useSetStoreLogo } from "@/modules/internal/catalogsHooks";
import { CATALOG_ASSETS_BUCKET } from "@/modules/internal/catalogs";
import { fmtAgo, fmtNum, SectionHeader } from "./catalogUi";

export function CatalogStoresSection() {
  const { toast } = useToast();
  const { data: stores, isLoading } = useCatalogStores();
  const { data: stats } = useCatalogDedupeStats();
  const setStoreLogo = useSetStoreLogo();
  const [logoStoreKey, setLogoStoreKey] = useState<string | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const byKey = new Map((stats?.tiendas ?? []).map((t) => [t.key, t]));

  function pick(storeKey: string) {
    setLogoStoreKey(storeKey);
    inputRef.current?.click();
  }

  // Foto propia por tienda: bucket público catalog-assets + URL en
  // catalog_stores.logo_url por RPC (gateada a internal). El ícono oficial,
  // si existe, se sigue mostrando primero.
  async function onPick(file: File | undefined) {
    const storeKey = logoStoreKey;
    if (!file || !storeKey) {
      setLogoStoreKey(null);
      return;
    }
    try {
      const supabase = createClient();
      const webp = await resizeToWebp(file, 400, 0.9);
      const path = `stores/${storeKey}-${crypto.randomUUID()}.webp`;
      const up = await supabase.storage.from(CATALOG_ASSETS_BUCKET).upload(path, webp, { contentType: "image/webp", upsert: false });
      if (up.error) throw up.error;
      const { data: pub } = supabase.storage.from(CATALOG_ASSETS_BUCKET).getPublicUrl(path);
      await setStoreLogo.mutateAsync({ storeKey, logoUrl: pub.publicUrl });
      toast({ title: "Foto de la tienda actualizada", variant: "success" });
    } catch (e) {
      toast({ title: "No se pudo actualizar la foto", description: e instanceof Error ? e.message : undefined, variant: "error" });
    } finally {
      setLogoStoreKey(null);
      if (inputRef.current) inputRef.current.value = "";
    }
  }

  const list = [...(stores ?? [])].sort((a, b) => b.productCount - a.productCount);
  const enVenta = list.filter((s) => byKey.get(s.key)?.enCatalogo).length;

  return (
    <section data-shot="tiendas" className="space-y-4">
      <SectionHeader
        icon={Store}
        title="Tiendas de origen"
        description={
          stores
            ? `${list.length} tiendas: ${enVenta} en venta en algún catálogo y ${list.length - enVenta} sólo para comparar precios. Llegan solas con la sincronización.`
            : "Llegan solas con la sincronización. Los catálogos vendibles se arman agrupando estas tiendas."
        }
      />

      <Card className="overflow-hidden">
        {isLoading ? (
          <div aria-busy className="divide-y divide-border">
            {Array.from({ length: 6 }, (_, i) => (
              <div key={i} className="flex items-center gap-3 p-4">
                <Skeleton className="h-9 w-9" />
                <Skeleton className="h-4 w-40" />
                <Skeleton className="ml-auto h-4 w-24" />
              </div>
            ))}
          </div>
        ) : list.length === 0 ? (
          <EmptyState
            compact
            icon={Store}
            title="Todavía no hay tiendas"
            description="Aparecen solas con la primera sincronización del catálogo."
          />
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full min-w-[760px] text-sm">
              <thead>
                <tr className="border-b border-border bg-muted/40 text-left text-xs font-medium text-muted-foreground">
                  <th scope="col" className="px-4 py-2.5 font-medium">Tienda</th>
                  <th scope="col" className="px-3 py-2.5 font-medium">Catálogo</th>
                  <th scope="col" className="px-3 py-2.5 text-right font-medium">Productos</th>
                  <th scope="col" className="px-3 py-2.5 text-right font-medium">Disponibles</th>
                  <th scope="col" className="px-3 py-2.5 text-right font-medium">Otros vendedores</th>
                  <th scope="col" className="px-3 py-2.5 font-medium">Sincronizada</th>
                  <th scope="col" className="px-4 py-2.5 text-right font-medium">
                    <span className="sr-only">Acciones</span>
                  </th>
                </tr>
              </thead>
              <tbody>
                {list.map((s) => {
                  const t = byKey.get(s.key);
                  const busy = setStoreLogo.isPending && logoStoreKey === s.key;
                  return (
                    <tr key={s.key} className="border-t border-border first:border-t-0">
                      <td className="px-4 py-3">
                        <span className="flex items-center gap-3">
                          <StoreLogo storeKey={s.key} name={s.name} logoUrl={s.logoUrl} size={36} />
                          <span className="min-w-0">
                            <span className="block truncate font-medium text-foreground">{s.name}</span>
                            <span className="block text-xs text-muted-foreground">{s.key}</span>
                          </span>
                        </span>
                      </td>
                      <td className="px-3 py-3">
                        {t?.enCatalogo ? <Badge tone="success">En venta</Badge> : <Badge tone="neutral">Sólo comparación</Badge>}
                      </td>
                      <td className="px-3 py-3 text-right tabular-nums text-foreground">{fmtNum(s.productCount)}</td>
                      <td className="px-3 py-3 text-right tabular-nums text-foreground">{t ? fmtNum(t.disponibles) : ""}</td>
                      <td className="px-3 py-3 text-right tabular-nums text-foreground">{t ? fmtNum(t.ofertasVendedores) : ""}</td>
                      <td className="px-3 py-3 text-muted-foreground">{s.lastImportAt ? fmtAgo(s.lastImportAt) : "Nunca"}</td>
                      <td className="px-4 py-3 text-right">
                        <Button
                          variant="ghost"
                          size="sm"
                          loading={busy}
                          disabled={setStoreLogo.isPending}
                          onClick={() => pick(s.key)}
                          title={s.logoUrl ? "Cambiar la foto propia" : "Subir una foto propia"}
                        >
                          {!busy && <ImagePlus size={14} />}
                          {s.logoUrl ? "Cambiar foto" : "Subir foto"}
                        </Button>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </Card>
      <input ref={inputRef} type="file" accept="image/*" hidden onChange={(e) => onPick(e.target.files?.[0])} />
    </section>
  );
}
