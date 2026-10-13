"use client";

import { useEffect, useMemo, useState, type ReactNode } from "react";
import { ChevronLeft, Plus, Search, Trash2, X } from "lucide-react";
import { Modal } from "@/components/ui/Modal";
import { Button } from "@/components/ui/Button";
import { Input } from "@/components/ui/Input";
import { Select } from "@/components/ui/Select";
import { Segmented } from "@/components/ui/Segmented";
import { Switch } from "@/components/ui/Switch";
import { ChoiceCard, CHOICE_ON } from "@/components/ui/ChoiceCard";
import { DateRangePicker, type DateRange } from "@/components/ui/DateRangePicker";
import { useToast } from "@/components/ui/Toast";
import { cn } from "@/lib/utils/cn";
import { useBrands, useCategories, useProducts, useProductsByIds } from "@/modules/products/hooks";
import { useBranches } from "@/modules/branches/hooks";
import { usePriceLists } from "@/modules/prices/hooks";
import { usePromotionMutations } from "@/modules/promotions/hooks";
import type { Promotion, PromotionInput, PromoScope } from "@/modules/promotions/api";
import { CARD_BRANDS } from "@/lib/pos/cardBrands";
import { bankBySlug, searchBanks } from "@/lib/payments/banks";
import { WEEKDAYS_SHORT, minToTime, timeToMin } from "@/lib/gastro/menuTime";
import {
  PAYMENT_LABELS,
  PROMO_KINDS,
  actionPhrase,
  conditionPhrases,
  emptyPromotion,
  kindOf,
  ticketPreview,
  type PreviewProduct,
  type PromoKind,
  type PromoNames,
} from "@/lib/promotions/describe";
import { PromoTicketPreview } from "./PromoTicketPreview";

// Asistente de promociones (F9, ADR-074): 1) tipo con ejemplo, 2) qué
// descuenta y sobre qué, 3) cuándo y cómo se cobra, 4) reglas y ticket. La
// vista previa usa el mismo motor que el POS y create_sale.

type Step = 1 | 2 | 3 | 4;
const STEP_TITLE: Record<Step, string> = {
  1: "Elegí el tipo de promoción",
  2: "Qué descuenta y en qué productos",
  3: "Cuándo vale y cómo se cobra",
  4: "Reglas y texto del ticket",
};

const toISO = (d: Date) =>
  `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
const fromISO = (s: string | null) => (s ? new Date(`${s}T00:00:00`) : undefined);
const num = (v: string) => (v.trim() === "" ? 0 : Number(v.replace(",", ".")) || 0);
const optNum = (v: string) => (v.trim() === "" ? null : Number(v.replace(",", ".")) || null);

/** Normaliza una promo existente al formato del asistente (alcance en scope_ids). */
function toDraft(p: Promotion): Promotion {
  const one =
    p.scope === "category" ? p.scope_category_id : p.scope === "product" ? p.scope_product_id : p.scope === "brand" ? p.scope_brand_id : null;
  return {
    ...emptyPromotion(),
    ...p,
    scope_ids: p.scope_ids && p.scope_ids.length > 0 ? p.scope_ids : one ? [one] : null,
    bundle_items: p.bundle_items ?? null,
    stackable: Boolean(p.stackable),
  };
}

function toInput(d: Promotion): PromotionInput {
  return {
    name: d.name,
    is_active: d.is_active,
    priority: d.priority,
    valid_from: d.valid_from,
    valid_to: d.valid_to,
    days_of_week: d.days_of_week,
    time_from: d.time_from,
    time_to: d.time_to,
    min_amount: d.min_amount,
    scope: d.scope,
    scope_ids: d.scope_ids,
    action_type: d.action_type,
    action_value: d.action_type === "nxm" || d.action_type === "volume_tier" || d.action_type === "gift" ? 0 : d.action_value,
    buy_qty: d.buy_qty,
    pay_qty: d.pay_qty,
    volume_tiers: d.volume_tiers,
    bundle_items: d.bundle_items,
    payment_method: d.payment_method,
    card_brands: d.card_brands,
    banks: d.banks,
    store_ids: d.store_ids,
    price_list_ids: d.price_list_ids,
    stackable: Boolean(d.stackable),
    max_discount: d.max_discount,
    max_uses_total: d.max_uses_total,
    max_uses_per_customer: d.max_uses_per_customer,
    ticket_label: d.ticket_label,
    gift_product_id: d.gift_product_id,
    gift_qty: d.gift_qty,
  };
}

/** Primer problema del borrador, en lenguaje simple. null = se puede guardar. */
export function draftProblem(d: Promotion, kind: PromoKind): string | null {
  const v = Number(d.action_value) || 0;
  if ((d.action_type === "percent" || d.action_type === "second_item") && (v <= 0 || v > 100))
    return "El porcentaje tiene que estar entre 1 y 100";
  if ((d.action_type === "amount" || d.action_type === "fixed_price" || d.action_type === "bundle") && v <= 0)
    return d.action_type === "amount" ? "Poné el monto a descontar" : "Poné el precio";
  if (d.action_type === "nxm" && !((d.pay_qty ?? 0) >= 1 && (d.buy_qty ?? 0) > (d.pay_qty ?? 0)))
    return "En lleva y paga, lo que lleva tiene que ser más que lo que paga";
  if (d.action_type === "volume_tier" && !(d.volume_tiers ?? []).some((t) => t.min_qty >= 1 && t.pct > 0 && t.pct <= 100))
    return "Cargá al menos un tramo con cantidad y porcentaje";
  if (d.action_type === "bundle" && (d.bundle_items ?? []).length === 0) return "Agregá los productos del combo";
  if (d.action_type === "gift" && !d.gift_product_id) return "Elegí el producto de regalo";
  if (d.action_type !== "bundle" && d.scope !== "cart" && (d.scope_ids ?? []).length === 0)
    return "Elegí al menos uno en \"Aplica a\"";
  if (kind === "payment" && !d.payment_method && (d.card_brands ?? []).length === 0 && (d.banks ?? []).length === 0)
    return "Elegí el medio de pago, la tarjeta o el banco";
  if (d.time_from != null && d.time_to != null && d.time_to <= d.time_from) return "El horario de fin tiene que ser después del de inicio";
  if (d.valid_from && d.valid_to && d.valid_to < d.valid_from) return "La fecha de fin es anterior a la de inicio";
  return null;
}

export function PromotionWizard({ open, promo, onClose }: { open: boolean; promo: Promotion | null; onClose: () => void }) {
  const { toast } = useToast();
  const { create, update } = usePromotionMutations();
  const [step, setStep] = useState<Step>(1);
  const [kind, setKind] = useState<PromoKind>("percent");
  const [d, setD] = useState<Promotion>(() => emptyPromotion());

  useEffect(() => {
    if (!open) return;
    if (promo) {
      setD(toDraft(promo));
      setKind(kindOf(promo));
      setStep(2);
    } else {
      setD(emptyPromotion());
      setKind("percent");
      setStep(1);
    }
  }, [open, promo]);

  const set = (patch: Partial<Promotion>) => setD((x) => ({ ...x, ...patch }));

  // Catálogos para nombres, selectores y la vista previa.
  const { data: categories } = useCategories();
  const { data: brands } = useBrands();
  const { data: branches } = useBranches();
  const { data: lists } = usePriceLists();
  const pickedIds = useMemo(
    () => [
      ...(d.scope === "product" ? (d.scope_ids ?? []) : []),
      ...(d.bundle_items ?? []).map((b) => b.product_id),
      ...(d.gift_product_id ? [d.gift_product_id] : []),
    ],
    [d.scope, d.scope_ids, d.bundle_items, d.gift_product_id],
  );
  const { data: pickedProducts } = useProductsByIds(pickedIds);
  const { data: sampleProducts } = useProducts("");

  const activeStores = useMemo(() => (branches ?? []).filter((b) => !b.deleted_at), [branches]);
  const names: PromoNames = useMemo(
    () => ({
      categories: Object.fromEntries((categories ?? []).map((c) => [c.id, c.name])),
      brands: Object.fromEntries((brands ?? []).map((b) => [b.id, b.name])),
      products: Object.fromEntries([...(sampleProducts ?? []), ...(pickedProducts ?? [])].map((p) => [p.id, p.name])),
      stores: Object.fromEntries(activeStores.map((s) => [s.id, s.name])),
      lists: Object.fromEntries((lists ?? []).map((l) => [l.id, l.name])),
      banks: Object.fromEntries((d.banks ?? []).map((s) => [s, bankBySlug(s)?.shortName ?? s])),
    }),
    [categories, brands, sampleProducts, pickedProducts, activeStores, lists, d.banks],
  );
  const catalog: PreviewProduct[] = useMemo(() => {
    const seen = new Set<string>();
    const out: PreviewProduct[] = [];
    for (const p of [...(pickedProducts ?? []), ...(sampleProducts ?? [])]) {
      if (seen.has(p.id)) continue;
      seen.add(p.id);
      const r = p as typeof p & { brand_id?: string | null };
      out.push({ id: r.id, name: r.name, price: Number(r.price) || 0, category_id: r.category_id ?? null, brand_id: r.brand_id ?? null });
    }
    return out;
  }, [pickedProducts, sampleProducts]);

  const preview = useMemo(() => ticketPreview({ ...d, name: d.name || "Promoción" }, catalog), [d, catalog]);
  const summary = useMemo(() => [actionPhrase(d, names), ...conditionPhrases(d, names)], [d, names]);
  const problem = draftProblem(d, kind);

  function chooseKind(k: PromoKind) {
    setKind(k);
    setD((x) => ({ ...emptyPromotion(k), id: x.id, name: x.name }));
    setStep(2);
  }

  async function save() {
    if (problem) {
      toast({ title: problem, variant: "error" });
      return;
    }
    const name = d.name.trim() || actionPhrase(d, names).slice(0, 60);
    const input = toInput({ ...d, name });
    try {
      if (promo) await update.mutateAsync({ id: promo.id, input });
      else await create.mutateAsync(input);
      toast({ title: promo ? "Promoción guardada" : "Promoción creada", variant: "success" });
      onClose();
    } catch (e) {
      const msg = e instanceof Error ? e.message : "";
      toast({
        title: msg.includes("row-level security") ? "No tenés permiso para guardar esta promoción" : "No se pudo guardar",
        description: msg.includes("row-level security")
          ? "Hace falta el plan con promociones y acceso a todas las sucursales elegidas."
          : msg || undefined,
        variant: "error",
      });
    }
  }

  const saving = create.isPending || update.isPending;
  const footer =
    step === 1 ? (
      <div className="flex justify-end">
        <Button variant="ghost" onClick={onClose}>
          Cancelar
        </Button>
      </div>
    ) : (
      <div className="flex flex-wrap items-center justify-between gap-2">
        <Button variant="ghost" onClick={() => setStep((s) => (s > 1 ? ((s - 1) as Step) : s))}>
          <ChevronLeft size={16} /> Atrás
        </Button>
        <div className="flex gap-2">
          {promo && step < 4 && (
            <Button variant="secondary" onClick={save} loading={saving}>
              Guardar
            </Button>
          )}
          {step < 4 ? (
            <Button onClick={() => setStep((s) => (s + 1) as Step)}>Siguiente</Button>
          ) : (
            <Button onClick={save} loading={saving}>
              {promo ? "Guardar" : "Crear promoción"}
            </Button>
          )}
        </div>
      </div>
    );

  return (
    <Modal
      open={open}
      onOpenChange={(o) => !o && onClose()}
      title={promo ? "Editar promoción" : "Nueva promoción"}
      className="sm:max-w-4xl"
      footer={footer}
    >
      <div className="space-y-4">
        <StepBar step={step} />
        {step === 1 ? (
          <div className="grid gap-2 sm:grid-cols-2" role="radiogroup" aria-label="Tipo de promoción">
            {PROMO_KINDS.map((k) => (
              <ChoiceCard
                key={k.kind}
                selected={kind === k.kind && Boolean(promo)}
                onClick={() => chooseKind(k.kind)}
                title={k.title}
                description={
                  <span className="block space-y-0.5">
                    <span className="block">{k.how}</span>
                    <span className="block text-foreground/80">Ejemplo: {k.example}</span>
                  </span>
                }
                className="p-3"
              />
            ))}
          </div>
        ) : (
          <div className="grid gap-5 md:grid-cols-[minmax(0,1fr)_280px]">
            <div className="min-w-0 space-y-4">
              {step === 2 && <ActionStep d={d} set={set} names={names} sample={catalog} />}
              {step === 2 && d.action_type !== "bundle" && (
                <ScopeStep d={d} set={set} categories={categories ?? []} brands={brands ?? []} names={names} />
              )}
              {step === 3 && (
                <ConditionsStep
                  d={d}
                  set={set}
                  kind={kind}
                  stores={activeStores.map((s) => ({ id: s.id, name: s.name }))}
                  lists={(lists ?? []).map((l) => ({ id: l.id, name: l.name }))}
                />
              )}
              {step === 4 && <RulesStep d={d} set={set} placeholder={actionPhrase(d, names)} />}
              {problem && step > 1 && <p className="text-xs text-warning">{problem}</p>}
            </div>
            <aside className="min-w-0 md:border-l md:border-border md:pl-5">
              <PromoTicketPreview preview={preview} summary={summary} />
            </aside>
          </div>
        )}
      </div>
    </Modal>
  );
}

function StepBar({ step }: { step: Step }) {
  return (
    <div className="flex items-center gap-3">
      <div className="min-w-0 flex-1">
        <p className="text-[11px] font-medium text-muted-foreground">Paso {step} de 4</p>
        <p className="truncate text-sm font-semibold">{STEP_TITLE[step]}</p>
      </div>
      <div className="flex gap-1" aria-hidden>
        {([1, 2, 3, 4] as const).map((s) => (
          <span key={s} className={cn("h-1 w-5 rounded-sm", s <= step ? "bg-foreground/70" : "bg-muted")} />
        ))}
      </div>
    </div>
  );
}

function Field({ label, hint, children }: { label: string; hint?: string; children: ReactNode }) {
  return (
    <div className="space-y-1.5">
      <p className="text-xs font-medium text-muted-foreground">{label}</p>
      {children}
      {hint && <p className="text-[11px] text-muted-foreground">{hint}</p>}
    </div>
  );
}

function Pill({ on, onClick, children }: { on: boolean; onClick: () => void; children: ReactNode }) {
  return (
    <button
      type="button"
      aria-pressed={on}
      onClick={onClick}
      className={cn(
        "h-9 rounded-md border px-3 text-sm transition focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
        on ? CHOICE_ON : "border-border bg-card text-foreground hover:bg-muted",
      )}
    >
      {children}
    </button>
  );
}

const toggle = (arr: string[] | null | undefined, v: string): string[] | null => {
  const cur = arr ?? [];
  const next = cur.includes(v) ? cur.filter((x) => x !== v) : [...cur, v];
  return next.length > 0 ? next : null;
};

// ── Paso 2: acción ───────────────────────────────────────────────────────────
function ActionStep({
  d,
  set,
  names,
  sample,
}: {
  d: Promotion;
  set: (p: Partial<Promotion>) => void;
  names: PromoNames;
  sample: PreviewProduct[];
}) {
  const t = d.action_type;
  if (t === "percent" || t === "second_item") {
    return (
      <Input
        label={t === "percent" ? "Porcentaje de descuento" : "Descuento de la segunda unidad (%)"}
        type="number"
        inputMode="decimal"
        min="1"
        max="100"
        value={d.action_value || ""}
        onChange={(e) => set({ action_value: num(e.target.value) })}
        hint="Entre 1 y 100"
      />
    );
  }
  if (t === "amount" || t === "fixed_price") {
    return (
      <Input
        label={t === "amount" ? "Monto a descontar ($)" : "Precio total de lo que entra en la promo ($)"}
        type="number"
        inputMode="decimal"
        min="0"
        value={d.action_value || ""}
        onChange={(e) => set({ action_value: num(e.target.value) })}
      />
    );
  }
  if (t === "nxm") {
    return (
      <div className="grid grid-cols-2 gap-3">
        <Input
          label="Lleva"
          type="number"
          inputMode="numeric"
          min="2"
          value={d.buy_qty ?? ""}
          onChange={(e) => set({ buy_qty: Math.trunc(num(e.target.value)) || null })}
        />
        <Input
          label="Paga"
          type="number"
          inputMode="numeric"
          min="1"
          value={d.pay_qty ?? ""}
          onChange={(e) => set({ pay_qty: Math.trunc(num(e.target.value)) || null })}
        />
      </div>
    );
  }
  if (t === "volume_tier") {
    const tiers = d.volume_tiers ?? [];
    const setTier = (i: number, patch: Partial<{ min_qty: number; pct: number }>) =>
      set({ volume_tiers: tiers.map((x, k) => (k === i ? { ...x, ...patch } : x)) });
    return (
      <Field label="Tramos" hint="Se aplica el porcentaje más alto al que llega la cantidad.">
        <div className="space-y-2">
          {tiers.map((x, i) => (
            <div key={i} className="flex items-end gap-2">
              <Input
                label={i === 0 ? "Desde (unidades)" : undefined}
                type="number"
                inputMode="numeric"
                min="1"
                value={x.min_qty || ""}
                onChange={(e) => setTier(i, { min_qty: Math.trunc(num(e.target.value)) })}
                className="flex-1"
              />
              <Input
                label={i === 0 ? "Descuento (%)" : undefined}
                type="number"
                inputMode="decimal"
                min="1"
                max="100"
                value={x.pct || ""}
                onChange={(e) => setTier(i, { pct: num(e.target.value) })}
                className="flex-1"
              />
              <button
                type="button"
                onClick={() => set({ volume_tiers: tiers.filter((_, k) => k !== i) })}
                className="mb-1 grid h-9 w-9 place-items-center rounded-md text-muted-foreground transition hover:bg-muted hover:text-danger"
                aria-label="Quitar tramo"
              >
                <Trash2 size={15} />
              </button>
            </div>
          ))}
          <Button variant="ghost" size="sm" onClick={() => set({ volume_tiers: [...tiers, { min_qty: 0, pct: 0 }] })}>
            <Plus size={15} /> Agregar tramo
          </Button>
        </div>
      </Field>
    );
  }
  if (t === "bundle") {
    const items = d.bundle_items ?? [];
    return (
      <div className="space-y-4">
        <Field label="Productos del combo" hint="Cada combo completo cuesta el precio de abajo.">
          <div className="space-y-2">
            {items.map((b, i) => (
              <div key={b.product_id} className="flex items-center gap-2">
                <span className="min-w-0 flex-1 truncate text-sm">{names.products?.[b.product_id] ?? "Producto"}</span>
                <Input
                  aria-label="Unidades"
                  type="number"
                  inputMode="numeric"
                  min="1"
                  value={b.qty || ""}
                  onChange={(e) =>
                    set({ bundle_items: items.map((x, k) => (k === i ? { ...x, qty: Math.max(1, Math.trunc(num(e.target.value))) } : x)) })
                  }
                  className="w-20"
                />
                <button
                  type="button"
                  onClick={() => set({ bundle_items: items.filter((_, k) => k !== i) })}
                  className="grid h-9 w-9 place-items-center rounded-md text-muted-foreground transition hover:bg-muted hover:text-danger"
                  aria-label="Quitar del combo"
                >
                  <Trash2 size={15} />
                </button>
              </div>
            ))}
            {items.length < 10 && (
              <ProductSearch
                exclude={items.map((b) => b.product_id)}
                onPick={(id) => set({ bundle_items: [...items, { product_id: id, qty: 1 }] })}
                placeholder="Buscar y agregar un producto"
              />
            )}
          </div>
        </Field>
        <Input
          label="Precio del combo ($)"
          type="number"
          inputMode="decimal"
          min="0"
          value={d.action_value || ""}
          onChange={(e) => set({ action_value: num(e.target.value) })}
          hint={
            items.length > 0
              ? `Precio de lista del combo: $${items
                  .reduce((a, b) => a + (sample.find((p) => p.id === b.product_id)?.price ?? 0) * b.qty, 0)
                  .toLocaleString("es-AR")}`
              : undefined
          }
        />
      </div>
    );
  }
  // Regalo.
  return (
    <div className="space-y-3">
      <Field label="Producto de regalo" hint="Si no hay stock, el POS no lo agrega.">
        {d.gift_product_id ? (
          <div className="flex items-center gap-2">
            <span className="min-w-0 flex-1 truncate text-sm">{names.products?.[d.gift_product_id] ?? "Producto"}</span>
            <Button variant="ghost" size="sm" onClick={() => set({ gift_product_id: null })}>
              Cambiar
            </Button>
          </div>
        ) : (
          <ProductSearch exclude={[]} onPick={(id) => set({ gift_product_id: id })} placeholder="Buscar el producto de regalo" />
        )}
      </Field>
      <Input
        label="Unidades de regalo"
        type="number"
        inputMode="numeric"
        min="1"
        value={d.gift_qty ?? ""}
        onChange={(e) => set({ gift_qty: Math.max(1, Math.trunc(num(e.target.value))) })}
        className="w-28"
      />
    </div>
  );
}

function ProductSearch({ exclude, onPick, placeholder }: { exclude: string[]; onPick: (id: string) => void; placeholder: string }) {
  const [q, setQ] = useState("");
  const { data } = useProducts(q);
  const results = (data ?? []).filter((p) => !exclude.includes(p.id)).slice(0, 6);
  return (
    <div className="space-y-1">
      <div className="relative">
        <Search size={15} className="pointer-events-none absolute left-2.5 top-1/2 -translate-y-1/2 text-muted-foreground" aria-hidden />
        <input
          value={q}
          onChange={(e) => setQ(e.target.value)}
          placeholder={placeholder}
          aria-label={placeholder}
          className="h-10 w-full rounded-md border border-border bg-background pl-8 pr-3 text-sm outline-none focus:border-foreground/30"
        />
      </div>
      {q.trim() !== "" && (
        <ul className="divide-y divide-border rounded-md border border-border">
          {results.length === 0 && <li className="px-3 py-2 text-xs text-muted-foreground">Sin resultados</li>}
          {results.map((p) => (
            <li key={p.id}>
              <button
                type="button"
                onClick={() => {
                  onPick(p.id);
                  setQ("");
                }}
                className="flex w-full items-center justify-between gap-2 px-3 py-2 text-left text-sm hover:bg-muted"
              >
                <span className="min-w-0 truncate">{p.name}</span>
                <span className="shrink-0 text-xs tabular-nums text-muted-foreground">${Number(p.price).toLocaleString("es-AR")}</span>
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

// ── Paso 2: alcance ──────────────────────────────────────────────────────────
function ScopeStep({
  d,
  set,
  categories,
  brands,
  names,
}: {
  d: Promotion;
  set: (p: Partial<Promotion>) => void;
  categories: { id: string; name: string }[];
  brands: { id: string; name: string }[];
  names: PromoNames;
}) {
  const ids = d.scope_ids ?? [];
  const opts =
    d.scope === "category" ? categories : d.scope === "brand" ? brands : [];
  return (
    <Field label={d.action_type === "gift" ? "Comprando en" : "Aplica a"}>
      <div className="space-y-3">
        <Segmented<PromoScope>
          fill
          size="sm"
          aria-label="Alcance"
          value={d.scope}
          onChange={(v) => set({ scope: v, scope_ids: null })}
          options={[
            { value: "cart", label: "Toda la compra" },
            { value: "category", label: "Categorías" },
            { value: "product", label: "Productos" },
            { value: "brand", label: "Marcas" },
          ]}
        />
        {(d.scope === "category" || d.scope === "brand") &&
          (opts.length === 0 ? (
            <p className="text-xs text-muted-foreground">
              Todavía no hay {d.scope === "category" ? "categorías" : "marcas"} cargadas.
            </p>
          ) : (
            <div className="flex flex-wrap gap-2">
              {opts.map((o) => (
                <Pill key={o.id} on={ids.includes(o.id)} onClick={() => set({ scope_ids: toggle(ids, o.id) })}>
                  {o.name}
                </Pill>
              ))}
            </div>
          ))}
        {d.scope === "product" && (
          <div className="space-y-2">
            {ids.length > 0 && (
              <div className="flex flex-wrap gap-2">
                {ids.map((id) => (
                  <span key={id} className="inline-flex h-8 items-center gap-1 rounded-md bg-muted pl-2.5 pr-1 text-sm">
                    <span className="max-w-[180px] truncate">{names.products?.[id] ?? "Producto"}</span>
                    <button
                      type="button"
                      onClick={() => set({ scope_ids: toggle(ids, id) })}
                      className="grid h-6 w-6 place-items-center rounded-md text-muted-foreground hover:text-danger"
                      aria-label="Quitar"
                    >
                      <X size={13} />
                    </button>
                  </span>
                ))}
              </div>
            )}
            <ProductSearch exclude={ids} onPick={(id) => set({ scope_ids: [...ids, id] })} placeholder="Buscar y agregar productos" />
          </div>
        )}
      </div>
    </Field>
  );
}

// ── Paso 3: condiciones ──────────────────────────────────────────────────────
function ConditionsStep({
  d,
  set,
  kind,
  stores,
  lists,
}: {
  d: Promotion;
  set: (p: Partial<Promotion>) => void;
  kind: PromoKind;
  stores: { id: string; name: string }[];
  lists: { id: string; name: string }[];
}) {
  const [bankQ, setBankQ] = useState("");
  const range: DateRange | undefined = d.valid_from || d.valid_to ? { from: fromISO(d.valid_from), to: fromISO(d.valid_to) } : undefined;
  const banks = d.banks ?? [];
  const bankResults = bankQ.trim() ? searchBanks(bankQ).filter((b) => !banks.includes(b.slug)).slice(0, 6) : [];

  const payBlock = (
    <div className="space-y-4">
      <Select
        label="Medio de pago"
        value={d.payment_method ?? "any"}
        onChange={(v) => set({ payment_method: v === "any" ? null : v })}
        options={[
          { value: "any", label: "Cualquiera" },
          ...Object.entries(PAYMENT_LABELS).map(([value, label]) => ({ value, label: label[0]!.toUpperCase() + label.slice(1) })),
        ]}
      />
      <Field label="Tarjetas" hint="Vacío = cualquier tarjeta. Si elegís alguna, sólo vale con débito o crédito de esa marca.">
        <div className="flex flex-wrap gap-2">
          {CARD_BRANDS.map((c) => (
            <Pill key={c.key} on={(d.card_brands ?? []).includes(c.key)} onClick={() => set({ card_brands: toggle(d.card_brands, c.key) })}>
              {c.short ?? c.label}
            </Pill>
          ))}
        </div>
      </Field>
      <Field label="Bancos" hint="El cajero elige el banco de la tarjeta al cobrar en el posnet.">
        <div className="space-y-2">
          {banks.length > 0 && (
            <div className="flex flex-wrap gap-2">
              {banks.map((s) => (
                <span key={s} className="inline-flex h-8 items-center gap-1 rounded-md bg-muted pl-2.5 pr-1 text-sm">
                  {bankBySlug(s)?.shortName ?? s}
                  <button
                    type="button"
                    onClick={() => set({ banks: toggle(banks, s) })}
                    className="grid h-6 w-6 place-items-center rounded-md text-muted-foreground hover:text-danger"
                    aria-label="Quitar banco"
                  >
                    <X size={13} />
                  </button>
                </span>
              ))}
            </div>
          )}
          <input
            value={bankQ}
            onChange={(e) => setBankQ(e.target.value)}
            placeholder="Buscar banco o billetera"
            aria-label="Buscar banco"
            className="h-10 w-full rounded-md border border-border bg-background px-3 text-sm outline-none focus:border-foreground/30"
          />
          {bankResults.length > 0 && (
            <ul className="divide-y divide-border rounded-md border border-border">
              {bankResults.map((b) => (
                <li key={b.slug}>
                  <button
                    type="button"
                    onClick={() => {
                      set({ banks: [...banks, b.slug] });
                      setBankQ("");
                    }}
                    className="w-full px-3 py-2 text-left text-sm hover:bg-muted"
                  >
                    {b.name}
                  </button>
                </li>
              ))}
            </ul>
          )}
        </div>
      </Field>
    </div>
  );

  return (
    <div className="space-y-5">
      {kind === "payment" && payBlock}
      <Field label="Vigencia" hint="Sin fechas, vale siempre.">
        <div className="flex flex-wrap items-center gap-2">
          <DateRangePicker
            value={range}
            onChange={(r) => set({ valid_from: r?.from ? toISO(r.from) : null, valid_to: r?.to ? toISO(r.to) : null })}
          />
          {range && (
            <Button variant="ghost" size="sm" onClick={() => set({ valid_from: null, valid_to: null })}>
              Quitar fechas
            </Button>
          )}
        </div>
      </Field>
      <Field label="Días" hint="Sin días marcados, vale todos los días.">
        <div className="flex flex-wrap gap-2">
          {WEEKDAYS_SHORT.map((label, i) => (
            <Pill
              key={label}
              on={(d.days_of_week ?? []).includes(i)}
              onClick={() => {
                const cur = d.days_of_week ?? [];
                const next = cur.includes(i) ? cur.filter((x) => x !== i) : [...cur, i].sort();
                set({ days_of_week: next.length > 0 ? next : null });
              }}
            >
              {label}
            </Pill>
          ))}
        </div>
      </Field>
      <div className="grid grid-cols-2 gap-3">
        <Input
          label="Desde la hora"
          type="time"
          value={d.time_from != null ? minToTime(d.time_from) : ""}
          onChange={(e) => set({ time_from: e.target.value ? timeToMin(e.target.value) : null })}
        />
        <Input
          label="Hasta la hora"
          type="time"
          value={d.time_to != null ? minToTime(d.time_to) : ""}
          onChange={(e) => set({ time_to: e.target.value ? timeToMin(e.target.value) : null })}
        />
      </div>
      <Input
        label="Compra mínima ($)"
        type="number"
        inputMode="decimal"
        min="0"
        value={d.min_amount || ""}
        onChange={(e) => set({ min_amount: num(e.target.value) })}
        hint="Sobre los productos del carrito. 0 = sin mínimo."
      />
      {kind !== "payment" && (
        <details className="rounded-md border border-border px-3 py-2">
          <summary className="cursor-pointer text-sm font-medium">Sólo con un medio de pago, tarjeta o banco</summary>
          <div className="pt-3">{payBlock}</div>
        </details>
      )}
      {stores.length > 1 && (
        <Field label="Sucursales" hint="Sin marcar, vale en todo el negocio. Las sucursales nuevas la heredan.">
          <div className="flex flex-wrap gap-2">
            {stores.map((s) => (
              <Pill key={s.id} on={(d.store_ids ?? []).includes(s.id)} onClick={() => set({ store_ids: toggle(d.store_ids, s.id) })}>
                {s.name}
              </Pill>
            ))}
          </div>
        </Field>
      )}
      {lists.length > 0 && (
        <Field label="Listas de precios" hint="Sin marcar, vale con cualquier lista.">
          <div className="flex flex-wrap gap-2">
            {lists.map((l) => (
              <Pill
                key={l.id}
                on={(d.price_list_ids ?? []).includes(l.id)}
                onClick={() => set({ price_list_ids: toggle(d.price_list_ids, l.id) })}
              >
                {l.name}
              </Pill>
            ))}
          </div>
        </Field>
      )}
    </div>
  );
}

// ── Paso 4: reglas ───────────────────────────────────────────────────────────
function RulesStep({ d, set, placeholder }: { d: Promotion; set: (p: Partial<Promotion>) => void; placeholder: string }) {
  return (
    <div className="space-y-4">
      <Input label="Nombre" value={d.name} onChange={(e) => set({ name: e.target.value })} placeholder={placeholder} />
      <Input
        label="Texto en el ticket"
        value={d.ticket_label ?? ""}
        maxLength={40}
        onChange={(e) => set({ ticket_label: e.target.value || null })}
        placeholder={d.name || "Igual que el nombre"}
        hint="Hasta 40 caracteres. Vacío = el nombre."
      />
      <Field label="¿Se combina con otras promociones?">
        <div className="grid gap-2 sm:grid-cols-2">
          <ChoiceCard
            selected={!d.stackable}
            onClick={() => set({ stackable: false })}
            title="No, es excluyente"
            description="Compite con las demás y queda la que más le conviene al cliente."
            className="p-3"
          />
          <ChoiceCard
            selected={Boolean(d.stackable)}
            onClick={() => set({ stackable: true })}
            title="Sí, es acumulable"
            description="Se suma a otras acumulables, cada una sobre lo que dejó la anterior."
            className="p-3"
          />
        </div>
      </Field>
      <div className="grid grid-cols-2 gap-3">
        <Input
          label="Prioridad"
          type="number"
          inputMode="numeric"
          value={d.priority || ""}
          onChange={(e) => set({ priority: Math.trunc(num(e.target.value)) })}
          hint="Mayor número, se aplica antes"
        />
        <Input
          label="Tope por ticket ($)"
          type="number"
          inputMode="decimal"
          min="0"
          value={d.max_discount ?? ""}
          onChange={(e) => set({ max_discount: optNum(e.target.value) })}
          hint="Vacío = sin tope"
        />
        <Input
          label="Usos en total"
          type="number"
          inputMode="numeric"
          min="1"
          value={d.max_uses_total ?? ""}
          onChange={(e) => set({ max_uses_total: optNum(e.target.value) })}
          hint="Vacío = sin límite"
        />
        <Input
          label="Usos por cliente"
          type="number"
          inputMode="numeric"
          min="1"
          value={d.max_uses_per_customer ?? ""}
          onChange={(e) => set({ max_uses_per_customer: optNum(e.target.value) })}
          hint="Pide elegir cliente al cobrar"
        />
      </div>
      <div className="flex items-center justify-between gap-3 rounded-md border border-border px-3 py-2.5">
        <div>
          <p className="text-sm font-medium">Activa</p>
          <p className="text-xs text-muted-foreground">Pausala cuando quieras sin perder la configuración.</p>
        </div>
        <Switch checked={d.is_active} onCheckedChange={(v) => set({ is_active: v })} label="Activa" />
      </div>
    </div>
  );
}
