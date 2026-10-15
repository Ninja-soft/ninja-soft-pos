"use client";

import { useQueryClient } from "@tanstack/react-query";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Package, ScanBarcode, Search, Sparkles, Truck } from "lucide-react";
import { Modal } from "@/components/ui/Modal";
import { Badge } from "@/components/ui/Badge";
import { Button } from "@/components/ui/Button";
import { Checkbox } from "@/components/ui/Checkbox";
import { Input } from "@/components/ui/Input";
import { Switch } from "@/components/ui/Switch";
import { SpinnerBlock } from "@/components/ui/Spinner";
import { Callout } from "@/components/ui/Callout";
import { useToast } from "@/components/ui/Toast";
import { cn } from "@/lib/utils/cn";
import { formatCurrency } from "@/lib/utils/format";
import { LISTING_TYPE_LABELS, mlErrorMessage, visibleWarnings } from "@/lib/mercadolibre/labels";
import {
  buildQuickInput,
  isValidGtin,
  localRowState,
  missingRequired,
  prefillAttributes,
  quickTitle,
  type AttrSource,
  type AttrValues,
  type ExternalAttr,
  type QuickRow,
  type QuickRowState,
} from "@/supabase/functions/_shared/mercadolibre/quick";
import {
  mlApi,
  mlPublishApi,
  refreshMlSoon,
  useMlAccountShipping,
  useMlCategoryMemory,
  useMlQuickCandidates,
  type AttrField,
  type MlAccount,
  type MlCategoryInfo,
  type MlChannelPreview,
  type MlDomainSuggestion,
  type MlPublishResult,
  type MlQuickCandidate,
} from "@/modules/mercadolibre/hooks";
import { MlPublishModal } from "@/components/mercadolibre/MlPublishModal";
import { MlMeActivationHint } from "@/components/mercadolibre/MlPublishFeedback";
import { MlQuickRow } from "./MlQuickRow";

// Publicación rápida en lote (H141 · ADR-132). Elegís productos (búsqueda,
// escáner, sólo sin publicar), el sistema sugiere la categoría por título y
// GTIN (catálogo de ML), precompleta todo desde la ficha y lo recordado por
// categoría, aplica las reglas de precio por tipo y muestra sólo los
// obligatorios que faltan, en una fila por producto. Valida contra ML y
// publica con progreso y resultado por fila.

const MAX = 50;
const PARALLEL = 3;

const EMPTY_GTIN_FALLBACK = [
  { id: "17055160", name: "El producto no tiene código registrado" },
  { id: "17055158", name: "Es un kit o pack armado por mí" },
  { id: "17055159", name: "Es artesanal o hecho a medida" },
];

interface Row extends QuickRow {
  productId: string;
  preview: MlChannelPreview | null;
  suggestions: MlDomainSuggestion[];
  categoryName: string;
  fields: AttrField[] | null;
  sources: Record<string, AttrSource>;
  types: string[];
  catalogName: string | null;
  catalogId: string | null;
  catalogAttrs: ExternalAttr[];
  state: QuickRowState;
  errors: string[];
  /** Avisos de ML (no frenan) y ajustes automáticos del servidor. */
  warnings: string[];
  notices: string[];
  attrNames: Record<string, string>;
  published: Array<{ ml_item_id: string; permalink: string | null; listing_type_id?: string }>;
  skip: "variants" | "kit" | "failed" | null;
}

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/** Reintenta una vez si Mercado Libre pidió bajar el ritmo. */
async function withRetry<T>(fn: () => Promise<T>): Promise<T> {
  try {
    return await fn();
  } catch (e) {
    if (/rate_limited|429/.test(String(e instanceof Error ? e.message : e))) {
      await sleep(4000);
      return fn();
    }
    throw e;
  }
}

async function pool<T>(items: T[], n: number, fn: (t: T) => Promise<void>) {
  const queue = [...items];
  await Promise.all(
    Array.from({ length: Math.min(n, queue.length) }, async () => {
      while (queue.length) await fn(queue.shift()!);
    }),
  );
}

export function MlQuickPublish({ open, onOpenChange, account }: { open: boolean; onOpenChange: (o: boolean) => void; account: MlAccount }) {
  const { toast } = useToast();
  const [step, setStep] = useState<"select" | "grid">("select");
  const [search, setSearch] = useState("");
  const [debounced, setDebounced] = useState("");
  const [onlyUnpublished, setOnlyUnpublished] = useState(true);
  const [scan, setScan] = useState("");
  const [selected, setSelected] = useState<Map<string, MlQuickCandidate>>(new Map());
  const [rows, setRows] = useState<Row[]>([]);
  const [busy, setBusy] = useState<"prepare" | "validate" | "publish" | null>(null);
  const [full, setFull] = useState<string | null>(null);
  const catCache = useRef(new Map<string, Promise<MlCategoryInfo>>());
  const { data: memory = [] } = useMlCategoryMemory(open ? account.id : null);
  // Estado real de Mercado Envíos de la cuenta (users/me): sin ME, lo de
  // catálogo sale como publicación propia con envío a convenir.
  const { data: shipping } = useMlAccountShipping(open ? account.id : null);
  const noMe = Boolean(shipping?.read && !shipping.me2_usable);
  const { data: candidates = [], isFetching } = useMlQuickCandidates(open && step === "select" ? account.id : null, debounced, null, onlyUnpublished);

  useEffect(() => {
    const t = setTimeout(() => setDebounced(search.trim()), 300);
    return () => clearTimeout(t);
  }, [search]);
  useEffect(() => {
    if (!open) {
      setStep("select");
      setSelected(new Map());
      setRows([]);
      setSearch("");
      setScan("");
      setBusy(null);
    }
  }, [open]);

  const category = useCallback((id: string) => {
    let p = catCache.current.get(id);
    if (!p) {
      p = withRetry(() => mlPublishApi.category(id));
      catCache.current.set(id, p);
      p.catch(() => catCache.current.delete(id));
    }
    return p;
  }, []);

  const patch = (productId: string, p: Partial<Row> | ((r: Row) => Partial<Row>)) =>
    setRows((rs) => rs.map((r) => (r.productId === productId ? { ...r, ...(typeof p === "function" ? p(r) : p) } : r)));

  const toggle = (c: MlQuickCandidate) =>
    setSelected((s) => {
      const n = new Map(s);
      if (n.has(c.product_id)) n.delete(c.product_id);
      else if (n.size < MAX) n.set(c.product_id, c);
      return n;
    });

  const addByScan = async () => {
    const code = scan.trim();
    if (!code) return;
    setScan("");
    try {
      const list = await mlApi.quickCandidates(account.id, code, null, false);
      const hit = list.find((c) => c.barcode === code || c.sku === code) ?? (list.length === 1 ? list[0] : null);
      if (!hit) {
        toast({ title: "No hay un producto con ese código", description: code, variant: "error" });
        return;
      }
      setSelected((s) => (s.size >= MAX ? s : new Map(s).set(hit.product_id, hit)));
      toast({ title: `${hit.name} agregado`, variant: "success" });
    } catch (e) {
      toast({ title: "No se pudo buscar", description: mlErrorMessage(e), variant: "error" });
    }
  };

  // ---------------------------------------------------------------------------
  // Preparar: vista previa del servidor + sugerencias + precompletado.
  // ---------------------------------------------------------------------------
  const applyCategory = async (productId: string, categoryId: string, categoryName: string, base?: { domainAttrs?: Array<{ id: string; value_id?: string | null; value_name?: string | null }> }) => {
    patch(productId, { state: "loading", categoryId, categoryName, fields: null, errors: [] });
    try {
      const info = await category(categoryId);
      setRows((rs) =>
        rs.map((r) => {
          if (r.productId !== productId) return r;
          const mem = memory.find((m) => m.category_id === categoryId)?.attrs ?? null;
          const userValues = Object.fromEntries(Object.entries(r.attrs).filter(([id]) => r.sources[id] === "user"));
          const { values, sources } = prefillAttributes({
            fields: info.attributes,
            product: { brand: r.preview?.brand ?? null, model: r.preview?.model ?? null },
            catalogAttrs: r.catalogAttrs,
            domainAttrs: base?.domainAttrs ?? r.suggestions.find((s) => s.category_id === categoryId)?.attributes ?? [],
            memory: mem,
            current: userValues,
          });
          const next: Row = {
            ...r,
            categoryId,
            categoryName: info.category.name || categoryName,
            fields: info.attributes,
            maxTitleLength: info.category.max_title_length ?? 60,
            title: quickTitle(r.title, null, info.category.max_title_length ?? 60),
            attrs: values,
            sources,
          };
          return { ...next, ...localRowState(previewProduct(next), next, info.attributes) };
        }),
      );
    } catch (e) {
      patch(productId, { state: "error", errors: [mlErrorMessage(e)] });
    }
  };

  const prepareOne = async (c: MlQuickCandidate) => {
    try {
      const pv = await mlApi.preview(account.id, c.product_id);
      const gtin = pv.barcode && isValidGtin(pv.barcode) ? pv.barcode : null;
      const types = (pv.listing_prices ?? [])
        .filter((l) => l.rule?.enabled && l.rule.default_on && typeof l.price === "number" && l.price > 0)
        .map((l) => l.listing_type_id);
      const defaultTypes = types.length ? types : [pv.listing_type || account.default_listing_type];
      patch(c.product_id, {
        preview: pv,
        title: quickTitle(pv.name, pv.brand, 60),
        gtin,
        types: defaultTypes,
      });
      if (pv.is_kit || (pv.has_variants && pv.variants.length > 0)) {
        patch(c.product_id, { state: "error", skip: pv.is_kit ? "kit" : "variants", errors: [] });
        return;
      }
      const sug = await withRetry(() => mlPublishApi.quickSuggest(quickTitle(pv.name, pv.brand, 120), gtin));
      const suggestions = sug.suggestions ?? [];
      patch(c.product_id, {
        suggestions,
        catalogName: sug.catalog?.name ?? null,
        catalogId: sug.catalog?.catalog_product_id ?? null,
        catalogAttrs: sug.catalog?.attributes ?? [],
      });
      const first = suggestions[0] ?? (memory[0] ? { category_id: memory[0].category_id, category_name: memory[0].category_name, attributes: [] } : null);
      if (!first) {
        patch(c.product_id, { state: "needs_input", errors: ["No encontramos una categoría: elegila."] });
        return;
      }
      await applyCategory(c.product_id, first.category_id, first.category_name, { domainAttrs: first.attributes ?? [] });
    } catch (e) {
      patch(c.product_id, { state: "error", skip: "failed", errors: [mlErrorMessage(e)] });
    }
  };

  const prepare = async () => {
    const list = [...selected.values()];
    setRows(
      list.map((c) => ({
        productId: c.product_id,
        preview: null,
        suggestions: [],
        categoryId: "",
        categoryName: "",
        fields: null,
        sources: {},
        types: [],
        catalogName: null,
        catalogId: null,
        catalogAttrs: [],
        warnings: [],
        notices: [],
        attrNames: {},
        title: c.name,
        maxTitleLength: 60,
        attrs: {},
        condition: "new",
        gtin: c.barcode,
        emptyGtinReason: null,
        freeShipping: false,
        state: "loading",
        errors: [],
        published: [],
        skip: null,
      })),
    );
    setStep("grid");
    setBusy("prepare");
    await pool(list, PARALLEL, prepareOne);
    setBusy(null);
  };

  // ---------------------------------------------------------------------------
  // Validar y publicar.
  // ---------------------------------------------------------------------------
  const inputOf = (r: Row) => {
    const pv = r.preview!;
    const firstType = r.types[0] ?? account.default_listing_type;
    const price = pv.listing_prices?.find((l) => l.listing_type_id === firstType)?.price ?? pv.price ?? 0;
    return {
      ...buildQuickInput(previewProduct(r), r, firstType, Number(price), account.user_product_seller ? "user_products" : "classic"),
      catalogProductId: r.catalogId,
    };
  };

  /** Lo que devolvió el servidor además del ok: ajustes, avisos y título final. */
  const feedback = (res: MlPublishResult): Partial<Row> => ({
    notices: res.notices ?? [],
    warnings: visibleWarnings(res.warnings, res.applied_shipping?.mode),
    attrNames: res.attribute_names ?? {},
    ...(res.applied_title ? { title: res.applied_title } : {}),
  });

  const eligible = (r: Row, states: QuickRowState[]) => !r.skip && r.preview && r.fields && states.includes(r.state) && r.types.length > 0;

  const validateRow = async (r: Row): Promise<boolean> => {
    patch(r.productId, { state: "validating", errors: [], warnings: [], notices: [] });
    try {
      const res = await withRetry(() => mlPublishApi.validate(account.id, inputOf(r)));
      if (res.ok) {
        patch(r.productId, { state: "valid", errors: [], ...feedback(res) });
        return true;
      }
      patch(r.productId, { state: "error", errors: res.errors ?? ["Mercado Libre rechazó los datos."], ...feedback(res) });
    } catch (e) {
      patch(r.productId, { state: "error", errors: [mlErrorMessage(e)] });
    }
    return false;
  };

  const publishRow = async (r: Row) => {
    patch(r.productId, { state: "publishing", errors: [] });
    try {
      const res = await mlPublishApi.publish(account.id, r.productId, inputOf(r), { listingTypes: r.types, categoryName: r.categoryName });
      const failed = (res.failed ?? []).flatMap((f) => f.errors.map((e) => `${LISTING_TYPE_LABELS[f.listing_type_id] ?? f.listing_type_id}: ${e}`));
      const skipped = (res.skipped ?? []).map(
        (s) =>
          `${LISTING_TYPE_LABELS[s.listing_type_id] ?? s.listing_type_id}: ${s.reason === "unavailable" ? "no está disponible para tu cuenta en esta categoría" : "sin precio o marcado para no publicar"}`,
      );
      if (res.ok) {
        patch(r.productId, {
          state: failed.length || skipped.length ? "partial" : "published",
          published: res.items ?? [],
          errors: [...failed, ...skipped],
          ...feedback(res),
        });
      } else {
        patch(r.productId, { state: "error", errors: res.errors ?? ["No se pudo publicar."], ...feedback(res) });
      }
    } catch (e) {
      patch(r.productId, { state: "error", errors: [mlErrorMessage(e)] });
    }
  };

  const qc = useQueryClient();
  const runAll = async (publish: boolean) => {
    const targets = rows.filter((r) => eligible(r, ["ready", "valid", "error"]) && localRowState(previewProduct(r), r, r.fields).state === "ready");
    if (targets.length === 0) return;
    setBusy(publish ? "publish" : "validate");
    await pool(targets, 2, async (r) => {
      const ok = r.state === "valid" ? true : await validateRow(r);
      if (ok && publish) await publishRow(r);
    });
    setBusy(null);
    if (publish) refreshMlSoon(qc);
  };

  const counts = useMemo(() => {
    const c = { ready: 0, published: 0, pending: 0 };
    for (const r of rows) {
      if (r.state === "published" || r.state === "partial") c.published++;
      else if (!r.skip && r.fields && localRowState(previewProduct(r), r, r.fields).state === "ready") c.ready++;
      else if (!r.skip) c.pending++;
    }
    return c;
  }, [rows]);

  const memoryOptions = memory.slice(0, 8);

  return (
    <>
      <Modal
        open={open}
        onOpenChange={(o) => (busy && busy !== "prepare" ? undefined : onOpenChange(o))}
        title="Publicación rápida"
        description={
          step === "select"
            ? "Elegí los productos. Después completás sólo lo que pide Mercado Libre y los publicás juntos."
            : "Revisá cada fila: categoría, tipos de publicación y lo que falta. Validamos con Mercado Libre antes de publicar."
        }
        className="sm:max-w-6xl"
        footer={
          step === "select" ? (
            <div className="flex flex-wrap items-center justify-between gap-2">
              <span className="text-sm text-muted-foreground">
                {selected.size} de {MAX} elegidos
              </span>
              <div className="flex gap-2">
                <Button variant="secondary" onClick={() => onOpenChange(false)}>
                  Cancelar
                </Button>
                <Button onClick={prepare} disabled={selected.size === 0}>
                  <Sparkles size={15} /> Preparar {selected.size > 0 ? `(${selected.size})` : ""}
                </Button>
              </div>
            </div>
          ) : (
            <div className="flex flex-wrap items-center justify-between gap-2">
              <span className="text-sm text-muted-foreground" aria-live="polite">
                {busy === "prepare" ? "Preparando sugerencias…" : `${counts.published} publicadas · ${counts.ready} listas · ${counts.pending} por completar`}
              </span>
              <div className="flex flex-wrap gap-2">
                <Button variant="ghost" onClick={() => setStep("select")} disabled={busy !== null}>
                  Volver
                </Button>
                <Button variant="secondary" onClick={() => runAll(false)} disabled={busy !== null || counts.ready === 0} loading={busy === "validate"}>
                  Sólo validar
                </Button>
                <Button onClick={() => runAll(true)} disabled={busy !== null || counts.ready === 0} loading={busy === "publish"}>
                  Validar y publicar ({counts.ready})
                </Button>
              </div>
            </div>
          )
        }
      >
        {step === "select" ? (
          <div className="space-y-3">
            <div className="grid gap-2 sm:grid-cols-[1fr_16rem]">
              <div className="relative">
                <Search size={16} className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-muted-foreground" />
                <Input className="pl-9" placeholder="Buscar por nombre, SKU o código" value={search} onChange={(e) => setSearch(e.target.value)} aria-label="Buscar productos" />
              </div>
              <form
                className="relative"
                onSubmit={(e) => {
                  e.preventDefault();
                  void addByScan();
                }}
              >
                <ScanBarcode size={16} className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-muted-foreground" />
                <Input className="pl-9" placeholder="Escaneá un código" value={scan} onChange={(e) => setScan(e.target.value)} aria-label="Escanear código de barras" inputMode="numeric" />
              </form>
            </div>
            <label className="flex items-center gap-2 text-sm">
              <Switch checked={onlyUnpublished} onCheckedChange={setOnlyUnpublished} label="Sólo sin publicar" />
              Sólo productos sin publicar en esta cuenta
            </label>
            {isFetching && candidates.length === 0 ? (
              <SpinnerBlock className="py-10" />
            ) : candidates.length === 0 ? (
              <p className="py-8 text-center text-sm text-muted-foreground">No hay productos con esa búsqueda.</p>
            ) : (
              <ul className="divide-y divide-border rounded-lg bg-card">
                {candidates.map((c) => {
                  const on = selected.has(c.product_id);
                  const blocked = c.is_kit;
                  return (
                    <li key={c.product_id}>
                      <label className={cn("flex items-center gap-3 px-3 py-2", blocked ? "opacity-60" : "cursor-pointer hover:bg-muted/60")}>
                        <Checkbox checked={on} disabled={blocked || (!on && selected.size >= MAX)} onCheckedChange={() => toggle(c)} aria-label={`Elegir ${c.name}`} />
                        {c.image_url ? (
                          // eslint-disable-next-line @next/next/no-img-element
                          <img src={c.image_url} alt="" className="h-10 w-10 shrink-0 rounded-md object-cover" loading="lazy" />
                        ) : (
                          <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-md bg-muted text-muted-foreground">
                            <Package size={16} />
                          </span>
                        )}
                        <span className="min-w-0 flex-1">
                          <span className="block truncate text-sm font-medium">{c.name}</span>
                          <span className="block truncate text-xs text-muted-foreground">
                            {[c.brand, c.barcode ?? c.sku, c.category_name].filter(Boolean).join(" · ")}
                          </span>
                        </span>
                        <span className="flex shrink-0 flex-wrap items-center justify-end gap-1">
                          {c.pictures === 0 && <Badge tone="warning">Sin foto</Badge>}
                          {c.has_variants && <Badge tone="neutral">Variantes</Badge>}
                          {c.is_kit && <Badge tone="neutral">Combo</Badge>}
                          {c.published_count > 0 && <Badge tone="success">Publicado</Badge>}
                          <span className="text-sm tabular-nums">{c.price != null ? formatCurrency(Number(c.price)) : ""}</span>
                        </span>
                      </label>
                    </li>
                  );
                })}
              </ul>
            )}
          </div>
        ) : (
          <div className="space-y-3">
            {noMe && shipping && (
              <Callout tone="neutral" icon={Truck} title="Tu cuenta no tiene Mercado Envíos activo">
                <span className="block">
                  Se publica con envío a convenir y lo que está en el catálogo de Mercado Libre sale como publicación propia: no hace falta hacer nada para publicar.
                </span>
                <MlMeActivationHint url={shipping.settings_url} path={shipping.settings_path} compact />
              </Callout>
            )}
            {rows.map((r) => {
              const fields = r.fields ?? [];
              const missing = r.fields ? missingRequired(fields, r.attrs) : [];
              const prefilled = Object.values(r.sources).filter((s) => s !== "user").length;
              const emptyGtinOptions = fields.find((f) => f.id === "EMPTY_GTIN_REASON")?.options ?? [];
              const pv = r.preview;
              const done = r.state === "published" || r.state === "partial";
              const catOptions = [
                ...r.suggestions.map((s) => ({ id: s.category_id, name: `${s.category_name} (${s.domain_name})`, attrs: s.attributes ?? [] })),
                ...memoryOptions
                  .filter((m) => !r.suggestions.some((s) => s.category_id === m.category_id))
                  .map((m) => ({ id: m.category_id, name: `${m.category_name || m.category_id} (usada antes)`, attrs: [] })),
              ];
              if (r.categoryId && !catOptions.some((o) => o.id === r.categoryId)) catOptions.unshift({ id: r.categoryId, name: r.categoryName || r.categoryId, attrs: [] });
              const meta = [
                pv ? `${pv.pictures.length} ${pv.pictures.length === 1 ? "foto" : "fotos"}` : null,
                pv?.qty != null ? `${pv.qty} para publicar` : null,
                prefilled > 0 ? `${prefilled} datos precompletados` : null,
                pv?.sku ? `SKU ${pv.sku}` : null,
              ]
                .filter(Boolean)
                .join(" · ");
              const local = r.fields ? localRowState(previewProduct(r), r, r.fields) : { state: r.state, problems: [] as string[] };
              const setLocal = (fn: (x: Row) => Partial<Row>) =>
                patch(r.productId, (x) => {
                  const next = { ...x, ...fn(x) };
                  return { ...fn(x), ...(x.state === "published" || x.state === "partial" ? {} : localRowState(previewProduct(next), next, x.fields)), errors: [], warnings: [], notices: [] };
                });
              return (
                <MlQuickRow
                  key={r.productId}
                  productId={r.productId}
                  name={pv?.name ?? r.title}
                  picture={pv?.pictures[0] ?? null}
                  meta={meta || "Preparando…"}
                  state={r.state}
                  catalogName={r.catalogName}
                  ownListingNote={noMe && r.catalogId ? "Se publica como publicación propia porque tu cuenta no tiene Mercado Envíos activo." : null}
                  skip={r.skip}
                  done={done}
                  locked={busy === "publish"}
                  title={r.title}
                  maxTitleLength={r.maxTitleLength}
                  categoryId={r.categoryId}
                  catOptions={catOptions}
                  gtin={r.gtin ?? ""}
                  emptyGtinReason={r.emptyGtinReason}
                  emptyGtinOptions={emptyGtinOptions.length ? emptyGtinOptions : EMPTY_GTIN_FALLBACK}
                  condition={r.condition}
                  listingPrices={(pv?.listing_prices ?? [])
                    .filter((l) => l.rule?.enabled !== false)
                    .map((l) => ({ id: l.listing_type_id, price: typeof l.price === "number" ? l.price : null, skip: l.override?.mode === "skip" }))}
                  types={r.types}
                  missing={missing}
                  attrs={r.attrs}
                  sources={r.sources}
                  published={r.published}
                  errors={r.errors}
                  warnings={r.warnings}
                  notices={r.notices}
                  attrNames={r.attrNames}
                  problems={local.problems}
                  onTitle={(title) => setLocal(() => ({ title }))}
                  onCategory={(id) => {
                    const opt = catOptions.find((o) => o.id === id);
                    if (opt) void applyCategory(r.productId, opt.id, opt.name, { domainAttrs: opt.attrs });
                  }}
                  onGtin={(gtin) => setLocal(() => ({ gtin }))}
                  onEmptyGtin={(emptyGtinReason) => setLocal(() => ({ emptyGtinReason }))}
                  onCondition={(condition) => setLocal(() => ({ condition }))}
                  onToggleType={(id, on) =>
                    patch(r.productId, (x) => ({ types: on ? [...new Set([...x.types, id])] : x.types.filter((t) => t !== id) }))
                  }
                  onAttr={(id, v) =>
                    setLocal((x) => ({ attrs: { ...x.attrs, [id]: v }, sources: { ...x.sources, [id]: "user" as AttrSource } }))
                  }
                  onFull={() => setFull(r.productId)}
                />
              );
            })}
          </div>
        )}
      </Modal>
      {full && (
        <MlPublishModal
          open={full !== null}
          onOpenChange={(o) => {
            if (!o) setFull(null);
          }}
          productId={full}
          accounts={[account]}
        />
      )}
    </>
  );
}

function previewProduct(r: Pick<Row, "productId" | "preview">) {
  const pv = r.preview;
  return {
    product_id: r.productId,
    name: pv?.name ?? "",
    description: pv?.description ?? null,
    sku: pv?.sku ?? null,
    barcode: pv?.barcode ?? null,
    pictures: pv?.pictures ?? [],
    qty: pv?.qty ?? null,
    warranty_months: pv?.warranty_months ?? null,
  };
}
