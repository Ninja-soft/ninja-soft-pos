"use client";

import { ChevronLeft, CreditCard } from "lucide-react";
import { Segmented } from "@/components/ui/Segmented";
import { choiceClass } from "@/components/ui/ChoiceCard";
import { CardBrandLogo } from "@/components/ui/ThemedLogo";
import { round2 } from "@/lib/pos/checkoutMath";
import { cardBrandByKey, cardLogoKey, type CardBrand, type CardKind } from "@/lib/pos/cardBrands";
import { cn } from "@/lib/utils/cn";
import { money } from "../ui/posStyles";

// "Tarjeta en posnet": cobro con una terminal NO integrada. El cajero pasa la
// tarjeta en su posnet y registra el cupón acá, en tres pasos:
//   1) Entidad (Visa, Mastercard, Amex…)
//   2) Tipo (débito / crédito) y cuotas con su recargo (se salta si la entidad
//      sólo emite débito)
//   3) Datos del cupón, con un resumen tipo cupón antes de registrar.
// Sólo presentación: el pago se registra como debit/credit con su
// card_voucher y el plan de payment_plans, igual que antes.

export type CardStep = 1 | 2 | 3;

export interface CardVoucherDraft {
  cupon: string;
  lote: string;
  ultimos4: string;
  autorizacion: string;
}
export const EMPTY_VOUCHER: CardVoucherDraft = { cupon: "", lote: "", ultimos4: "", autorizacion: "" };

export interface WizardPlan {
  id: string;
  label: string;
  installments: number | null;
  surcharge_pct: number | string | null;
}

const STEP_TITLE: Record<CardStep, string> = {
  1: "Entidad de la tarjeta",
  2: "Tipo y cuotas",
  3: "Datos del cupón",
};

const LABEL = "block text-[11px] font-semibold uppercase tracking-[0.08em] text-muted-foreground";
const INPUT =
  "h-11 w-full min-w-0 rounded-lg border bg-background px-3 text-sm font-medium tabular-nums text-foreground outline-none transition placeholder:text-muted-foreground focus:border-ring focus-visible:ring-2 focus-visible:ring-ring/40";

export function CardWizard({
  brands,
  brand,
  onBrand,
  step,
  onStep,
  kind,
  onKind,
  plans,
  planId,
  onPlan,
  portion,
  amount,
  surcharge,
  voucher,
  onVoucher,
  voucherRequired,
  onEnter,
}: {
  brands: CardBrand[];
  brand: string | null;
  onBrand: (key: string) => void;
  step: CardStep;
  onStep: (s: CardStep) => void;
  kind: CardKind;
  onKind: (k: CardKind) => void;
  plans: WizardPlan[];
  planId: string;
  onPlan: (id: string) => void;
  /** Monto con este medio (sin recargo). */
  portion: number;
  /** Total a cobrar con el recargo del plan. */
  amount: number;
  surcharge: number;
  voucher: CardVoucherDraft;
  onVoucher: (v: CardVoucherDraft) => void;
  voucherRequired: boolean;
  onEnter: () => void;
}) {
  const info = cardBrandByKey(brand);
  const debitOnly = info ? info.kinds.length === 1 && info.kinds[0] === "debit" : false;
  const plan = plans.find((p) => p.id === planId) ?? null;
  // Un plan de 1 pago sin recargo es lo mismo que "sin plan": no se repite.
  const shownPlans = plans.filter((p) => (p.installments ?? 1) > 1 || (Number(p.surcharge_pct) || 0) > 0);
  const noPlanTitle = kind === "credit" && !shownPlans.some((p) => (p.installments ?? 1) <= 1) ? "1 pago" : "Sin plan";
  // Logo de la tarjeta elegida en los chips de cuotas.
  const chipLogo = cardLogoKey(brand, kind);

  function pickBrand(b: CardBrand) {
    onBrand(b.key);
    const only = b.kinds.length === 1 ? b.kinds[0] : null;
    if (only) onKind(only);
    else if (!b.kinds.includes(kind)) onKind(b.kinds[0] ?? "debit");
    onStep(only === "debit" ? 3 : 2);
  }

  const back = () => onStep(step === 3 && !debitOnly ? 2 : 1);
  const set = (k: keyof CardVoucherDraft, v: string) => onVoucher({ ...voucher, [k]: v });
  const last4Bad = voucher.ultimos4.trim() !== "" && !/^\d{4}$/.test(voucher.ultimos4.trim());
  const missing = voucherRequired
    ? (["cupon", "lote", "autorizacion"] as const).filter((k) => voucher[k].trim() === "")
    : [];

  return (
    <div className="space-y-4">
      {/* Indicador de paso + Atrás */}
      <div className="flex items-center gap-3">
        {step > 1 && (
          <button
            type="button"
            onClick={back}
            className="flex h-8 items-center gap-0.5 rounded-md pr-2 text-sm font-medium text-muted-foreground transition hover:bg-muted hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
          >
            <ChevronLeft size={16} /> Atrás
          </button>
        )}
        <div className="min-w-0 flex-1">
          <p className="text-[11px] font-medium text-muted-foreground">Paso {step} de 3</p>
          <p className="truncate text-sm font-semibold">{STEP_TITLE[step]}</p>
        </div>
        <div className="flex gap-1" aria-hidden>
          {([1, 2, 3] as const).map((s) => (
            <span
              key={s}
              className={cn("h-1.5 w-6 rounded-full", s <= step ? "bg-foreground/70" : "bg-muted")}
            />
          ))}
        </div>
      </div>

      {step === 1 && (
        <div className="grid grid-cols-3 gap-2 sm:grid-cols-4" role="radiogroup" aria-label="Entidad de la tarjeta">
          {brands.map((b) => {
            const logo = cardLogoKey(b.key);
            const on = brand === b.key;
            return (
              <button
                key={b.key}
                type="button"
                role="radio"
                aria-checked={on}
                onClick={() => pickBrand(b)}
                className={choiceClass(on, "flex min-h-[84px] flex-col items-center justify-center gap-1.5 rounded-lg px-1.5 py-2.5")}
              >
                {logo ? (
                  <CardBrandLogo brand={logo} label={b.label} height={28} />
                ) : (
                  <span className="grid h-[38px] w-[38px] place-items-center rounded-[22.5%] bg-muted ring-1 ring-border">
                    <CreditCard size={20} className="text-muted-foreground" aria-hidden />
                  </span>
                )}
                <span className="w-full truncate text-center text-xs font-medium" title={b.label}>{b.short ?? b.label}</span>
              </button>
            );
          })}
        </div>
      )}

      {step === 2 && info && (
        <div className="space-y-4">
          {info.kinds.length > 1 ? (
            <Segmented
              fill
              aria-label="Tipo de tarjeta"
              value={kind}
              onChange={onKind}
              options={info.kinds.map((k) => ({ value: k, label: k === "debit" ? "Débito" : "Crédito" }))}
            />
          ) : (
            <p className="text-sm text-muted-foreground">
              {info.label} emite sólo tarjetas de {kind === "debit" ? "débito" : "crédito"}.
            </p>
          )}
          {shownPlans.length > 0 ? (
            <div>
              <p className={LABEL}>{kind === "credit" ? "Cuotas" : "Plan"}</p>
              <div className="mt-1.5 grid grid-cols-2 gap-1.5 sm:grid-cols-3" role="radiogroup" aria-label="Cuotas">
                <PlanChip
                  on={planId === ""}
                  onClick={() => onPlan("")}
                  title={noPlanTitle}
                  sub={money(portion)}
                  brand={chipLogo}
                />
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
          ) : (
            kind === "credit" && (
              <p className="text-xs text-muted-foreground">
                No hay planes de cuotas cargados para {info.label}. Se registra en un pago.
              </p>
            )
          )}
          <AmountSummary portion={portion} amount={amount} surcharge={surcharge} />
        </div>
      )}

      {step === 3 && (
        <div className="space-y-4">
          <div className="grid grid-cols-2 gap-2">
            <VoucherField
              id="cv-cupon"
              autoFocus
              label="N° de cupón"
              value={voucher.cupon}
              onChange={(v) => set("cupon", v)}
              required={voucherRequired}
              onEnter={onEnter}
            />
            <VoucherField
              id="cv-lote"
              label="N° de lote"
              value={voucher.lote}
              onChange={(v) => set("lote", v)}
              required={voucherRequired}
              onEnter={onEnter}
            />
            <VoucherField
              id="cv-ult4"
              label="Últimos 4"
              value={voucher.ultimos4}
              onChange={(v) => set("ultimos4", v.replace(/\D/g, "").slice(0, 4))}
              maxLength={4}
              invalid={last4Bad}
              onEnter={onEnter}
            />
            <VoucherField
              id="cv-aut"
              label="Autorización"
              value={voucher.autorizacion}
              onChange={(v) => set("autorizacion", v)}
              required={voucherRequired}
              onEnter={onEnter}
              numeric={false}
            />
          </div>
          {(missing.length > 0 || last4Bad) && (
            <p className="text-xs text-muted-foreground">
              {last4Bad
                ? "Los últimos 4 dígitos tienen que ser 4 números."
                : "Completá cupón, lote y autorización para registrar el cobro."}
            </p>
          )}

          {/* Resumen tipo cupón */}
          <div className="rounded-lg bg-muted px-4 py-3 font-price text-[13px] tabular-nums">
            <div className="flex items-center justify-between gap-2 border-b border-dashed border-border pb-2">
              <span className="flex items-center gap-2 font-sans text-sm font-semibold">
                {info && cardLogoKey(info.key, kind) ? (
                  <CardBrandLogo brand={cardLogoKey(info.key, kind)!} label={info.label} height={20} natural />
                ) : (
                  <CreditCard size={16} className="text-muted-foreground" aria-hidden />
                )}
                {info && info.key !== "other" ? info.label : "Tarjeta"} {kind === "debit" ? "débito" : "crédito"}
              </span>
              <span className="text-muted-foreground">
                {voucher.ultimos4.trim().length === 4 ? `**** ${voucher.ultimos4.trim()}` : "****"}
              </span>
            </div>
            <dl className="space-y-0.5 pt-2">
              <CouponRow label="Plan" value={plan ? plan.label : kind === "credit" ? "1 pago" : "Sin plan"} />
              <CouponRow label="Cupón" value={voucher.cupon.trim() || "Sin cargar"} muted={!voucher.cupon.trim()} />
              <CouponRow label="Lote" value={voucher.lote.trim() || "Sin cargar"} muted={!voucher.lote.trim()} />
              <CouponRow
                label="Autorización"
                value={voucher.autorizacion.trim() || "Sin cargar"}
                muted={!voucher.autorizacion.trim()}
              />
              {surcharge > 0 && <CouponRow label="Recargo" value={`+${money(surcharge)}`} />}
            </dl>
            <div className="mt-2 flex items-baseline justify-between border-t border-dashed border-border pt-2">
              <span className="font-sans text-xs font-semibold uppercase tracking-[0.08em] text-muted-foreground">Total</span>
              <span className="text-lg font-bold text-foreground">{money(amount)}</span>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

function AmountSummary({ portion, amount, surcharge }: { portion: number; amount: number; surcharge: number }) {
  return (
    <div className="flex items-end justify-between gap-3 rounded-lg bg-muted px-3.5 py-2.5">
      <div>
        <p className="text-[11px] text-muted-foreground">Monto {money(portion)}</p>
        {surcharge > 0 && <p className="text-[11px] text-muted-foreground">Recargo +{money(surcharge)}</p>}
      </div>
      <div className="text-right">
        <p className="text-[11px] text-muted-foreground">Total a cobrar</p>
        <p className="font-price text-xl font-bold tabular-nums text-foreground">{money(amount)}</p>
      </div>
    </div>
  );
}

function CouponRow({ label, value, muted }: { label: string; value: string; muted?: boolean }) {
  return (
    <div className="flex justify-between gap-3">
      <dt className="text-muted-foreground">{label}</dt>
      <dd className={cn("truncate text-right", muted ? "text-muted-foreground" : "text-foreground")}>{value}</dd>
    </div>
  );
}

function VoucherField({
  id,
  label,
  value,
  onChange,
  required,
  invalid,
  maxLength = 20,
  numeric = true,
  autoFocus,
  onEnter,
}: {
  id: string;
  label: string;
  value: string;
  onChange: (v: string) => void;
  required?: boolean;
  invalid?: boolean;
  maxLength?: number;
  numeric?: boolean;
  /** Primer campo del paso: recibe el foco al entrar (el botón del paso anterior ya no existe). */
  autoFocus?: boolean;
  onEnter: () => void;
}) {
  return (
    <div className="min-w-0">
      <label htmlFor={id} className="mb-1 block text-xs font-medium text-muted-foreground">
        {label}
        {!required && <span className="font-normal"> (opcional)</span>}
      </label>
      <input
        id={id}
        inputMode={numeric ? "numeric" : "text"}
        autoComplete="off"
        maxLength={maxLength}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        autoFocus={autoFocus}
        data-voucher-field
        onKeyDown={(e) => {
          if (e.key !== "Enter") return;
          // Enter pasa al campo siguiente, como Tab; en el último, confirma.
          const fields = Array.from(document.querySelectorAll<HTMLInputElement>("[data-voucher-field]"));
          const next = fields[fields.indexOf(e.currentTarget) + 1];
          if (next) {
            e.preventDefault();
            next.focus();
          } else onEnter();
        }}
        aria-invalid={invalid || undefined}
        aria-required={required || undefined}
        className={cn(INPUT, invalid ? "border-danger" : "border-border")}
      />
    </div>
  );
}

export function PlanChip({
  on,
  onClick,
  title,
  sub,
  brand,
}: {
  on: boolean;
  onClick: () => void;
  title: string;
  sub: string;
  /** Clave de logo de la tarjeta (cardLogoKey / payment_plans.brand): se muestra en el chip. */
  brand?: string | null;
}) {
  return (
    <button
      type="button"
      role="radio"
      aria-checked={on}
      onClick={onClick}
      className={choiceClass(on, "flex min-w-0 flex-col items-start gap-1 rounded-lg px-3 py-2 pr-8 text-left")}
    >
      {/* Logo arriba: los chips van de a 3 por fila y no hay ancho para ponerlo al costado. */}
      {brand && <CardBrandLogo brand={brand} height={16} />}
      <span className="text-[13px] font-semibold">{title}</span>
      <span className="text-[11px] tabular-nums text-muted-foreground">{sub}</span>
    </button>
  );
}
