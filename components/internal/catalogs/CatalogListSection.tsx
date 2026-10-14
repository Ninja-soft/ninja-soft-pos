"use client";

// Catálogos vendibles: agrupan tiendas con nombre, carátula y precio único.
// Tarjeta por catálogo: portada completa (sin nada encima), badges, título,
// descripción, tiendas (logos sin fondo), datos y precio con acciones.
import { useState } from "react";
import { Boxes, Gift, Layers, Package, Pencil, Plus, Store, Tags, Users, type LucideIcon } from "lucide-react";
import { Card } from "@/components/ui/Card";
import { Badge } from "@/components/ui/Badge";
import { Button } from "@/components/ui/Button";
import { EmptyState } from "@/components/ui/EmptyState";
import { Skeleton } from "@/components/ui/Skeleton";
import { StoreLogo } from "@/components/catalog/StoreLogo";
import { CatalogCover } from "@/components/catalog/CatalogCover";
import { cn } from "@/lib/utils/cn";
import { formatCurrency } from "@/lib/utils/format";
import { useCatalogs, useCatalogStores } from "@/modules/internal/catalogsHooks";
import type { Catalog, CatalogStore } from "@/modules/internal/catalogs";
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
              <Skeleton className="aspect-[16/9] w-full rounded-none" />
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
        <div className="grid items-stretch gap-4 sm:grid-cols-2 xl:grid-cols-3">
          {catalogs.map((c) => (
            <CatalogTile key={c.id} catalog={c} stores={names} onEdit={onEdit} onGrants={onGrants} />
          ))}
        </div>
      )}
    </section>
  );
}

// Tarjeta de un catálogo: portada completa → badges → título → descripción →
// tiendas → datos → precio y acciones. Los bloques de texto reservan su alto
// para que las tarjetas de una misma fila queden alineadas.
function CatalogTile({
  catalog: c,
  stores,
  onEdit,
  onGrants,
}: {
  catalog: Catalog;
  stores: Map<string, CatalogStore>;
  onEdit: (c: Catalog) => void;
  onGrants: (c: Catalog) => void;
}) {
  const [expanded, setExpanded] = useState(false);
  const long = (c.description?.length ?? 0) > 90;
  const storeName = (k: string) => stores.get(k)?.name ?? k;

  return (
    <Card className="flex h-full min-w-0 flex-col overflow-hidden">
      <CatalogCover coverUrl={c.coverUrl} name={c.name} className="border-b border-border" />

      <div className="flex flex-1 flex-col p-4">
        <div className="flex flex-wrap items-center gap-1.5">
          <Badge tone={c.isActive ? "success" : "neutral"}>{c.isActive ? "Activo" : "Inactivo"}</Badge>
          {c.dedupeByEan && (
            <Badge tone="brand">
              <Layers size={12} aria-hidden /> Paquete
            </Badge>
          )}
        </div>

        <h3 className="mt-3 truncate text-lg font-bold tracking-tight text-foreground" title={c.name}>
          {c.name}
        </h3>

        <div className="mt-1">
          <p
            className={cn(
              "min-h-[2.5rem] whitespace-pre-line text-sm leading-5 text-muted-foreground",
              !expanded && "line-clamp-2",
            )}
          >
            {c.description || "Sin descripción."}
          </p>
          <button
            type="button"
            onClick={() => setExpanded((v) => !v)}
            className={cn(
              "mt-0.5 h-5 text-xs font-semibold text-muted-foreground hover:text-foreground",
              !long && "invisible",
            )}
            tabIndex={long ? 0 : -1}
            aria-hidden={!long || undefined}
          >
            {expanded ? "Ver menos" : "Ver más"}
          </button>
        </div>

        <div
          className="mt-3 flex h-8 items-center gap-2"
          aria-label={`Tiendas: ${c.storeKeys.map(storeName).join(", ") || "ninguna"}`}
        >
          {c.storeKeys.length === 0 ? (
            <span className="text-xs text-muted-foreground">Sin tiendas</span>
          ) : (
            <>
              {c.storeKeys.slice(0, MAX_LOGOS).map((k) => (
                <span key={k} title={storeName(k)} className="inline-flex">
                  <StoreLogo storeKey={k} name={storeName(k)} logoUrl={stores.get(k)?.logoUrl} size={28} />
                </span>
              ))}
              {c.storeKeys.length > MAX_LOGOS && (
                <span className="text-xs font-semibold tabular-nums text-muted-foreground">
                  +{c.storeKeys.length - MAX_LOGOS}
                </span>
              )}
            </>
          )}
        </div>

        <dl className="mt-4 grid grid-cols-2 gap-px overflow-hidden rounded-lg border border-border bg-border">
          <Stat
            icon={Package}
            label="Productos únicos"
            value={c.productCount}
            title="Productos únicos que ve quien compra el catálogo (con o sin EAN). Se actualiza al terminar cada sincronización y al editar sus tiendas."
          />
          <Stat
            icon={Tags}
            label="Ofertas"
            value={c.offerCount}
            title="Publicaciones de sus tiendas (un mismo producto puede estar en varias)."
          />
          <Stat icon={Store} label="Tiendas" value={c.storeKeys.length} />
          <Stat icon={Users} label="Con acceso" value={c.purchaseCount} />
        </dl>

        <div className="mt-auto pt-4">
          <div className="flex flex-wrap items-end justify-between gap-3 border-t border-border pt-4">
            <div className="min-w-0">
              <p className="text-[11px] font-medium uppercase tracking-wide text-muted-foreground">Pago único</p>
              <p className="font-price text-2xl font-black tabular-nums leading-tight text-foreground">
                {formatCurrency(c.priceArs)}
              </p>
            </div>
            <div className="flex items-center gap-1.5">
              <Button variant="secondary" size="sm" onClick={() => onGrants(c)}>
                <Gift size={14} /> Accesos
              </Button>
              <Button variant="ghost" size="sm" onClick={() => onEdit(c)}>
                <Pencil size={14} /> Editar
              </Button>
            </div>
          </div>
        </div>
      </div>
    </Card>
  );
}

function Stat({ icon: Icon, label, value, title }: { icon: LucideIcon; label: string; value: number; title?: string }) {
  return (
    <div className="min-w-0 bg-card px-3 py-2.5" title={title}>
      <dt className="flex items-center gap-1 truncate text-xs font-medium text-muted-foreground">
        <Icon size={12} aria-hidden className="shrink-0" /> {label}
      </dt>
      <dd className="mt-0.5 truncate text-xl font-semibold tabular-nums leading-tight text-foreground">
        {fmtNum(value)}
      </dd>
    </div>
  );
}
