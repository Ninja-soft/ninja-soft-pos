"use client";

import { useCallback, useDeferredValue, useEffect, useMemo, useRef, useState } from "react";
import { Check, Download, Eye, LayoutTemplate, ListChecks, Maximize2, Printer, RefreshCw, Ruler, Send, Tag } from "lucide-react";
import { Button } from "@/components/ui/Button";
import { Badge } from "@/components/ui/Badge";
import { Card, CardContent } from "@/components/ui/Card";
import { InfoHint } from "@/components/ui/InfoHint";
import { PageHeader } from "@/components/ui/PageHeader";
import { Segmented } from "@/components/ui/Segmented";
import { useToast } from "@/components/ui/Toast";
import { useFeature } from "@/modules/saas/gating";
import { useCategories, useBrands } from "@/modules/products/hooks";
import { useCurrentStoreId, useStores } from "@/modules/stock/hooks";
import { useWarehouses } from "@/modules/stock/warehouses";
import { useApplyDuePrices, useLabelQueue, usePriceProMutations, usePriceResolver } from "@/modules/prices/proHooks";
import { useMyTenant } from "@/modules/tenants/hooks";
import { useTenantTicketBranding } from "@/modules/tickets/hooks";
import { useMyCapabilities } from "@/modules/permissions/hooks";
import {
  useLabelCatalog,
  useLabelTemplateMutations,
  useLabelTemplates,
  useSetNetContent,
  useTenantSlug,
  type LabelCatalogParams,
  type LabelTemplate,
} from "@/modules/labels/hooks";
import { DEFAULT_DESIGN, designNeedsPro, normalizeDesign, presetByKey, type LabelDesign } from "@/lib/labels/designs";
import { copiesFor, expandCopies, MAX_LABELS, parseNetContent, toLabelItem, type LabelCatalogRow, type LabelItem, type QtyMode } from "@/lib/labels/items";
import { DEFAULT_MEDIA, labelsPerPage, mediaSummary, normalizeMedia, type MediaConfig } from "@/lib/labels/media";
import { buildLabelDocument, pageCount } from "@/lib/labels/render";
import { buildZpl, type ZplDpi } from "@/lib/labels/zpl";
import { downloadTextFile, printLabelDocument } from "@/lib/labels/print";
import { productPublicUrl } from "@/lib/labels/publicLink";
import { toEan13 } from "@/lib/barcode/ean13";
import { appOrigin } from "@/lib/site";
import { enqueueZplLabel } from "@/lib/shipping/print";
import { cn } from "@/lib/utils/cn";
import { DesignPanel } from "./DesignPanel";
import { LabelFrame, PX_PER_MM } from "./LabelFrame";
import { MediaPanel } from "./MediaPanel";
import { ProductsPanel, rowKey, type RowOverride, type Scope } from "./ProductsPanel";

type Tab = "productos" | "diseno" | "papel" | "vista";

const STORAGE_KEY = "ninja.labels.v1";
const PRO = "etiquetas_pro";

interface Saved {
  presetKey: string;
  design: LabelDesign;
  media: MediaConfig;
  dpi: ZplDpi;
}

function loadSaved(): Partial<Saved> {
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    if (!raw) return {};
    const s = JSON.parse(raw) as Partial<Saved>;
    return {
      presetKey: typeof s.presetKey === "string" ? s.presetKey : undefined,
      design: s.design ? normalizeDesign(s.design) : undefined,
      media: s.media ? normalizeMedia({ ...DEFAULT_MEDIA, ...s.media }) : undefined,
      dpi: s.dpi === 300 ? 300 : 203,
    };
  } catch {
    return {};
  }
}

function saveLocal(s: Saved) {
  try {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(s));
  } catch {
    /* sin storage: no se recuerda, no pasa nada */
  }
}

const today = () => new Date().toISOString().slice(0, 10);

export function LabelStudio() {
  const { toast } = useToast();
  const proFlag = useFeature(PRO);
  // Sin respuesta de capacidades (rol fijo viejo o error) se deja editar: el
  // servidor igual exige products.edit al guardar.
  const { data: caps } = useMyCapabilities();
  const canEditProducts = !caps || caps.capabilities.includes("products.edit");

  // ── Selección ───────────────────────────────────────────────────────────
  const currentStore = useCurrentStoreId();
  const { data: stores } = useStores();
  const [storeId, setStoreId] = useState<string | null>(null);
  const [storeTouched, setStoreTouched] = useState(false);
  useEffect(() => {
    if (!storeTouched && currentStore) setStoreId(currentStore);
  }, [currentStore, storeTouched]);
  const { data: warehouses } = useWarehouses(storeId);
  const [warehouseId, setWarehouseId] = useState<string | null>(null);
  const { data: categories } = useCategories();
  const { data: brands } = useBrands();
  const [scope, setScope] = useState<Scope>("stock");
  const [categoryIds, setCategoryIds] = useState<string[]>([]);
  const [brandIds, setBrandIds] = useState<string[]>([]);
  const [search, setSearch] = useState("");
  const deferredSearch = useDeferredValue(search);
  const [includeVariants, setIncludeVariants] = useState(true);
  const [qtyMode, setQtyMode] = useState<QtyMode>("one");
  const [fixedQty, setFixedQty] = useState(2);
  const [pickedIds, setPickedIds] = useState<string[]>([]);
  const [excluded, setExcluded] = useState<Set<string>>(new Set());
  const [overrides, setOverrides] = useState<Record<string, RowOverride>>({});

  const baseParams = {
    storeId,
    warehouseId,
    categoryIds,
    brandIds,
    includeVariants,
  };
  const selParams: LabelCatalogParams =
    scope === "pick"
      ? { ...baseParams, categoryIds: [], brandIds: [], search: "", onlyStock: false, productIds: pickedIds }
      : { ...baseParams, search: deferredSearch, onlyStock: scope === "stock", productIds: null };
  const selection = useLabelCatalog(selParams, scope !== "pick" || pickedIds.length > 0);
  const searchQ = useLabelCatalog(
    { ...baseParams, categoryIds: [], brandIds: [], search: deferredSearch, onlyStock: false, productIds: null, includeVariants: false },
    scope === "pick" && deferredSearch.trim().length >= 2,
  );
  const rows: LabelCatalogRow[] = useMemo(
    () => (scope === "pick" && pickedIds.length === 0 ? [] : (selection.data ?? [])),
    [scope, pickedIds.length, selection.data],
  );

  // ── Precios de góndola y cola de reimpresión ───────────────────────────
  useApplyDuePrices();
  const prices = usePriceResolver({ storeId, customerId: null });
  const priceOf = useCallback(
    (r: LabelCatalogRow) => prices.priceFor({ productId: r.product_id, variantId: r.variant_id, basePrice: r.price, termId: "none" }),
    [prices],
  );
  const { data: queue } = useLabelQueue(storeId);
  const { markPrinted } = usePriceProMutations();
  const queuePrev = useMemo(() => {
    const m = new Map<string, number>();
    for (const q of queue ?? []) {
      if (q.old_price != null) m.set(`${q.product_id}:${q.variant_id ?? ""}`, Number(q.old_price));
    }
    return m;
  }, [queue]);
  const queueIds = useMemo(() => [...new Set((queue ?? []).map((q) => q.product_id))], [queue]);

  // ── Diseño y papel ──────────────────────────────────────────────────────
  const [presetKey, setPresetKey] = useState("gondola");
  const [design, setDesign] = useState<LabelDesign>(DEFAULT_DESIGN);
  const [media, setMedia] = useState<MediaConfig>(DEFAULT_MEDIA);
  const [skip, setSkip] = useState(0);
  const [dpi, setDpi] = useState<ZplDpi>(203);
  const [templateId, setTemplateId] = useState<string | null>(null);
  const hydrated = useRef(false);
  useEffect(() => {
    const s = loadSaved();
    if (s.presetKey) setPresetKey(s.presetKey);
    if (s.design) setDesign(s.design);
    if (s.media) setMedia(s.media);
    if (s.dpi) setDpi(s.dpi);
    hydrated.current = true;
  }, []);
  useEffect(() => {
    if (hydrated.current) saveLocal({ presetKey, design, media, dpi });
  }, [presetKey, design, media, dpi]);

  const { data: templates } = useLabelTemplates(proFlag === true);
  const tplMut = useLabelTemplateMutations();
  const appliedDefault = useRef(false);
  const applyTemplate = useCallback((t: LabelTemplate) => {
    setTemplateId(t.id);
    setDesign(t.design);
    setMedia(t.media);
    setPresetKey(t.design.layout);
    setSkip(0);
  }, []);
  useEffect(() => {
    if (appliedDefault.current || !templates) return;
    appliedDefault.current = true;
    const def = templates.find((t) => t.is_default);
    if (def) applyTemplate(def);
  }, [templates, applyTemplate]);

  // Sin el plan, un diseño PRO guardado en este equipo vuelve al clásico.
  const effectiveDesign = useMemo(() => (proFlag === false && designNeedsPro(design) ? DEFAULT_DESIGN : design), [proFlag, design]);

  const { data: me } = useMyTenant();
  const { data: brand } = useTenantTicketBranding();
  const { data: slug } = useTenantSlug();
  const ctx = useMemo(() => ({ businessName: me?.name ?? null, logoUrl: brand?.logo_url ?? null }), [me?.name, brand?.logo_url]);
  const origin = typeof window !== "undefined" ? appOrigin() : "";

  // ── Etiquetas a imprimir ────────────────────────────────────────────────
  const copiesOf = useCallback(
    (r: LabelCatalogRow) => {
      const ov = overrides[rowKey(r)];
      return ov?.copies ?? copiesFor(qtyMode, r.stock, fixedQty);
    },
    [overrides, qtyMode, fixedQty],
  );
  const date = today();
  const toItem = useCallback(
    (r: LabelCatalogRow): LabelItem => {
      const key = rowKey(r);
      const ov = overrides[key];
      return toLabelItem(r, {
        price: priceOf(r),
        prevPrice: ov?.prevPrice ?? queuePrev.get(key) ?? null,
        qrUrl: effectiveDesign.show.qr && slug && origin ? productPublicUrl(origin, slug, r.product_id) : null,
        date,
      });
    },
    [overrides, priceOf, queuePrev, effectiveDesign.show.qr, slug, origin, date],
  );
  const { items, truncated } = useMemo(
    () => expandCopies(rows.filter((r) => !excluded.has(rowKey(r))).map((r) => ({ item: toItem(r), copies: copiesOf(r) }))),
    [rows, excluded, toItem, copiesOf],
  );

  const sample = useMemo<LabelItem>(() => {
    const first = rows[0];
    if (first) return toItem(first);
    return {
      key: "sample",
      productId: "00000000-0000-4000-8000-000000000000",
      variantId: null,
      name: "Yerba mate suave 1 kg",
      variant: null,
      brand: "La Ninja",
      price: 4590,
      prevPrice: 5390,
      unitPrice: null,
      plu: "000123",
      sku: "YER-1KG",
      barcode: toEan13("779123456789"),
      imageUrl: null,
      qrUrl: effectiveDesign.show.qr ? `${origin || "https://pos.soft.ninja"}/p/tu-negocio/AAAAAAAAAAAAAAAAAAAAAA` : null,
      date,
    };
  }, [rows, toItem, effectiveDesign.show.qr, origin, date]);

  // ── Vista previa ────────────────────────────────────────────────────────
  const previewRef = useRef<HTMLDivElement>(null);
  const [boxW, setBoxW] = useState(360);
  useEffect(() => {
    const el = previewRef.current;
    if (!el || typeof ResizeObserver === "undefined") return;
    const ro = new ResizeObserver(() => setBoxW(el.clientWidth));
    ro.observe(el);
    setBoxW(el.clientWidth);
    return () => ro.disconnect();
  }, []);
  const [zoomMode, setZoomMode] = useState<"fit" | "real">("fit");
  const fitZoom = Math.max(0.2, Math.min(4, (boxW - 28) / (media.pageW * PX_PER_MM)));
  const zoom = zoomMode === "real" ? 1 : fitZoom;
  const previewItems = items.length ? items : [sample];
  const maxPages = media.kind === "thermal" ? 8 : 2;
  const deferredItems = useDeferredValue(previewItems);
  const previewHtml = useMemo(
    () =>
      buildLabelDocument({
        items: deferredItems.slice(0, labelsPerPage(media) * maxPages + skip),
        design: effectiveDesign,
        media,
        skip,
        ctx,
        mode: "preview",
        zoom,
        maxPages,
      }),
    [deferredItems, effectiveDesign, media, skip, ctx, zoom, maxPages],
  );
  const pages = pageCount(items.length, media, skip);

  // ── Acciones ────────────────────────────────────────────────────────────
  const [printing, setPrinting] = useState(false);
  const print = async () => {
    if (!items.length) return;
    setPrinting(true);
    try {
      await printLabelDocument(
        buildLabelDocument({ items, design: effectiveDesign, media, skip, ctx, mode: "print", title: `Etiquetas · ${items.length}` }),
      );
    } catch {
      toast({ title: "No se pudo abrir la impresión", description: "Probá de nuevo o desde otro navegador.", variant: "error" });
    } finally {
      setPrinting(false);
    }
  };
  const zpl = () => buildZpl(items, effectiveDesign, media, dpi);
  const downloadZpl = () => downloadTextFile(zpl(), `etiquetas-${date}.zpl`);
  const sendZpl = () => {
    const pending = enqueueZplLabel(zpl(), `Etiquetas (${items.length})`, "label");
    toast({ title: "Mandadas a la cola de impresión", description: `${pending} trabajos pendientes en este equipo.`, variant: "success" });
  };

  const addQueued = () => {
    if (!queueIds.length) return;
    setScope("pick");
    setPickedIds((ids) => [...new Set([...ids, ...queueIds])]);
    setTab("productos");
  };
  const markQueued = () => {
    const ids = (queue ?? []).map((q) => q.id);
    if (!ids.length) return;
    markPrinted.mutate(ids, {
      onSuccess: (n) => toast({ title: `${n} etiquetas marcadas como impresas`, variant: "success" }),
      onError: () => toast({ title: "No se pudo marcar", variant: "error" }),
    });
  };

  const setNet = useSetNetContent();
  const saveContent = (productId: string, text: string) => {
    const t = text.trim();
    const parsed = t ? parseNetContent(t) : null;
    if (t && !parsed) {
      toast({ title: "No entendimos el contenido", description: "Escribilo como 900 ml, 1 kg o 500 g.", variant: "warning" });
      return;
    }
    setNet.mutate(
      { productId, qty: parsed?.qty ?? null, unit: parsed?.unit ?? null },
      {
        onSuccess: () => toast({ title: "Contenido guardado", variant: "success" }),
        onError: () => toast({ title: "No se pudo guardar el contenido", variant: "error" }),
      },
    );
  };

  const saveTemplate = (name: string, asDefault: boolean, id: string | null) => {
    tplMut.save.mutate(
      { id: id ?? undefined, name, design: effectiveDesign, media, is_default: asDefault },
      {
        onSuccess: (newId) => {
          setTemplateId(newId);
          toast({ title: "Plantilla guardada", variant: "success" });
        },
        onError: () => toast({ title: "No se pudo guardar la plantilla", description: "Revisá tu plan y tus permisos.", variant: "error" }),
      },
    );
  };
  const deleteTemplate = (id: string) => {
    tplMut.remove.mutate(id, {
      onSuccess: () => {
        setTemplateId(null);
        toast({ title: "Plantilla eliminada", variant: "success" });
      },
      onError: () => toast({ title: "No se pudo eliminar", variant: "error" }),
    });
  };

  const [tab, setTab] = useState<Tab>("productos");
  const overLimit = truncated;

  const preview = (
    <Card className="overflow-hidden">
      <CardContent className="space-y-3 p-3 sm:p-4">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <div className="min-w-0">
            <div className="text-sm font-semibold">Vista previa</div>
            <div className="truncate text-xs text-muted-foreground">{mediaSummary(media)}</div>
          </div>
          <Segmented<"fit" | "real">
            aria-label="Zoom"
            size="sm"
            value={zoomMode}
            onChange={setZoomMode}
            options={[
              { value: "fit", label: "Ajustar", icon: <Maximize2 size={14} /> },
              { value: "real", label: "Tamaño real", icon: <Ruler size={14} /> },
            ]}
          />
        </div>
        <div ref={previewRef} className="slim-scrollbar max-h-[70vh] overflow-auto rounded-lg bg-muted/60">
          <LabelFrame html={previewHtml} title="Vista previa de etiquetas" minHeight={120} />
        </div>
        <div className="flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
          {items.length === 0 ? (
            <span>Ejemplo con datos de muestra. Elegí productos para ver los tuyos.</span>
          ) : (
            <>
              <Badge tone="neutral">{items.length} etiquetas</Badge>
              <Badge tone="neutral">
                {pages} {media.kind === "thermal" ? (pages === 1 ? "fila de rollo" : "filas de rollo") : pages === 1 ? "hoja" : "hojas"}
              </Badge>
              {pages > maxPages && <span>Se muestran las primeras {maxPages}.</span>}
            </>
          )}
        </div>
        {overLimit && (
          <p className="text-xs text-warning">Se imprimen las primeras {MAX_LABELS} etiquetas. Partí la impresión con filtros.</p>
        )}
        <div className="flex flex-wrap gap-2">
          <Button onClick={print} disabled={!items.length} loading={printing} className="flex-1">
            <Printer size={16} /> Imprimir {items.length > 0 ? `(${items.length})` : ""}
          </Button>
          {media.kind === "thermal" && (
            <>
              <Button variant="secondary" onClick={downloadZpl} disabled={!items.length} title="Archivo ZPL para Zebra">
                <Download size={16} /> ZPL
              </Button>
              <Button variant="secondary" onClick={sendZpl} disabled={!items.length} title="Mandar a la cola de impresión de este equipo">
                <Send size={16} /> <span className="sr-only sm:not-sr-only">A la cola</span>
              </Button>
            </>
          )}
        </div>
      </CardContent>
    </Card>
  );

  return (
    <div className="mx-auto w-full max-w-7xl px-4 pb-[calc(2.5rem+env(safe-area-inset-bottom))] pt-6 sm:px-6 sm:pt-8">
      <PageHeader
        eyebrow="Catálogo"
        title="Etiquetas"
        icon={Tag}
        help={<InfoHint section="etiquetas" size={18} />}
        description="Elegí qué etiquetar (con stock, por sucursal, depósito, categoría o marca), el diseño y el papel. Lo que ves en la vista previa es lo que sale."
        actions={
          <Button onClick={print} disabled={!items.length} loading={printing}>
            <Printer size={16} /> Imprimir ({items.length})
          </Button>
        }
      />

      {(queue ?? []).length > 0 && (
        <Card className="mt-5">
          <CardContent className="flex flex-wrap items-center justify-between gap-3 p-4">
            <div className="min-w-0">
              <div className="flex items-center gap-2 text-sm font-semibold">
                <RefreshCw size={16} /> Etiquetas a reimprimir ({queueIds.length})
              </div>
              <p className="text-xs text-muted-foreground">Productos que cambiaron de precio en esta sucursal desde la última impresión.</p>
            </div>
            <div className="flex gap-2">
              <Button size="sm" variant="secondary" onClick={addQueued}>
                Agregar a la impresión
              </Button>
              <Button size="sm" variant="secondary" onClick={markQueued} loading={markPrinted.isPending}>
                <Check size={15} /> Marcar impresas
              </Button>
            </div>
          </CardContent>
        </Card>
      )}

      <div className="mt-5 lg:hidden">
        <Segmented<Tab>
          aria-label="Pasos"
          value={tab}
          onChange={setTab}
          scrollOnMobile
          options={[
            { value: "productos", label: "Productos" },
            { value: "diseno", label: "Diseño" },
            { value: "papel", label: "Papel" },
            { value: "vista", label: "Ver", icon: <Eye size={15} /> },
          ]}
        />
      </div>

      <div className="mt-5 grid gap-5 lg:grid-cols-[minmax(0,1fr)_minmax(340px,440px)]">
        <div className="min-w-0 space-y-5">
          <div className="hidden lg:block">
            <Segmented<Tab>
              aria-label="Pasos"
              value={tab === "vista" ? "productos" : tab}
              onChange={setTab}
              options={[
                { value: "productos", label: "1 · Productos", icon: <ListChecks size={15} /> },
                { value: "diseno", label: "2 · Diseño", icon: <LayoutTemplate size={15} /> },
                { value: "papel", label: "3 · Papel", icon: <Ruler size={15} /> },
              ]}
            />
          </div>
          <Card className={cn(tab === "vista" && "hidden lg:block")}>
            <CardContent className="p-4 sm:p-5">
              {(tab === "productos" || tab === "vista") && (
                <ProductsPanel
                  scope={scope}
                  onScope={(s) => {
                    setScope(s);
                    setExcluded(new Set());
                  }}
                  stores={stores ?? []}
                  storeId={storeId}
                  onStore={(id) => {
                    setStoreTouched(true);
                    setStoreId(id);
                    setWarehouseId(null);
                  }}
                  warehouses={(warehouses ?? []).map((w) => ({ id: w.id, name: w.name, kind: w.kind }))}
                  warehouseId={warehouseId}
                  onWarehouse={setWarehouseId}
                  categories={categories ?? []}
                  categoryIds={categoryIds}
                  onCategories={setCategoryIds}
                  brands={(brands ?? []).map((b) => ({ id: b.id, name: b.name }))}
                  brandIds={brandIds}
                  onBrands={setBrandIds}
                  search={search}
                  onSearch={setSearch}
                  includeVariants={includeVariants}
                  onIncludeVariants={setIncludeVariants}
                  qtyMode={qtyMode}
                  onQtyMode={setQtyMode}
                  fixedQty={fixedQty}
                  onFixedQty={setFixedQty}
                  rows={rows}
                  loading={selection.isLoading || selection.isFetching}
                  error={selection.isError}
                  searchResults={searchQ.data ?? []}
                  searchLoading={searchQ.isFetching}
                  pickedIds={pickedIds}
                  onPick={(id) => setPickedIds((ids) => (ids.includes(id) ? ids : [...ids, id]))}
                  onUnpick={(id) => setPickedIds((ids) => ids.filter((x) => x !== id))}
                  excluded={excluded}
                  onToggleRow={(key) =>
                    setExcluded((s) => {
                      const n = new Set(s);
                      if (n.has(key)) n.delete(key);
                      else n.add(key);
                      return n;
                    })
                  }
                  onToggleAll={(on) => setExcluded(on ? new Set() : new Set(rows.map(rowKey)))}
                  overrides={overrides}
                  onOverride={(key, o) => setOverrides((s) => ({ ...s, [key]: o }))}
                  copiesOf={copiesOf}
                  priceOf={priceOf}
                  showPrev={effectiveDesign.show.prevPrice}
                  showContent={effectiveDesign.show.unitPrice}
                  onSaveContent={saveContent}
                  canEditProducts={canEditProducts}
                />
              )}
              {tab === "diseno" && (
                <DesignPanel
                  design={effectiveDesign}
                  presetKey={presetKey}
                  onPreset={(k) => {
                    const p = presetByKey(k);
                    if (!p) return;
                    setPresetKey(k);
                    setDesign(p.design);
                    setTemplateId(null);
                  }}
                  onDesign={(d) => setDesign(d)}
                  pro={proFlag !== false}
                  sample={sample}
                  media={media}
                  ctx={ctx}
                  templates={templates ?? []}
                  templateId={templateId}
                  onApplyTemplate={applyTemplate}
                  onSaveTemplate={saveTemplate}
                  onDeleteTemplate={deleteTemplate}
                  saving={tplMut.save.isPending}
                  canEdit={canEditProducts}
                  slugMissing={!slug}
                />
              )}
              {tab === "papel" && <MediaPanel media={media} onMedia={setMedia} skip={skip} onSkip={setSkip} dpi={dpi} onDpi={setDpi} />}
            </CardContent>
          </Card>
          {items.length > 0 && tab !== "vista" && (
            <p className="text-xs text-muted-foreground lg:hidden">{items.length} etiquetas listas. Mirá cómo quedan en Ver.</p>
          )}
        </div>
        <div className={cn("min-w-0 lg:sticky lg:top-4 lg:self-start", tab !== "vista" && "hidden lg:block")}>{preview}</div>
      </div>
    </div>
  );
}
