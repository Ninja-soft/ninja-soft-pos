"use client";

// Buscador reutilizable de productos (combobox). Input con lector de códigos de
// barras (useScanner) y una lista flotante (no empuja el layout) con foto,
// nombre, stock, EAN, PLU, SKU y variantes. Dentro de un Modal se monta por
// portal DENTRO del diálogo (no en body): Radix trataría un clic en body como
// "afuera" y cerraría el modal, y el Dialog.Content tiene overflow-hidden y
// transform, así que se posiciona absoluto respecto de él.

import {
  useCallback,
  useEffect,
  useId,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
} from "react";
import { createPortal } from "react-dom";
import { ChevronLeft, ScanLine, Search } from "lucide-react";
import { ProductThumb } from "@/components/products/ProductThumb";
import { Spinner } from "@/components/ui/Spinner";
import { useToast } from "@/components/ui/Toast";
import { cn } from "@/lib/utils/cn";
import { branchQty } from "@/lib/stock/posBranchStock";
import {
  MIN_SEARCH,
  decideScan,
  moveIndex,
  stockLabel,
  visibleResults,
} from "@/lib/products/productSearch";
import { useScanner } from "@/modules/pos/useScanner";
import {
  productsApi,
  variantsApi,
  variantLabel,
  type Product,
  type ProductVariant,
} from "@/modules/products/api";
import { useProducts } from "@/modules/products/hooks";
import { useMultiStoreStock, useStockByStore } from "@/modules/stock/hooks";

export interface ProductSearchComboboxProps {
  onPick: (product: Product, variant: ProductVariant | null) => void;
  /** Sucursal cuyo stock se muestra (con stock por sucursal activo). Sin ella, el total. */
  storeId?: string | null;
  /** Qué productos se pueden elegir (p. ej. excluir kits o sin control de stock). */
  filter?: (p: Product) => boolean;
  /** Aviso cuando se escanea un producto que el filtro descarta. */
  rejectMessage?: (p: Product) => string;
  /** Texto bajo "Sin resultados" (p. ej. por qué faltan los kits). */
  emptyHint?: string;
  placeholder?: string;
  autoFocus?: boolean;
  /** Apaga búsqueda y lector (p. ej. con el modal cerrado o en otro paso). */
  enabled?: boolean;
  className?: string;
}

type VariantsState = { product: Product; variants: ProductVariant[] } | null;

const DROPDOWN_MAX = 320;
const DROPDOWN_MIN = 160;
const GAP = 4;

// Posición de la lista anclada al input. Contenedor = el diálogo más cercano o
// body. En body va `fixed` con coordenadas de viewport; en un diálogo va
// `absolute` relativa a él. Se abre hacia arriba si abajo no entra.
function useAnchoredPosition(anchor: React.RefObject<HTMLElement>, open: boolean) {
  const [pos, setPos] = useState<{ container: HTMLElement; style: CSSProperties } | null>(null);

  useLayoutEffect(() => {
    if (!open) return;
    const el = anchor.current;
    if (!el) return;
    const dialog = el.closest<HTMLElement>('[role="dialog"]');
    const container = dialog ?? document.body;

    const update = () => {
      const r = el.getBoundingClientRect();
      const vw = window.innerWidth;
      const vh = window.innerHeight;
      const c = dialog
        ? dialog.getBoundingClientRect()
        : { top: 0, left: 0, bottom: vh, width: vw, height: vh };
      const offTop = dialog ? c.top + dialog.clientTop : 0;
      const offLeft = dialog ? c.left + dialog.clientLeft : 0;
      const innerH = dialog ? dialog.clientHeight : vh;
      const innerW = dialog ? dialog.clientWidth : vw;

      const below = c.bottom - r.bottom - GAP - 8;
      const above = r.top - c.top - GAP - 8;
      const up = below < 240 && above > below;
      const maxHeight = Math.max(DROPDOWN_MIN, Math.min(DROPDOWN_MAX, up ? above : below));
      // Mobile-first: en celular la lista ocupa el ancho (con margen de 8px).
      const mobile = vw < 640;
      const left = mobile ? 8 : r.left - offLeft;
      const width = mobile ? innerW - 16 : r.width;

      const style: CSSProperties = {
        position: dialog ? "absolute" : "fixed",
        left,
        width,
        maxHeight,
      };
      if (up) style.bottom = innerH - (r.top - offTop) + GAP;
      else style.top = r.bottom - offTop + GAP;
      setPos({ container, style });
    };

    update();
    window.addEventListener("resize", update);
    window.addEventListener("scroll", update, true);
    return () => {
      window.removeEventListener("resize", update);
      window.removeEventListener("scroll", update, true);
    };
  }, [anchor, open]);

  return open ? pos : null;
}

export function ProductSearchCombobox({
  onPick,
  storeId = null,
  filter,
  rejectMessage,
  emptyHint,
  placeholder = "Buscá por nombre, SKU, EAN o PLU",
  autoFocus = false,
  enabled = true,
  className,
}: ProductSearchComboboxProps) {
  const { toast } = useToast();
  const uid = useId();
  const listId = `${uid}-list`;
  const optId = (i: number) => `${uid}-opt-${i}`;

  const wrapRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLUListElement>(null);

  const [search, setSearch] = useState("");
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState(-1);
  const [variantsOf, setVariantsOf] = useState<VariantsState>(null);
  const [loadingVariants, setLoadingVariants] = useState(false);
  const [mounted, setMounted] = useState(false);
  useEffect(() => setMounted(true), []);

  const { data: found = [], isFetching } = useProducts(enabled ? search : "");
  const results = useMemo(() => visibleResults(found, search, filter), [found, search, filter]);

  // Stock de la sucursal pedida (sólo con stock por sucursal activo).
  const { enabled: multiStore } = useMultiStoreStock();
  const byStore = Boolean(storeId) && multiStore;
  const stockIds = useMemo(
    () => (variantsOf ? [variantsOf.product.id] : results.map((p) => p.id)),
    [variantsOf, results],
  );
  const { data: storeRows } = useStockByStore(stockIds, enabled && open && byStore);
  const qtyOf = (productId: string, fallback: number, variantId: string | null = null) =>
    byStore && storeId ? branchQty(storeRows ?? [], storeId, productId, variantId) : fallback;

  const searching = search.trim().length >= MIN_SEARCH;
  const showList = enabled && open && (searching || variantsOf !== null);
  const optionCount = variantsOf ? variantsOf.variants.length : results.length;
  const pos = useAnchoredPosition(wrapRef, showList);

  const reset = useCallback(() => {
    setSearch("");
    setVariantsOf(null);
    setActive(-1);
    setOpen(false);
  }, []);

  useEffect(() => {
    if (!enabled) reset();
  }, [enabled, reset]);

  const choose = useCallback(
    (p: Product, v: ProductVariant | null) => {
      onPick(p, v);
      reset();
    },
    [onPick, reset],
  );

  const openVariants = useCallback(
    async (p: Product) => {
      setLoadingVariants(true);
      setOpen(true);
      try {
        const variants = await variantsApi.list(p.id);
        setVariantsOf({ product: p, variants });
        setActive(variants.length > 0 ? 0 : -1);
      } catch {
        toast({ title: `No se pudieron cargar las variantes de ${p.name}`, variant: "error" });
      } finally {
        setLoadingVariants(false);
      }
    },
    [toast],
  );

  const pickProduct = useCallback(
    (p: Product) => {
      if (p.has_variants) void openVariants(p);
      else choose(p, null);
    },
    [openVariants, choose],
  );

  // Lector de códigos: coincidencia exacta única → directo; varias → lista.
  useScanner(
    async (code) => {
      try {
        const matches = await productsApi.findAllByCode(code);
        const d = decideScan(matches, filter);
        if (d.kind === "pick") {
          const { product, variant } = d.match;
          if (product.has_variants && !variant) {
            setSearch("");
            await openVariants(product);
          } else {
            choose(product, variant ?? null);
          }
        } else if (d.kind === "list") {
          setVariantsOf(null);
          setSearch(code);
          setActive(-1);
          setOpen(true);
        } else if (d.kind === "rejected") {
          setSearch("");
          toast({
            title: rejectMessage?.(d.match.product) ?? `${d.match.product.name} no se puede agregar acá`,
            variant: "error",
          });
        } else {
          setSearch("");
          toast({ title: `No encontramos el código ${code}`, variant: "error" });
        }
      } catch {
        toast({ title: "No se pudo leer el código", variant: "error" });
      }
    },
    { enabled },
  );

  // Clic afuera (del input y de la lista) cierra.
  useEffect(() => {
    if (!showList) return;
    const onDown = (e: PointerEvent) => {
      const t = e.target as Node;
      if (wrapRef.current?.contains(t) || listRef.current?.contains(t)) return;
      setOpen(false);
    };
    document.addEventListener("pointerdown", onDown);
    return () => document.removeEventListener("pointerdown", onDown);
  }, [showList]);

  // Esc cierra la lista SIN cerrar el modal: Radix escucha Escape en document
  // (captura), así que se previene antes, en window (captura).
  useEffect(() => {
    if (!showList) return;
    const onEsc = (e: KeyboardEvent) => {
      if (e.key !== "Escape" || e.target !== inputRef.current) return;
      e.preventDefault();
      e.stopPropagation();
      if (variantsOf) {
        setVariantsOf(null);
        setActive(-1);
      } else {
        setOpen(false);
      }
    };
    window.addEventListener("keydown", onEsc, true);
    return () => window.removeEventListener("keydown", onEsc, true);
  }, [showList, variantsOf]);

  // Mantener visible la opción activa.
  useEffect(() => {
    if (active < 0) return;
    const el = document.getElementById(optId(active));
    el?.scrollIntoView?.({ block: "nearest" });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [active]);

  function onKeyDown(e: React.KeyboardEvent<HTMLInputElement>) {
    if (e.key === "ArrowDown" || e.key === "ArrowUp") {
      e.preventDefault();
      if (!open) setOpen(true);
      setActive((i) => moveIndex(i, e.key === "ArrowDown" ? 1 : -1, optionCount));
      return;
    }
    if (e.key === "Enter") {
      // Sólo elige con una opción activa (flechas): el Enter del lector de
      // códigos lo resuelve useScanner.
      if (!showList || active < 0 || active >= optionCount) return;
      e.preventDefault();
      if (variantsOf) choose(variantsOf.product, variantsOf.variants[active]!);
      else pickProduct(results[active]!);
    }
  }

  const loading = (isFetching && searching && !variantsOf) || loadingVariants;

  const list = showList && pos && mounted
    ? createPortal(
        <ul
          ref={listRef}
          id={listId}
          role="listbox"
          aria-label={variantsOf ? `Variantes de ${variantsOf.product.name}` : "Productos"}
          style={pos.style}
          className="z-[60] overflow-y-auto overscroll-contain rounded-md border border-border bg-popover text-popover-foreground"
          onMouseDown={(e) => e.preventDefault()}
        >
          {variantsOf && (
            <li role="presentation" className="sticky top-0 z-10 flex items-center gap-2 border-b border-border bg-popover px-2 py-1.5">
              <button
                type="button"
                tabIndex={-1}
                onClick={() => {
                  setVariantsOf(null);
                  setActive(-1);
                }}
                className="grid h-8 w-8 place-items-center rounded-md text-muted-foreground hover:bg-muted hover:text-foreground"
                aria-label="Volver a los productos"
              >
                <ChevronLeft size={16} />
              </button>
              <span className="min-w-0 truncate text-xs font-medium">
                Elegí la variante de {variantsOf.product.name}
              </span>
            </li>
          )}
          {loading && optionCount === 0 && (
            <li role="presentation" className="flex items-center gap-2 px-3 py-3 text-sm text-muted-foreground">
              <Spinner size={16} /> Buscando…
            </li>
          )}
          {!loading && optionCount === 0 && (
            <li role="presentation" className="px-3 py-3 text-sm text-muted-foreground">
              {variantsOf ? "Este producto no tiene variantes activas." : "Sin resultados."}
              {!variantsOf && emptyHint && <span className="mt-0.5 block text-xs">{emptyHint}</span>}
            </li>
          )}
          {variantsOf
            ? variantsOf.variants.map((v, i) => (
                <li
                  key={v.id}
                  id={optId(i)}
                  role="option"
                  aria-selected={i === active}
                  onMouseEnter={() => setActive(i)}
                  onClick={() => choose(variantsOf.product, v)}
                  className={cn(
                    "flex min-h-11 cursor-pointer items-center gap-3 px-3 py-2 text-sm",
                    i === active && "bg-muted",
                  )}
                >
                  <span className="min-w-0 flex-1">
                    <span className="block truncate font-medium">{variantLabel(v)}</span>
                    <Meta
                      stock={stockLabel(variantsOf.product.track_stock, qtyOf(variantsOf.product.id, v.stock, v.id))}
                      ean={v.barcode}
                      sku={v.sku}
                    />
                  </span>
                </li>
              ))
            : results.map((p, i) => (
                <li
                  key={p.id}
                  id={optId(i)}
                  role="option"
                  aria-selected={i === active}
                  onMouseEnter={() => setActive(i)}
                  onClick={() => pickProduct(p)}
                  className={cn(
                    "flex min-h-11 cursor-pointer items-center gap-3 px-3 py-2 text-sm",
                    i === active && "bg-muted",
                  )}
                >
                  <ProductThumb src={p.image_url} size={40} />
                  <span className="min-w-0 flex-1">
                    <span className="block truncate font-medium">{p.name}</span>
                    <Meta
                      stock={stockLabel(p.track_stock, qtyOf(p.id, Number(p.stock ?? 0)))}
                      ean={p.barcode}
                      plu={p.plu}
                      sku={p.sku}
                      variants={Boolean(p.has_variants)}
                    />
                  </span>
                </li>
              ))}
        </ul>,
        pos.container,
      )
    : null;

  return (
    <div ref={wrapRef} className={cn("relative", className)}>
      <Search
        size={16}
        className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-muted-foreground"
      />
      <input
        ref={inputRef}
        type="text"
        role="combobox"
        aria-label="Buscar producto"
        aria-autocomplete="list"
        aria-expanded={showList}
        aria-controls={listId}
        aria-activedescendant={showList && active >= 0 ? optId(active) : undefined}
        autoComplete="off"
        autoFocus={autoFocus}
        disabled={!enabled}
        value={search}
        placeholder={placeholder}
        onChange={(e) => {
          setSearch(e.target.value);
          setVariantsOf(null);
          setActive(-1);
          setOpen(true);
        }}
        onFocus={() => setOpen(true)}
        onKeyDown={onKeyDown}
        className="h-11 w-full rounded-lg border border-input bg-background pl-9 pr-11 text-sm text-foreground outline-none transition placeholder:text-muted-foreground focus:border-ninja-flameSoft focus:ring-2 focus:ring-ninja-flameSoft/20 disabled:opacity-60"
      />
      <span className="absolute right-1 top-1/2 flex -translate-y-1/2 items-center">
        {loading ? (
          <span className="grid h-9 w-9 place-items-center">
            <Spinner size={16} label="Buscando" />
          </span>
        ) : (
          <button
            type="button"
            tabIndex={-1}
            onClick={() => inputRef.current?.focus()}
            title="Lector de códigos activo: escaneá el código de barras"
            aria-label="Lector de códigos activo: escaneá el código de barras"
            className="grid h-9 w-9 place-items-center rounded-md text-muted-foreground hover:text-foreground"
          >
            <ScanLine size={16} />
          </button>
        )}
      </span>
      {list}
    </div>
  );
}
ProductSearchCombobox.displayName = "ProductSearchCombobox";

function Meta({
  stock,
  ean,
  plu,
  sku,
  variants,
}: {
  stock: string;
  ean?: string | null;
  plu?: string | null;
  sku?: string | null;
  variants?: boolean;
}) {
  return (
    <span className="mt-0.5 flex flex-wrap gap-x-3 gap-y-0.5 text-xs text-muted-foreground">
      <span>
        Stock: <span className="tabular-nums text-foreground">{stock}</span>
      </span>
      {ean && <span className="tabular-nums">EAN {ean}</span>}
      {plu && <span className="tabular-nums">PLU {plu}</span>}
      {sku && sku !== ean && <span>SKU {sku}</span>}
      {variants && <span>con variantes</span>}
    </span>
  );
}
