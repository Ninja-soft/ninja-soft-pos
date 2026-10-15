"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { AlertTriangle, Filter, RotateCcw, Search, Undo2, Wand2, X } from "lucide-react";
import { Badge } from "@/components/ui/Badge";
import { Button } from "@/components/ui/Button";
import { Checkbox } from "@/components/ui/Checkbox";
import { Modal } from "@/components/ui/Modal";
import { Pagination } from "@/components/ui/Pagination";
import { useToast } from "@/components/ui/Toast";
import { ProductThumb } from "@/components/products/ProductThumb";
import { MultiPick, categoryTree } from "@/components/prices/MultiPick";
import { Field, RoundingPicker, fieldCls } from "@/components/prices/shared";
import { cn } from "@/lib/utils/cn";
import { formatCurrency } from "@/lib/utils/format";
import { useDebouncedValue } from "@/hooks/useDebouncedValue";
import { useFeature } from "@/modules/saas/gating";
import { useMyTenant } from "@/modules/tenants/hooks";
import { useBrands, useCategories } from "@/modules/products/hooks";
import { useSuppliers } from "@/modules/purchases/hooks";
import { usePriceSettings } from "@/modules/prices/proHooks";
import { priceProApi } from "@/modules/prices/proApi";
import { usePriceEditorRows, usePriceEditorSave } from "@/modules/prices/editorApi";
import { parseTypedPrice } from "@/lib/prices/openPrice";
import type { RoundingRule } from "@/lib/prices/rounding";
import {
  EDITOR_FILTERS,
  applyBulk,
  buildChanges,
  buildPreview,
  canEditCost,
  editorErrorText,
  estimateListPrice,
  listField,
  previewSummary,
  pushHistory,
  resetRow,
  rowCost,
  rowItem,
  rowMargin,
  rowPrice,
  rowUtility,
  setCell,
  type BulkKind,
  type BulkTarget,
  type CellField,
  type Drafts,
  type EditorFilter,
  type EditorRow,
  type PreviewFlag,
} from "@/lib/prices/editor";

// Editor rápido de precios (ADR-151): planilla con costo, precio, margen y
// precios por lista. Nada se guarda hasta "Revisar y guardar": ahí se arma un
// lote con vista previa, auditoría y deshacer (motor de ADR-058 / ADR-140).

const PAGE_SIZE = 50;

const BULK_KINDS: { value: BulkKind; label: string; unit: string }[] = [
  { value: "pct", label: "Subir o bajar %", unit: "%" },
  { value: "amount", label: "Sumar monto", unit: "$" },
  { value: "set", label: "Fijar valor", unit: "$" },
  { value: "margin", label: "Margen objetivo %", unit: "%" },
  { value: "markup", label: "Markup objetivo %", unit: "%" },
  { value: "round", label: "Sólo redondear", unit: "" },
];

const FLAG_LABELS: Record<PreviewFlag, string> = {
  below_cost: "Debajo del costo",
  below_floor: "Debajo del mínimo",
  low_margin: "Margen bajo",
};

/** Número para editar: coma decimal, sin separador de miles. */
export function editText(n: number | null | undefined): string {
  if (n == null || !Number.isFinite(n)) return "";
  return n.toLocaleString("es-AR", { useGrouping: false, maximumFractionDigits: 2 });
}

function pctText(n: number | null | undefined): string {
  return n == null ? "" : `${n.toLocaleString("es-AR", { maximumFractionDigits: 1 })} %`;
}

interface CellProps {
  r: number;
  c: number;
  label: string;
  value: number | null;
  modified?: boolean;
  readOnly?: boolean;
  estimated?: boolean;
  title?: string;
  suffix?: string;
  onCommit: (v: number | null) => void;
  register: (r: number, c: number, el: HTMLInputElement | null) => void;
  onNav: (r: number, c: number, key: string, shift: boolean) => void;
}

// Celda editable. Guarda el texto con el que se entró: al confirmar (Enter,
// Tab, flechas o al salir) sólo carga el valor si cambió; Escape lo revierte.
function GridCell({ r, c, label, value, modified, readOnly, estimated, title, suffix, onCommit, register, onNav }: CellProps) {
  const [text, setText] = useState<string | null>(null);
  const start = useRef("");
  // Sin tipear nada (o recién confirmado), la celda muestra el valor vigente:
  // así Ctrl+Z o una edición masiva se ven aunque la celda tenga el foco.
  const shown = text != null && text !== start.current ? text : editText(value);

  const commit = () => {
    if (text == null) return;
    if (text !== start.current && !readOnly) onCommit(parseTypedPrice(text));
    start.current = text;
  };

  return (
    <div className="relative">
      <input
        ref={(el) => register(r, c, el)}
        aria-label={label}
        title={title}
        inputMode="decimal"
        readOnly={readOnly}
        value={shown}
        data-modified={modified ? "true" : undefined}
        onFocus={(e) => {
          const t = editText(value);
          start.current = t;
          setText(t);
          const el = e.currentTarget;
          requestAnimationFrame(() => el.select());
        }}
        onChange={(e) => setText(e.target.value)}
        onBlur={() => {
          commit();
          setText(null);
        }}
        onKeyDown={(e) => {
          const el = e.currentTarget;
          if (e.key === "Escape") {
            e.preventDefault();
            setText(start.current);
            requestAnimationFrame(() => el.select());
            return;
          }
          let move = false;
          if (e.key === "Enter" || e.key === "Tab" || e.key === "ArrowUp" || e.key === "ArrowDown") move = true;
          else if (e.key === "ArrowLeft") move = el.selectionStart === 0 && el.selectionEnd === 0;
          else if (e.key === "ArrowRight") move = el.selectionStart === el.value.length && el.selectionEnd === el.value.length;
          if (!move) return;
          e.preventDefault();
          commit();
          onNav(r, c, e.key, e.shiftKey);
        }}
        className={cn(
          "h-10 w-full min-w-[6.5rem] rounded-md border border-transparent bg-transparent px-2 text-right text-sm tabular-nums outline-none transition",
          "focus:border-foreground/40 focus:bg-background",
          suffix && "pr-6",
          modified && "bg-warning/10 font-semibold",
          estimated && !modified && "italic text-muted-foreground",
          readOnly && "cursor-default text-muted-foreground",
        )}
      />
      {suffix && (
        <span className="pointer-events-none absolute right-2 top-1/2 -translate-y-1/2 text-xs text-muted-foreground">{suffix}</span>
      )}
    </div>
  );
}

export function QuickPriceEditor() {
  const { toast } = useToast();
  const { data: myTenant } = useMyTenant();
  const isOwner = myTenant?.role === "owner";
  const { data: settings } = usePriceSettings();
  const needsApproval = Boolean(settings?.pro && settings?.require_approval && !isOwner);
  const hasPurchases = useFeature("compras") !== false;

  // Filtros
  const [search, setSearch] = useState("");
  const debounced = useDebouncedValue(search, 350);
  const [filter, setFilter] = useState<EditorFilter>("all");
  const [catIds, setCatIds] = useState<string[]>([]);
  const [brandIds, setBrandIds] = useState<string[]>([]);
  const [supplierIds, setSupplierIds] = useState<string[]>([]);
  const [filtersOpen, setFiltersOpen] = useState(false);
  const [page, setPage] = useState(1);
  useEffect(() => setPage(1), [debounced, filter, catIds, brandIds, supplierIds]);

  const { data: categories } = useCategories();
  const { data: brands } = useBrands();
  const { data: suppliers } = useSuppliers({}, filtersOpen && hasPurchases);
  const catOptions = useMemo(
    () => categoryTree((categories ?? []).map((c) => ({ id: c.id, name: c.name, parent_id: c.parent_id }))),
    [categories],
  );

  const q = usePriceEditorRows({
    search: debounced,
    categoryIds: catIds,
    brandIds,
    supplierIds,
    filter,
    limit: PAGE_SIZE,
    offset: (page - 1) * PAGE_SIZE,
  });
  const data = q.data;
  const rows = useMemo(() => data?.rows ?? [], [data]);
  const lists = useMemo(() => data?.lists ?? [], [data]);
  const minMargin = data?.min_margin_pct ?? 20;

  // Filas vistas (los borradores son por producto y sobreviven al cambiar de página).
  const cache = useRef(new Map<string, EditorRow>());
  for (const r of rows) cache.current.set(r.id, r);

  const world = useQuery({
    queryKey: ["price-pro", "snapshot", null, null],
    queryFn: () => priceProApi.snapshot(null, null),
    enabled: lists.length > 0,
    staleTime: 60_000,
  });

  // Borradores y deshacer
  const [drafts, setDrafts] = useState<Drafts>({});
  const [history, setHistory] = useState<Drafts[]>([]);
  const draftsRef = useRef(drafts);
  draftsRef.current = drafts;
  const pending = Object.keys(drafts).length;

  const change = useCallback((next: Drafts) => {
    if (next === draftsRef.current) return;
    setHistory((h) => pushHistory(h, draftsRef.current));
    setDrafts(next);
  }, []);
  const undo = useCallback(() => {
    setHistory((h) => {
      if (h.length === 0) return h;
      setDrafts(h[h.length - 1] ?? {});
      return h.slice(0, -1);
    });
  }, []);

  useEffect(() => {
    if (pending === 0) return;
    const h = (e: BeforeUnloadEvent) => {
      e.preventDefault();
      e.returnValue = "";
    };
    window.addEventListener("beforeunload", h);
    return () => window.removeEventListener("beforeunload", h);
  }, [pending]);

  // Grilla y teclado
  const cols: CellField[] = useMemo(() => ["cost", "price", "margin", ...lists.map((l) => listField(l.id))], [lists]);
  const cells = useRef(new Map<string, HTMLInputElement>());
  const register = useCallback((r: number, c: number, el: HTMLInputElement | null) => {
    const k = `${r}:${c}`;
    if (el) cells.current.set(k, el);
    else cells.current.delete(k);
  }, []);
  const onNav = useCallback(
    (r: number, c: number, key: string, shift: boolean) => {
      let nr = r;
      let nc = c;
      if (key === "Enter") nr = shift ? r - 1 : r + 1;
      else if (key === "ArrowDown") nr = r + 1;
      else if (key === "ArrowUp") nr = r - 1;
      else if (key === "ArrowLeft") nc = c - 1;
      else if (key === "ArrowRight") nc = c + 1;
      else if (key === "Tab") {
        nc = shift ? c - 1 : c + 1;
        if (nc >= cols.length) {
          nc = 0;
          nr = r + 1;
        } else if (nc < 0) {
          nc = cols.length - 1;
          nr = r - 1;
        }
      }
      cells.current.get(`${nr}:${nc}`)?.focus();
    },
    [cols.length],
  );

  function commitCell(row: EditorRow, field: CellField, v: number | null) {
    if (v == null) return;
    const res = setCell(draftsRef.current, row, field, v, lists);
    if (res.error) {
      const msg: Record<string, string> = {
        invalid: "Valor inválido",
        negative: "No puede ser negativo",
        cost_usd: "El costo está en dólares: se edita en la ficha",
        list_locked: "Esa lista se carga en otra moneda",
        no_cost: "Cargá el costo para calcular por margen",
        margin_100: "El margen tiene que ser menor a 100 %",
      };
      toast({ title: msg[res.error] ?? "Valor inválido", variant: "error" });
      return;
    }
    change(res.drafts);
  }

  // Selección y edición masiva
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const pageIds = rows.map((r) => r.id);
  const allPage = pageIds.length > 0 && pageIds.every((id) => selected.has(id));
  const somePage = pageIds.some((id) => selected.has(id));
  const [bulkOpen, setBulkOpen] = useState(false);
  const [bulkTarget, setBulkTarget] = useState<BulkTarget>("price");
  const [bulkKind, setBulkKind] = useState<BulkKind>("pct");
  const [bulkValue, setBulkValue] = useState("");
  const [bulkRounding, setBulkRounding] = useState<RoundingRule | null>(null);

  function toggleRow(id: string, on: boolean) {
    setSelected((s) => {
      const n = new Set(s);
      if (on) n.add(id);
      else n.delete(id);
      return n;
    });
  }
  function togglePage(on: boolean) {
    setSelected((s) => {
      const n = new Set(s);
      for (const id of pageIds) {
        if (on) n.add(id);
        else n.delete(id);
      }
      return n;
    });
  }

  function applyBulkOp() {
    const target = [...selected].map((id) => cache.current.get(id)).filter(Boolean) as EditorRow[];
    const scope = target.length ? target : rows;
    const v = bulkKind === "round" ? 0 : parseTypedPrice(bulkValue);
    if (v == null) {
      toast({ title: "Cargá el valor a aplicar", variant: "error" });
      return;
    }
    const res = applyBulk(draftsRef.current, scope, { target: bulkTarget, kind: bulkKind, value: v, rounding: bulkRounding }, lists);
    change(res.drafts);
    toast({
      title: `${res.changed} ${res.changed === 1 ? "producto cambiado" : "productos cambiados"}`,
      description: res.skipped ? `${res.skipped} salteados (sin costo, costo en dólares o lista bloqueada).` : undefined,
      variant: res.changed ? "success" : "error",
    });
  }

  // Vista previa y guardado
  const [previewOpen, setPreviewOpen] = useState(false);
  const [onlyAlerts, setOnlyAlerts] = useState(false);
  const [reason, setReason] = useState("");
  const save = usePriceEditorSave();
  const preview = useMemo(() => {
    if (!previewOpen) return [];
    const rs = Object.keys(drafts).map((id) => cache.current.get(id)).filter(Boolean) as EditorRow[];
    // Listas conocidas: las de la página (todas las páginas comparten las mismas).
    return buildPreview(rs, drafts, lists, minMargin);
  }, [previewOpen, drafts, lists, minMargin]);
  const summary = previewSummary(preview);
  const shownPreview = onlyAlerts ? preview.filter((l) => l.flags.length) : preview;

  async function confirmSave() {
    try {
      const res = await save.mutateAsync({ changes: buildChanges(drafts), reason });
      toast({
        title: res.status === "pending_approval" ? "Pendiente de aprobación" : "Precios aplicados",
        description:
          res.status === "pending_approval"
            ? "El dueño lo aprueba en Configuración > Listas de precios > Cambios."
            : `${res.count} cambios. Para deshacer: Configuración > Listas de precios > Cambios.`,
        variant: "success",
      });
      setDrafts({});
      setHistory([]);
      setSelected(new Set());
      setReason("");
      setPreviewOpen(false);
    } catch (e) {
      toast({ title: editorErrorText(e), variant: "error" });
    }
  }

  const bulkTargets: { value: BulkTarget; label: string }[] = [
    { value: "price", label: "Precio de venta" },
    { value: "cost", label: "Costo" },
    ...lists.filter((l) => l.editable).map((l) => ({ value: listField(l.id) as BulkTarget, label: `Lista ${l.name}` })),
  ];
  const bulkUnit = BULK_KINDS.find((k) => k.value === bulkKind)?.unit ?? "";

  return (
    <div
      className="space-y-4"
      onKeyDown={(e) => {
        if ((e.ctrlKey || e.metaKey) && !e.shiftKey && e.key.toLowerCase() === "z") {
          e.preventDefault();
          undo();
        }
      }}
    >
      <div className="rounded-lg bg-muted px-4 py-3 text-sm text-muted-foreground">
        <p>
          <span className="font-semibold text-foreground">Editor de precios.</span> Cambiá costos, precios y precios por lista
          como en una planilla (Enter baja, Tab avanza). Nada se guarda hasta que revisás los cambios.
        </p>
        <p className="mt-1 text-xs">
          El margen es sobre el precio sin IVA contra el costo final. Una lista sin precio fijo se calcula con su regla (en
          gris); si la editás, queda un precio fijo para ese producto.
        </p>
      </div>

      {/* Barra */}
      <div className="flex flex-wrap items-center gap-2">
        <div className="relative min-w-0 basis-full sm:max-w-sm sm:flex-1 sm:basis-auto">
          <Search size={16} className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-muted-foreground" />
          <input
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Buscar por nombre, SKU o código"
            aria-label="Buscar productos"
            className={cn(fieldCls, "h-11 pl-9")}
          />
        </div>
        <Button variant="secondary" size="sm" className="h-11" onClick={() => setFiltersOpen((o) => !o)}>
          <Filter size={15} /> Filtros
          {catIds.length + brandIds.length + supplierIds.length > 0 && (
            <Badge tone="info">{catIds.length + brandIds.length + supplierIds.length}</Badge>
          )}
        </Button>
        <div className="flex flex-wrap gap-1.5" role="group" aria-label="Mostrar">
          {EDITOR_FILTERS.map((f) => (
            <button
              key={f.value}
              type="button"
              aria-pressed={filter === f.value}
              onClick={() => setFilter(f.value)}
              className={cn(
                "h-10 rounded-md px-3 text-xs font-semibold transition",
                filter === f.value ? "bg-foreground text-background" : "bg-muted text-muted-foreground hover:text-foreground",
              )}
            >
              {f.label}
            </button>
          ))}
        </div>
      </div>

      {filtersOpen && (
        <div className="grid gap-3 sm:grid-cols-3">
          <Field label="Categorías (incluye subcategorías)">
            <MultiPick options={catOptions} value={catIds} onChange={setCatIds} placeholder="Buscar categoría" empty="Sin categorías" />
          </Field>
          <Field label="Marcas">
            <MultiPick
              options={(brands ?? []).map((b) => ({ id: b.id, name: b.name }))}
              value={brandIds}
              onChange={setBrandIds}
              placeholder="Buscar marca"
              empty="Sin marcas"
            />
          </Field>
          {hasPurchases && (
            <Field label="Proveedores">
              <MultiPick
                options={((suppliers ?? []) as { id: string; name: string }[]).map((s) => ({ id: s.id, name: s.name }))}
                value={supplierIds}
                onChange={setSupplierIds}
                placeholder="Buscar proveedor"
                empty="Sin proveedores"
              />
            </Field>
          )}
        </div>
      )}

      {/* Acciones */}
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="flex flex-wrap items-center gap-2">
          <Button variant="secondary" size="sm" onClick={() => setBulkOpen((o) => !o)} aria-expanded={bulkOpen}>
            <Wand2 size={15} /> Edición masiva
            {selected.size > 0 && <Badge tone="neutral">{selected.size}</Badge>}
          </Button>
          <Button variant="ghost" size="sm" onClick={undo} disabled={history.length === 0} title="Deshacer (Ctrl+Z)">
            <Undo2 size={15} /> Deshacer
          </Button>
          <Button
            variant="ghost"
            size="sm"
            disabled={pending === 0}
            onClick={() => {
              change({});
              setSelected(new Set());
            }}
          >
            <X size={15} /> Descartar todo
          </Button>
        </div>
        <Button size="sm" disabled={pending === 0} onClick={() => setPreviewOpen(true)}>
          Revisar y guardar ({pending})
        </Button>
      </div>
      {pending > 0 && (
        <p className="text-xs text-muted-foreground" role="status">
          {pending === 1 ? "1 producto con cambios sin guardar" : `${pending} productos con cambios sin guardar`} (se
          conservan al cambiar de página o de filtro).
        </p>
      )}

      {bulkOpen && (
        <div className="space-y-3 rounded-lg bg-muted p-3.5">
          <p className="text-sm">
            {selected.size > 0
              ? `Se aplica a ${selected.size} ${selected.size === 1 ? "producto elegido" : "productos elegidos"}.`
              : "Sin productos elegidos: se aplica a todos los de esta página."}
          </p>
          <div className="grid gap-3 sm:grid-cols-4">
            <Field label="Qué cambiar">
              <select className={fieldCls} value={bulkTarget} onChange={(e) => setBulkTarget(e.target.value as BulkTarget)} aria-label="Qué cambiar">
                {bulkTargets.map((t) => (
                  <option key={t.value} value={t.value}>
                    {t.label}
                  </option>
                ))}
              </select>
            </Field>
            <Field label="Cómo">
              <select className={fieldCls} value={bulkKind} onChange={(e) => setBulkKind(e.target.value as BulkKind)} aria-label="Cómo">
                {BULK_KINDS.filter((k) => bulkTarget !== "cost" || (k.value !== "margin" && k.value !== "markup" && k.value !== "round")).map(
                  (k) => (
                    <option key={k.value} value={k.value}>
                      {k.label}
                    </option>
                  ),
                )}
              </select>
            </Field>
            {bulkKind !== "round" && (
              <Field label={bulkUnit === "%" ? "Valor (%)" : "Valor ($)"} hint={bulkKind === "pct" ? "Negativo para bajar." : undefined}>
                <input
                  className={fieldCls}
                  inputMode="decimal"
                  aria-label="Valor a aplicar"
                  value={bulkValue}
                  onChange={(e) => setBulkValue(e.target.value)}
                  placeholder={bulkUnit === "%" ? "10" : "0"}
                />
              </Field>
            )}
            {bulkTarget !== "cost" && (
              <Field label="Redondeo">
                <RoundingPicker value={bulkRounding} onChange={setBulkRounding} />
              </Field>
            )}
          </div>
          <div className="flex justify-end">
            <Button size="sm" onClick={applyBulkOp}>
              Aplicar
            </Button>
          </div>
        </div>
      )}

      {/* Planilla */}
      <div className="overflow-auto rounded-lg border border-border bg-card" style={{ maxHeight: "70vh" }}>
        <table className="w-full min-w-[720px] border-collapse text-sm">
          <thead className="sticky top-0 z-20 bg-muted text-left text-xs text-muted-foreground">
            <tr>
              <th className="sticky left-0 z-30 bg-muted px-3 py-2.5">
                <div className="flex items-center gap-3">
                  <Checkbox
                    checked={allPage ? true : somePage ? "indeterminate" : false}
                    onCheckedChange={togglePage}
                    aria-label="Elegir todos los de la página"
                  />
                  <span>Producto</span>
                </div>
              </th>
              <th className="px-2 py-2.5 text-right">Costo</th>
              <th className="px-2 py-2.5 text-right">Precio de venta</th>
              <th className="px-2 py-2.5 text-right">Margen</th>
              <th className="px-2 py-2.5 text-right">Markup</th>
              {lists.map((l) => (
                <th key={l.id} className="px-2 py-2.5 text-right" title={l.editable ? undefined : "Lista en moneda extranjera: se edita desde la lista"}>
                  {l.name}
                  {!l.editable && <span className="ml-1 text-[10px]">({l.currency})</span>}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {q.isLoading && (
              <tr>
                <td colSpan={5 + lists.length} className="px-3 py-8 text-center text-muted-foreground">
                  Cargando precios
                </td>
              </tr>
            )}
            {q.isError && (
              <tr>
                <td colSpan={5 + lists.length} className="px-3 py-8 text-center text-muted-foreground">
                  {editorErrorText(q.error)}
                </td>
              </tr>
            )}
            {!q.isLoading && !q.isError && rows.length === 0 && (
              <tr>
                <td colSpan={5 + lists.length} className="px-3 py-8 text-center text-muted-foreground">
                  No hay productos con ese filtro.
                </td>
              </tr>
            )}
            {rows.map((row, r) => {
              const d = drafts[row.id];
              const util = rowUtility(row, d);
              const margin = rowMargin(row, d);
              const low = margin != null && margin < minMargin;
              const usd = !canEditCost(row);
              const open = row.price_mode === "open";
              return (
                <tr key={row.id} className={cn("border-t border-border", d && "bg-warning/[0.04]")}>
                  <td className="sticky left-0 z-10 bg-card px-3 py-1.5">
                    <div className="flex min-w-[13rem] items-center gap-3">
                      <Checkbox checked={selected.has(row.id)} onCheckedChange={(v) => toggleRow(row.id, v)} aria-label={`Elegir ${row.name}`} />
                      <ProductThumb src={row.image_url} size={32} />
                      <div className="min-w-0 flex-1">
                        <div className="truncate font-medium" title={row.name}>
                          {row.name}
                        </div>
                        <div className="flex flex-wrap items-center gap-1 text-[11px] text-muted-foreground">
                          {row.sku && <span className="truncate">{row.sku}</span>}
                          {open && <Badge tone="info" className="px-1.5 py-0 text-[10px]">Libre</Badge>}
                          {usd && <Badge tone="neutral" className="px-1.5 py-0 text-[10px]">USD</Badge>}
                          {!row.is_active && <Badge tone="neutral" className="px-1.5 py-0 text-[10px]">Inactivo</Badge>}
                        </div>
                      </div>
                      {d && (
                        <button
                          type="button"
                          aria-label={`Descartar cambios de ${row.name}`}
                          title="Descartar los cambios de esta fila"
                          onClick={() => change(resetRow(draftsRef.current, row.id))}
                          className="grid h-9 w-9 shrink-0 place-items-center rounded-md text-muted-foreground transition hover:bg-muted hover:text-foreground"
                        >
                          <RotateCcw size={15} />
                        </button>
                      )}
                    </div>
                  </td>
                  <td className="px-1 py-1">
                    <GridCell
                      r={r}
                      c={0}
                      label={`Costo de ${row.name}`}
                      value={rowCost(row, d)}
                      modified={d?.cost != null}
                      readOnly={usd}
                      title={usd ? `Costo en dólares (US$ ${editText(row.cost_usd)}). Se edita en la ficha` : undefined}
                      onCommit={(v) => commitCell(row, "cost", v)}
                      register={register}
                      onNav={onNav}
                    />
                  </td>
                  <td className="px-1 py-1">
                    <GridCell
                      r={r}
                      c={1}
                      label={`Precio de venta de ${row.name}`}
                      value={rowPrice(row, d)}
                      modified={d?.price != null}
                      title={open ? "Precio libre: este es el sugerido, el precio se define al cobrar" : undefined}
                      onCommit={(v) => commitCell(row, "price", v)}
                      register={register}
                      onNav={onNav}
                    />
                  </td>
                  <td className={cn("px-1 py-1", low && "text-danger")}>
                    <GridCell
                      r={r}
                      c={2}
                      label={`Margen de ${row.name}`}
                      value={margin}
                      suffix="%"
                      title={low ? `Debajo del mínimo de ${minMargin} %` : "Margen sobre el precio sin IVA. Al cambiarlo se calcula el precio"}
                      onCommit={(v) => commitCell(row, "margin", v)}
                      register={register}
                      onNav={onNav}
                    />
                  </td>
                  <td className="px-2 py-1 text-right text-xs tabular-nums text-muted-foreground">{util ? pctText(util.markupPct) : ""}</td>
                  {lists.map((l, i) => {
                    const fixed = rowItem(row, l.id, d);
                    const hasFixed = fixed != null;
                    const value = hasFixed ? fixed : estimateListPrice(world.data ?? null, row, l.id, d);
                    return (
                      <td key={l.id} className="px-1 py-1">
                        <GridCell
                          r={r}
                          c={3 + i}
                          label={`${l.name} de ${row.name}`}
                          value={value}
                          modified={d?.lists?.[l.id] != null}
                          estimated={!hasFixed}
                          readOnly={!l.editable}
                          title={
                            !l.editable
                              ? "Lista en moneda extranjera: se edita desde la lista"
                              : hasFixed
                                ? "Precio fijo de esta lista"
                                : "Calculado por la regla de la lista. Si lo cambiás, queda fijo"
                          }
                          onCommit={(v) => commitCell(row, listField(l.id), v)}
                          register={register}
                          onNav={onNav}
                        />
                      </td>
                    );
                  })}
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>

      <Pagination page={page} pageSize={PAGE_SIZE} total={data?.total ?? 0} onPageChange={setPage} loading={q.isFetching} />

      <Modal
        open={previewOpen}
        onOpenChange={setPreviewOpen}
        title="Revisar cambios"
        className="sm:max-w-3xl"
        footer={
          <div className="flex justify-end gap-2">
            <Button variant="secondary" onClick={() => setPreviewOpen(false)}>
              Seguir editando
            </Button>
            <Button onClick={confirmSave} loading={save.isPending}>
              {needsApproval ? "Enviar a aprobación" : "Guardar precios"}
            </Button>
          </div>
        }
      >
        <div className="space-y-4">
          <p className="text-sm" data-testid="preview-summary">
            {summary.lines} {summary.lines === 1 ? "cambio" : "cambios"} en {summary.products}{" "}
            {summary.products === 1 ? "producto" : "productos"}.
          </p>
          {(summary.belowCost > 0 || summary.lowMargin > 0 || summary.belowFloor > 0) && (
            <div className="flex items-start gap-2 rounded-md bg-warning/10 px-3 py-2 text-sm">
              <AlertTriangle size={16} className="mt-0.5 shrink-0 text-warning" />
              <span>
                {[
                  summary.belowCost ? `${summary.belowCost} debajo del costo` : null,
                  summary.belowFloor ? `${summary.belowFloor} debajo del precio mínimo` : null,
                  summary.lowMargin ? `${summary.lowMargin} con margen menor a ${minMargin} %` : null,
                ]
                  .filter(Boolean)
                  .join(", ")}
                . Revisalos antes de guardar.
              </span>
            </div>
          )}
          {needsApproval && (
            <p className="rounded-md bg-muted px-3 py-2 text-sm">
              Tu negocio pide aprobación para los cambios de precios: quedan pendientes hasta que el dueño los apruebe.
            </p>
          )}
          <label className="flex items-center gap-2 text-sm">
            <Checkbox checked={onlyAlerts} onCheckedChange={setOnlyAlerts} aria-label="Sólo con alerta" />
            Sólo con alerta
          </label>
          <div className="max-h-[45vh] overflow-auto rounded-md border border-border">
            <table className="w-full min-w-[560px] text-sm">
              <thead className="sticky top-0 bg-muted text-left text-xs text-muted-foreground">
                <tr>
                  <th className="px-3 py-2">Producto</th>
                  <th className="px-3 py-2">Qué</th>
                  <th className="px-3 py-2 text-right">Antes</th>
                  <th className="px-3 py-2 text-right">Después</th>
                  <th className="px-3 py-2 text-right">Dif.</th>
                  <th className="px-3 py-2 text-right">Margen</th>
                </tr>
              </thead>
              <tbody>
                {shownPreview.map((l, i) => (
                  <tr key={`${l.productId}:${l.what}:${i}`} className="border-t border-border">
                    <td className="px-3 py-2">
                      <div className="font-medium">{l.name}</div>
                      {l.flags.length > 0 && (
                        <div className="mt-1 flex flex-wrap gap-1">
                          {l.flags.map((f) => (
                            <Badge key={f} tone={f === "low_margin" ? "warning" : "danger"}>
                              {FLAG_LABELS[f]}
                            </Badge>
                          ))}
                        </div>
                      )}
                    </td>
                    <td className="px-3 py-2 text-muted-foreground">{l.what}</td>
                    <td className="px-3 py-2 text-right tabular-nums">{l.before != null ? formatCurrency(l.before) : "Sin precio"}</td>
                    <td className="px-3 py-2 text-right font-semibold tabular-nums">{formatCurrency(l.after)}</td>
                    <td className="px-3 py-2 text-right tabular-nums text-muted-foreground">
                      {l.diffPct != null ? `${l.diffPct > 0 ? "+" : ""}${pctText(l.diffPct)}` : ""}
                    </td>
                    <td className="px-3 py-2 text-right tabular-nums">{pctText(l.marginPct)}</td>
                  </tr>
                ))}
                {shownPreview.length === 0 && (
                  <tr>
                    <td colSpan={6} className="px-3 py-6 text-center text-muted-foreground">
                      Sin cambios con alerta.
                    </td>
                  </tr>
                )}
              </tbody>
            </table>
          </div>
          <Field label="Motivo (opcional)" hint="Queda en el historial de cada precio y en el lote.">
            <input
              className={fieldCls}
              value={reason}
              maxLength={300}
              onChange={(e) => setReason(e.target.value)}
              placeholder="Ej.: aumento del proveedor de octubre"
            />
          </Field>
          <p className="text-xs text-muted-foreground">
            Se guarda como un lote: lo podés deshacer desde Configuración, Listas de precios, Cambios.
            {lists.length > 0 ? " Los precios de lista que cargues quedan fijos para esos productos." : ""}
          </p>
        </div>
      </Modal>
    </div>
  );
}
