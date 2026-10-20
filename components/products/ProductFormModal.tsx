"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { useForm, type FieldErrors } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { useQueryClient } from "@tanstack/react-query";
import {
  Barcode as BarcodeIcon,
  Boxes,
  BriefcaseBusiness,
  Camera,
  ChevronDown,
  CircleDollarSign,
  History,
  Info,
  LayoutGrid,
  Plus,
  Settings2,
  Tag,
  Warehouse,
} from "lucide-react";
import { Modal } from "@/components/ui/Modal";
import { Input } from "@/components/ui/Input";
import { Button } from "@/components/ui/Button";
import { Switch } from "@/components/ui/Switch";
import { Disclosure } from "@/components/ui/Disclosure";
import { Spinner } from "@/components/ui/Spinner";
import { useToast } from "@/components/ui/Toast";
import { cn } from "@/lib/utils/cn";
import { ProductTaxFields } from "./ProductTaxFields";
import { productTaxDefaults } from "@/modules/products/tax";
import {
  ProductSchema,
  type ProductInput,
  type ProductOutput,
} from "@/modules/products/schemas";
import { altCodesApi, categoriesApi, packagesApi, saleUnitsApi, type Product } from "@/modules/products/api";
import { KDS_STATIONS, KDS_STATION_LABELS } from "@/modules/dining/api";
import { useDiningEnabled } from "@/modules/dining/hooks";
import { usePriceLists } from "@/modules/prices/hooks";
import { PriceHistoryPanel } from "@/components/products/PriceHistoryPanel";
import { ProductPricesPanel } from "@/components/products/ProductPricesPanel";
import { useMyTenant } from "@/modules/tenants/hooks";
import { useFeature } from "@/modules/saas/gating";
import { ProductImages } from "@/components/products/ProductImages";
import { KitComponentsEditor } from "@/components/products/KitComponentsEditor";
import { SerialsEditor } from "@/components/products/SerialsEditor";
import { VariantsEditor } from "@/components/products/VariantsEditor";
import { StoreStockPanel } from "@/components/stock/StoreStockPanel";
import { ModifiersEditor } from "@/components/products/ModifiersEditor";
import { RecipeEditor } from "@/components/products/RecipeEditor";
import dynamic from "next/dynamic";
import { AttributesEditor } from "@/components/products/AttributesEditor";
import { CategoryPathEditor } from "@/components/products/CategoryPathEditor";
import { PackagesEditor } from "@/components/products/PackagesEditor";
import { Barcode } from "@/components/products/Barcode";
import { ProductCostsPanel } from "@/components/purchases/ProductCostsPanel";
import { ProductCostBuilder } from "@/components/prices/ProductCostBuilder";
import {
  EMPTY_COSTING,
  costingApi,
  costingEquals,
  costingFromProduct,
  type CostingDraft,
} from "@/modules/prices/costingApi";
import { useFxQuote } from "@/modules/prices/proHooks";
import { useTaxSettings } from "@/modules/tax/hooks";
import { IVA_RATES, emitterDiscriminatesIva, type IvaCode } from "@/lib/tax/catalog";
import { finalCost as calcFinalCost, usdToArs } from "@/lib/prices/costing";
import type { PriceMode } from "@/lib/prices/openPrice";
import { usePriceProLists } from "@/modules/prices/proHooks";
import { ProductListPrices, ProductPriceSection } from "@/components/products/ProductPriceSection";
import { FeatureGate } from "@/components/saas/FeatureGate";
import { MarketReferencePanel } from "@/components/catalog/MarketReferencePanel";
import { normalizeAttributes, type ProductAttribute } from "@/lib/products/attributes";
import { findBrandByName, normalizeBrandName } from "@/lib/products/brandName";
import { diffPackages, type ProductPackage } from "@/lib/products/packages";
import {
  normalizeNodes,
  pathToCategory,
  type CategoryNode,
} from "@/lib/products/categoryPath";
import {
  useCategories,
  useBrands,
  useCreateBrand,
  useProductMutations,
  usePluSettings,
  useProductPackages,
  useVariants,
} from "@/modules/products/hooks";
import { errorDescription } from "@/lib/permissions/errors";
import { SERVICE_UNITS, itemNoun } from "@/lib/catalog/mode";
import { useCatalogMode, useServiceClarifications } from "@/modules/services/hooks";
import { ClarificationsModal } from "@/components/services/ClarificationsModal";
import { ServiceTypesModal } from "@/components/services/ServiceTypesModal";
import { AiCoverPanel } from "@/components/ai/AiCoverPanel";
import { ProductImageChoice, type ImageMode } from "@/components/products/ProductImageChoice";
import { useServiceTypes } from "@/modules/services/types";
import { aiCoverError, useAiCoverMutations, useAiCoversEnabled, useAiImageSettings } from "@/modules/ai/covers";
import { coverStyleInfo } from "@/supabase/functions/_shared/aiCoverPrompt";
import { AltCodesEditor, type AltCodeDraft } from "@/components/products/AltCodesEditor";
import { SaleUnitsEditor } from "@/components/products/SaleUnitsEditor";
import { useProductAltCodes, useProductSaleUnits } from "@/modules/products/hooks";
import { useSuppliers } from "@/modules/purchases/hooks";
import {
  USAGE_OPTIONS,
  barcodeTakenMessage,
  copyName,
  diffAltCodes,
  diffSaleUnits,
  saleUnitError,
  usageOf,
  type ProductUsage,
  type SaleUnit,
} from "@/lib/products/catalogCodes";

interface Props {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  product?: Product | null;
  /** H163: alta prellenada desde otro artículo ("Duplicar"). Sin product. */
  copyFrom?: Product | null;
}

type TabKey =
  | "general"
  | "servicio"
  | "precios"
  | "stock"
  | "codigos"
  | "atributos"
  | "fotos"
  | "medidas"
  | "mas"
  | "historial";

const MlProductPanel = dynamic(
  () => import("@/components/mercadolibre/MlProductPanel").then((m) => m.MlProductPanel),
  { ssr: false },
);

const TABS: { key: TabKey; label: string; icon: typeof Info }[] = [
  { key: "general", label: "General", icon: LayoutGrid },
  // ADR-116: sólo para servicios (unidad, duración, detalle y aclaraciones).
  { key: "servicio", label: "Servicio", icon: BriefcaseBusiness },
  { key: "precios", label: "Precios", icon: CircleDollarSign },
  { key: "stock", label: "Stock", icon: Warehouse },
  { key: "codigos", label: "Códigos", icon: BarcodeIcon },
  { key: "atributos", label: "Atributos", icon: Tag },
  { key: "fotos", label: "Imágenes", icon: Camera },
  { key: "medidas", label: "Medidas", icon: Boxes },
  { key: "mas", label: "Más", icon: Settings2 },
  // F18 · H100 (ADR-056): sólo con el producto guardado.
  { key: "historial", label: "Precios e historial", icon: History },
];

// Campo → pestaña (para llevar al usuario al error si está en otra pestaña).
const FIELD_TAB: Partial<Record<keyof ProductInput, TabKey>> = {
  name: "general",
  description: "general",
  model: "general",
  price: "precios",
  cost: "precios",
  replacement_cost: "precios",
  tax_rate: "precios",
  tax_rate_code: "precios",
  internal_tax_rate: "precios",
  internal_tax_amount: "precios",
  stock: "stock",
  stock_min: "stock",
  unit: "stock",
  sku: "codigos",
  barcode: "codigos",
  plu: "codigos",
  service_duration_min: "mas",
  commission_pct: "mas",
  invoice_detail: "servicio",
};

// ADR-116: pestañas que no aplican a un servicio (sin stock, variantes ni bultos).
const SERVICE_HIDDEN_TABS: TabKey[] = ["stock", "atributos", "medidas"];

const selectCls =
  "h-11 w-full appearance-none rounded-xl border-0 bg-muted px-3.5 pr-9 text-sm text-foreground outline-none transition focus:bg-secondary focus:shadow-[inset_0_0_0_1px_var(--border)]";
const textareaCls =
  "min-h-[110px] w-full resize-y rounded-xl border-0 bg-muted px-3.5 py-3 text-sm leading-relaxed text-foreground outline-none transition placeholder:text-muted-foreground focus:bg-secondary focus:shadow-[inset_0_0_0_1px_var(--border)]";

function Group({
  title,
  description,
  aside,
  children,
}: {
  title?: string;
  description?: string;
  aside?: React.ReactNode;
  children: React.ReactNode;
}) {
  return (
    <section className="space-y-3">
      {(title || aside) && (
        <div className="flex items-end justify-between gap-2">
          <div className="min-w-0">
            {title && (
              <h3 className="text-[11px] font-semibold uppercase tracking-[0.14em] text-muted-foreground">
                {title}
              </h3>
            )}
            {description && <p className="mt-1 text-xs text-muted-foreground">{description}</p>}
          </div>
          {aside}
        </div>
      )}
      {children}
    </section>
  );
}

// Fila de ajuste estilo iOS: título + bajada a la izquierda, control a la derecha.
function SettingRow({
  title,
  description,
  control,
  disabled,
  hint,
}: {
  title: React.ReactNode;
  description?: React.ReactNode;
  control: React.ReactNode;
  disabled?: boolean;
  hint?: string;
}) {
  return (
    <div
      className={cn("flex items-center justify-between gap-4 px-3.5 py-3", disabled && "opacity-50")}
      title={hint}
    >
      <div className="min-w-0">
        <p className="text-sm font-medium text-foreground">{title}</p>
        {description && <p className="mt-0.5 text-xs text-muted-foreground">{description}</p>}
      </div>
      {control}
    </div>
  );
}

function SaveFirst({ children }: { children: React.ReactNode }) {
  return <p className="rounded-xl bg-muted p-3.5 text-xs text-muted-foreground">{children}</p>;
}

export function ProductFormModal({ open, onOpenChange, product, copyFrom }: Props) {
  // H163: duplicar = alta con los datos de otro artículo para revisar y grabar.
  const src = product ?? copyFrom ?? null;
  const isCopy = !product && Boolean(copyFrom);
  // Tras crear, seguimos en modo edición (fotos / componentes / seriales).
  const [created, setCreated] = useState<Product | null>(null);
  const active = product ?? created;
  const isEdit = Boolean(active);
  const { toast } = useToast();
  const qc = useQueryClient();
  const { data: categories = [] } = useCategories();
  const { data: brands } = useBrands();
  const createBrand = useCreateBrand();
  const { create, update } = useProductMutations();
  const { data: plu } = usePluSettings();
  const pluEnabled = plu?.enabled ?? false;
  const { data: diningEnabled } = useDiningEnabled();
  const { data: priceLists = [] } = usePriceLists();
  const packagesAllowed = useFeature("medidas_bultos") !== false;
  const historyAllowed = useFeature("historial_precios") !== false;
  // Mercado Libre (ADR-104): sólo con la feature y el producto guardado.
  const mlAllowed = useFeature("mercadolibre") === true;
  const { data: myTenant } = useMyTenant();
  // ADR-116: modo del catálogo (vocabulario y si lo nuevo nace como servicio).
  const { mode: catalogMode, vocab } = useCatalogMode();
  const { data: clarifications = [] } = useServiceClarifications(false, open);
  const [clarificationsOpen, setClarificationsOpen] = useState(false);
  // ADR-122: tipos de servicio y portada con IA.
  const [typesOpen, setTypesOpen] = useState(false);
  const aiEnabled = useAiCoversEnabled() === true && Boolean(myTenant?.canManage);
  const { data: aiSettings } = useAiImageSettings(open && aiEnabled);
  const aiMut = useAiCoverMutations();
  // Imagen al crear (General): IA, subir foto o sin imagen. Arranca en IA si
  // el negocio prendió la portada automática; el dueño lo cambia por ítem.
  const [imageMode, setImageMode] = useState<ImageMode>("upload");
  const [imageModeTouched, setImageModeTouched] = useState(false);
  // Imagen recién generada y aplicada: el producto que llega por props no se
  // refresca solo, así que la mostramos acá hasta cerrar el editor.
  const [freshImage, setFreshImage] = useState<string | null>(null);
  useEffect(() => {
    if (!open || product || imageModeTouched) return;
    setImageMode(aiEnabled && aiSettings?.auto_cover ? "ai" : "upload");
  }, [open, product, aiEnabled, aiSettings?.auto_cover, imageModeTouched]);

  function generateAiCover(productId: string) {
    toast({ title: "Generando la imagen con IA", description: "Aparece en Imágenes en unos segundos.", variant: "info" });
    aiMut.generate.mutate(
      { productId, apply: true },
      {
        onSuccess: (r) => {
          if (!r.ok) {
            toast({ title: "No se generó la imagen", description: aiCoverError(r.error), variant: "error" });
            return;
          }
          if (r.applied) setFreshImage(r.generation.url);
          toast({
            title: r.applied ? "Imagen lista" : "Imagen generada",
            description: r.applied ? "Quedó como imagen principal." : "Elegila en Imágenes con Usar esta.",
            variant: "success",
          });
          qc.invalidateQueries({ queryKey: ["products"] });
        },
        onError: (e) => toast({ title: "No se generó la imagen", description: aiCoverError(e instanceof Error ? e.message : null), variant: "error" }),
      },
    );
  }
  const { data: savedPackages = [], isLoading: packagesLoading } = useProductPackages(
    active?.id ?? null,
  );
  const { data: savedAltCodes = [], isLoading: altLoading } = useProductAltCodes(active?.id ?? null);
  const { data: savedSaleUnits = [], isLoading: unitsLoading } = useProductSaleUnits(active?.id ?? null);
  const { data: suppliers = [] } = useSuppliers({}, open);

  const [tab, setTab] = useState<TabKey>("general");
  const { data: historyVariants } = useVariants(active?.id ?? null, tab === "historial");
  const variantNames = useMemo(
    () =>
      new Map(
        (historyVariants ?? []).map((v) => [v.id, [v.option1, v.option2].filter(Boolean).join(" / ")] as [string, string]),
      ),
    [historyVariants],
  );
  const [newBrand, setNewBrand] = useState("");
  const [addingBrand, setAddingBrand] = useState(false);
  const [nodes, setNodes] = useState<CategoryNode[]>([]);
  const [attributes, setAttributes] = useState<ProductAttribute[]>([]);
  const [packages, setPackages] = useState<ProductPackage[]>([]);
  // H163: códigos alternativos y unidades de venta (se guardan con el artículo).
  const [altCodes, setAltCodes] = useState<AltCodeDraft[]>([]);
  const [saleUnits, setSaleUnits] = useState<SaleUnit[]>([]);
  // "Grabar y seguir": después de crear, el form queda en blanco (misma categoría).
  const keepGoingRef = useRef(false);
  const [blankKey, setBlankKey] = useState(0);
  const [savingExtras, setSavingExtras] = useState(false);
  // ADR-140: costo final y utilidad (se guarda después del producto, como los bultos).
  const [costing, setCosting] = useState<CostingDraft>(EMPTY_COSTING);
  const [costingSaved, setCostingSaved] = useState<CostingDraft>(EMPTY_COSTING);
  // ADR-151: costo final y costos de compra plegados, abiertos si ya tienen datos.
  const [advancedOpen, setAdvancedOpen] = useState(false);

  const {
    register,
    handleSubmit,
    reset,
    setValue,
    watch,
    formState: { errors },
  } = useForm<ProductInput>({ resolver: zodResolver(ProductSchema) });
  const isKit = watch("is_kit");
  const isSerialized = watch("is_serialized");
  const hasVariants = watch("has_variants");
  const trackStock = watch("track_stock");
  const isActive = watch("is_active");
  const isFavorite = watch("is_favorite");
  const noDiscount = watch("no_discount");
  const priceRaw = watch("price");
  const costRaw = watch("cost");
  const barcodeVal = watch("barcode");
  const nameVal = watch("name");
  const isService = Boolean(watch("is_service"));
  const clarificationIds = watch("service_clarification_ids") ?? [];
  const { data: serviceTypes = [] } = useServiceTypes(open && isService);
  const noun = itemNoun(isService);
  const Noun = noun.charAt(0).toUpperCase() + noun.slice(1);

  // Tipos de producto mutuamente excluyentes (constraint también en DB).
  const kitDisabled = Boolean(isSerialized || hasVariants);
  const serializedDisabled = Boolean(isKit || hasVariants);
  const variantsDisabled = Boolean(isKit || isSerialized);
  const exclusiveHint =
    "Incompatible con kit / serializado / variantes. Desmarcá el otro tipo primero.";

  useEffect(() => {
    if (!open) return;
    setCreated(null);
    setTab("general");
    setImageModeTouched(false);
    setFreshImage(null);
    setAddingBrand(false);
    const cd = costingFromProduct(src);
    setCosting(cd);
    setCostingSaved(cd);
    setAdvancedOpen(cd.cost_currency === "USD" || cd.cost_extras.length > 0 || cd.markup_pct !== "");
    setAttributes(normalizeAttributes(src?.attributes));
    setNodes(pathToCategory(src?.category_id ?? null, categories));
    reset({
      // H163: la copia no repite nombre, códigos ni PLU (se revisan antes de grabar).
      name: isCopy ? copyName(src?.name ?? "") : (src?.name ?? ""),
      sku: isCopy ? "" : (src?.sku ?? ""),
      barcode: isCopy ? "" : (src?.barcode ?? ""),
      plu: isCopy ? "" : (src?.plu ?? ""),
      category_id: src?.category_id ?? null,
      brand_id: src?.brand_id ?? null,
      price: src?.price ?? 0,
      cost: src?.cost ?? undefined,
      replacement_cost:
        (src as { replacement_cost?: number | null } | null | undefined)?.replacement_cost ?? undefined,
      stock: isCopy ? 0 : (src?.stock ?? 0),
      stock_min: src?.stock_min ?? 0,
      unit: src?.unit ?? "un",
      tax_rate: src?.tax_rate ?? 21,
      ...productTaxDefaults(src),
      // ADR-116: en un negocio de servicios lo nuevo nace como servicio.
      ...(src ? {} : { is_service: vocab.newIsService }),
      season: src?.season ?? "",
      tags: src?.tags?.join(", ") ?? "",
      image_url: src?.image_url ?? "",
      description: src?.description ?? "",
      model: src?.model ?? "",
      attributes: [],
      is_active: src?.is_active ?? true,
      is_kit: src?.is_kit ?? false,
      is_serialized: src?.is_serialized ?? false,
      has_variants: src?.has_variants ?? false,
      track_stock: src ? (src.track_stock ?? true) : !vocab.newIsService,
      allow_negative:
        src?.allow_negative == null ? "inherit" : src.allow_negative ? "yes" : "no",
      warranty_months: src?.warranty_months ?? 0,
      is_favorite: isCopy ? false : (src?.is_favorite ?? false),
      no_discount: src?.no_discount ?? false,
      favorite_order: src?.favorite_order ?? 0,
      service_duration_min: src?.service_duration_min ?? "",
      commission_pct: src?.commission_pct ?? "",
      station: src?.station ?? "",
      invoice_detail: src?.invoice_detail ?? "",
      service_clarification_ids: src?.service_clarification_ids ?? [],
      service_type_id: src?.service_type_id ?? "",
      // ADR-151: modo de precio (undefined = fijo sin tocar).
      price_mode: src?.price_mode === "open" ? "open" : undefined,
      open_price_min: src?.open_price_min ?? "",
      open_price_max: src?.open_price_max ?? "",
      usage: src?.usage && src.usage !== "both" ? src.usage : undefined,
    });
    setAltCodes([]);
    setSaleUnits([]);
    setPackages([]);
    // categories entra aparte (abajo) para no resetear el form al llegar.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, product, copyFrom, blankKey, reset]);

  // Las categorías pueden llegar después de abrir: completamos la ruta.
  useEffect(() => {
    if (open && src?.category_id && nodes.length === 0 && categories.length > 0) {
      setNodes(pathToCategory(src.category_id, categories));
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, categories.length]);

  // Bultos guardados → estado editable (cuando abre o cambia el producto).
  useEffect(() => {
    if (open) setPackages(savedPackages);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, active?.id, packagesLoading]);

  // H163: alternativos y bultos guardados → estado editable.
  useEffect(() => {
    if (open && active?.id) setAltCodes(savedAltCodes);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, active?.id, altLoading]);
  useEffect(() => {
    if (open && active?.id) setSaleUnits(savedSaleUnits);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, active?.id, unitsLoading]);

  useEffect(() => {
    if (created?.plu) setValue("plu", created.plu);
  }, [created, setValue]);

  const fxQuote = useFxQuote(costing.cost_currency === "USD" ? costing.cost_fx_source : "oficial", open && costing.cost_currency === "USD");
  const { data: taxSettings } = useTaxSettings(open);
  const ivaCode = (watch("tax_rate_code") ?? "21") as IvaCode;
  const ivaPct =
    emitterDiscriminatesIva(taxSettings?.iva_condition) && IVA_RATES[ivaCode]?.kind === "gravado" ? IVA_RATES[ivaCode].rate : 0;
  // En dólares, el costo en pesos sale de USD × cotización (el campo queda de sólo lectura).
  const usdArs =
    costing.cost_currency === "USD"
      ? usdToArs(Number(costing.cost_usd.replace(",", ".")) || null, fxQuote.data?.rate ?? null)
      : null;
  useEffect(() => {
    if (open && usdArs != null) setValue("cost", usdArs, { shouldDirty: true });
  }, [open, usdArs, setValue]);

  const price = Number(priceRaw ?? 0) || 0;
  const cost =
    costRaw == null || (costRaw as unknown) === "" ? null : Number(costRaw);
  // ADR-151: margen y markup contra el costo final (compra + componentes).
  const purchaseCost = costing.cost_currency === "USD" ? usdArs : cost;
  const finalCostNow = calcFinalCost(purchaseCost, costing.cost_extras);
  const priceMode: PriceMode = watch("price_mode") === "open" ? "open" : "fixed";
  const { data: proLists = [] } = usePriceProLists();
  const listCosts = useMemo(() => ({ cost: purchaseCost, final_cost: finalCostNow }), [purchaseCost, finalCostNow]);

  function onInvalid(errs: FieldErrors<ProductInput>) {
    const first = Object.keys(errs)[0] as keyof ProductInput | undefined;
    const t = first ? FIELD_TAB[first] : undefined;
    if (t) setTab(t);
    toast({ title: "Revisá los datos marcados", variant: "error" });
  }

  async function saveExtras(productId: string) {
    if (!costingEquals(costing, costingSaved)) {
      await costingApi.save(productId, costing, costing.cost_currency === "USD" ? (fxQuote.data?.rate ?? null) : null);
      setCostingSaved(costing);
      await qc.invalidateQueries({ queryKey: ["products"] });
    }
    // H163: códigos alternativos y unidades de venta.
    const ad = diffAltCodes(savedAltCodes, altCodes);
    if (ad.insert.length + ad.remove.length > 0) {
      await altCodesApi.save(productId, savedAltCodes, altCodes);
      await qc.invalidateQueries({ queryKey: ["product-alt-codes", productId] });
    }
    const ud = diffSaleUnits(savedSaleUnits, saleUnits);
    if (ud.insert.length + ud.update.length + ud.remove.length > 0) {
      await saleUnitsApi.save(productId, savedSaleUnits, saleUnits);
      await qc.invalidateQueries({ queryKey: ["product-sale-units", productId] });
      await qc.invalidateQueries({ queryKey: ["sale-units-active"] });
    }
    if (!packagesAllowed) return;
    const d = diffPackages(savedPackages, packages);
    if (d.insert.length + d.update.length + d.remove.length === 0) return;
    await packagesApi.save(productId, savedPackages, packages);
    await qc.invalidateQueries({ queryKey: ["product-packages", productId] });
  }

  async function onSubmit(values: ProductInput) {
    const parsed = values as unknown as ProductOutput;
    const exclusive = [parsed.is_kit, parsed.is_serialized, parsed.has_variants].filter(Boolean);
    if (exclusive.length > 1) {
      toast({
        title: "Un producto no puede ser kit, serializado y con variantes a la vez",
        variant: "error",
      });
      return;
    }
    // H163: bultos válidos (no van con pesables, variantes ni serializados).
    const unitErr = saleUnits
      .map((u) => saleUnitError(u, { unit: parsed.unit, has_variants: parsed.has_variants, is_serialized: parsed.is_serialized, is_service: parsed.is_service }))
      .find(Boolean);
    if (unitErr) {
      setTab("precios");
      toast({ title: "Revisá la venta por bulto", description: unitErr, variant: "error" });
      keepGoingRef.current = false;
      return;
    }
    const keepGoing = keepGoingRef.current && !active;
    keepGoingRef.current = false;
    setSavingExtras(true);
    try {
      // Árbol de categorías: crea los niveles nuevos y usa la hoja.
      const path = normalizeNodes(nodes, categories);
      const categoryId = path.length === 0 ? null : await categoriesApi.ensurePath(path);
      if (path.some((n) => !n.id)) qc.invalidateQueries({ queryKey: ["categories"] });
      const wasOpen = active?.price_mode === "open";
      const input: ProductOutput = {
        ...parsed,
        // ADR-151: un producto fijo que sigue fijo no manda las columnas nuevas.
        price_mode: parsed.price_mode === "open" ? "open" : wasOpen ? "fixed" : undefined,
        category_id: categoryId,
        attributes: normalizeAttributes(attributes),
      };
      if (active) {
        await update.mutateAsync({ id: active.id, input });
        await saveExtras(active.id);
        toast({ title: `${Noun} actualizado`, variant: "success" });
        onOpenChange(false);
        return;
      }
      const nuevo = await create.mutateAsync(input);
      await saveExtras(nuevo.id);
      if (keepGoing) {
        // H163: "Grabar y seguir": form en blanco con la misma categoría.
        const keepNodes = nodes;
        toast({ title: `${Noun} creado: ${nuevo.name}`, description: "Seguí con el próximo.", variant: "success" });
        if (aiEnabled && imageMode === "ai") generateAiCover(nuevo.id);
        if (copyFrom) {
          onOpenChange(false);
          return;
        }
        setBlankKey((k) => k + 1);
        setTimeout(() => setNodes(keepNodes), 0);
        return;
      }
      setCreated(nuevo);
      // ADR-122: imagen elegida en General. Con IA se genera de fondo (no
      // bloquea el alta) para cualquier producto o servicio; "Subir foto"
      // lleva a Imágenes.
      if (aiEnabled && imageMode === "ai") generateAiCover(nuevo.id);
      else if (aiEnabled && imageMode === "upload") setTab("fotos");
      toast({
        title: `${Noun} creado`,
        description: isService ? undefined : "Ahora podés sumar imágenes o cargar componentes.",
        variant: "success",
      });
    } catch (e) {
      toast({
        title: "No se pudo guardar",
        description: barcodeTakenMessage(e) ?? errorDescription(e),
        variant: "error",
      });
    } finally {
      setSavingExtras(false);
    }
  }

  async function addBrand() {
    const name = normalizeBrandName(newBrand);
    if (!name) return;
    // Si ya existe (sin distinguir mayúsculas), se elige la existente.
    const existing = findBrandByName(brands, name);
    if (existing) {
      setValue("brand_id", existing.id);
      setNewBrand("");
      setAddingBrand(false);
      return;
    }
    try {
      const b = await createBrand.mutateAsync(name);
      setValue("brand_id", b.id);
      setNewBrand("");
      setAddingBrand(false);
      toast({ title: "Marca creada", variant: "success" });
    } catch {
      toast({ title: "No se pudo crear la marca", variant: "error" });
    }
  }

  const saving = create.isPending || update.isPending || savingExtras;
  const show = (k: TabKey) => (tab === k ? "space-y-6" : "hidden");

  // ADR-116: producto o servicio. Un servicio no lleva stock.
  function setItemType(service: boolean) {
    setValue("is_service", service, { shouldDirty: true });
    if (service) {
      setValue("track_stock", false, { shouldDirty: true });
      if (!SERVICE_UNITS.some((u) => u.value === watch("unit"))) setValue("unit", "un", { shouldDirty: true });
      if (SERVICE_HIDDEN_TABS.includes(tab)) setTab("general");
    } else if (tab === "servicio") {
      setTab("general");
    }
  }
  function toggleClarification(id: string, on: boolean) {
    const next = on ? [...clarificationIds.filter((x) => x !== id), id] : clarificationIds.filter((x) => x !== id);
    setValue("service_clarification_ids", next, { shouldDirty: true });
  }
  const visibleTabs = TABS.filter((t) => {
    if (t.key === "historial") return isEdit && historyAllowed;
    if (t.key === "servicio") return isService;
    return !(isService && SERVICE_HIDDEN_TABS.includes(t.key));
  });

  return (
    <Modal
      open={open}
      onOpenChange={onOpenChange}
      title={isEdit ? `Editar ${noun}` : isCopy ? `Nuevo ${noun} (copia de ${copyFrom?.name ?? ""})` : `Nuevo ${noun}`}
      className="sm:max-w-3xl"
      footer={
        <>
          <Button type="button" variant="secondary" onClick={() => onOpenChange(false)}>
            {created ? "Cerrar" : "Cancelar"}
          </Button>
          {!isEdit && (
            <Button
              type="button"
              variant="secondary"
              disabled={saving}
              onClick={() => {
                keepGoingRef.current = true;
                void handleSubmit(onSubmit, onInvalid)();
              }}
            >
              Grabar y seguir
            </Button>
          )}
          <Button type="submit" form="product-form" loading={saving}>
            {isEdit ? "Guardar" : `Crear ${noun}`}
          </Button>
        </>
      }
    >
      {/* Pestañas de secciones (relleno en la activa, sin bordes de color). */}
      <div className="sticky -top-5 z-10 -mx-5 -mt-5 mb-5 bg-popover px-5 pb-3 pt-4 backdrop-blur sm:-top-6 sm:-mx-6 sm:-mt-6 sm:px-6">
        <div className="-mx-1 flex [scrollbar-width:none] [&::-webkit-scrollbar]:hidden gap-1 overflow-x-auto px-1">
          {visibleTabs.map((t) => {
            const on = tab === t.key;
            const Icon = t.icon;
            return (
              <button
                key={t.key}
                type="button"
                onClick={() => setTab(t.key)}
                className={cn(
                  "inline-flex shrink-0 items-center gap-1.5 rounded-md px-3 py-1.5 text-xs font-semibold outline-none transition focus-visible:bg-muted",
                  on
                    ? "bg-ninja-flame/[0.12] text-ninja-flameSoft"
                    : "text-muted-foreground hover:bg-muted hover:text-foreground",
                )}
              >
                <Icon size={14} /> {t.label}
              </button>
            );
          })}
        </div>
      </div>

      <form id="product-form" onSubmit={handleSubmit(onSubmit, onInvalid)} noValidate>
        {/* ── General ─────────────────────────────────────────────── */}
        <div className={show("general")}>
          <Group>
            {/* ADR-116: con servicios en el catálogo, cada ítem dice qué es. */}
            {catalogMode !== "productos" && (
              <div role="radiogroup" aria-label="Tipo de ítem" className="grid grid-cols-2 gap-1 rounded-xl bg-muted p-1">
                {[
                  { v: false, label: "Producto" },
                  { v: true, label: "Servicio" },
                ].map((o) => (
                  <button
                    key={o.label}
                    type="button"
                    role="radio"
                    aria-checked={isService === o.v}
                    onClick={() => setItemType(o.v)}
                    className={cn(
                      "h-9 rounded-lg text-sm font-semibold outline-none transition focus-visible:bg-secondary",
                      isService === o.v ? "bg-popover text-foreground" : "text-muted-foreground hover:text-foreground",
                    )}
                  >
                    {o.label}
                  </button>
                ))}
              </div>
            )}
            <Input
              variant="filled"
              label="Nombre"
              placeholder={isService ? "Ej. Análisis microbiológico de agua" : undefined}
              error={errors.name?.message}
              {...register("name")}
            />
            {!isService && (
            <div className="grid grid-cols-2 gap-3">
              <div>
                <label className="mb-1.5 block text-xs font-medium text-muted-foreground">Marca</label>
                <div className="relative">
                  <select className={selectCls} {...register("brand_id")}>
                    <option value="" className="bg-popover text-popover-foreground">
                      Sin marca
                    </option>
                    {brands?.map((b) => (
                      <option key={b.id} value={b.id} className="bg-popover text-popover-foreground">
                        {b.name}
                      </option>
                    ))}
                  </select>
                  <ChevronDown
                    size={15}
                    className="pointer-events-none absolute right-3 top-1/2 -translate-y-1/2 text-muted-foreground"
                  />
                </div>
              </div>
              <Input variant="filled" label="Modelo" placeholder="Opcional" {...register("model")} />
            </div>
            )}
            {isService ? null : addingBrand ? (
              <div className="flex gap-2">
                <Input
                  variant="filled"
                  value={newBrand}
                  onChange={(e) => setNewBrand(e.target.value.toLocaleUpperCase("es-AR"))}
                  placeholder="NOMBRE DE LA MARCA"
                  autoFocus
                  className="h-10 uppercase"
                />
                <Button type="button" size="sm" className="h-10" onClick={addBrand} loading={createBrand.isPending}>
                  Crear
                </Button>
                <Button type="button" size="sm" variant="ghost" className="h-10" onClick={() => setAddingBrand(false)}>
                  Cancelar
                </Button>
              </div>
            ) : (
              <button
                type="button"
                onClick={() => setAddingBrand(true)}
                className="-mt-1 inline-flex items-center gap-1 text-xs font-medium text-muted-foreground transition hover:text-foreground"
              >
                <Plus size={13} /> Nueva marca
              </button>
            )}
            <label className="block">
              <span className="mb-1.5 block text-xs font-medium text-muted-foreground">
                {isService ? "Descripción del servicio" : "Descripción"}
              </span>
              <textarea
                className={textareaCls}
                placeholder={
                  isService
                    ? "Qué incluye, alcance, metodología, plazos de entrega..."
                    : "Qué es, para qué sirve, presentación, cuidados..."
                }
                maxLength={4000}
                {...register("description")}
              />
              {errors.description?.message && (
                <span className="mt-1 block text-xs text-destructive">{errors.description.message}</span>
              )}
            </label>
          </Group>

          <Group title="Imagen" description={active ? undefined : "Elegí cómo querés la imagen de este ítem."}>
            <ProductImageChoice
              mode={imageMode}
              onMode={(m) => {
                setImageMode(m);
                setImageModeTouched(true);
              }}
              aiEnabled={aiEnabled}
              styleName={aiSettings?.style ? coverStyleInfo(aiSettings.style).name : null}
              saved={Boolean(active)}
              imageUrl={freshImage ?? active?.image_url ?? null}
              noun={noun}
              generating={aiMut.generate.isPending}
              onGenerate={() => active && generateAiCover(active.id)}
              onGoImages={() => setTab("fotos")}
            />
          </Group>

          <Group title="Árbol de jerarquía" description="Rubro, categoría y subcategoría. Elegí existentes o creá nuevas acá mismo.">
            <CategoryPathEditor value={nodes} onChange={setNodes} categories={categories} />
          </Group>

          <Group title="Visibilidad">
            <div className="divide-y divide-border rounded-lg bg-muted">
              <SettingRow
                title="Activo"
                description="Se puede vender y aparece en el POS."
                control={
                  <Switch
                    checked={Boolean(isActive)}
                    onCheckedChange={(v) => setValue("is_active", v, { shouldDirty: true })}
                    label="Activo"
                  />
                }
              />
              <SettingRow
                title="Favorito (botón rápido del POS)"
                description="Aparece como botón grande para cobrarlo sin buscar."
                control={
                  <Switch
                    checked={Boolean(isFavorite)}
                    onCheckedChange={(v) => setValue("is_favorite", v, { shouldDirty: true })}
                    label="Favorito"
                  />
                }
              />
              <SettingRow
                title="No acepta descuentos"
                description="En el POS no se le puede hacer descuento manual (las promociones y cupones sí aplican)."
                control={
                  <Switch
                    checked={Boolean(noDiscount)}
                    onCheckedChange={(v) => setValue("no_discount", v, { shouldDirty: true })}
                    label="No acepta descuentos"
                  />
                }
              />
            </div>
          </Group>
        </div>

        {/* ── Servicio (ADR-116) ──────────────────────────────────── */}
        {isService && (
          <div className={show("servicio")}>
            <Group
              title="Tipo de servicio"
              description="Programa, visita, trabajo, informe o los tuyos. Sale en el presupuesto y la factura, y sirve de filtro."
              aside={
                <button
                  type="button"
                  onClick={() => setTypesOpen(true)}
                  className="shrink-0 rounded-md px-1 text-xs font-semibold text-ninja-flameSoft outline-none hover:underline focus-visible:underline"
                >
                  Administrar
                </button>
              }
            >
              <div className="relative">
                <select className={selectCls} aria-label="Tipo de servicio" {...register("service_type_id")}>
                  <option value="" className="bg-popover text-popover-foreground">
                    Sin tipo
                  </option>
                  {serviceTypes
                    .filter((t) => t.is_active || t.id === watch("service_type_id"))
                    .map((t) => (
                      <option key={t.id} value={t.id} className="bg-popover text-popover-foreground">
                        {t.name}
                      </option>
                    ))}
                </select>
                <ChevronDown
                  size={15}
                  className="pointer-events-none absolute right-3 top-1/2 -translate-y-1/2 text-muted-foreground"
                />
              </div>
            </Group>

            <Group title="Unidad y duración" description="Cómo se cobra: por hora, visita, informe, análisis, muestra o mes.">
              <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
                <div>
                  <label className="mb-1.5 block text-xs font-medium text-muted-foreground">Unidad</label>
                  <div className="relative">
                    <select className={selectCls} {...register("unit")}>
                      {SERVICE_UNITS.map((u) => (
                        <option key={u.value} value={u.value} className="bg-popover text-popover-foreground">
                          {u.label}
                        </option>
                      ))}
                    </select>
                    <ChevronDown
                      size={15}
                      className="pointer-events-none absolute right-3 top-1/2 -translate-y-1/2 text-muted-foreground"
                    />
                  </div>
                </div>
                <Input
                  variant="filled"
                  label="Duración estimada (min)"
                  type="number"
                  step="5"
                  min="0"
                  placeholder="Ej. 90"
                  error={errors.service_duration_min?.message}
                  {...register("service_duration_min")}
                />
                <Input
                  variant="filled"
                  label="Comisión (%)"
                  type="number"
                  step="1"
                  min="0"
                  max="100"
                  placeholder="Opcional"
                  error={errors.commission_pct?.message}
                  {...register("commission_pct")}
                />
              </div>
            </Group>

            <Group
              title="Detalle para la factura"
              description="Sale debajo del nombre en la factura y el ticket. Empezá una línea con un guion para armar una lista. En el POS se puede cambiar en cada venta."
            >
              <textarea
                className={textareaCls}
                placeholder={"Recuento de aerobios mesófilos\n- Coliformes totales y fecales\n- Informe firmado por profesional matriculado"}
                maxLength={2000}
                {...register("invoice_detail")}
              />
              {errors.invoice_detail?.message && (
                <span className="block text-xs text-destructive">{errors.invoice_detail.message}</span>
              )}
            </Group>

            <Group
              title="Aclaraciones que se suman solas"
              description="Plantillas de texto del negocio. Al vender se pueden sacar o sumar otras."
              aside={
                <button
                  type="button"
                  onClick={() => setClarificationsOpen(true)}
                  className="shrink-0 rounded-md px-1 text-xs font-semibold text-ninja-flameSoft outline-none hover:underline focus-visible:underline"
                >
                  Administrar
                </button>
              }
            >
              {clarifications.filter((c) => c.is_active).length === 0 ? (
                <SaveFirst>
                  Todavía no cargaste aclaraciones. Tocá Administrar para crear, por ejemplo, &quot;Incluye toma de
                  muestras&quot; o &quot;Normativa CAA art. 1413&quot;.
                </SaveFirst>
              ) : (
                <div className="divide-y divide-border rounded-lg bg-muted">
                  {clarifications
                    .filter((c) => c.is_active)
                    .map((c) => (
                      <SettingRow
                        key={c.id}
                        title={c.title}
                        description={c.body}
                        control={
                          <Switch
                            checked={clarificationIds.includes(c.id)}
                            onCheckedChange={(v) => toggleClarification(c.id, v)}
                            label={`Sumar ${c.title}`}
                          />
                        }
                      />
                    ))}
                </div>
              )}
            </Group>
          </div>
        )}

        {/* ── Precios ─────────────────────────────────────────────── */}
        <div className={show("precios")}>
          <Group title={isService ? "Honorarios" : "Precio"}>
            <ProductPriceSection
              active={open && tab === "precios"}
              isService={isService}
              ivaPct={ivaPct}
              price={price}
              finalCost={finalCostNow}
              priceRegister={register("price")}
              costRegister={register("cost")}
              priceError={errors.price?.message}
              costError={errors.cost?.message}
              costReadOnly={costing.cost_currency === "USD"}
              onPriceChange={(p) => setValue("price", p, { shouldDirty: true })}
              priceMode={priceMode}
              onPriceModeChange={(m) => setValue("price_mode", m, { shouldDirty: true })}
              openMinRegister={register("open_price_min")}
              openMaxRegister={register("open_price_max")}
              openMin={watch("open_price_min") as string | number | null | undefined}
              openMax={watch("open_price_max") as string | number | null | undefined}
              openMaxError={errors.open_price_max?.message}
            />
            {/* Referencia de mercado (ADR-109): sólo con catálogo y el switch del dueño prendido. */}
            <MarketReferencePanel ean={barcodeVal} myPrice={price} className="pt-2" />
          </Group>

          {!isService && (
            <Group
              title="Venta por bulto"
              description="Vendé por caja, pack o bulto: 1 bulto descuenta sus unidades del stock. Precio propio o el de las unidades con descuento."
            >
              {active && unitsLoading ? (
                <div className="grid h-16 place-items-center">
                  <Spinner />
                </div>
              ) : (
                <SaleUnitsEditor
                  value={saleUnits}
                  onChange={setSaleUnits}
                  unitPrice={price}
                  allowDiscount={!noDiscount}
                  product={{ unit: watch("unit"), has_variants: hasVariants, is_serialized: isSerialized, is_service: isService }}
                />
              )}
            </Group>
          )}

          <Group
            title="Listas de precios"
            description="Cómo queda este precio en cada lista activa y de dónde sale, con la misma cuenta que usa el POS."
          >
            <ProductListPrices
              productId={active?.id ?? null}
              price={price}
              lists={proLists}
              priceMode={priceMode}
              costs={listCosts}
            />
          </Group>
          <Group
            title="Impuestos"
            description="Alícuota de IVA del catálogo, servicio e impuestos internos. El precio de venta es final (con IVA)."
          >
            <ProductTaxFields register={register} watch={watch} setValue={setValue} price={price} cost={cost ?? 0} />
          </Group>

          {/* Lo avanzado del costo, plegado salvo que ya tenga datos. */}
          <Disclosure
            title="Costo final, utilidad objetivo y costos de compra"
            open={advancedOpen}
            onOpenChange={setAdvancedOpen}
          >
            <div className="space-y-6">
              <Group
                title="Costo final y utilidad"
                description="Costo de compra en pesos o dólares, lo que se le suma y la ganancia que buscás."
              >
                <ProductCostBuilder
                  draft={costing}
                  onChange={setCosting}
                  arsCost={cost}
                  price={price}
                  ivaPct={ivaPct}
                  quote={fxQuote.data}
                  onUsePrice={(p) => setValue("price", p, { shouldDirty: true })}
                />
              </Group>

              <Group
                title="Costos de compra"
                description="Último costo, promedio ponderado y reposición, sin IVA. El que elegiste en Configuración de compras alimenta el margen."
              >
                <ProductCostsPanel
                  product={active}
                  price={price}
                  replacementField={register("replacement_cost")}
                />
                {errors.replacement_cost?.message && (
                  <p className="text-xs text-destructive">{errors.replacement_cost.message}</p>
                )}
              </Group>
            </div>
          </Disclosure>
        </div>

        {/* ── Stock ───────────────────────────────────────────────── */}
        <div className={show("stock")}>
          <Group>
            <div className="divide-y divide-border rounded-lg bg-muted">
              <SettingRow
                title="Controla stock"
                description="Si está apagado, no descuenta stock al venderse (ej. servicios)."
                control={
                  <Switch
                    checked={Boolean(trackStock)}
                    onCheckedChange={(v) => setValue("track_stock", v, { shouldDirty: true })}
                    label="Controla stock"
                  />
                }
              />
            </div>
            <div className="grid grid-cols-3 gap-3">
              {!isEdit && (
                <Input
                  variant="filled"
                  label="Stock inicial"
                  type="number"
                  step="0.001"
                  disabled={Boolean(hasVariants)}
                  {...register("stock")}
                />
              )}
              <Input
                variant="filled"
                label="Stock mínimo"
                type="number"
                step="0.001"
                disabled={Boolean(hasVariants)}
                {...register("stock_min")}
              />
              {!isService && <Input variant="filled" label="Unidad" placeholder="un, kg, lt" {...register("unit")} />}
            </div>
            {hasVariants && (
              <p className="text-xs text-muted-foreground">
                Este producto tiene variantes: el stock vive en cada combinación, no en el producto padre.
              </p>
            )}
            <div>
              <label className="mb-1.5 block text-xs font-medium text-muted-foreground">Venta sin stock</label>
              <div className="relative">
                <select className={selectCls} {...register("allow_negative")}>
                  <option value="inherit" className="bg-popover text-popover-foreground">
                    Según configuración general
                  </option>
                  <option value="yes" className="bg-popover text-popover-foreground">
                    Permitir igual (vende en negativo)
                  </option>
                  <option value="no" className="bg-popover text-popover-foreground">
                    No permitir
                  </option>
                </select>
                <ChevronDown
                  size={15}
                  className="pointer-events-none absolute right-3 top-1/2 -translate-y-1/2 text-muted-foreground"
                />
              </div>
            </div>
            {active && trackStock && <StoreStockPanel product={active} />}
          </Group>
        </div>

        {/* ── Códigos ─────────────────────────────────────────────── */}
        <div className={show("codigos")}>
          <Group>
            <div className="grid grid-cols-2 gap-3">
              <Input
                variant="filled"
                label={isService ? "Código interno" : "SKU"}
                placeholder={isService ? "Ej. AN-MIC-01" : "Código interno"}
                {...register("sku")}
              />
              {!isService && (
                <Input
                  variant="filled"
                  label="Código de barras (EAN)"
                  inputMode="numeric"
                  {...register("barcode")}
                />
              )}
            </div>
            {!isService && barcodeVal?.trim() ? (
              <div className="flex flex-col items-center gap-1.5 rounded-lg bg-white px-4 py-4 text-black">
                <Barcode value={barcodeVal.trim().toUpperCase()} height={44} />
                <span className="font-mono text-xs tracking-widest">{barcodeVal.trim()}</span>
              </div>
            ) : null}
            {pluEnabled && !isService && (
              <Input
                variant="filled"
                label="PLU (código corto)"
                inputMode="numeric"
                maxLength={6}
                placeholder={
                  active?.plu
                    ? undefined
                    : plu?.mode === "incremental"
                      ? "Se asigna solo (correlativo)"
                      : "Se asigna solo (aleatorio)"
                }
                hint="6 dígitos para tipear el producto en el POS. Vacío = automático."
                error={errors.plu?.message}
                {...register("plu")}
              />
            )}
          </Group>
          {!isService && (
            <Group
              title="Códigos alternativos"
              description="Otro EAN, el código del fabricante o el del proveedor: el scanner y el buscador los encuentran igual que al principal."
            >
              {active && altLoading ? (
                <div className="grid h-16 place-items-center">
                  <Spinner />
                </div>
              ) : (
                <AltCodesEditor
                  value={altCodes}
                  onChange={setAltCodes}
                  mainBarcode={barcodeVal}
                  suppliers={suppliers.map((x) => ({ id: x.id, name: x.name }))}
                />
              )}
            </Group>
          )}
        </div>

        {/* ── Atributos ───────────────────────────────────────────── */}
        <div className={show("atributos")}>
          <Group title="Atributos" description="Color, talle, material, contenido: lo que describa al producto.">
            <AttributesEditor value={attributes} onChange={setAttributes} />
          </Group>
          <Group title="Etiquetas y garantía">
            <div className="grid grid-cols-2 gap-3">
              <Input variant="filled" label="Temporada" placeholder="Verano 2026" {...register("season")} />
              <Input variant="filled" label="Tags" placeholder="oferta, premium" {...register("tags")} />
            </div>
            <Input
              variant="filled"
              label="Garantía de fábrica (meses)"
              type="number"
              step="1"
              min="0"
              className="max-w-[200px]"
              {...register("warranty_months")}
            />
          </Group>
        </div>

        {/* ── Fotos ───────────────────────────────────────────────── */}
        <div className={show("fotos")}>
          {active ? (
            <div className="space-y-4">
              <ProductImages productId={active.id} tenantId={active.tenant_id} legacyUrl={active.image_url} />
              {/* ADR-122: portada con IA (complemento Asistente IA). */}
              <AiCoverPanel productId={active.id} canManage={Boolean(myTenant?.canManage)} />
            </div>
          ) : (
            <Group>
              <SaveFirst>Guardá y después subí las fotos o generalas con IA acá mismo (se guardan como WebP). En General elegís si al guardar se genera con IA.</SaveFirst>
              <Input
                variant="filled"
                label="O pegá la URL de una imagen"
                placeholder="https://"
                {...register("image_url")}
              />
            </Group>
          )}
        </div>

        {/* ── Medidas y bultos ────────────────────────────────────── */}
        <div className={show("medidas")}>
          <Group
            title="Medidas y bultos"
            description="Cada bulto con sus medidas, peso y unidades. Calcula volumen, m³ y peso volumétrico."
          >
            <FeatureGate feature="medidas_bultos" featureLabel="Medidas por bulto">
              {active && packagesLoading ? (
                <div className="grid h-32 place-items-center">
                  <Spinner />
                </div>
              ) : (
                <PackagesEditor value={packages} onChange={setPackages} productName={nameVal || undefined} />
              )}
            </FeatureGate>
          </Group>
        </div>

        {/* ── Más (tipo de producto, servicio, cocina) ────────────── */}
        <div className={show("mas")}>
          {!isService && (
            <Group title="Se usa para" description="Un insumo no aparece en el POS ni en el catálogo online; lo de sólo venta no aparece al comprar.">
              <div className="grid gap-2 sm:grid-cols-3">
                {USAGE_OPTIONS.map((o) => {
                  const on = usageOf({ usage: watch("usage") }) === o.value;
                  return (
                    <button
                      key={o.value}
                      type="button"
                      aria-pressed={on}
                      onClick={() => setValue("usage", o.value as ProductUsage, { shouldDirty: true })}
                      className={cn(
                        "rounded-lg px-3 py-2.5 text-left transition",
                        on ? "bg-ninja-flame/[0.12] text-ninja-flameSoft" : "bg-muted hover:bg-muted/70",
                      )}
                    >
                      <span className="block text-sm font-semibold">{o.label}</span>
                      <span className="block text-xs text-muted-foreground">{o.hint}</span>
                    </button>
                  );
                })}
              </div>
            </Group>
          )}
          {!isService && (
          <Group title="Tipo de producto">
            <div className="divide-y divide-border rounded-lg bg-muted">
              <SettingRow
                title="Es un kit / combo"
                description="Sin stock propio; descuenta el de sus componentes."
                disabled={kitDisabled}
                hint={kitDisabled ? exclusiveHint : undefined}
                control={
                  <Switch
                    checked={Boolean(isKit)}
                    disabled={kitDisabled}
                    onCheckedChange={(v) => setValue("is_kit", v, { shouldDirty: true })}
                    label="Kit"
                  />
                }
              />
              <SettingRow
                title="Serializado (IMEI / N° de serie)"
                description="Cada unidad tiene un serial único."
                disabled={serializedDisabled}
                hint={serializedDisabled ? exclusiveHint : undefined}
                control={
                  <Switch
                    checked={Boolean(isSerialized)}
                    disabled={serializedDisabled}
                    onCheckedChange={(v) => setValue("is_serialized", v, { shouldDirty: true })}
                    label="Serializado"
                  />
                }
              />
              <FeatureGate feature="variantes" featureLabel="Variantes">
                <SettingRow
                  title="Tiene variantes (talle / color)"
                  description="Combinaciones con SKU, precio y stock propios."
                  disabled={variantsDisabled}
                  hint={variantsDisabled ? exclusiveHint : undefined}
                  control={
                    <Switch
                      checked={Boolean(hasVariants)}
                      disabled={variantsDisabled}
                      onCheckedChange={(v) => setValue("has_variants", v, { shouldDirty: true })}
                      label="Variantes"
                    />
                  }
                />
              </FeatureGate>
            </div>
            {isKit && (active ? <KitComponentsEditor kitId={active.id} /> : <SaveFirst>Guardá el combo primero; después cargás sus componentes acá mismo.</SaveFirst>)}
            {isSerialized && (active ? <SerialsEditor productId={active.id} /> : <SaveFirst>Guardá el producto primero; después cargás los seriales acá mismo.</SaveFirst>)}
            {hasVariants &&
              (active ? (
                <VariantsEditor
                  productId={active.id}
                  tenantId={active.tenant_id}
                  parentSku={active.sku}
                  parentPrice={active.price}
                />
              ) : (
                <SaveFirst>Guardá el producto primero; después definís los ejes y generás las combinaciones.</SaveFirst>
              ))}
          </Group>
          )}

          {!isService && (
          <Disclosure title="Servicio para agenda (duración y comisión)">
            <div className="space-y-3">
              <p className="text-xs text-muted-foreground">
                Para peluquería, estética y servicios con turnos. Dejalo vacío si es un producto común.
              </p>
              <div className="grid grid-cols-2 gap-3">
                <Input
                  variant="filled"
                  label="Duración (min)"
                  type="number"
                  step="5"
                  min="0"
                  placeholder="Ej. 45"
                  error={errors.service_duration_min?.message}
                  {...register("service_duration_min")}
                />
                <Input
                  variant="filled"
                  label="Comisión (%)"
                  type="number"
                  step="1"
                  min="0"
                  max="100"
                  placeholder="Ej. 30"
                  error={errors.commission_pct?.message}
                  {...register("commission_pct")}
                />
              </div>
            </div>
          </Disclosure>
          )}

          {diningEnabled && !isService && (
            <Disclosure title="Estación de cocina (KDS)">
              <div className="relative">
                <select className={selectCls} {...register("station")}>
                  <option value="" className="bg-popover text-popover-foreground">
                    Sin estación
                  </option>
                  {KDS_STATIONS.map((s) => (
                    <option key={s} value={s} className="bg-popover text-popover-foreground">
                      {KDS_STATION_LABELS[s]}
                    </option>
                  ))}
                </select>
                <ChevronDown
                  size={15}
                  className="pointer-events-none absolute right-3 top-1/2 -translate-y-1/2 text-muted-foreground"
                />
              </div>
            </Disclosure>
          )}

          <Disclosure title="Modificadores (tamaños / sabores / toppings)">
            {active ? (
              <ModifiersEditor productId={active.id} />
            ) : (
              <SaveFirst>Guardá el producto primero; después cargás los grupos de modificadores.</SaveFirst>
            )}
          </Disclosure>

          {!isService && (
            <Disclosure title="Receta / escandallo (costo y margen)">
              {active ? (
                <RecipeEditor productId={active.id} salePrice={active.price} />
              ) : (
                <SaveFirst>Guardá el producto primero; después cargás la receta (insumos y costos).</SaveFirst>
              )}
            </Disclosure>
          )}

          {mlAllowed && active && (
            <Disclosure title="Mercado Libre">
              <MlProductPanel productId={active.id} canManage={Boolean(myTenant?.canManage)} />
            </Disclosure>
          )}
        </div>
      </form>
      {/* ── Historial de precios (fuera del form: sólo lectura) ─────── */}
      {active && historyAllowed && (
        <div className={show("historial")}>
          {tab === "historial" && <ProductPricesPanel productId={active.id} canEdit={Boolean(myTenant?.canManage)} />}
          <PriceHistoryPanel
            productId={active.id}
            active={tab === "historial"}
            lists={new Map(priceLists.map((l) => [l.id, l.name]))}
            variants={variantNames}
          />
        </div>
      )}
      <ClarificationsModal open={clarificationsOpen} onOpenChange={setClarificationsOpen} />
      <ServiceTypesModal open={typesOpen} onOpenChange={setTypesOpen} />
    </Modal>
  );
}
