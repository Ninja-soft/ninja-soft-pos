"use client";

import Link from "next/link";
import { ArrowDown, ArrowUp, Lock, Pin, Plus, Search, Star, Trash2 } from "lucide-react";
import { Switch } from "@/components/ui/Switch";
import { Segmented } from "@/components/ui/Segmented";
import { choiceClass } from "@/components/ui/ChoiceCard";
import {
  CHECKOUT_FAVORITES_MAX,
  CHECKOUT_LAYOUTS,
  CHECKOUT_LAYOUT_INFO,
  POS_ACCENTS,
  POS_PRESETS,
  PRESET_DEFAULTS,
  PRESET_INFO,
  QUICK_KEYS_BASE_MAX,
  QUICK_KEYS_PRO_MAX,
  QUICK_KEY_COLORS,
  ACCENT_GRADIENT,
  type PosLayout,
  type PosPreset,
} from "@/lib/pos/layout";
import { TENDER_GROUPS, type ResolvedTender } from "@/lib/pos/tenders";
import { cn } from "@/lib/utils/cn";
import { TenderLogo, tenderFallback, tenderGlyph } from "../ui/TenderLogo";
import { QUICK_KEY_FILL, accentVars, money } from "../ui/posStyles";
import { CheckoutThumb, PresetThumb } from "../screen/PresetThumb";

// Pastillas en reposo / seleccionadas (relleno neutro, sin borde de color).
const PILL = "flex h-8 items-center gap-1 rounded-lg px-2.5 text-xs font-semibold transition disabled:opacity-40";
const PILL_IDLE = "border border-border bg-card text-muted-foreground hover:text-foreground";
const PILL_ON = "choice-on border border-transparent";

// Editor del diseño del POS (Configuración, Diseño del POS). Presentacional:
// recibe el diseño resuelto y emite cambios; quien lo usa decide si se guarda
// para el negocio o sólo para el usuario.

const ACCENT_LABEL: Record<string, string> = { fire: "Fuego", violet: "Violeta", ocean: "Océano", mint: "Menta" };

export interface QuickKeyProduct {
  id: string;
  name: string;
  price: number;
}

export function PosLayoutEditor({
  value,
  onChange,
  diningEnabled,
  tenders,
  quickKeysPro,
  onLockedQuickKeys,
  productQuery,
  onProductQuery,
  productResults,
  keyProducts,
}: {
  value: PosLayout;
  onChange: (next: PosLayout) => void;
  diningEnabled: boolean;
  tenders: ResolvedTender[];
  quickKeysPro: boolean;
  onLockedQuickKeys: () => void;
  productQuery: string;
  onProductQuery: (v: string) => void;
  productResults: QuickKeyProduct[];
  keyProducts: Map<string, QuickKeyProduct>;
}) {
  const set = <K extends keyof PosLayout>(k: K, v: PosLayout[K]) => onChange({ ...value, [k]: v });
  const setPay = (patch: Partial<PosLayout["payments"]>) =>
    onChange({ ...value, payments: { ...value.payments, ...patch } });
  const setCheckout = (patch: Partial<PosLayout["checkout"]>) =>
    onChange({ ...value, checkout: { ...value.checkout, ...patch } });
  const maxKeys = quickKeysPro ? QUICK_KEYS_PRO_MAX : QUICK_KEYS_BASE_MAX;

  const pickPreset = (p: PosPreset) =>
    onChange({
      ...PRESET_DEFAULTS[p],
      accent: value.accent,
      fontScale: value.fontScale,
      payments: value.payments,
      quickKeys: value.quickKeys,
      tipPresets: value.tipPresets,
      // La distribución del cobro sigue al preset; favoritos y grupos se conservan.
      checkout: { ...value.checkout, layout: PRESET_DEFAULTS[p].checkout.layout, density: PRESET_DEFAULTS[p].checkout.density },
    });

  const togglePin = (id: string) => {
    const pinned = value.payments.pinned.includes(id)
      ? value.payments.pinned.filter((x) => x !== id)
      : [...value.payments.pinned, id].slice(-3);
    setPay({ pinned });
  };
  const toggleFavorite = (id: string) => {
    const favs = value.checkout.favorites;
    setCheckout({
      favorites: favs.includes(id)
        ? favs.filter((x) => x !== id)
        : [...favs, id].slice(-CHECKOUT_FAVORITES_MAX),
    });
  };
  const toggleGroup = (key: string) => {
    const hidden = value.checkout.hiddenGroups;
    setCheckout({ hiddenGroups: hidden.includes(key) ? hidden.filter((x) => x !== key) : [...hidden, key] });
  };
  const groupsInUse = TENDER_GROUPS.filter((g) => tenders.some((t) => t.group === g.key));

  const toggleHidden = (id: string) =>
    setPay({
      hidden: value.payments.hidden.includes(id)
        ? value.payments.hidden.filter((x) => x !== id)
        : [...value.payments.hidden, id],
    });

  const moveKey = (i: number, d: -1 | 1) => {
    const ks = [...value.quickKeys];
    const j = i + d;
    if (j < 0 || j >= ks.length) return;
    [ks[i], ks[j]] = [ks[j]!, ks[i]!];
    set("quickKeys", ks);
  };

  return (
    <div className="space-y-8" style={accentVars(value.accent)}>
      {/* Presets */}
      <section>
        <h3 className="text-sm font-black">Elegí la pantalla</h3>
        <p className="mt-0.5 text-xs text-muted-foreground">
          Cada diseño ordena la venta para un tipo de negocio. Después podés ajustar todo.
        </p>
        <div className="mt-3 grid grid-cols-2 gap-2 sm:gap-3 xl:grid-cols-4" role="radiogroup" aria-label="Pantalla de venta">
          {POS_PRESETS.map((p) => {
            const info = PRESET_INFO[p];
            const blocked = Boolean(info.requiresDining && !diningEnabled);
            const on = value.preset === p;
            if (blocked) {
              return (
                <div key={p} className="rounded-lg border border-dashed border-border bg-card p-2">
                  <PresetThumb preset={p} className="h-20 w-full opacity-50 sm:h-28" />
                  <span className="flex items-center gap-1.5 px-1 pt-2.5 text-sm font-semibold text-muted-foreground">
                    <Lock size={13} aria-hidden /> {info.name}
                  </span>
                  <span className="block px-1 pt-0.5 text-xs text-muted-foreground">
                    Necesita el modo gastronómico (mesas) activo.
                  </span>
                  <Link
                    href={"/configuracion?seccion=operacion" as never}
                    className="mx-1 mb-1 mt-2 inline-flex h-8 items-center rounded-md bg-muted px-2.5 text-xs font-semibold text-foreground transition hover:bg-fg-10"
                  >
                    Activar modo gastronómico
                  </Link>
                </div>
              );
            }
            return (
              <button
                key={p}
                type="button"
                role="radio"
                aria-checked={on}
                onClick={() => pickPreset(p)}
                className={choiceClass(on, "rounded-lg p-2")}
              >
                <PresetThumb preset={p} className="h-20 w-full sm:h-28" />
                <span className="block px-1 pt-2.5 text-sm font-semibold">{info.name}</span>
                <span className="block px-1 text-xs text-muted-foreground">{info.tagline}</span>
                <span className="block px-1 pb-1 pt-1 text-[11px] font-medium text-muted-foreground">{info.bestFor}</span>
              </button>
            );
          })}
        </div>
      </section>

      {/* Ajustes visuales */}
      <section className="grid gap-x-8 gap-y-5 lg:grid-cols-2">
        <Field label="Densidad">
          <Seg
            value={value.density}
            onChange={(v) => set("density", v)}
            options={[
              ["compact", "Compacta"],
              ["comfortable", "Cómoda"],
              ["spacious", "Amplia"],
            ]}
          />
        </Field>
        <Field label="Tamaño de los productos">
          <Seg
            value={value.tileSize}
            onChange={(v) => set("tileSize", v)}
            options={[
              ["s", "Chico"],
              ["m", "Mediano"],
              ["l", "Grande"],
            ]}
          />
        </Field>
        <Field label="Columnas">
          <Seg
            value={value.columns}
            onChange={(v) => set("columns", v)}
            options={[
              ["auto", "Auto"],
              ["3", "3"],
              ["4", "4"],
              ["5", "5"],
              ["6", "6"],
              ["8", "8"],
            ]}
          />
        </Field>
        <Field label="Rubros">
          <Seg
            value={value.categoryBar}
            onChange={(v) => set("categoryBar", v)}
            options={[
              ["top", "Arriba"],
              ["left", "Al costado"],
              ["hidden", "Ocultos"],
            ]}
          />
        </Field>
        <Field label="Carrito">
          <Seg
            value={value.cartSide}
            onChange={(v) => set("cartSide", v)}
            options={[
              ["right", "A la derecha"],
              ["left", "A la izquierda"],
            ]}
          />
        </Field>
        <Field label="Carrito en el celular">
          <Seg
            value={value.mobileCart}
            onChange={(v) => set("mobileCart", v)}
            options={[
              ["sticky_bar", "Barra fija abajo"],
              ["tabs", "Pestañas"],
            ]}
          />
        </Field>
        <Field label="Acento">
          <div className="flex flex-wrap gap-2">
            {POS_ACCENTS.map((a) => {
              const g = ACCENT_GRADIENT[a];
              const on = value.accent === a;
              return (
                <button
                  key={a}
                  type="button"
                  onClick={() => set("accent", a)}
                  aria-pressed={on}
                  className={cn("flex h-10 items-center gap-2 rounded-lg pl-1.5 pr-3.5 text-[13px] font-semibold transition", on ? PILL_ON : PILL_IDLE)}
                >
                  <span className="h-6 w-6 rounded-md" style={{ background: g.via }} />
                  {ACCENT_LABEL[a]}
                </button>
              );
            })}
          </div>
        </Field>
        <Field label="Tamaño del texto">
          <Seg
            value={String(value.fontScale)}
            onChange={(v) => set("fontScale", Number(v))}
            options={[
              ["0.9", "90%"],
              ["1", "100%"],
              ["1.1", "110%"],
              ["1.2", "120%"],
            ]}
          />
        </Field>
        <Toggle label="Mostrar fotos de productos" checked={value.showImages} onChange={(v) => set("showImages", v)} />
        <Toggle label="Mostrar stock en cada producto" checked={value.showStock} onChange={(v) => set("showStock", v)} />
        <Toggle label="Teclado numérico en pantalla" checked={value.keypad} onChange={(v) => set("keypad", v)} />
      </section>

      {/* Pantalla de cobro */}
      <section>
        <h3 className="text-sm font-black">Pantalla de cobro</h3>
        <p className="mt-0.5 text-xs text-muted-foreground">
          Cómo se ordena la hoja de cobro. Es una preferencia de pantalla: no cambia los medios habilitados.
        </p>
        <div className="mt-3 grid grid-cols-2 gap-2 sm:gap-3 xl:grid-cols-4" role="radiogroup" aria-label="Pantalla de cobro">
          {CHECKOUT_LAYOUTS.map((l) => {
            const info = CHECKOUT_LAYOUT_INFO[l];
            const on = value.checkout.layout === l;
            return (
              <button
                key={l}
                type="button"
                role="radio"
                aria-checked={on}
                onClick={() => setCheckout({ layout: l })}
                className={choiceClass(on, "rounded-lg p-2")}
              >
                <CheckoutThumb layout={l} className="h-20 w-full sm:h-24" />
                <span className="block px-1 pt-2.5 text-sm font-semibold">{info.name}</span>
                <span className="block px-1 text-xs text-muted-foreground">{info.tagline}</span>
                <span className="block px-1 pb-1 pt-1 text-[11px] font-medium text-muted-foreground">{info.bestFor}</span>
              </button>
            );
          })}
        </div>
        <div className="mt-5 grid gap-x-8 gap-y-5 lg:grid-cols-2">
          <Field label="Densidad del cobro">
            <Seg
              value={value.checkout.density}
              onChange={(v) => setCheckout({ density: v })}
              options={[
                ["compact", "Compacta"],
                ["comfortable", "Cómoda"],
              ]}
            />
          </Field>
          <Toggle
            label="Canales de cada marca en una fila (QR, Link, Point)"
            checked={value.checkout.channelChips}
            onChange={(v) => setCheckout({ channelChips: v })}
          />
        </div>
        {groupsInUse.length > 1 && (
          <div className="mt-5">
            <Field label="Grupos que se muestran al cobrar">
              <ul className="grid gap-1.5 sm:grid-cols-2 lg:grid-cols-3">
                {groupsInUse.map((g) => {
                  const shown = !value.checkout.hiddenGroups.includes(g.key);
                  return (
                    <li key={g.key}>
                      <label className="flex cursor-pointer items-center justify-between gap-3 rounded-lg border border-border bg-card px-3 py-2.5 text-sm font-medium">
                        {g.label}
                        <Switch checked={shown} onCheckedChange={() => toggleGroup(g.key)} label={`Mostrar ${g.label}`} />
                      </label>
                    </li>
                  );
                })}
              </ul>
            </Field>
          </div>
        )}
      </section>

      {/* Medios de cobro */}
      <section>
        <h3 className="text-sm font-black">Medios de cobro en la pantalla</h3>
        <p className="mt-0.5 text-xs text-muted-foreground">
          Fijá hasta 3 para cobrar de un toque desde el carrito, marcá hasta {CHECKOUT_FAVORITES_MAX} favoritos
          para verlos primero al cobrar y ocultá los que no uses. Sólo ordena: habilitar un medio se hace en Medios
          de pago.
        </p>
        {tenders.length === 0 ? (
          <p className="mt-3 rounded-lg bg-muted p-4 text-sm text-muted-foreground">
            Todavía no hay medios habilitados.
          </p>
        ) : (
          <ul className="mt-3 grid gap-1.5 sm:grid-cols-2">
            {tenders.map((t) => {
              const pinned = value.payments.pinned.includes(t.id);
              const hidden = value.payments.hidden.includes(t.id);
              const favorite = value.checkout.favorites.includes(t.id);
              const group = TENDER_GROUPS.find((g) => g.key === t.group)?.label;
              return (
                <li key={t.id} className={cn("flex flex-col gap-2 rounded-lg border border-border bg-card p-2.5", hidden && "opacity-50")}>
                  <div className="flex items-center gap-2.5">
                    <TenderLogo
                      source={t}
                      alt={t.brandLabel}
                      size={32}
                      fallback={tenderFallback(t)}
                      glyph={tenderGlyph(t)}
                      framed
                    />
                    <span className="min-w-0 flex-1">
                      <span className="block text-[13px] font-bold leading-tight">
                        {t.group === "cash" || t.group === "transfer" ? t.label : `${t.brandLabel} · ${t.label}`}
                      </span>
                      {group && group !== t.label && (
                        <span className="block text-[11px] leading-tight text-muted-foreground">{group}</span>
                      )}
                    </span>
                    <Switch checked={!hidden} onCheckedChange={() => toggleHidden(t.id)} label={`Mostrar ${t.brandLabel} ${t.label}`} />
                  </div>
                  <div className="flex gap-1.5 pl-[38px]">
                    <button
                      type="button"
                      onClick={() => toggleFavorite(t.id)}
                      aria-pressed={favorite}
                      disabled={hidden}
                      title="Mostrarlo primero en la pantalla de cobro"
                      className={cn(PILL, favorite ? PILL_ON : PILL_IDLE)}
                    >
                      <Star size={12} className={favorite ? "fill-current" : undefined} /> Favorito
                    </button>
                    <button
                      type="button"
                      onClick={() => togglePin(t.id)}
                      aria-pressed={pinned}
                      disabled={hidden}
                      title="Botón de cobro rápido en el carrito"
                      className={cn(PILL, pinned ? PILL_ON : PILL_IDLE)}
                    >
                      <Pin size={12} /> {pinned ? "En el carrito" : "Al carrito"}
                    </button>
                  </div>
                </li>
              );
            })}
          </ul>
        )}
        <div className="mt-5 grid gap-5 lg:grid-cols-2">
          <Field label="Montos rápidos de efectivo (además de los billetes)">
            <NumberList
              values={value.payments.quickCash}
              onChange={(v) => setPay({ quickCash: v.filter((n) => n > 0).slice(0, 6) })}
              placeholder="Ej. 5000, 15000"
            />
          </Field>
          <Field label="Propinas sugeridas (%)">
            <NumberList
              values={value.tipPresets}
              onChange={(v) => set("tipPresets", v.filter((n) => n >= 0 && n <= 100).slice(0, 5))}
              placeholder="Ej. 10, 15, 20"
            />
          </Field>
        </div>
      </section>

      {/* Teclas rápidas */}
      <section>
        <div className="flex flex-wrap items-baseline justify-between gap-2">
          <div>
            <h3 className="flex items-center gap-1.5 text-sm font-black">
              Teclas rápidas
              {!quickKeysPro && <Lock size={13} className="text-muted-foreground" />}
            </h3>
            <p className="mt-0.5 text-xs text-muted-foreground">
              Botones grandes arriba de la grilla. Sin teclas, se usan tus favoritos.{" "}
              {quickKeysPro
                ? `Hasta ${QUICK_KEYS_PRO_MAX}, con color.`
                : `Hasta ${QUICK_KEYS_BASE_MAX}. Con Teclas rápidas Pro: hasta ${QUICK_KEYS_PRO_MAX} y color por tecla.`}
            </p>
          </div>
          <span className="text-xs font-bold tabular-nums text-muted-foreground">
            {value.quickKeys.length} de {maxKeys}
          </span>
        </div>
        <div className="relative mt-3">
          <Search size={15} className="pointer-events-none absolute left-3.5 top-1/2 -translate-y-1/2 text-muted-foreground" />
          <input
            value={productQuery}
            onChange={(e) => onProductQuery(e.target.value)}
            placeholder="Buscar un producto para sumar"
            aria-label="Buscar un producto para sumar como tecla rápida"
            className="h-11 w-full rounded-lg bg-fg-6 pl-10 pr-3 text-sm outline-none focus:bg-fg-10"
          />
        </div>
        {productQuery.trim() && (
          <ul className="mt-1.5 max-h-56 overflow-y-auto rounded-lg bg-fg-4 p-1">
            {productResults.length === 0 && <li className="px-3 py-2 text-sm text-muted-foreground">Sin resultados.</li>}
            {productResults.slice(0, 12).map((p) => {
              const added = value.quickKeys.some((k) => k.productId === p.id);
              return (
                <li key={p.id}>
                  <button
                    type="button"
                    disabled={added}
                    onClick={() => {
                      if (value.quickKeys.length >= maxKeys) {
                        if (!quickKeysPro) onLockedQuickKeys();
                        return;
                      }
                      set("quickKeys", [...value.quickKeys, { productId: p.id }]);
                      onProductQuery("");
                    }}
                    className="flex w-full items-center gap-2 rounded-xl px-3 py-2 text-left text-sm transition hover:bg-fg-6 disabled:opacity-50"
                  >
                    <Plus size={14} className="text-muted-foreground" />
                    <span className="min-w-0 flex-1 truncate font-semibold">{p.name}</span>
                    <span className="font-price text-xs font-bold tabular-nums">{money(p.price)}</span>
                  </button>
                </li>
              );
            })}
          </ul>
        )}
        {value.quickKeys.length > 0 && (
          <ul className="mt-3 grid gap-1.5 sm:grid-cols-2">
            {value.quickKeys.map((k, i) => {
              const p = keyProducts.get(k.productId);
              return (
                <li key={k.productId} className="flex flex-wrap items-center gap-2 rounded-lg border border-border bg-card p-2">
                  <span className={cn("grid h-9 w-9 shrink-0 place-items-center rounded-xl text-xs font-black", k.color ? QUICK_KEY_FILL[k.color] : "bg-fg-10")}>
                    {i + 1}
                  </span>
                  <span className="min-w-0 flex-1 truncate text-[13px] font-semibold">{p?.name ?? "Producto"}</span>
                  <div className="order-last flex w-full items-center gap-1 pl-11 sm:order-none sm:w-auto sm:gap-0.5 sm:pl-0">
                    {QUICK_KEY_COLORS.map((c) => (
                      <button
                        key={c}
                        type="button"
                        onClick={() =>
                          quickKeysPro
                            ? set(
                                "quickKeys",
                                value.quickKeys.map((x, j) => (j === i ? { ...x, color: x.color === c ? undefined : c } : x)),
                              )
                            : onLockedQuickKeys()
                        }
                        aria-label={`Color ${c}`}
                        aria-pressed={k.color === c}
                        className={cn(
                          "h-5 w-5 rounded-full transition",
                          QUICK_KEY_FILL[c],
                          k.color === c ? "scale-110 shadow-[0_0_0_2px_var(--popover),0_0_0_4px_var(--foreground)]" : "opacity-70 hover:opacity-100",
                        )}
                      />
                    ))}
                  </div>
                  <button type="button" onClick={() => moveKey(i, -1)} aria-label="Subir" className="grid h-8 w-8 place-items-center rounded-full text-muted-foreground hover:bg-fg-6">
                    <ArrowUp size={14} />
                  </button>
                  <button type="button" onClick={() => moveKey(i, 1)} aria-label="Bajar" className="grid h-8 w-8 place-items-center rounded-full text-muted-foreground hover:bg-fg-6">
                    <ArrowDown size={14} />
                  </button>
                  <button
                    type="button"
                    onClick={() => set("quickKeys", value.quickKeys.filter((_, j) => j !== i))}
                    aria-label="Quitar tecla"
                    className="grid h-8 w-8 place-items-center rounded-full text-muted-foreground hover:bg-danger/15 hover:text-danger"
                  >
                    <Trash2 size={14} />
                  </button>
                </li>
              );
            })}
          </ul>
        )}
      </section>
    </div>
  );
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div>
      <p className="mb-1.5 text-[11px] font-semibold uppercase tracking-[0.12em] text-muted-foreground">{label}</p>
      {children}
    </div>
  );
}

function Seg<T extends string>({
  value,
  onChange,
  options,
}: {
  value: T;
  onChange: (v: T) => void;
  options: [T, string][];
}) {
  return (
    <Segmented value={value} onChange={onChange} options={options.map(([v, label]) => ({ value: v, label }))} />
  );
}

function Toggle({ label, checked, onChange }: { label: string; checked: boolean; onChange: (v: boolean) => void }) {
  return (
    <label className="flex cursor-pointer items-center justify-between gap-3 rounded-lg border border-border bg-card px-3.5 py-3 text-sm font-medium">
      {label}
      <Switch checked={checked} onCheckedChange={onChange} label={label} />
    </label>
  );
}

function NumberList({
  values,
  onChange,
  placeholder,
}: {
  values: number[];
  onChange: (v: number[]) => void;
  placeholder: string;
}) {
  return (
    <input
      defaultValue={values.join(", ")}
      key={values.join(",")}
      onBlur={(e) =>
        onChange(
          e.target.value
            .split(/[,;\s]+/)
            .map((s) => Number(s.replace(/\./g, "")))
            .filter((n) => Number.isFinite(n) && n > 0),
        )
      }
      placeholder={placeholder}
      inputMode="numeric"
      className="h-11 w-full rounded-lg bg-fg-6 px-3.5 text-sm font-semibold outline-none focus:bg-fg-10"
    />
  );
}
