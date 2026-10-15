"use client";

import { useEffect, useMemo, useState } from "react";
import { CheckCircle2, ExternalLink, Info, Plus, Sparkles, Trash2, Truck } from "lucide-react";
import { Modal } from "@/components/ui/Modal";
import { Badge } from "@/components/ui/Badge";
import { Button } from "@/components/ui/Button";
import { Callout } from "@/components/ui/Callout";
import { Checkbox } from "@/components/ui/Checkbox";
import { Input } from "@/components/ui/Input";
import { Segmented } from "@/components/ui/Segmented";
import { Switch } from "@/components/ui/Switch";
import { SpinnerBlock } from "@/components/ui/Spinner";
import { useToast } from "@/components/ui/Toast";
import { cn } from "@/lib/utils/cn";
import { formatCurrency } from "@/lib/utils/format";
import { selectCls } from "@/components/stock/transfers/shared";
import { LISTING_TYPE_LABELS, mlCauseInfo, mlErrorMessage } from "@/lib/mercadolibre/labels";
import { fieldsForCondition, filterCategorySuggestions } from "@/supabase/functions/_shared/mercadolibre/items";
import { SHIPPING_MODE_LABELS, SHIPPING_REASONS } from "@/supabase/functions/_shared/mercadolibre/shipping";
import {
  mlPublishApi,
  useMlChannelPreview,
  type AttrField,
  type MlAccount,
  type MlCategoryInfo,
  type MlDomainSuggestion,
  type MlPublishResult,
  type PublishInput,
  type ShippingInput,
  type ShippingMode,
  type ShippingPlan,
} from "@/modules/mercadolibre/hooks";

// Publicar un producto del catálogo en Mercado Libre (H87 · ADR-104):
// predictor de categoría, atributos obligatorios de la categoría, validación
// previa (/items/validate) y publicación con el precio del canal y el stock
// publicable de la cuenta. Vendedor User Products: un ítem por variante con la
// misma familia; clásico: un ítem con variaciones.

// Respaldo si la categoría no trae las opciones de EMPTY_GTIN_REASON
// (se usan las de la categoría cuando vienen). Ids leídos de MLA1644 el 2026-10-15.
const EMPTY_GTIN_FALLBACK = [
  { id: "17055160", name: "El producto no tiene código registrado" },
  { id: "17055159", name: "Es un kit o pack armado por mí" },
  { id: "17055158", name: "Es artesanal o hecho a medida" },
  { id: "17055161", name: "Otra razón" },
];

type CostRow = { description: string; cost: string };

/** Errores de ML en español con la acción; el código crudo, en un desplegable. */
function MlErrorList({ errors }: { errors: string[] }) {
  const infos = errors.map(mlCauseInfo);
  const raw = infos.filter((i) => i.code);
  return (
    <div className="space-y-2">
      <ul className="list-disc space-y-1.5 pl-4">
        {infos.map((i, k) => (
          <li key={k}>
            {i.message}
            {i.action && <span className="block text-xs text-muted-foreground">{i.action}</span>}
          </li>
        ))}
      </ul>
      {raw.length > 0 && (
        <details className="text-xs text-muted-foreground">
          <summary className="cursor-pointer">Ver detalle técnico</summary>
          <ul className="mt-1 space-y-1 font-mono break-all">
            {raw.map((i, k) => (
              <li key={k}>{i.raw}</li>
            ))}
          </ul>
        </details>
      )}
    </div>
  );
}

type AttrValues = Record<string, { value_id?: string | null; value_name?: string | null }>;

function AttrInputField({ f, value, onChange }: { f: AttrField; value: AttrValues[string] | undefined; onChange: (v: AttrValues[string]) => void }) {
  const label = `${f.name}${f.required ? " *" : ""}`;
  if (f.options.length > 0 && f.valueType !== "number_unit") {
    return (
      <label className="block space-y-1 text-sm">
        <span className="font-medium">{label}</span>
        <select
          className={selectCls}
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
      </label>
    );
  }
  return (
    <Input
      label={label}
      value={value?.value_name ?? ""}
      maxLength={f.maxLength ?? 255}
      hint={f.valueType === "number_unit" && f.defaultUnit ? `Con unidad, por ejemplo 10 ${f.defaultUnit}` : (f.hint ?? undefined)}
      onChange={(e) => onChange({ value_name: e.target.value })}
    />
  );
}

export function MlPublishModal({
  open,
  onOpenChange,
  productId,
  accounts,
}: {
  open: boolean;
  onOpenChange: (o: boolean) => void;
  productId: string;
  accounts: MlAccount[];
}) {
  const { toast } = useToast();
  const active = accounts.filter((a) => a.status === "active");
  const [accountId, setAccountId] = useState<string | null>(active[0]?.id ?? null);
  const account = active.find((a) => a.id === accountId) ?? null;
  const { data: pv, isLoading } = useMlChannelPreview(open ? accountId : null, open ? productId : null);

  const [title, setTitle] = useState("");
  const [price, setPrice] = useState("");
  const [qty, setQty] = useState("");
  const [listing, setListing] = useState("gold_special");
  const [condition, setCondition] = useState<"new" | "used">("new");
  const [gtin, setGtin] = useState("");
  const [emptyGtin, setEmptyGtin] = useState("");
  const [freeShipping, setFreeShipping] = useState(false);
  const [shipPlan, setShipPlan] = useState<ShippingPlan | null>(null);
  const [shipLoading, setShipLoading] = useState(false);
  const [shipMode, setShipMode] = useState<ShippingMode>("me2");
  const [localPickUp, setLocalPickUp] = useState(false);
  const [costs, setCosts] = useState<CostRow[]>([{ description: "Envío a todo el país", cost: "" }]);
  const [notices, setNotices] = useState<string[]>([]);
  const [suggestions, setSuggestions] = useState<MlDomainSuggestion[]>([]);
  const [categoryId, setCategoryId] = useState("");
  const [cat, setCat] = useState<MlCategoryInfo | null>(null);
  const [attrs, setAttrs] = useState<AttrValues>({});
  const [axis1, setAxis1] = useState("");
  const [axis2, setAxis2] = useState("");
  const [errors, setErrors] = useState<string[]>([]);
  const [validated, setValidated] = useState(false);
  const [busy, setBusy] = useState<"predict" | "category" | "validate" | "publish" | null>(null);
  const [published, setPublished] = useState<Array<{ ml_item_id: string; permalink: string | null }> | null>(null);
  // Otros tipos de publicación con el precio de las reglas (ADR-132).
  const [extraTypes, setExtraTypes] = useState<string[]>([]);

  // Prefill desde el POS.
  useEffect(() => {
    if (!pv) return;
    setTitle(pv.name.slice(0, 60));
    // Precio del canal 0 o sin calcular: se deja vacío para que lo cargue (nunca se manda 0).
    setPrice(pv.price != null && Number(pv.price) > 0 ? String(pv.price) : "");
    setQty(pv.qty != null ? String(pv.qty) : "0");
    setGtin(pv.barcode ?? "");
    setListing(pv.listing_type || account?.default_listing_type || "gold_special");
  }, [pv, account?.default_listing_type]);

  useEffect(() => {
    if (!open) {
      setSuggestions([]);
      setCategoryId("");
      setCat(null);
      setAttrs({});
      setErrors([]);
      setNotices([]);
      setShipPlan(null);
      setValidated(false);
      setPublished(null);
      setExtraTypes([]);
    }
  }, [open]);

  const hasVariants = Boolean(pv?.has_variants && pv.variants.length > 0);
  // Sólo los atributos que aplican a la condición (GRADING es de reacondicionados).
  const condFields = useMemo(() => fieldsForCondition(cat?.attributes ?? [], condition), [cat, condition]);
  const variationAttrs = useMemo(() => condFields.filter((a) => a.variationAttribute || a.allowVariations), [condFields]);
  const formFields = useMemo(
    () => condFields.filter((a) => !["SELLER_SKU", "GTIN", "ITEM_CONDITION", "EMPTY_GTIN_REASON"].includes(a.id) && !(hasVariants && (a.id === axis1 || a.id === axis2))),
    [condFields, hasVariants, axis1, axis2],
  );
  const gtinApplies = !cat || condFields.some((a) => a.id === "GTIN") || !(cat.attributes ?? []).some((a) => a.id === "GTIN");

  const changeCondition = (c: "new" | "used") => {
    setCondition(c);
    setValidated(false);
    // Lo cargado en atributos que no aplican a la nueva condición no se manda.
    const keep = new Set(fieldsForCondition(cat?.attributes ?? [], c).map((f) => f.id));
    setAttrs((prev) => Object.fromEntries(Object.entries(prev).filter(([id]) => keep.has(id) || !(cat?.attributes ?? []).some((f) => f.id === id))));
  };

  const loadShipping = async (catId: string, accId: string | null = accountId) => {
    if (!accId) return;
    setShipLoading(true);
    let plan: ShippingPlan;
    try {
      plan = (await mlPublishApi.shipping(accId, catId)).shipping;
    } catch {
      // Sin datos: se intenta Mercado Envíos y el servidor pasa a "a convenir" si ML no lo acepta.
      plan = { mode: "me2", allowed: ["me2", "not_specified", "custom"], freeShippingAllowed: true, reason: SHIPPING_REASONS.unknown, known: false };
    } finally {
      setShipLoading(false);
    }
    setShipPlan(plan);
    setShipMode(plan.mode);
    if (!plan.freeShippingAllowed) setFreeShipping(false);
  };

  // Precio del canal: de dónde sale (lista de precios de la cuenta o precio del producto).
  const channelPrice = pv?.price != null ? Number(pv.price) : null;
  const priceSource = account?.price_list_id
    ? "la lista de precios elegida para Mercado Libre (Configuración > Integraciones > Mercado Libre)"
    : `el precio del producto en el POS${Number(account?.price_markup_pct ?? 0) ? ` más el ${Number(account?.price_markup_pct)}% de margen de la cuenta` : ""}`;
  const priceHint =
    channelPrice != null && channelPrice > 0
      ? `Precio del canal: ${formatCurrency(channelPrice)}. Sale de ${priceSource}.`
      : `El precio del canal salió en cero: sale de ${priceSource} y ahí no hay precio cargado. Cargalo acá para esta publicación.`;

  const applyResult = (r: MlPublishResult) => {
    setNotices(r.notices ?? []);
    if (r.removed_attributes?.length) {
      const drop = new Set(r.removed_attributes);
      setAttrs((prev) => Object.fromEntries(Object.entries(prev).filter(([id]) => !drop.has(id))));
    }
    if (r.shipping) setShipPlan(r.shipping);
    if (r.applied_shipping) {
      setShipMode(r.applied_shipping.mode);
      setFreeShipping(Boolean(r.applied_shipping.freeShipping));
    }
  };
  const emptyGtinOptions = useMemo(() => {
    const opts = (cat?.attributes ?? []).find((a) => a.id === "EMPTY_GTIN_REASON")?.options ?? [];
    return opts.length > 0 ? opts : EMPTY_GTIN_FALLBACK;
  }, [cat]);
  const requiredFields = formFields.filter((f) => f.required || f.conditional || f.catalogRequired);
  const optionalFields = formFields.filter((f) => !(f.required || f.conditional || f.catalogRequired)).slice(0, 12);

  const predict = async () => {
    setBusy("predict");
    try {
      const r = await mlPublishApi.predict(title);
      // Sin categorías de prueba de ML ("All in One Test"); la primera es la sugerida.
      const list = filterCategorySuggestions(r.suggestions ?? [], 3);
      setSuggestions(list);
      if (list[0]) void pickCategory(list[0]);
      else toast({ title: "No encontramos una categoría", description: "Probá con un título más descriptivo: producto, marca y modelo.", variant: "error" });
    } catch (e) {
      toast({ title: "No se pudo sugerir la categoría", description: mlErrorMessage(e), variant: "error" });
    } finally {
      setBusy(null);
    }
  };

  const pickCategory = async (s: MlDomainSuggestion) => {
    setCategoryId(s.category_id);
    setValidated(false);
    setErrors([]);
    setNotices([]);
    setBusy("category");
    void loadShipping(s.category_id);
    try {
      const info = await mlPublishApi.category(s.category_id);
      setCat(info);
      const usable = new Set(fieldsForCondition(info.attributes, condition).map((f) => f.id));
      const pre: AttrValues = {};
      for (const a of s.attributes ?? []) {
        if (usable.has(a.id) && (a.value_name || a.value_id)) pre[a.id] = { value_id: a.value_id ?? null, value_name: a.value_name ?? null };
      }
      setAttrs(pre);
      const va = info.attributes.filter((a) => a.variationAttribute || a.allowVariations);
      setAxis1(va.find((a) => a.id === "COLOR")?.id ?? va[0]?.id ?? "");
      setAxis2(va.find((a) => a.id === "SIZE")?.id ?? "");
    } catch (e) {
      toast({ title: "No se pudo leer la categoría", description: mlErrorMessage(e), variant: "error" });
    } finally {
      setBusy(null);
    }
  };

  const shippingInput: ShippingInput = {
    mode: shipMode,
    freeShipping: shipMode === "me2" && freeShipping,
    localPickUp,
    ...(shipMode === "custom" ? { costs: costs.map((c) => ({ description: c.description.trim(), cost: Number(c.cost) })) } : {}),
  };
  const costsOk = shipMode !== "custom" || (costs.length > 0 && costs.every((c) => c.description.trim() && c.cost !== "" && Number(c.cost) >= 0));

  const buildInput = (): PublishInput | null => {
    if (!pv || !cat) return null;
    const variants = hasVariants
      ? pv.variants.map((v) => ({
          key: v.variant_id,
          combos: [
            ...(axis1 ? [{ id: axis1, value_name: v.option1 }] : []),
            ...(axis2 && v.option2 ? [{ id: axis2, value_name: v.option2 }] : []),
          ],
          // Variante sin precio del canal (0 o vacío): el precio cargado en el modal.
          price: v.price != null && Number(v.price) > 0 ? Number(v.price) : Number(price),
          quantity: Math.max(0, Math.floor(Number(v.qty ?? 0))),
          sku: v.sku,
          gtin: v.barcode,
        }))
      : undefined;
    return {
      model: account?.user_product_seller ? "user_products" : "classic",
      title: title.trim(),
      categoryId,
      listingTypeId: listing,
      price: Number(price),
      quantity: Math.max(0, Math.floor(Number(qty) || 0)),
      currency: "ARS",
      condition,
      pictures: pv.pictures,
      description: pv.description,
      attributes: attrs,
      sku: pv.sku,
      gtin: gtin.trim() || null,
      emptyGtinReason: gtin.trim() ? null : emptyGtin || null,
      freeShipping: shippingInput.freeShipping,
      shipping: shippingInput,
      variants,
      maxTitleLength: cat.category.max_title_length ?? undefined,
    };
  };

  const validate = async () => {
    const input = buildInput();
    if (!input || !accountId) return;
    setBusy("validate");
    setErrors([]);
    try {
      const r = await mlPublishApi.validate(accountId, input);
      applyResult(r);
      if (r.ok) {
        setValidated(true);
        toast({ title: "Mercado Libre aceptó la publicación", description: "Ya podés publicarla.", variant: "success" });
      } else {
        setValidated(false);
        setErrors(r.errors ?? ["Mercado Libre rechazó los datos."]);
      }
    } catch (e) {
      setErrors([mlErrorMessage(e)]);
    } finally {
      setBusy(null);
    }
  };

  const publish = async () => {
    const input = buildInput();
    if (!input || !accountId) return;
    setBusy("publish");
    setErrors([]);
    try {
      const r = await mlPublishApi.publish(
        accountId,
        productId,
        input,
        extraTypes.length > 0 ? { listingTypes: [listing, ...extraTypes.filter((t) => t !== listing)], categoryName: cat?.category.name } : { categoryName: cat?.category.name },
      );
      applyResult(r);
      if (r.ok) {
        setPublished(r.items ?? []);
        toast({ title: "Publicado en Mercado Libre", variant: "success" });
      } else {
        setValidated(false);
        setErrors(r.errors ?? ["No se pudo publicar."]);
      }
    } catch (e) {
      setErrors([mlErrorMessage(e)]);
    } finally {
      setBusy(null);
    }
  };

  const missingRequired = requiredFields.filter((f) => f.required && !(attrs[f.id]?.value_id || attrs[f.id]?.value_name?.trim()));
  const ready =
    Boolean(cat && title.trim().length >= 3 && Number(price) > 0 && (pv?.pictures.length ?? 0) > 0) &&
    missingRequired.length === 0 &&
    costsOk &&
    !shipLoading &&
    (!gtinApplies || Boolean(gtin.trim()) || Boolean(emptyGtin));

  return (
    <Modal
      open={open}
      onOpenChange={onOpenChange}
      title="Publicar en Mercado Libre"
      description="Elegí la categoría, completá lo que pide Mercado Libre, validá y publicá."
      className="sm:max-w-2xl"
      footer={
        published ? (
          <div className="flex justify-end">
            <Button onClick={() => onOpenChange(false)}>Listo</Button>
          </div>
        ) : (
          <div className="flex flex-wrap justify-end gap-2">
            <Button variant="secondary" onClick={() => onOpenChange(false)}>
              Cancelar
            </Button>
            <Button variant="secondary" onClick={validate} disabled={!ready || busy !== null} loading={busy === "validate"}>
              Validar
            </Button>
            <Button onClick={publish} disabled={!ready || !validated || busy !== null} loading={busy === "publish"}>
              Publicar
            </Button>
          </div>
        )
      }
    >
      {published ? (
        <div className="space-y-3">
          <Callout tone="success" icon={CheckCircle2} title="Publicación creada">
            Quedó vinculada al producto: el stock y el precio se sincronizan solos.
          </Callout>
          {published.map((p) => (
            <p key={p.ml_item_id} className="flex items-center gap-2 text-sm">
              {p.ml_item_id}
              {p.permalink && (
                <a href={p.permalink} target="_blank" rel="noreferrer" className="inline-flex items-center gap-1 text-muted-foreground hover:underline">
                  <ExternalLink size={13} /> Ver en Mercado Libre
                </a>
              )}
            </p>
          ))}
        </div>
      ) : active.length === 0 ? (
        <Callout tone="warning" title="No hay cuentas activas">
          Conectá o reconectá una cuenta en Configuración &gt; Integraciones &gt; Mercado Libre.
        </Callout>
      ) : isLoading || !pv ? (
        <SpinnerBlock className="py-12" />
      ) : pv.is_kit ? (
        <Callout tone="warning" title="Los combos no se publican">
          Publicá cada producto del combo por separado.
        </Callout>
      ) : (
        <div className="space-y-5">
          {active.length > 1 && (
            <select
              className={selectCls}
              value={accountId ?? ""}
              onChange={(e) => {
                setAccountId(e.target.value);
                setValidated(false);
                if (categoryId) void loadShipping(categoryId, e.target.value);
              }}
              aria-label="Cuenta"
            >
              {active.map((a) => (
                <option key={a.id} value={a.id}>
                  {a.nickname || a.ml_user_id}
                </option>
              ))}
            </select>
          )}

          <div className="space-y-2">
            <Input
              label="Título"
              value={title}
              maxLength={cat?.category.max_title_length ?? 60}
              hint="Producto, marca y modelo. Sin stock, ofertas, envío ni cuotas."
              onChange={(e) => {
                setTitle(e.target.value);
                setValidated(false);
              }}
            />
            <Button variant="secondary" size="sm" onClick={predict} disabled={title.trim().length < 3 || busy !== null} loading={busy === "predict"}>
              <Sparkles size={15} /> Sugerir categoría
            </Button>
            {suggestions.length > 0 && (
              <div className="space-y-1">
                {suggestions.map((s, i) => (
                  <button
                    key={s.category_id}
                    type="button"
                    onClick={() => void pickCategory(s)}
                    aria-pressed={s.category_id === categoryId}
                    className={cn(
                      "flex w-full items-center justify-between gap-3 rounded-lg px-3 py-2 text-left text-sm",
                      s.category_id === categoryId ? "bg-ninja-flame/10" : "bg-muted hover:bg-secondary/60",
                    )}
                  >
                    <span className="min-w-0">
                      {s.category_name} <span className="text-xs text-muted-foreground">({s.domain_name})</span>
                    </span>
                    <span className="flex shrink-0 items-center gap-2">
                      {i === 0 && <Badge tone="brand">Sugerida</Badge>}
                      <span className="hidden font-mono text-xs text-muted-foreground sm:inline">{s.category_id}</span>
                    </span>
                  </button>
                ))}
              </div>
            )}
          </div>

          {busy === "category" && <SpinnerBlock className="py-6" />}

          {cat && (
            <>
              <div className="grid gap-3 sm:grid-cols-3">
                <Input
                  label="Precio"
                  type="number"
                  inputMode="decimal"
                  value={price}
                  hint={priceHint}
                  onChange={(e) => {
                    setPrice(e.target.value);
                    setValidated(false);
                  }}
                />
                <Input
                  label="Cantidad"
                  type="number"
                  inputMode="numeric"
                  value={qty}
                  disabled={hasVariants}
                  hint="Stock publicable de la cuenta"
                  onChange={(e) => setQty(e.target.value)}
                />
                <label className="block space-y-1 text-sm">
                  <span className="font-medium">Tipo de publicación</span>
                  <select className={selectCls} value={listing} onChange={(e) => setListing(e.target.value)}>
                    {(cat.listing_types.length ? cat.listing_types : [{ id: "gold_special", name: "Clásica" }, { id: "gold_pro", name: "Premium" }])
                      .filter((l) => l.id !== "free")
                      .map((l) => (
                        <option key={l.id} value={l.id}>
                          {LISTING_TYPE_LABELS[l.id] ?? l.name}
                        </option>
                      ))}
                  </select>
                </label>
              </div>
              {(pv.listing_prices ?? []).some((l) => l.listing_type_id !== listing && typeof l.price === "number" && l.price > 0) && (
                <div className="space-y-1 rounded-lg bg-muted px-3 py-2">
                  <p className="text-sm font-medium">También publicar como</p>
                  {(pv.listing_prices ?? [])
                    .filter((l) => l.listing_type_id !== listing && typeof l.price === "number" && l.price > 0)
                    .map((l) => (
                      <label key={l.listing_type_id} className="flex items-center justify-between gap-2 text-sm">
                        <span className="flex items-center gap-2">
                          <Checkbox
                            checked={extraTypes.includes(l.listing_type_id)}
                            onCheckedChange={(v) =>
                              setExtraTypes((xs) => (v ? [...new Set([...xs, l.listing_type_id])] : xs.filter((x) => x !== l.listing_type_id)))
                            }
                          />
                          {LISTING_TYPE_LABELS[l.listing_type_id] ?? l.listing_type_id}
                        </span>
                        <span className="tabular-nums text-muted-foreground">{formatCurrency(Number(l.price))}</span>
                      </label>
                    ))}
                  {extraTypes.length > 0 && (
                    <p className="text-xs text-muted-foreground">Con varios tipos, el precio de cada uno sale de los precios por tipo de la cuenta.</p>
                  )}
                </div>
              )}
              <div className="grid gap-3 sm:grid-cols-2">
                <label className="block space-y-1 text-sm">
                  <span className="font-medium">Condición</span>
                  <select className={selectCls} value={condition} onChange={(e) => changeCondition(e.target.value as "new" | "used")}>
                    <option value="new">Nuevo</option>
                    <option value="used">Usado</option>
                  </select>
                </label>
                <div className="flex items-center justify-between gap-3 rounded-lg bg-muted px-3 py-2">
                  <span className="text-sm">Retiro en persona</span>
                  <Switch
                    checked={localPickUp}
                    onCheckedChange={(v) => {
                      setLocalPickUp(v);
                      setValidated(false);
                    }}
                    label="Retiro en persona"
                  />
                </div>
              </div>

              <div className="space-y-3 rounded-lg bg-muted p-3">
                <div className="flex items-start gap-2">
                  <Truck size={16} className="mt-0.5 shrink-0 text-muted-foreground" />
                  <div className="min-w-0 space-y-0.5">
                    <p className="text-sm font-medium">
                      Envío: {shipLoading ? "consultando tu cuenta y la categoría" : SHIPPING_MODE_LABELS[shipMode]}
                    </p>
                    {!shipLoading && shipPlan && <p className="text-xs text-muted-foreground">{shipPlan.reason}</p>}
                  </div>
                </div>
                {!shipLoading && shipPlan && !shipPlan.allowed.includes("me2") && shipPlan.allowed.length > 1 && (
                  <Segmented<ShippingMode>
                    aria-label="Cómo se acuerda el envío"
                    size="sm"
                    fill
                    value={shipMode}
                    onChange={(m) => {
                      setShipMode(m);
                      setValidated(false);
                    }}
                    options={shipPlan.allowed.filter((m) => m !== "me2").map((m) => ({ value: m, label: m === "custom" ? "Costo fijo" : "A convenir" }))}
                  />
                )}
                {shipMode === "custom" && (
                  <div className="space-y-2">
                    {costs.map((c, i) => (
                      <div key={i} className="flex items-end gap-2">
                        <div className="min-w-0 flex-1">
                          <Input
                            label={i === 0 ? "Destino" : undefined}
                            aria-label="Destino del envío"
                            value={c.description}
                            maxLength={60}
                            onChange={(e) => {
                              setCosts(costs.map((x, k) => (k === i ? { ...x, description: e.target.value } : x)));
                              setValidated(false);
                            }}
                          />
                        </div>
                        <div className="w-28 shrink-0">
                          <Input
                            label={i === 0 ? "Costo" : undefined}
                            aria-label="Costo del envío"
                            type="number"
                            inputMode="decimal"
                            value={c.cost}
                            onChange={(e) => {
                              setCosts(costs.map((x, k) => (k === i ? { ...x, cost: e.target.value } : x)));
                              setValidated(false);
                            }}
                          />
                        </div>
                        {costs.length > 1 && (
                          <Button variant="ghost" size="sm" aria-label="Quitar costo" onClick={() => setCosts(costs.filter((_, k) => k !== i))}>
                            <Trash2 size={15} />
                          </Button>
                        )}
                      </div>
                    ))}
                    {costs.length < 10 && (
                      <Button variant="ghost" size="sm" onClick={() => setCosts([...costs, { description: "", cost: "" }])}>
                        <Plus size={15} /> Agregar otro destino
                      </Button>
                    )}
                  </div>
                )}
                {shipMode === "not_specified" && (
                  <p className="text-xs text-muted-foreground">El costo y la forma de envío los acordás con el comprador después de la compra.</p>
                )}
                <div className="flex items-center justify-between gap-3">
                  <span className={cn("text-sm", shipMode !== "me2" && "text-muted-foreground")}>Envío gratis</span>
                  <Switch
                    checked={shipMode === "me2" && freeShipping}
                    disabled={shipLoading || shipMode !== "me2" || !(shipPlan?.freeShippingAllowed ?? true)}
                    onCheckedChange={(v) => {
                      setFreeShipping(v);
                      setValidated(false);
                    }}
                    label="Envío gratis"
                  />
                </div>
                {shipMode !== "me2" && !shipLoading && (
                  <p className="text-xs text-muted-foreground">El envío gratis sólo se puede ofrecer con Mercado Envíos.</p>
                )}
              </div>

              {gtinApplies && (
                <div className="grid gap-3 sm:grid-cols-2">
                  <Input label="Código de barras (GTIN)" value={gtin} onChange={(e) => setGtin(e.target.value)} />
                  {!gtin.trim() && (
                  <label className="block space-y-1 text-sm">
                    <span className="font-medium">Sin código porque</span>
                    <select className={selectCls} value={emptyGtin} onChange={(e) => setEmptyGtin(e.target.value)}>
                      <option value="">Elegí el motivo</option>
                      {emptyGtinOptions.map((r) => (
                        <option key={r.id} value={r.id}>
                          {r.name}
                        </option>
                      ))}
                    </select>
                  </label>
                  )}
                </div>
              )}

              {hasVariants && (
                <div className="space-y-2 rounded-lg bg-muted p-3">
                  <p className="text-sm font-medium">Variantes ({pv.variants.length})</p>
                  <p className="text-xs text-muted-foreground">
                    {account?.user_product_seller
                      ? "Tu cuenta usa User Products: cada variante se publica como un ítem con su precio, agrupados en la misma familia."
                      : "Se publica un ítem con variaciones (todas al mismo precio)."}
                  </p>
                  <div className="grid gap-2 sm:grid-cols-2">
                    {[
                      { label: "Opción 1 es", value: axis1, set: setAxis1 },
                      { label: "Opción 2 es", value: axis2, set: setAxis2 },
                    ].map((x) => (
                      <label key={x.label} className="block space-y-1 text-sm">
                        <span>{x.label}</span>
                        <select className={selectCls} value={x.value} onChange={(e) => x.set(e.target.value)}>
                          <option value="">No usar</option>
                          {variationAttrs.map((a) => (
                            <option key={a.id} value={a.id}>
                              {a.name}
                            </option>
                          ))}
                        </select>
                      </label>
                    ))}
                  </div>
                </div>
              )}

              {requiredFields.length > 0 && (
                <div className="space-y-3">
                  <p className="text-sm font-semibold">Datos que pide la categoría</p>
                  <div className="grid gap-3 sm:grid-cols-2">
                    {requiredFields.map((f) => (
                      <AttrInputField key={f.id} f={f} value={attrs[f.id]} onChange={(v) => { setAttrs({ ...attrs, [f.id]: v }); setValidated(false); }} />
                    ))}
                  </div>
                </div>
              )}
              {optionalFields.length > 0 && (
                <details className="space-y-3">
                  <summary className="cursor-pointer text-sm font-medium">Más datos (mejoran la calidad de la publicación)</summary>
                  <div className="mt-3 grid gap-3 sm:grid-cols-2">
                    {optionalFields.map((f) => (
                      <AttrInputField key={f.id} f={f} value={attrs[f.id]} onChange={(v) => { setAttrs({ ...attrs, [f.id]: v }); setValidated(false); }} />
                    ))}
                  </div>
                </details>
              )}
              {pv.pictures.length === 0 && (
                <Callout tone="warning" title="Sin fotos">
                  Cargá al menos una foto en la pestaña Imágenes del producto.
                </Callout>
              )}
            </>
          )}

          {notices.length > 0 && (
            <Callout tone="info" icon={Info} title="Ajustamos la publicación">
              <ul className="list-disc space-y-1 pl-4">
                {notices.map((n, i) => (
                  <li key={i}>{n}</li>
                ))}
              </ul>
            </Callout>
          )}

          {errors.length > 0 && (
            <Callout tone="danger" title="Mercado Libre pide corregir">
              <MlErrorList errors={errors} />
            </Callout>
          )}
        </div>
      )}
    </Modal>
  );
}
