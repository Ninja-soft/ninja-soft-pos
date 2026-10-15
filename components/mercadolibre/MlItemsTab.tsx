"use client";

import { useMemo, useState } from "react";
import { BadgePercent, Download, Eye, ExternalLink, Link2, Link2Off, Pause, Play, RefreshCw, Search, Tag, Zap } from "lucide-react";
import { Badge } from "@/components/ui/Badge";
import { Button } from "@/components/ui/Button";
import { Checkbox } from "@/components/ui/Checkbox";
import { EmptyState } from "@/components/ui/EmptyState";
import { Input } from "@/components/ui/Input";
import { Modal } from "@/components/ui/Modal";
import { SpinnerBlock } from "@/components/ui/Spinner";
import { useToast } from "@/components/ui/Toast";
import { selectCls } from "@/components/stock/transfers/shared";
import { formatCurrency } from "@/lib/utils/format";
import {
  LISTING_TYPE_LABELS,
  itemStatusLabel,
  itemStatusTone,
  logisticLabel,
  mlErrorMessage,
} from "@/lib/mercadolibre/labels";
import {
  useMlItems,
  useMlMutations,
  type MlItem,
  type MlItemAction,
  type MlLinkSuggestion,
} from "@/modules/mercadolibre/hooks";
import { LinkProductModal } from "./LinkProductModal";

const BULK: Array<{ action: MlItemAction; label: string; icon: typeof Pause }> = [
  { action: "pause", label: "Pausar", icon: Pause },
  { action: "activate", label: "Activar", icon: Play },
  { action: "push_stock", label: "Reenviar stock", icon: RefreshCw },
  { action: "push_price", label: "Reenviar precio", icon: Tag },
  { action: "refresh", label: "Releer de ML", icon: Download },
];

type Sort = "title" | "visits" | "sold" | "health";

export function MlItemsTab({
  accountId,
  onQuickPublish,
  onConfigurePrices,
}: {
  accountId: string;
  /** Abre la publicación rápida (gestor, ADR-132). */
  onQuickPublish?: () => void;
  /** Lleva a Configuración > Precios por tipo. */
  onConfigurePrices?: () => void;
}) {
  const { toast } = useToast();
  const { data: items = [], isLoading } = useMlItems(accountId);
  const { itemsAction, unlink, importItems, link, visits } = useMlMutations();
  const [sort, setSort] = useState<Sort>("title");
  const [status, setStatus] = useState("");
  const [listing, setListing] = useState("");
  const [logistic, setLogistic] = useState("");
  const [linked, setLinked] = useState("");
  const [search, setSearch] = useState("");
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [linking, setLinking] = useState<MlItem | null>(null);
  const [suggestions, setSuggestions] = useState<MlLinkSuggestion[] | null>(null);

  const logistics = useMemo(() => [...new Set(items.map((i) => i.logistic_type).filter(Boolean))] as string[], [items]);
  const listings = useMemo(() => [...new Set(items.map((i) => i.listing_type_id).filter(Boolean))] as string[], [items]);

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase();
    const list = items.filter(
      (i) =>
        (!status || i.status === status) &&
        (!listing || i.listing_type_id === listing) &&
        (!logistic || i.logistic_type === logistic) &&
        (!linked || (linked === "yes" ? i.links.length > 0 : i.links.length === 0)) &&
        (!q || i.title.toLowerCase().includes(q) || i.ml_item_id.toLowerCase().includes(q)),
    );
    const key: Record<Sort, (i: MlItem) => number> = {
      title: () => 0,
      visits: (i) => -(i.visits_30d ?? -1),
      sold: (i) => -(i.sold_quantity ?? 0),
      health: (i) => Number(i.health ?? 2),
    };
    return sort === "title" ? list : [...list].sort((a, b) => key[sort](a) - key[sort](b));
  }, [items, status, listing, logistic, linked, search, sort]);

  const readVisits = () => {
    const ids = items.filter((i) => selected.has(i.id)).map((i) => i.ml_item_id).slice(0, 50);
    if (ids.length === 0) return;
    visits.mutate(
      { accountId, itemIds: ids },
      {
        onSuccess: (r) => toast({ title: `Visitas de ${r?.count ?? ids.length} publicaciones`, description: "Últimos 30 días.", variant: "success" }),
        onError: (e) => toast({ title: "No se pudieron leer las visitas", description: mlErrorMessage(e), variant: "error" }),
      },
    );
  };

  const allOn = filtered.length > 0 && filtered.every((i) => selected.has(i.id));
  const toggle = (id: string) =>
    setSelected((s) => {
      const n = new Set(s);
      if (n.has(id)) n.delete(id);
      else n.add(id);
      return n;
    });

  const runBulk = (action: MlItemAction) => {
    const ids = [...selected];
    if (ids.length === 0) return;
    itemsAction.mutate(
      { ids, action },
      {
        onSuccess: (r) => {
          toast({ title: `${r?.count ?? ids.length} publicaciones en la cola`, description: "Se envían de a poco para respetar los límites de Mercado Libre.", variant: "success" });
          setSelected(new Set());
        },
        onError: (e) => toast({ title: "No se pudo", description: mlErrorMessage(e), variant: "error" }),
      },
    );
  };

  const runImport = () =>
    importItems.mutate(accountId, {
      onSuccess: (r) => {
        toast({ title: `${r?.imported ?? 0} publicaciones leídas de Mercado Libre`, variant: "success" });
        if (r?.suggestions?.length) setSuggestions(r.suggestions);
      },
      onError: (e) => toast({ title: "No se pudo importar", description: mlErrorMessage(e), variant: "error" }),
    });

  const acceptSuggestion = (s: MlLinkSuggestion) =>
    link.mutate(
      { itemId: s.item_row_id, variationId: s.variation_id, productId: s.product_id, variantId: s.variant_id, by: s.by },
      {
        onSuccess: () => setSuggestions((list) => (list ?? []).filter((x) => x !== s)),
        onError: (e) => toast({ title: "No se pudo vincular", description: mlErrorMessage(e), variant: "error" }),
      },
    );

  if (isLoading) return <SpinnerBlock className="py-16" />;

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center gap-2">
        <div className="relative min-w-[200px] flex-1">
          <Search size={16} className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-muted-foreground" />
          <Input className="pl-9" placeholder="Buscar por título o MLA" value={search} onChange={(e) => setSearch(e.target.value)} aria-label="Buscar publicación" />
        </div>
        {onQuickPublish && (
          <Button onClick={onQuickPublish}>
            <Zap size={15} /> Publicar rápido
          </Button>
        )}
        <Button variant="secondary" onClick={runImport} loading={importItems.isPending}>
          <Download size={15} /> Importar publicaciones
        </Button>
      </div>
      <div className="grid grid-cols-2 gap-2 sm:grid-cols-5">
        <select className={selectCls} value={status} onChange={(e) => setStatus(e.target.value)} aria-label="Estado">
          <option value="">Todos los estados</option>
          {["active", "paused", "closed", "under_review"].map((s) => (
            <option key={s} value={s}>
              {itemStatusLabel(s)}
            </option>
          ))}
        </select>
        <select className={selectCls} value={listing} onChange={(e) => setListing(e.target.value)} aria-label="Tipo de publicación">
          <option value="">Todos los tipos</option>
          {listings.map((l) => (
            <option key={l} value={l}>
              {LISTING_TYPE_LABELS[l] ?? l}
            </option>
          ))}
        </select>
        <select className={selectCls} value={logistic} onChange={(e) => setLogistic(e.target.value)} aria-label="Logística">
          <option value="">Todas las logísticas</option>
          {logistics.map((l) => (
            <option key={l} value={l}>
              {logisticLabel(l)}
            </option>
          ))}
        </select>
        <select className={selectCls} value={linked} onChange={(e) => setLinked(e.target.value)} aria-label="Vínculo">
          <option value="">Vinculadas y sin vincular</option>
          <option value="yes">Vinculadas</option>
          <option value="no">Sin vincular</option>
        </select>
        <select className={selectCls} value={sort} onChange={(e) => setSort(e.target.value as Sort)} aria-label="Ordenar">
          <option value="title">Ordenar por título</option>
          <option value="visits">Más visitas</option>
          <option value="sold">Más vendidas</option>
          <option value="health">Menor calidad primero</option>
        </select>
      </div>

      {selected.size > 0 && (
        <div className="flex flex-wrap items-center gap-2 rounded-lg bg-muted px-3 py-2">
          <span className="text-sm font-medium">{selected.size} elegidas</span>
          {BULK.map((b) => (
            <Button key={b.action} variant="secondary" size="sm" onClick={() => runBulk(b.action)} disabled={itemsAction.isPending}>
              <b.icon size={15} /> {b.label}
            </Button>
          ))}
          <Button variant="secondary" size="sm" onClick={readVisits} disabled={visits.isPending} loading={visits.isPending}>
            <Eye size={15} /> Leer visitas
          </Button>
          <Button variant="ghost" size="sm" onClick={() => setSelected(new Set())}>
            Limpiar
          </Button>
        </div>
      )}

      {filtered.length === 0 ? (
        <EmptyState
          icon={Tag}
          title={items.length === 0 ? "Todavía no hay publicaciones en el POS" : "No hay publicaciones con esos filtros"}
          description={
            items.length === 0
              ? "Publicá productos de tu catálogo en minutos (también en Clásica y Premium a la vez, cada una con su precio), o traé las que ya tenés en Mercado Libre para que el stock y el precio se sincronicen solos."
              : undefined
          }
          action={
            items.length === 0 ? (
              <div className="flex flex-wrap justify-center gap-2">
                {onQuickPublish && (
                  <Button size="sm" onClick={onQuickPublish}>
                    <Zap size={15} /> Publicar productos rápido
                  </Button>
                )}
                <Button size="sm" variant="secondary" onClick={runImport} loading={importItems.isPending}>
                  <Download size={15} /> Importar las que ya tenés
                </Button>
                {onConfigurePrices && (
                  <Button size="sm" variant="ghost" onClick={onConfigurePrices}>
                    <BadgePercent size={15} /> Configurar precios por tipo
                  </Button>
                )}
              </div>
            ) : undefined
          }
        />
      ) : (
        <div className="divide-y divide-border rounded-xl bg-card">
          <label className="flex items-center gap-3 px-4 py-2 text-xs text-muted-foreground">
            <Checkbox
              checked={allOn}
              onCheckedChange={(on) => setSelected(on ? new Set(filtered.map((i) => i.id)) : new Set())}
              aria-label="Elegir todas"
            />
            Elegir todas ({filtered.length})
          </label>
          {filtered.map((i) => (
            <div key={i.id} className="flex flex-wrap gap-3 px-4 py-3 sm:flex-nowrap">
              <Checkbox checked={selected.has(i.id)} onCheckedChange={() => toggle(i.id)} aria-label={`Elegir ${i.title}`} className="mt-1" />
              {i.thumbnail ? (
                // eslint-disable-next-line @next/next/no-img-element
                <img src={i.thumbnail.replace(/^http:\/\//i, "https://")} alt="" loading="lazy" className="h-12 w-12 shrink-0 rounded-lg object-cover" />
              ) : (
                <span className="h-12 w-12 shrink-0 rounded-lg bg-muted" />
              )}
              <div className="min-w-0 flex-1 basis-[calc(100%-6.5rem)] space-y-1 sm:basis-auto">
                <p className="line-clamp-2 text-sm font-medium sm:truncate">{i.title}</p>
                <div className="flex flex-wrap items-center gap-1.5">
                  <Badge tone={itemStatusTone(i.status)}>{itemStatusLabel(i.status)}</Badge>
                  {i.listing_type_id && <Badge tone="neutral">{LISTING_TYPE_LABELS[i.listing_type_id] ?? i.listing_type_id}</Badge>}
                  <Badge tone="neutral">{logisticLabel(i.logistic_type, i.shipping_mode)}</Badge>
                  {i.links.length > 0 ? <Badge tone="success">Vinculada</Badge> : <Badge tone="warning">Sin vincular</Badge>}
                  {i.price_source === "automation" && <Badge tone="info">Precio automático de ML</Badge>}
                  {i.price_source === "manual" && <Badge tone="info">Precio manual</Badge>}
                </div>
                <p className="text-xs text-muted-foreground">
                  {i.ml_item_id} · {formatCurrency(i.price ?? 0)} · {i.available_quantity ?? 0} disponibles · {i.sold_quantity ?? 0} vendidas
                  {i.health != null ? ` · calidad ${Math.round(Number(i.health) * 100)} %` : ""}
                  {i.visits_30d != null ? ` · ${i.visits_30d} visitas en 30 días` : ""}
                </p>
                {i.links.map((l) => (
                  <p key={l.id} className="flex items-center gap-2 text-xs">
                    <Link2 size={12} className="text-muted-foreground" />
                    <span className="truncate">{l.products?.name ?? "Producto"}</span>
                    {l.ml_variation_id && <span className="text-muted-foreground">variación {l.ml_variation_id}</span>}
                    <button
                      type="button"
                      className="text-muted-foreground underline-offset-2 hover:underline"
                      onClick={() =>
                        unlink.mutate(l.id, {
                          onSuccess: () => toast({ title: "Vínculo quitado", variant: "success" }),
                          onError: (e) => toast({ title: "No se pudo", description: mlErrorMessage(e), variant: "error" }),
                        })
                      }
                    >
                      <Link2Off size={12} className="mr-1 inline" />
                      Desvincular
                    </button>
                  </p>
                ))}
                {i.last_error && <p className="text-xs text-danger">{i.last_error}</p>}
              </div>
              <div className="flex w-full shrink-0 items-center justify-end gap-2 sm:w-auto sm:flex-col sm:items-stretch sm:gap-1">
                {(i.links.length === 0 || i.has_variations) && (
                  <Button variant="secondary" size="sm" onClick={() => setLinking(i)}>
                    <Link2 size={15} /> Vincular
                  </Button>
                )}
                {i.permalink && (
                  <a href={i.permalink} target="_blank" rel="noreferrer" className="inline-flex items-center gap-1 px-2 text-xs text-muted-foreground hover:underline">
                    <ExternalLink size={12} /> Ver
                  </a>
                )}
              </div>
            </div>
          ))}
        </div>
      )}

      <LinkProductModal item={linking} onClose={() => setLinking(null)} />

      <Modal
        open={suggestions !== null}
        onOpenChange={(o) => !o && setSuggestions(null)}
        title="Vínculos sugeridos"
        description="Publicaciones que coinciden con tus productos por SKU o código de barras. Confirmá cada una."
        footer={
          <div className="flex justify-end">
            <Button variant="secondary" onClick={() => setSuggestions(null)}>
              Listo
            </Button>
          </div>
        }
      >
        <div className="space-y-2">
          {(suggestions ?? []).length === 0 && <p className="text-sm text-muted-foreground">No quedan sugerencias.</p>}
          {(suggestions ?? []).map((s) => (
            <div key={`${s.item_row_id}-${s.variation_id ?? ""}`} className="flex items-center justify-between gap-3 rounded-lg bg-muted px-3 py-2">
              <div className="min-w-0">
                <p className="truncate text-sm">{s.label || s.title}</p>
                <p className="text-xs text-muted-foreground">
                  {s.ml_item_id} · por {s.by === "sku" ? "SKU" : "código de barras"}
                </p>
              </div>
              <Button size="sm" onClick={() => acceptSuggestion(s)} disabled={link.isPending}>
                Vincular
              </Button>
            </div>
          ))}
        </div>
      </Modal>
    </div>
  );
}
