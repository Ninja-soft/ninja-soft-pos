"use client";

// Catálogos vendibles: agrupan tiendas con nombre, carátula y precio único.
// Tarjeta por catálogo con carátula, estado, tiendas (logos), productos,
// negocios con acceso, precio y acciones (Accesos / Editar).
import { Boxes, Gift, Package, Pencil, Plus, Users } from "lucide-react";
import { Card } from "@/components/ui/Card";
import { Badge } from "@/components/ui/Badge";
import { Button } from "@/components/ui/Button";
import { EmptyState } from "@/components/ui/EmptyState";
import { Skeleton } from "@/components/ui/Skeleton";
import { StoreLogo } from "@/components/catalog/StoreLogo";
import { formatCurrency } from "@/lib/utils/format";
import { useCatalogs, useCatalogStores } from "@/modules/internal/catalogsHooks";
import type { Catalog } from "@/modules/internal/catalogs";
import { fmtNum, SectionHeader } from "./catalogUi";

const MAX_LOGOS = 6;

export function CatalogListSection({
  onCreate,
  onEdit,
  onGrants,
}: {
  onCreate: () => void;
  onEdit: (c: Catalog) => void;
  onGrants: (c: Catalog) => void;
}) {
  const { data: catalogs, isLoading } = useCatalogs();
  const { data: stores } = useCatalogStores();
  const names = new Map((stores ?? []).map((s) => [s.key, s]));

  return (
    <section data-shot="catalogos" className="space-y-4">
      <SectionHeader
        icon={Boxes}
        title="Catálogos vendibles"
        description="Agrupá tiendas en un catálogo con nombre, carátula y precio único. El negocio lo compra (o se lo bonificás) y puede buscar y agregar sus productos."
        actions={
          <Button onClick={onCreate}>
            <Plus size={15} /> Nuevo catálogo
          </Button>
        }
      />

      {isLoading ? (
        <div aria-busy className="grid gap-4 sm:grid-cols-2 xl:grid-cols-3">
          {Array.from({ length: 3 }, (_, i) => (
            <Card key={i} className="overflow-hidden">
              <Skeleton className="aspect-[16/7] w-full rounded-none" />
              <div className="space-y-2 p-4">
                <Skeleton className="h-5 w-40" />
                <Skeleton className="h-3.5 w-full" />
                <Skeleton className="h-8 w-32" />
              </div>
            </Card>
          ))}
        </div>
      ) : !catalogs?.length ? (
        <Card>
          <EmptyState
            icon={Boxes}
            title="Todavía no hay catálogos"
            description="Creá el primero agrupando tiendas de origen. Después le ponés precio y lo bonificás a los negocios que quieras."
            action={
              <Button onClick={onCreate}>
                <Plus size={15} /> Nuevo catálogo
              </Button>
            }
          />
        </Card>
      ) : (
        <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-3">
          {catalogs.map((c) => (
            <Card key={c.id} className="flex min-w-0 flex-col overflow-hidden">
              <div className="relative aspect-[16/7] w-full bg-muted">
                {c.coverUrl ? (
                  // eslint-disable-next-line @next/next/no-img-element
                  <img src={c.coverUrl} alt="" className="h-full w-full object-cover" />
                ) : (
                  <div className="grid h-full w-full place-items-center text-muted-foreground">
                    <Package size={28} strokeWidth={1.5} aria-hidden />
                  </div>
                )}
              </div>
              <div className="flex flex-1 flex-col gap-3 p-4">
                <div className="space-y-1">
                  <div className="flex flex-wrap items-center gap-1.5">
                    <h3 className="mr-1 truncate font-semibold text-foreground">{c.name}</h3>
                    <Badge tone={c.isActive ? "success" : "neutral"}>{c.isActive ? "Activo" : "Inactivo"}</Badge>
                    {c.dedupeByEan && <Badge tone="brand">Paquete</Badge>}
                  </div>
                  <p className="line-clamp-2 min-h-[2.5rem] text-sm text-muted-foreground">
                    {c.description || "Sin descripción."}
                  </p>
                </div>

                <div className="flex items-center gap-1.5" aria-label={`Tiendas: ${c.storeKeys.join(", ") || "ninguna"}`}>
                  {c.storeKeys.length === 0 ? (
                    <span className="text-xs text-muted-foreground">Sin tiendas</span>
                  ) : (
                    <>
                      {c.storeKeys.slice(0, MAX_LOGOS).map((k) => (
                        <span key={k} title={names.get(k)?.name ?? k}>
                          <StoreLogo storeKey={k} name={names.get(k)?.name ?? k} logoUrl={names.get(k)?.logoUrl} size={28} />
                        </span>
                      ))}
                      {c.storeKeys.length > MAX_LOGOS && (
                        <span className="text-xs font-medium text-muted-foreground">+{c.storeKeys.length - MAX_LOGOS}</span>
                      )}
                    </>
                  )}
                </div>

                <dl className="grid grid-cols-2 gap-3 text-sm">
                  <div>
                    <dt className="flex items-center gap-1 text-xs text-muted-foreground">
                      <Package size={12} aria-hidden /> Productos
                    </dt>
                    <dd className="font-semibold tabular-nums text-foreground">{fmtNum(c.productCount)}</dd>
                  </div>
                  <div>
                    <dt className="flex items-center gap-1 text-xs text-muted-foreground">
                      <Users size={12} aria-hidden /> Con acceso
                    </dt>
                    <dd className="font-semibold tabular-nums text-foreground">{fmtNum(c.purchaseCount)}</dd>
                  </div>
                </dl>

                <div className="mt-auto flex flex-wrap items-center justify-between gap-2 border-t border-border pt-3">
                  <span className="font-price text-lg font-bold text-foreground">{formatCurrency(c.priceArs)}</span>
                  <div className="flex gap-1.5">
                    <Button variant="secondary" size="sm" onClick={() => onGrants(c)}>
                      <Gift size={14} /> Accesos
                    </Button>
                    <Button variant="ghost" size="sm" onClick={() => onEdit(c)}>
                      <Pencil size={14} /> Editar
                    </Button>
                  </div>
                </div>
              </div>
            </Card>
          ))}
        </div>
      )}
    </section>
  );
}
