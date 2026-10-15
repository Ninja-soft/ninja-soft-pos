"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { AlertTriangle, CheckCircle2, ExternalLink, Layers, Package, ScanBarcode, Search, Sparkles } from "lucide-react";
import { Modal } from "@/components/ui/Modal";
import { Badge } from "@/components/ui/Badge";
import { Button } from "@/components/ui/Button";
import { Checkbox } from "@/components/ui/Checkbox";
import { Input } from "@/components/ui/Input";
import { Switch } from "@/components/ui/Switch";
import { Spinner, SpinnerBlock } from "@/components/ui/Spinner";
import { useToast } from "@/components/ui/Toast";
import { selectCls } from "@/components/stock/transfers/shared";
import { cn } from "@/lib/utils/cn";
import { formatCurrency } from "@/lib/utils/format";
import { LISTING_TYPE_LABELS, mlErrorMessage } from "@/lib/mercadolibre/labels";
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
  useMlCategoryMemory,
  useMlQuickCandidates,
  type AttrField,
  type MlAccount,
  type MlCategoryInfo,
  type MlChannelPreview,
  type MlDomainSuggestion,
  type MlQuickCandidate,
} from "@/modules/mercadolibre/hooks";
import { MlPublishModal } from "@/components/mercadolibre/MlPublishModal";

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

const SOURCE_LABEL: Record<AttrSource, string> = {
  user: "",
  product: "de la ficha",
  catalog: "del catálogo de ML",
  domain: "sugerido",
  memory: "del último uso",
};

const STATE: Record<QuickRowState, { label: string; tone: "neutral" | "warning" | "success" | "danger" | "info" }> = {
  loading: { label: "Preparando", tone: "neutral" },
  needs_input: { label: "Falta completar", tone: "warning" },
  ready: { label: "Lista", tone: "info" },
  validating: { label: "Validando", tone: "neutral" },
  valid: { label: "Validada", tone: "success" },
  publishing: { label: "Publicando", tone: "neutral" },
  published: { label: "Publicada", tone: "success" },
  partial: { label: "Publicada en parte", tone: "warning" },
  error: { label: "Corregir", tone: "danger" },
};

interface Row extends QuickRow {
  productId: string;
  preview: MlChannelPreview | null;
  suggestions: MlDomainSuggestion[];
  categoryName: string;
  fields: AttrField[] | null;
  sources: Record<string, AttrSource>;
  types: string[];
  catalogName: string | null;
  catalogAttrs: ExternalAttr[];
  state: QuickRowState;
  errors: string[];
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

function AttrCell({ f, value, source, onChange }: { f: AttrField; value: AttrValues[string] | undefined; source?: AttrSource; onChange: (v: AttrValues[string]) => void }) {
  const label = f.name;
  const hint = source && SOURCE_LABEL[source] ? SOURCE_LABEL[source] : undefined;
  if (f.options.length > 0 && f.valueType !== "number_unit") {
    return (
      <label className="block min-w-[9rem] space-y-1 text-xs">
        <span className="font-medium">{label}</span>
        <select
          className={cn(selectCls, "h-9")}
          value={value?.value_id ?? ""}
          onChange={(e) => {
            const opt = f.options.find((o) => o.id === e.target.value);
            onChange(opt ? { value_id: opt.id, value_name: opt.name } : {});
          }}
        >
          <option value="">Elegí</option>
          {f.options.map((o) => (
            <option key={o.id} value={o.id}>
              {o.name}
            </option>
          ))}
        </select>
        {hint && <span className="text-muted-foreground">{hint}</span>}
      </label>
    );
  }
  return (
    <div className="min-w-[9rem]">
      <Input
        label={label}
        className="h-9"
        value={value?.value_name ?? ""}
        maxLength={f.maxLength ?? 255}
        placeholder={f.valueType === "number_unit" && f.defaultUnit ? `10 ${f.defaultUnit}` : undefined}
        hint={hint}
        onChange={(e) => onChange({ value_name: e.target.value })}
      />
    </div>
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
        catalogAttrs: [],
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
    return buildQuickInput(previewProduct(r), r, firstType, Number(price), account.user_product_seller ? "user_products" : "classic");
  };

  const eligible = (r: Row, states: QuickRowState[]) => !r.skip && r.preview && r.fields && states.includes(r.state) && r.types.length > 0;

  const validateRow = async (r: Row): Promise<boolean> => {
    patch(r.productId, { state: "validating", errors: [] });
    try {
      const res = await withRetry(() => mlPublishApi.validate(account.id, inputOf(r)));
      if (res.ok) {
        patch(r.productId, { state: "valid", errors: [] });
        return true;
      }
      patch(r.productId, { state: "error", errors: res.errors ?? ["Mercado Libre rechazó los datos."] });
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
      const skipped = (res.skipped ?? []).map((s) => `${LISTING_TYPE_LABELS[s.listing_type_id] ?? s.listing_type_id}: sin precio o marcado para no publicar`);
      if (res.ok) {
        patch(r.productId, {
          state: failed.length || skipped.length ? "partial" : "published",
          published: res.items ?? [],
          errors: [...failed, ...skipped],
        });
      } else {
        patch(r.productId, { state: "error", errors: res.errors ?? ["No se pudo publicar."] });
      }
    } catch (e) {
      patch(r.productId, { state: "error", errors: [mlErrorMessage(e)] });
    }
  };

  const runAll = async (publish: boolean) => {
    const targets = rows.filter((r) => eligible(r, ["ready", "valid", "error"]) && localRowState(previewProduct(r), r, r.fields).state === "ready");
    if (targets.length === 0) return;
    setBusy(publish ? "publish" : "validate");
    await pool(targets, 2, async (r) => {
      const ok = r.state === "valid" ? true : await validateRow(r);
      if (ok && publish) await publishRow(r);
    });
    setBusy(null);
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
            {rows.map((r) => {
              const st = STATE[r.state];
              const fields = r.fields ?? [];
              const missing = r.fields ? missingRequired(fields, r.attrs) : [];
              const filledFromSuggestion = Object.entries(r.sources).filter(([, s]) => s !== "user");
              const emptyGtinOptions = fields.find((f) => f.id === "EMPTY_GTIN_REASON")?.options ?? [];
              const pv = r.preview;
              const done = r.state === "published" || r.state === "partial";
              const catOptions = [
                ...r.suggestions.map((s) => ({ id: s.category_id, name: `${s.category_name} (${s.domain_name})`, attrs: s.attributes ?? [] })),
                ...memoryOptions
                  .filter((m) => !r.suggestions.some((s) => s.category_id === m.category_id))
                  .map((m) => ({ id: m.category_id, name: `${m.category_name || m.category_id} (usada antes)`, attrs: [] })),
              ];
              return (
                <div key={r.productId} className="rounded-lg bg-muted/60 p-3">
                  <div className="grid gap-3 lg:grid-cols-[minmax(0,2.2fr)_minmax(0,1.6fr)_minmax(0,1.3fr)]">
                    {/* Producto y título */}
                    <div className="flex min-w-0 gap-3">
                      {pv?.pictures[0] ? (
                        // eslint-disable-next-line @next/next/no-img-element
                        <img src={pv.pictures[0]} alt="" className="h-12 w-12 shrink-0 rounded-md object-cover" />
                      ) : (
                        <span className="flex h-12 w-12 shrink-0 items-center justify-center rounded-md bg-muted text-muted-foreground">
                          <Package size={18} />
                        </span>
                      )}
                      <div className="min-w-0 flex-1 space-y-1">
                        <div className="flex flex-wrap items-center gap-1.5">
                          <Badge tone={st.tone}>{r.state === "loading" || r.state === "validating" || r.state === "publishing" ? <Spinner size={12} /> : null}{st.label}</Badge>
                          {r.catalogName && <Badge tone="info">En el catálogo de ML</Badge>}
                        </div>
                        <Input
                          aria-label="Título"
                          className="h-9"
                          value={r.title}
                          maxLength={r.maxTitleLength}
                          disabled={done || r.skip !== null}
                          onChange={(e) => {
                            const title = e.target.value;
                            patch(r.productId, (x) => ({ title, ...localRowState(previewProduct(x), { ...x, title }, x.fields) }));
                          }}
                        />
                        <p className="text-xs text-muted-foreground">
                          {r.title.length}/{r.maxTitleLength}
                          {pv ? ` · ${pv.pictures.length} fotos` : ""}
                          {pv?.qty != null ? ` · ${pv.qty} para publicar` : ""}
                          {filledFromSuggestion.length > 0 ? ` · ${filledFromSuggestion.length} datos precompletados` : ""}
                        </p>
                      </div>
                    </div>

                    {/* Categoría y GTIN */}
                    <div className="min-w-0 space-y-2">
                      {r.skip === "variants" ? (
                        <div className="space-y-2 text-sm">
                          <p className="text-muted-foreground">Tiene variantes: se publica con la pantalla completa (talle, color y precio por variante).</p>
                          <Button variant="secondary" size="sm" onClick={() => setFull(r.productId)}>
                            <Layers size={15} /> Publicación completa
                          </Button>
                        </div>
                      ) : r.skip === "kit" ? (
                        <p className="text-sm text-muted-foreground">Los combos no se publican: publicá cada producto del combo.</p>
                      ) : (
                        <>
                          <label className="block space-y-1 text-xs">
                            <span className="font-medium">Categoría</span>
                            <select
                              className={cn(selectCls, "h-9")}
                              value={r.categoryId}
                              disabled={done || busy === "publish"}
                              onChange={(e) => {
                                const opt = catOptions.find((o) => o.id === e.target.value);
                                if (opt) void applyCategory(r.productId, opt.id, opt.name, { domainAttrs: opt.attrs });
                              }}
                            >
                              {!r.categoryId && <option value="">Elegí la categoría</option>}
                              {catOptions.map((o) => (
                                <option key={o.id} value={o.id}>
                                  {o.name}
                                </option>
                              ))}
                            </select>
                          </label>
                          <div className="grid grid-cols-2 gap-2">
                            <Input
                              label="Código de barras"
                              className="h-9"
                              value={r.gtin ?? ""}
                              disabled={done}
                              onChange={(e) => {
                                const gtin = e.target.value;
                                patch(r.productId, (x) => ({ gtin, ...localRowState(previewProduct(x), { ...x, gtin }, x.fields) }));
                              }}
                            />
                            {!(r.gtin ?? "").trim() ? (
                              <label className="block space-y-1 text-xs">
                                <span className="font-medium">Sin código porque</span>
                                <select
                                  className={cn(selectCls, "h-9")}
                                  value={r.emptyGtinReason ?? ""}
                                  disabled={done}
                                  onChange={(e) => {
                                    const emptyGtinReason = e.target.value || null;
                                    patch(r.productId, (x) => ({ emptyGtinReason, ...localRowState(previewProduct(x), { ...x, emptyGtinReason }, x.fields) }));
                                  }}
                                >
                                  <option value="">Elegí</option>
                                  {(emptyGtinOptions.length ? emptyGtinOptions : EMPTY_GTIN_FALLBACK).map((o) => (
                                    <option key={o.id} value={o.id}>
                                      {o.name}
                                    </option>
                                  ))}
                                </select>
                              </label>
                            ) : (
                              <label className="block space-y-1 text-xs">
                                <span className="font-medium">Condición</span>
                                <select
                                  className={cn(selectCls, "h-9")}
                                  value={r.condition}
                                  disabled={done}
                                  onChange={(e) => patch(r.productId, { condition: e.target.value as "new" | "used" })}
                                >
                                  <option value="new">Nuevo</option>
                                  <option value="used">Usado</option>
                                </select>
                              </label>
                            )}
                          </div>
                        </>
                      )}
                    </div>

                    {/* Tipos y precio */}
                    {!r.skip && (
                      <fieldset className="min-w-0 space-y-1" disabled={done}>
                        <legend className="text-xs font-medium">Publicar como</legend>
                        {(pv?.listing_prices ?? []).filter((l) => l.rule?.enabled !== false).length === 0 && <p className="text-xs text-muted-foreground">Preparando precios…</p>}
                        {(pv?.listing_prices ?? [])
                          .filter((l) => l.rule?.enabled !== false)
                          .map((l) => {
                            const on = r.types.includes(l.listing_type_id);
                            const noPrice = !(typeof l.price === "number" && l.price > 0);
                            return (
                              <label key={l.listing_type_id} className="flex items-center justify-between gap-2 rounded-md px-1 py-0.5 text-sm">
                                <span className="flex items-center gap-2">
                                  <Checkbox
                                    checked={on}
                                    disabled={noPrice}
                                    onCheckedChange={(v) =>
                                      patch(r.productId, (x) => ({
                                        types: v ? [...new Set([...x.types, l.listing_type_id])] : x.types.filter((t) => t !== l.listing_type_id),
                                      }))
                                    }
                                  />
                                  {LISTING_TYPE_LABELS[l.listing_type_id] ?? l.listing_type_id}
                                </span>
                                <span className="tabular-nums text-muted-foreground">{noPrice ? (l.override?.mode === "skip" ? "No se publica" : "Sin precio") : formatCurrency(Number(l.price))}</span>
                              </label>
                            );
                          })}
                      </fieldset>
                    )}
                  </div>

                  {/* Obligatorios que faltan */}
                  {!r.skip && r.fields && missing.length > 0 && !done && (
                    <div className="mt-3 flex flex-wrap gap-2">
                      {missing.map((f) => (
                        <AttrCell
                          key={f.id}
                          f={f}
                          value={r.attrs[f.id]}
                          source={r.sources[f.id]}
                          onChange={(v) =>
                            patch(r.productId, (x) => {
                              const attrs = { ...x.attrs, [f.id]: v };
                              const sources = { ...x.sources, [f.id]: "user" as AttrSource };
                              return { attrs, sources, ...localRowState(previewProduct(x), { ...x, attrs }, x.fields) };
                            })
                          }
                        />
                      ))}
                    </div>
                  )}

                  {/* Resultado */}
                  {r.published.length > 0 && (
                    <div className="mt-2 flex flex-wrap items-center gap-3 text-sm">
                      <CheckCircle2 size={15} className="text-success" />
                      {r.published.map((p) => (
                        <span key={p.ml_item_id} className="inline-flex items-center gap-1">
                          {LISTING_TYPE_LABELS[p.listing_type_id ?? ""] ?? ""} {p.ml_item_id}
                          {p.permalink && (
                            <a href={p.permalink} target="_blank" rel="noreferrer" className="text-muted-foreground hover:underline" aria-label={`Ver ${p.ml_item_id} en Mercado Libre`}>
                              <ExternalLink size={13} />
                            </a>
                          )}
                        </span>
                      ))}
                    </div>
                  )}
                  {r.errors.length > 0 && (
                    <ul className="mt-2 space-y-0.5 text-xs text-danger">
                      {r.errors.slice(0, 6).map((e, i) => (
                        <li key={i} className="flex gap-1">
                          <AlertTriangle size={12} className="mt-0.5 shrink-0" /> {e}
                        </li>
                      ))}
                    </ul>
                  )}
                  {r.state === "needs_input" && r.errors.length === 0 && r.fields && (
                    <p className="mt-2 text-xs text-warning">{localRowState(previewProduct(r), r, r.fields).problems.join(" ")}</p>
                  )}
                </div>
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
