"use client";

import { ArrowDown, ArrowUp, Check, Lock, Pin, Plus, Search, Trash2 } from "lucide-react";
import { Switch } from "@/components/ui/Switch";
import {
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
import { BrandIcon } from "../ui/BrandIcon";
import { POS_IDLE, POS_SELECTED, QUICK_KEY_FILL, accentVars, money } from "../ui/posStyles";
import { PresetThumb } from "../screen/PresetThumb";

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
  const maxKeys = quickKeysPro ? QUICK_KEYS_PRO_MAX : QUICK_KEYS_BASE_MAX;

  const pickPreset = (p: PosPreset) =>
    onChange({
      ...PRESET_DEFAULTS[p],
      accent: value.accent,
      fontScale: value.fontScale,
      payments: value.payments,
      quickKeys: value.quickKeys,
      tipPresets: value.tipPresets,
    });

  const togglePin = (id: string) => {
    const pinned = value.payments.pinned.includes(id)
      ? value.payments.pinned.filter((x) => x !== id)
      : [...value.payments.pinned, id].slice(-3);
    setPay({ pinned });
  };
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
        <div className="mt-3 grid grid-cols-1 gap-3 sm:grid-cols-2 xl:grid-cols-4">
          {POS_PRESETS.map((p) => {
            const info = PRESET_INFO[p];
            const blocked = Boolean(info.requiresDining && !diningEnabled);
            const on = value.preset === p;
            return (
              <button
                key={p}
                type="button"
                disabled={blocked}
                onClick={() => pickPreset(p)}
                aria-pressed={on}
                className={cn(
                  "rounded-3xl p-2 text-left transition active:scale-[0.99] disabled:opacity-50",
                  on ? POS_SELECTED : "bg-fg-6 hover:bg-fg-10",
                )}
              >
                <PresetThumb preset={p} className="h-32 w-full" />
                <span className="flex items-center justify-between gap-2 px-1.5 pt-2.5">
                  <span className="text-sm font-black">{info.name}</span>
                  {on && <Check size={16} />}
                </span>
                <span className={cn("block px-1.5 text-xs", on ? "opacity-75" : "text-muted-foreground")}>
                  {info.tagline}
                </span>
                <span className={cn("block px-1.5 pb-1.5 pt-1 text-[11px] font-semibold", on ? "opacity-60" : "text-muted-foreground")}>
                  {blocked ? "Activá el modo gastronómico en Operación" : info.bestFor}
                </span>
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
                  className={cn("flex h-10 items-center gap-2 rounded-full pl-1.5 pr-3.5 text-[13px] font-bold transition", on ? POS_SELECTED : POS_IDLE)}
                >
                  <span className="h-7 w-7 rounded-full" style={{ background: `linear-gradient(135deg, ${g.from}, ${g.via}, ${g.to})` }} />
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

      {/* Medios de cobro */}
      <section>
        <h3 className="text-sm font-black">Medios de cobro en la pantalla</h3>
        <p className="mt-0.5 text-xs text-muted-foreground">
          Fijá hasta 3 para cobrar de un toque desde el carrito y ocultá los que no uses. Sólo ordena:
          habilitar un medio se hace en Medios de pago.
        </p>
        {tenders.length === 0 ? (
          <p className="mt-3 rounded-2xl bg-fg-4 p-4 text-sm text-muted-foreground">
            Todavía no hay medios habilitados.
          </p>
        ) : (
          <ul className="mt-3 grid gap-1.5 sm:grid-cols-2">
            {tenders.map((t) => {
              const pinned = value.payments.pinned.includes(t.id);
              const hidden = value.payments.hidden.includes(t.id);
              const group = TENDER_GROUPS.find((g) => g.key === t.group)?.label;
              return (
                <li key={t.id} className={cn("flex items-center gap-3 rounded-2xl bg-fg-4 p-2 pr-2.5", hidden && "opacity-50")}>
                  <BrandIcon logo={t.logo} alt={t.brandLabel} size={34} />
                  <span className="min-w-0 flex-1">
                    <span className="block truncate text-[13px] font-bold">
                      {t.group === "cash" || t.group === "transfer" ? t.label : `${t.brandLabel} · ${t.label}`}
                    </span>
                    {group && group !== t.label && (
                      <span className="block truncate text-[11px] text-muted-foreground">{group}</span>
                    )}
                  </span>
                  <button
                    type="button"
                    onClick={() => togglePin(t.id)}
                    aria-pressed={pinned}
                    disabled={hidden}
                    className={cn("flex h-8 items-center gap-1 rounded-full px-2.5 text-[11px] font-bold transition", pinned ? POS_SELECTED : POS_IDLE)}
                  >
                    <Pin size={12} /> {pinned ? "Fijado" : "Fijar"}
                  </button>
                  <Switch checked={!hidden} onCheckedChange={() => toggleHidden(t.id)} label={`Mostrar ${t.brandLabel} ${t.label}`} />
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
            className="h-11 w-full rounded-2xl bg-fg-6 pl-10 pr-3 text-sm outline-none focus:bg-fg-10"
          />
        </div>
        {productQuery.trim() && (
          <ul className="mt-1.5 max-h-56 overflow-y-auto rounded-2xl bg-fg-4 p-1">
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
                <li key={k.productId} className="flex flex-wrap items-center gap-2 rounded-2xl bg-fg-4 p-2">
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
    <div className="inline-flex flex-wrap gap-1 rounded-2xl bg-fg-6 p-1">
      {options.map(([v, label]) => (
        <button
          key={v}
          type="button"
          onClick={() => onChange(v)}
          aria-pressed={value === v}
          className={cn(
            "h-9 rounded-xl px-3 text-[13px] font-bold transition",
            value === v ? "bg-card text-foreground shadow-sm" : "text-muted-foreground hover:text-foreground",
          )}
        >
          {label}
        </button>
      ))}
    </div>
  );
}

function Toggle({ label, checked, onChange }: { label: string; checked: boolean; onChange: (v: boolean) => void }) {
  return (
    <label className="flex cursor-pointer items-center justify-between gap-3 rounded-2xl bg-fg-4 px-3.5 py-3 text-sm font-semibold">
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
      className="h-11 w-full rounded-2xl bg-fg-6 px-3.5 text-sm font-semibold outline-none focus:bg-fg-10"
    />
  );
}
