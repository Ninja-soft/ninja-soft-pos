"use client";

import { CreditCard, PlugZap } from "lucide-react";
import { Segmented } from "@/components/ui/Segmented";
import { choiceClass } from "@/components/ui/ChoiceCard";
import { CardBrandLogo } from "@/components/ui/ThemedLogo";
import { round2 } from "@/lib/pos/checkoutMath";
import { cardLogoKey, type CardBrand, type CardKind } from "@/lib/pos/cardBrands";
import type { IntegratedTenderInfo } from "@/lib/pos/tenders";
import { money } from "../ui/posStyles";
import { PlanChip, type WizardPlan } from "./CardWizard";

// "Tarjeta en terminal" (ADR-053): el cajero elige débito / crédito y cuotas
// (y la marca si el protocolo la pide), y el monto va a la terminal
// integrada de la caja. El cupón vuelve solo. "Cargar a mano" pasa a la
// Tarjeta en posnet de siempre.

const LABEL = "block text-[11px] font-semibold uppercase tracking-[0.08em] text-muted-foreground";

export function IntegratedCardPanel({
  info,
  brands,
  brand,
  onBrand,
  kind,
  onKind,
  plans,
  planId,
  onPlan,
  portion,
  amount,
  surcharge,
  onManual,
}: {
  info: IntegratedTenderInfo;
  brands: CardBrand[];
  brand: string | null;
  onBrand: (key: string) => void;
  kind: CardKind;
  onKind: (k: CardKind) => void;
  plans: WizardPlan[];
  planId: string;
  onPlan: (id: string) => void;
  portion: number;
  amount: number;
  surcharge: number;
  onManual: () => void;
}) {
  const shownPlans = plans.filter((p) => (p.installments ?? 1) > 1 || (Number(p.surcharge_pct) || 0) > 0);
  const chipLogo = cardLogoKey(brand, kind);
  return (
    <div className="space-y-4">
      <div className="flex items-start gap-2.5 rounded-lg bg-muted px-3.5 py-2.5 text-xs text-muted-foreground">
        <PlugZap size={15} className="mt-0.5 shrink-0" aria-hidden />
        <p>
          El monto va a <span className="font-medium text-foreground">{info.label}</span>
          {info.simulated ? " (simulador, no cobra de verdad)" : ""}. Lote, cupón, autorización y tarjeta vuelven
          solos al aprobarse.
        </p>
      </div>

      {info.requiresBrand && (
        <div>
          <p className={LABEL}>Tarjeta</p>
          <div className="mt-1.5 grid grid-cols-4 gap-1.5 sm:grid-cols-7" role="radiogroup" aria-label="Tarjeta">
            {brands
              .filter((b) => b.key !== "other")
              .map((b) => {
                const logo = cardLogoKey(b.key);
                const on = brand === b.key;
                return (
                  <button
                    key={b.key}
                    type="button"
                    role="radio"
                    aria-checked={on}
                    onClick={() => {
                      onBrand(b.key);
                      if (!b.kinds.includes(kind)) onKind(b.kinds[0] ?? "debit");
                    }}
                    className={choiceClass(on, "flex min-h-[64px] flex-col items-center justify-center gap-1 rounded-lg px-1 py-2")}
                  >
                    {logo ? (
                      <CardBrandLogo brand={logo} label={b.label} height={22} />
                    ) : (
                      <CreditCard size={18} className="text-muted-foreground" aria-hidden />
                    )}
                    <span className="w-full truncate text-center text-[11px] font-medium">{b.short ?? b.label}</span>
                  </button>
                );
              })}
          </div>
        </div>
      )}

      <Segmented
        fill
        aria-label="Tipo de tarjeta"
        value={kind}
        onChange={onKind}
        options={[
          { value: "debit", label: "Débito" },
          { value: "credit", label: "Crédito" },
        ]}
      />

      {shownPlans.length > 0 && (
        <div>
          <p className={LABEL}>{kind === "credit" ? "Cuotas" : "Plan"}</p>
          <div className="mt-1.5 grid grid-cols-2 gap-1.5 sm:grid-cols-3" role="radiogroup" aria-label="Cuotas">
            <PlanChip on={planId === ""} onClick={() => onPlan("")} title="1 pago" sub={money(portion)} brand={chipLogo} />
            {shownPlans.map((p) => {
              const pct = Number(p.surcharge_pct) || 0;
              return (
                <PlanChip
                  key={p.id}
                  on={planId === p.id}
                  onClick={() => onPlan(p.id)}
                  brand={chipLogo}
                  title={p.installments && p.installments > 1 ? `${p.installments} cuotas` : "1 pago"}
                  sub={pct > 0 ? `+${pct}% · ${money(round2(portion * (1 + pct / 100)))}` : `Sin recargo · ${money(portion)}`}
                />
              );
            })}
          </div>
        </div>
      )}

      <div className="flex items-end justify-between gap-3 rounded-lg bg-muted px-3.5 py-2.5">
        <div className="text-[11px] text-muted-foreground">
          <p>Monto {money(portion)}</p>
          {surcharge > 0 && <p>Recargo +{money(surcharge)}</p>}
        </div>
        <div className="text-right">
          <p className="text-[11px] text-muted-foreground">Va a la terminal</p>
          <p className="font-price text-xl font-bold tabular-nums text-foreground">{money(amount)}</p>
        </div>
      </div>

      <button
        type="button"
        onClick={onManual}
        className="text-xs font-medium text-muted-foreground underline-offset-2 transition hover:text-foreground hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
      >
        Cobrar en otro posnet y cargar el cupón a mano
      </button>
    </div>
  );
}
