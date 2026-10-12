"use client";

import { CreditCard, Link2, QrCode, Smartphone } from "lucide-react";
import type { ResolvedTender, TenderSection } from "@/lib/pos/tenders";
import { cn } from "@/lib/utils/cn";
import { BrandIcon } from "../ui/BrandIcon";
import { POS_SELECTED, POS_SURFACE, money } from "../ui/posStyles";

// Grilla de medios de cobro agrupada por medio → marca → canal. Las marcas con
// varios canales (Mercado Pago, Payway, Getnet, Nave) se muestran como una fila
// con su logo y los canales como segmentos. Selección con relleno.

const BRAND_GROUPS = new Set(["mercadopago", "payway", "getnet", "nave"]);

const CHANNEL_ICON = {
  qr: QrCode,
  link: Link2,
  point: Smartphone,
  manual: CreditCard,
} as const;

export function TenderPicker({
  sections,
  activeId,
  onPick,
  promoBadge,
  disabled,
}: {
  sections: TenderSection[];
  activeId: string | null;
  onPick: (t: ResolvedTender) => void;
  /** Descuento por medio a mostrar en el botón (promo por medio de pago). */
  promoBadge?: (t: ResolvedTender) => number;
  disabled?: boolean;
}) {
  return (
    <div className="space-y-5">
      {sections.map((s) => (
        <section key={s.key} aria-label={s.label}>
          <h3 className="mb-2 px-1 text-[11px] font-semibold uppercase tracking-[0.12em] text-muted-foreground">
            {s.label}
          </h3>
          {BRAND_GROUPS.has(s.key) ? (
            <BrandRow section={s} activeId={activeId} onPick={onPick} promoBadge={promoBadge} disabled={disabled} />
          ) : (
            <div className="grid grid-cols-2 gap-2 sm:grid-cols-3 md:grid-cols-2 lg:grid-cols-3">
              {s.tenders.map((t) => {
                const on = t.id === activeId;
                const promo = promoBadge?.(t) ?? 0;
                return (
                  <button
                    key={t.id}
                    type="button"
                    disabled={disabled}
                    onClick={() => onPick(t)}
                    className={cn(
                      "relative flex min-h-[64px] items-center gap-3 rounded-2xl p-2.5 pr-3 text-left transition active:scale-[0.98] disabled:opacity-50",
                      on ? POS_SELECTED : cn(POS_SURFACE, "hover:bg-muted"),
                    )}
                    aria-pressed={on}
                  >
                    <BrandIcon
                      logo={t.logo}
                      alt={t.brandLabel}
                      size={38}
                      fallback={t.flow === "account" ? "account" : "wallet"}
                    />
                    <span className="min-w-0">
                      <span className="block truncate text-sm font-bold">
                        {s.key === "wallets" ? t.brandLabel : t.label}
                      </span>
                      <span className={cn("block truncate text-[11px]", on ? "opacity-70" : "text-muted-foreground")}>
                        {s.key === "wallets" ? t.label : t.hint ?? " "}
                      </span>
                    </span>
                    {promo > 0 && (
                      <span className="absolute -top-1.5 right-2 rounded-full bg-success px-1.5 py-0.5 text-[10px] font-bold text-background">
                        −{money(promo)}
                      </span>
                    )}
                  </button>
                );
              })}
            </div>
          )}
        </section>
      ))}
    </div>
  );
}

function BrandRow({
  section,
  activeId,
  onPick,
  promoBadge,
  disabled,
}: {
  section: TenderSection;
  activeId: string | null;
  onPick: (t: ResolvedTender) => void;
  promoBadge?: (t: ResolvedTender) => number;
  disabled?: boolean;
}) {
  const first = section.tenders[0];
  if (!first) return null;
  const brandActive = section.tenders.some((t) => t.id === activeId);
  return (
    <div
      className={cn(
        "flex items-center gap-3 rounded-2xl p-2.5 transition",
        brandActive ? "bg-[color-mix(in_srgb,var(--pos-from)_12%,var(--card))]" : POS_SURFACE,
      )}
    >
      <BrandIcon logo={first.logo} alt={first.brandLabel} size={42} />
      <span className="hidden min-w-0 flex-1 truncate text-sm font-bold sm:block">{first.brandLabel}</span>
      <div className="ml-auto flex flex-1 gap-1.5 sm:flex-none">
        {section.tenders.map((t) => {
          const Icon = CHANNEL_ICON[t.channel];
          const on = t.id === activeId;
          const promo = promoBadge?.(t) ?? 0;
          return (
            <button
              key={t.id}
              type="button"
              disabled={disabled}
              onClick={() => onPick(t)}
              aria-pressed={on}
              aria-label={`${t.brandLabel} ${t.label}`}
              className={cn(
                "relative flex h-11 min-w-[4.5rem] flex-1 items-center justify-center gap-1.5 rounded-xl px-3 text-[13px] font-bold transition active:scale-95 disabled:opacity-50 sm:flex-none",
                on ? POS_SELECTED : "bg-muted/80 text-foreground hover:bg-muted",
              )}
            >
              <Icon size={15} />
              {t.label}
              {promo > 0 && (
                <span className="absolute -top-1.5 -right-1 rounded-full bg-success px-1 text-[9px] font-bold text-background">
                  %
                </span>
              )}
            </button>
          );
        })}
      </div>
    </div>
  );
}
