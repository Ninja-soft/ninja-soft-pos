"use client";

import { Fragment } from "react";
import { Check, ChevronRight, CreditCard, Link2, QrCode, Smartphone } from "lucide-react";
import { brandRuns, type CheckoutSection, type ResolvedTender } from "@/lib/pos/tenders";
import { cn } from "@/lib/utils/cn";
import { TenderLogo, tenderFallback, tenderGlyph } from "../ui/TenderLogo";
import { money } from "../ui/posStyles";

// Selector de medios de cobro de la hoja de cobro, agrupado por medio, marca y
// canal. Las marcas con varios canales (Mercado Pago, Payway, Getnet, Nave y,
// dentro de "Billeteras y links", GO Cuotas, Mobbex o Directo con API) van en
// una fila con su logo y los canales como un control segmentado. Logos
// oficiales transparentes con variante oscura (TenderLogo → ThemedLogo).
//
// Lenguaje visual del POS: superficies neutras con borde sutil, esquinas de
// 8px, selección con borde neutro fuerte + relleno (--choice-fill) + tilde,
// sin sombras, nunca borde de color ni degradado. Cada medio lleva su ícono en
// un contenedor cuadrado del mismo tamaño: logo oficial de la marca o, para
// los genéricos (efectivo, transferencia, posnet, vale, cuenta corriente), el
// set propio Phosphor duotone (TenderLogo → tenderGlyph). El título usa hasta
// dos líneas y la bajada completa queda en el tooltip (title).
//
// Variantes:
//   tiles   → grilla de tiles (Dos columnas)
//   list    → filas a lo ancho (Lista compacta), con el editor desplegado
//             debajo del medio activo
//   big     → tiles grandes para pantallas táctiles (Botones grandes)
//   compact → tiles chicos en dos columnas (Teclado primero)

export type TenderPickerVariant = "tiles" | "list" | "big" | "compact";

const BRAND_GROUPS = new Set(["mercadopago", "payway", "getnet", "nave", "fiserv"]);

const CHANNEL_ICON = {
  qr: QrCode,
  link: Link2,
  point: Smartphone,
  manual: CreditCard,
} as const;

const SURFACE = "border border-border bg-card";
const SURFACE_HOVER = "hover:bg-muted/60";

// Medios "simples" (un solo botón por grupo: efectivo, transferencia, tarjeta,
// cuenta del cliente, o una marca con un único canal) van juntos en una grilla
// sin un rótulo por grupo. Las marcas con varios canales van en su fila y las
// billeteras con su rótulo.
type Block =
  | { kind: "grid"; key: string; label: string | null; tenders: ResolvedTender[]; wallets: boolean }
  | { kind: "brand"; key: string; section: CheckoutSection }
  | { kind: "wallets"; key: string; label: string; rows: CheckoutSection[]; tenders: ResolvedTender[] };

function blocksOf(sections: CheckoutSection[], channelChips: boolean): Block[] {
  const out: Block[] = [];
  for (const s of sections) {
    if (channelChips && BRAND_GROUPS.has(s.key) && s.tenders.length > 1) {
      out.push({ kind: "brand", key: s.key, section: s });
    } else if (channelChips && s.key === "wallets") {
      // Billeteras y links: cada marca con varios canales (GO Cuotas QR + Link,
      // Directo con API, Mobbex) en su fila con segmentos, igual que Payway o
      // Nave; las de un solo canal, en la grilla debajo.
      const runs = brandRuns(s.tenders);
      out.push({
        kind: "wallets",
        key: s.key,
        label: s.label,
        rows: runs.filter((r) => r.length > 1).map((r) => ({ ...s, label: r[0]!.brandLabel, tenders: r })),
        tenders: runs.filter((r) => r.length === 1).flat(),
      });
    } else if (s.key === "favorites" || s.key === "wallets") {
      out.push({ kind: "grid", key: s.key, label: s.label, tenders: s.tenders, wallets: s.key === "wallets" });
    } else {
      // Todos los simples en una sola grilla, donde aparece el primero.
      const main = out.find((x): x is Extract<Block, { kind: "grid" }> => x.kind === "grid" && x.key === "main");
      if (main) main.tenders.push(...s.tenders);
      else out.push({ kind: "grid", key: "main", label: null, tenders: [...s.tenders], wallets: false });
    }
  }
  // Rótulo "Medios" sólo cuando hay favoritos arriba (para separarlos).
  if (out[0]?.key === "favorites") {
    for (const b of out) if (b.kind === "grid" && b.label === null) b.label = "Otros medios";
  }
  return out;
}

const SIMPLE_GROUPS = new Set(["cash", "transfer", "card", "customer"]);

function tenderTitle(t: ResolvedTender, wallets: boolean): string {
  if (wallets) return t.brandLabel;
  return SIMPLE_GROUPS.has(t.group) || t.group === "wallets" ? t.label : `${t.brandLabel} ${t.label}`;
}

function tenderSub(t: ResolvedTender, wallets: boolean): string | undefined {
  if (wallets) return t.label;
  return t.hint;
}

export function TenderPicker({
  sections,
  activeId,
  onPick,
  promoBadge,
  disabled,
  variant = "tiles",
  channelChips = true,
  dense = false,
  renderExpanded,
}: {
  sections: CheckoutSection[];
  activeId: string | null;
  onPick: (t: ResolvedTender) => void;
  /** Descuento por medio a mostrar en el botón (promo por medio de pago). */
  promoBadge?: (t: ResolvedTender) => number;
  disabled?: boolean;
  variant?: TenderPickerVariant;
  /** Marcas con varios canales en una fila con segmentos (si no, un tile por canal). */
  channelChips?: boolean;
  dense?: boolean;
  /** Sólo `list`: contenido desplegado debajo del medio activo (el editor). */
  renderExpanded?: () => React.ReactNode;
}) {
  const expanded = (ids: string[]) =>
    variant === "list" && renderExpanded && activeId && ids.includes(activeId) ? (
      <div className="rounded-b-lg border border-t-0 border-border bg-card px-3 pb-3 pt-1">{renderExpanded()}</div>
    ) : null;
  const blocks = blocksOf(sections, channelChips);

  const brandRow = (section: CheckoutSection) => {
    const ids = section.tenders.map((t) => t.id);
    return (
      <>
        <BrandRow
          section={section}
          activeId={activeId}
          onPick={onPick}
          promoBadge={promoBadge}
          disabled={disabled}
          variant={variant}
          dense={dense}
          attached={Boolean(expanded(ids))}
        />
        {expanded(ids)}
      </>
    );
  };

  const grid = (tenders: ResolvedTender[], wallets: boolean) => (
    <div
      className={cn(
        "grid",
        variant === "list" ? "gap-1.5" : "gap-2",
        variant === "tiles" && "grid-cols-2 sm:grid-cols-[repeat(auto-fill,minmax(200px,1fr))]",
        variant === "big" && "grid-cols-[repeat(auto-fill,minmax(176px,1fr))]",
        variant === "compact" && "grid-cols-2",
        variant === "list" && "grid-cols-1",
      )}
    >
      {tenders.map((t) => (
        <Fragment key={t.id}>
          <Tile
            t={t}
            title={tenderTitle(t, wallets)}
            sub={tenderSub(t, wallets)}
            on={t.id === activeId}
            onPick={onPick}
            promo={promoBadge?.(t) ?? 0}
            disabled={disabled}
            variant={variant}
            dense={dense}
            attached={Boolean(expanded([t.id]))}
          />
          {expanded([t.id])}
        </Fragment>
      ))}
    </div>
  );

  return (
    <div className={cn(dense ? "space-y-3" : "space-y-4")}>
      {blocks.map((b) => {
        if (b.kind === "brand") {
          return (
            <section key={b.key} aria-label={b.section.label}>
              {brandRow(b.section)}
            </section>
          );
        }
        if (b.kind === "wallets") {
          return (
            <section key={b.key} aria-label={b.label}>
              <SectionLabel>{b.label}</SectionLabel>
              <div className={cn(variant === "list" ? "space-y-1.5" : "space-y-2")}>
                {b.rows.map((r) => (
                  <div key={r.tenders[0]!.brand}>{brandRow(r)}</div>
                ))}
                {b.tenders.length > 0 && grid(b.tenders, true)}
              </div>
            </section>
          );
        }
        return (
          <section key={b.key} aria-label={b.label ?? "Medios de cobro"}>
            {b.label && <SectionLabel>{b.label}</SectionLabel>}
            {grid(b.tenders, b.wallets)}
          </section>
        );
      })}
    </div>
  );
}

function SectionLabel({ children }: { children: React.ReactNode }) {
  return (
    <h3 className="mb-1.5 px-0.5 text-[11px] font-semibold uppercase tracking-[0.08em] text-muted-foreground">
      {children}
    </h3>
  );
}

function Tile({
  t,
  title,
  sub,
  on,
  onPick,
  promo,
  disabled,
  variant,
  dense,
  attached,
}: {
  t: ResolvedTender;
  title: string;
  sub?: string;
  on: boolean;
  onPick: (t: ResolvedTender) => void;
  promo: number;
  disabled?: boolean;
  variant: TenderPickerVariant;
  dense: boolean;
  attached: boolean;
}) {
  const big = variant === "big";
  const list = variant === "list";
  const compact = variant === "compact";
  const tiles = variant === "tiles";
  // Contenedor del ícono: mismo tamaño para logos de marca e íconos propios.
  const logo = big ? 44 : compact ? 32 : list ? 36 : 40;
  const promoTag =
    promo > 0 ? (
      <span className="shrink-0 rounded-md bg-success/15 px-1.5 py-0.5 text-[11px] font-semibold tabular-nums text-success">
        -{money(promo)}
      </span>
    ) : null;
  return (
    <button
      type="button"
      disabled={disabled}
      onClick={() => onPick(t)}
      aria-pressed={on}
      title={sub ? `${title}: ${sub}` : title}
      className={cn(
        "relative flex w-full min-w-0 text-left transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:cursor-not-allowed disabled:opacity-50",
        "rounded-lg border",
        attached && "rounded-b-none",
        // Seleccionado: borde fuerte neutro + relleno + tilde. Sin sombras.
        on ? "border-foreground/60 bg-[var(--choice-fill)]" : cn(SURFACE, SURFACE_HOVER),
        big
          ? cn("flex-col items-start gap-2.5 p-3.5 pr-9", dense ? "min-h-[104px]" : "min-h-[124px]")
          : compact
            ? cn("items-center gap-2.5 py-1.5 pl-2 pr-7", dense ? "min-h-[48px]" : "min-h-[56px]")
            : list
              ? cn("items-center gap-3 px-3", dense ? "min-h-[52px] py-1.5" : "min-h-[60px] py-2")
              : cn(
                  // Tiles: en celular ícono arriba (dos columnas); desde sm, en fila.
                  "flex-col items-start gap-2 p-3 pr-9 sm:flex-row sm:items-center sm:gap-3",
                  dense ? "min-h-[64px]" : "min-h-[72px]",
                ),
      )}
    >
      <TenderLogo
        source={t}
        alt={t.brandLabel}
        size={logo}
        fallback={tenderFallback(t)}
        glyph={tenderGlyph(t)}
        framed
      />
      <span className={cn("min-w-0 flex-1", (big || tiles) && "w-full")}>
        <span
          className={cn(
            "block font-semibold leading-tight text-foreground [overflow-wrap:anywhere]",
            list ? "truncate" : "line-clamp-2",
            big ? "text-base" : compact ? "text-[13px]" : "text-sm",
          )}
        >
          {title}
        </span>
        {sub && !compact && (
          <span
            className={cn(
              "mt-0.5 block leading-snug text-muted-foreground",
              list ? "truncate" : "line-clamp-2",
              big ? "text-xs" : "text-[11px]",
            )}
          >
            {sub}
          </span>
        )}
        {promoTag && !list && <span className="mt-1.5 flex">{promoTag}</span>}
      </span>
      {list && promoTag}
      {on ? (
        <span
          aria-hidden
          className={cn(
            "grid h-5 w-5 shrink-0 place-items-center rounded-full bg-[var(--pos-solid)] text-white",
            !list && "absolute right-2 top-2",
          )}
        >
          <Check size={12} strokeWidth={3.5} />
        </span>
      ) : (
        list && <ChevronRight size={16} className="shrink-0 text-muted-foreground" />
      )}
    </button>
  );
}

function BrandRow({
  section,
  activeId,
  onPick,
  promoBadge,
  disabled,
  variant,
  dense,
  attached,
}: {
  section: CheckoutSection;
  activeId: string | null;
  onPick: (t: ResolvedTender) => void;
  promoBadge?: (t: ResolvedTender) => number;
  disabled?: boolean;
  variant: TenderPickerVariant;
  dense: boolean;
  attached: boolean;
}) {
  const first = section.tenders[0];
  if (!first) return null;
  const brandActive = section.tenders.some((t) => t.id === activeId);
  const big = variant === "big";
  const stacked = big || variant === "compact";
  return (
    <div
      className={cn(
        "flex gap-3 rounded-lg p-2 transition",
        attached && "rounded-b-none",
        stacked ? "flex-col items-stretch" : "flex-wrap items-center sm:flex-nowrap",
        brandActive ? "border border-foreground/60 bg-[var(--choice-fill)]" : SURFACE,
      )}
    >
      <span className={cn("flex min-w-0 items-center gap-2.5", !stacked && "flex-1 pl-1")}>
        <TenderLogo source={first} alt={first.brandLabel} size={big ? 44 : variant === "compact" ? 32 : 40} framed />
        <span className={cn("truncate font-semibold text-foreground", big ? "text-base" : "text-sm")}>
          {first.brandLabel}
        </span>
      </span>
      <div
        role="radiogroup"
        aria-label={`Canal de ${first.brandLabel}`}
        className={cn(
          "grid auto-cols-fr grid-flow-col gap-1 rounded-lg bg-[var(--seg-track)] p-1",
          stacked ? "w-full" : "w-full sm:w-auto",
        )}
      >
        {section.tenders.map((t) => {
          const Icon = CHANNEL_ICON[t.channel];
          const on = t.id === activeId;
          const promo = promoBadge?.(t) ?? 0;
          return (
            <button
              key={t.id}
              type="button"
              role="radio"
              disabled={disabled}
              onClick={() => onPick(t)}
              aria-checked={on}
              aria-label={`${t.brandLabel} ${t.label}`}
              className={cn(
                "relative flex items-center justify-center gap-1.5 whitespace-nowrap rounded-md px-3 text-[13px] font-semibold transition focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-50",
                big ? "h-12 text-sm" : dense ? "h-8" : "h-9",
                on
                  ? "bg-[var(--seg-thumb)] text-foreground shadow-[var(--seg-thumb-shadow)]"
                  : "text-muted-foreground hover:text-foreground",
              )}
            >
              {on ? (
                <span className="grid h-4 w-4 place-items-center rounded-full bg-[var(--pos-solid)] text-white">
                  <Check size={10} strokeWidth={3.5} />
                </span>
              ) : (
                <Icon size={14} />
              )}
              {t.label}
              {promo > 0 && <span className="text-[11px] font-semibold text-success">%</span>}
            </button>
          );
        })}
      </div>
    </div>
  );
}
