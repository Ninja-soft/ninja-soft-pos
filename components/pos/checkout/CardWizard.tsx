"use client";

import { useRef, useState } from "react";
import { ChevronLeft, CreditCard } from "lucide-react";
import { choiceClass } from "@/components/ui/ChoiceCard";
import { CardBrandLogo } from "@/components/ui/ThemedLogo";
import { round2 } from "@/lib/pos/checkoutMath";
import { cardBrandByKey, cardLogoKey, type CardBrand, type CardKind } from "@/lib/pos/cardBrands";
import { acquirerLogo, type AcquirerDef } from "@/lib/payments/acquirers";
import {
  FIELD_LABEL,
  FIELD_SHORT,
  askedFields,
  errorText,
  lengthHint,
  nextField,
  sanitizeValue,
  shouldAutoAdvance,
  valueError,
  type EffectiveRules,
  type VoucherFieldKey,
  type VoucherValues,
} from "@/lib/payments/voucherRules";
import {
  POSNET_STEP_TITLE,
  afterBrand,
  afterKind,
  backStep,
  choosablePlans,
  type PosnetStep,
} from "@/lib/pos/posnetWizard";
import { cn } from "@/lib/utils/cn";
import { money } from "../ui/posStyles";
import { TenderLogo } from "../ui/TenderLogo";

// "Tarjeta en posnet": cobro con una terminal NO integrada. El cajero pasa la
// tarjeta en su posnet y registra el cupón acá, en cuatro pasos (ADR-054):
//   1) Terminal: adquirente (Getnet, Payway, MP Point, Fiserv, Nave, Otra).
//      Se recuerda el último por caja y se preselecciona.
//   2) Entidad (Visa, Mastercard, Amex…)
//   3) Tipo (débito / crédito) y cuotas con su recargo
//   4) Datos del cupón según las reglas del negocio (qué se pide, obligatorio,
//      numérico o alfanumérico y largo), con salto automático al completar.
// Cada elección pasa sola al paso siguiente; los pasos sin nada que elegir se
// saltean. Sólo presentación: el pago se registra como debit/credit con su
// card_voucher y el plan de payment_plans.

export type CardStep = PosnetStep;
export type CardVoucherDraft = VoucherValues;
export const EMPTY_VOUCHER: CardVoucherDraft = {};

export interface WizardPlan {
  id: string;
  label: string;
  installments: number | null;
  surcharge_pct: number | string | null;
}

const LABEL = "block text-[11px] font-semibold uppercase tracking-[0.08em] text-muted-foreground";
const INPUT =
  "h-11 w-full min-w-0 rounded-md border bg-background px-3 text-sm font-medium tabular-nums text-foreground outline-none transition placeholder:text-muted-foreground focus:border-ring focus-visible:ring-2 focus-visible:ring-ring/40";

export function CardWizard({
  acquirers,
  acquirer,
  onAcquirer,
  brands,
  brand,
  onBrand,
  step,
  onStep,
  kind,
  onKind,
  plansByKind,
  planId,
  onPlan,
  portion,
  amount,
  surcharge,
  rules,
  voucher,
  onVoucher,
  onEnter,
}: {
  acquirers: AcquirerDef[];
  acquirer: string | null;
  onAcquirer: (key: string) => void;
  brands: CardBrand[];
  brand: string | null;
  onBrand: (key: string) => void;
  step: CardStep;
  onStep: (s: CardStep) => void;
  kind: CardKind;
  onKind: (k: CardKind) => void;
  /** Planes de la entidad y el adquirente, por tipo. */
  plansByKind: Record<CardKind, WizardPlan[]>;
  planId: string;
  onPlan: (id: string) => void;
  /** Monto con este medio (sin recargo). */
  portion: number;
  /** Total a cobrar con el recargo del plan. */
  amount: number;
  surcharge: number;
  /** Reglas efectivas del cupón para el adquirente elegido. */
  rules: EffectiveRules;
  voucher: CardVoucherDraft;
  onVoucher: (v: CardVoucherDraft) => void;
  onEnter: () => void;
}) {
  const info = cardBrandByKey(brand);
  const acq = acquirers.find((a) => a.key === acquirer) ?? null;
  const plans = plansByKind[kind];
  const plan = plans.find((p) => p.id === planId) ?? null;
  const shownPlans = choosablePlans(plans);
  const choosable: Record<CardKind, number> = {
    debit: choosablePlans(plansByKind.debit).length,
    credit: choosablePlans(plansByKind.credit).length,
  };
  const noPlanTitle = kind === "credit" && !shownPlans.some((p) => (p.installments ?? 1) <= 1) ? "1 pago" : "Sin plan";
  const chipLogo = cardLogoKey(brand, kind);

  function pickAcquirer(a: AcquirerDef) {
    onAcquirer(a.key);
    onStep(2);
  }

  function pickBrand(b: CardBrand) {
    onBrand(b.key);
    const next = afterBrand(b, kind, choosable);
    if (next.kind !== kind) onKind(next.kind);
    onStep(next.step);
  }

  function pickKind(k: CardKind) {
    onKind(k);
    onStep(afterKind(k, choosable));
  }

  function pickPlan(id: string) {
    onPlan(id);
    onStep(4);
  }

  const back = () => onStep(backStep(step, info, kind, choosable));

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
          <p className="text-[11px] font-medium text-muted-foreground">Paso {step} de 4</p>
          <p className="truncate text-sm font-semibold">{POSNET_STEP_TITLE[step]}</p>
        </div>
        <div className="flex gap-1" aria-hidden>
          {([1, 2, 3, 4] as const).map((s) => (
            <span key={s} className={cn("h-1 w-5 rounded-sm", s <= step ? "bg-foreground/70" : "bg-muted")} />
          ))}
        </div>
      </div>

      {/* Terminal elegida: siempre a la vista y cambiable con un toque. */}
      {step > 1 && acq && (
        <button
          type="button"
          onClick={() => onStep(1)}
          className="flex w-full items-center gap-2.5 rounded-md border border-border bg-card px-3 py-2 text-left transition hover:bg-muted focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
          aria-label={`Terminal ${acq.label}. Cambiar`}
        >
          <TenderLogo source={{ logo: acquirerLogo(acq.key) }} alt={acq.label} size={22} fallback="card" />
          <span className="min-w-0 flex-1 truncate text-[13px]">
            <span className="text-muted-foreground">Terminal </span>
            <span className="font-semibold">{acq.label}</span>
          </span>
          <span className="text-xs font-medium text-muted-foreground underline-offset-2 hover:underline">Cambiar</span>
        </button>
      )}

      {step === 1 && (
        <div className="grid grid-cols-2 gap-2 sm:grid-cols-3" role="radiogroup" aria-label="Terminal del cobro">
          {acquirers.map((a) => {
            const on = acquirer === a.key;
            return (
              <button
                key={a.key}
                type="button"
                role="radio"
                aria-checked={on}
                onClick={() => pickAcquirer(a)}
                className={choiceClass(on, "flex min-h-[76px] flex-col items-center justify-center gap-1.5 rounded-md px-2 py-2.5")}
              >
                {/* Logo arriba y nombre centrado: los nombres quedan alineados entre sí. */}
                <TenderLogo source={{ logo: acquirerLogo(a.key) }} alt={a.label} size={28} fallback="card" />
                <span className="w-full truncate text-center text-xs font-semibold" title={a.label}>{a.short}</span>
              </button>
            );
          })}
        </div>
      )}

      {step === 2 && (
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
                className={choiceClass(on, "flex min-h-[84px] flex-col items-center justify-center gap-1.5 rounded-md px-1.5 py-2.5")}
              >
                {logo ? (
                  <CardBrandLogo brand={logo} label={b.label} height={28} />
                ) : (
                  <span className="grid h-[38px] w-[38px] place-items-center rounded-md bg-muted">
                    <CreditCard size={20} className="text-muted-foreground" aria-hidden />
                  </span>
                )}
                <span className="w-full truncate text-center text-xs font-medium" title={b.label}>{b.short ?? b.label}</span>
              </button>
            );
          })}
        </div>
      )}

      {step === 3 && info && (
        <div className="space-y-4">
          {info.kinds.length > 1 ? (
            <div className="grid grid-cols-2 gap-2" role="radiogroup" aria-label="Tipo de tarjeta">
              {info.kinds.map((k) => (
                <button
                  key={k}
                  type="button"
                  role="radio"
                  aria-checked={kind === k}
                  onClick={() => pickKind(k)}
                  className={choiceClass(kind === k, "flex h-12 items-center justify-center rounded-md px-3 text-sm font-semibold")}
                >
                  {k === "debit" ? "Débito" : "Crédito"}
                </button>
              ))}
            </div>
          ) : (
            <p className="text-sm text-muted-foreground">
              {info.label} emite sólo tarjetas de {kind === "debit" ? "débito" : "crédito"}.
            </p>
          )}
          {shownPlans.length > 0 && (
            <div>
              <p className={LABEL}>{kind === "credit" ? "Cuotas" : "Plan"}</p>
              <div className="mt-1.5 grid grid-cols-2 gap-1.5 sm:grid-cols-3" role="radiogroup" aria-label="Cuotas">
                <PlanChip on={planId === ""} onClick={() => pickPlan("")} title={noPlanTitle} sub={money(portion)} brand={chipLogo} />
                {shownPlans.map((p) => {
                  const pct = Number(p.surcharge_pct) || 0;
                  return (
                    <PlanChip
                      key={p.id}
                      on={planId === p.id}
                      onClick={() => pickPlan(p.id)}
                      brand={chipLogo}
                      title={p.installments && p.installments > 1 ? `${p.installments} cuotas` : "1 pago"}
                      sub={pct > 0 ? `+${pct}% · ${money(round2(portion * (1 + pct / 100)))}` : `Sin recargo · ${money(portion)}`}
                    />
                  );
                })}
              </div>
            </div>
          )}
          <AmountSummary portion={portion} amount={amount} surcharge={surcharge} />
        </div>
      )}

      {step === 4 && (
        <div className="space-y-4">
          <VoucherFields rules={rules} values={voucher} onChange={onVoucher} onDone={onEnter} />

          {/* Resumen tipo cupón */}
          <div className="rounded-md bg-muted px-4 py-3 font-price text-[13px] tabular-nums">
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
                {(voucher.ultimos4 ?? "").length === 4 ? `**** ${voucher.ultimos4}` : "****"}
              </span>
            </div>
            <dl className="space-y-0.5 pt-2">
              {acq && <CouponRow label="Terminal" value={acq.label} />}
              <CouponRow label="Plan" value={plan ? plan.label : kind === "credit" ? "1 pago" : "Sin plan"} />
              {askedFields(rules)
                .filter((f) => f !== "ultimos4")
                .map((f) => (
                  <CouponRow
                    key={f}
                    label={FIELD_SHORT[f]}
                    value={(voucher[f] ?? "").trim() || "Sin cargar"}
                    muted={!(voucher[f] ?? "").trim()}
                  />
                ))}
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

/**
 * Datos del cupón según las reglas: teclado numérico en los numéricos, salto
 * al siguiente al completar el largo exacto, Enter pasa al siguiente (en el
 * último confirma) y validación en línea. Lo usa también la terminal de la
 * marca sin integrar.
 */
export function VoucherFields({
  rules,
  values,
  onChange,
  onDone,
  autoFocus = true,
  only,
}: {
  rules: EffectiveRules;
  values: CardVoucherDraft;
  onChange: (v: CardVoucherDraft) => void;
  onDone: () => void;
  autoFocus?: boolean;
  /** Limita a estos datos (p. ej. sólo los obligatorios). */
  only?: VoucherFieldKey[];
}) {
  const asked = askedFields(rules).filter((f) => !only || only.includes(f));
  const refs = useRef<Partial<Record<VoucherFieldKey, HTMLInputElement | null>>>({});
  const [touched, setTouched] = useState<Partial<Record<VoucherFieldKey, boolean>>>({});
  if (asked.length === 0) return null;

  const focusNext = (f: VoucherFieldKey): boolean => {
    const n = nextField(asked, f);
    if (!n) return false;
    refs.current[n]?.focus();
    refs.current[n]?.select();
    return true;
  };

  const missing = asked.filter((f) => valueError(rules[f], values[f]) === "required");

  return (
    <div>
      <div className="grid grid-cols-2 gap-2">
        {asked.map((f, i) => {
          const rule = rules[f];
          const value = values[f] ?? "";
          const err = valueError(rule, value);
          // El error se marca al salir del campo (o con Enter), no mientras se tipea.
          const shown = touched[f] ? err : null;
          const id = `cv-${f}`;
          return (
            <div key={f} className="min-w-0">
              <label htmlFor={id} className="mb-1 flex items-baseline justify-between gap-2 text-xs font-medium text-muted-foreground">
                <span className="truncate">
                  {FIELD_LABEL[f]}
                  {!rule.required && <span className="font-normal"> (opcional)</span>}
                </span>
                <span className="shrink-0 text-[10px] font-normal tabular-nums">{lengthHint(rule)}</span>
              </label>
              <input
                id={id}
                ref={(el) => {
                  refs.current[f] = el;
                }}
                inputMode={rule.type === "numeric" ? "numeric" : "text"}
                autoCapitalize={rule.type === "alnum" ? "characters" : undefined}
                autoComplete="off"
                spellCheck={false}
                maxLength={rule.max}
                value={value}
                autoFocus={autoFocus && i === 0}
                onChange={(e) => {
                  const v = sanitizeValue(rule, e.target.value);
                  onChange({ ...values, [f]: v });
                  if (shouldAutoAdvance(rule, v)) focusNext(f);
                }}
                onBlur={() => setTouched((t) => ({ ...t, [f]: true }))}
                onKeyDown={(e) => {
                  if (e.key !== "Enter") return;
                  e.preventDefault();
                  setTouched((t) => ({ ...t, [f]: true }));
                  if (!focusNext(f)) onDone();
                }}
                aria-invalid={shown ? true : undefined}
                aria-required={rule.required || undefined}
                aria-describedby={shown ? `${id}-err` : undefined}
                className={cn(INPUT, shown ? "border-danger" : "border-border")}
              />
              {shown && (
                <p id={`${id}-err`} className="mt-1 text-[11px] text-danger">
                  {errorText(f, rule, shown)}
                </p>
              )}
            </div>
          );
        })}
      </div>
      {missing.length > 0 && (
        <p className="mt-2 text-xs text-muted-foreground">
          Para registrar falta: {missing.map((f) => FIELD_LABEL[f].toLowerCase()).join(", ")}.
        </p>
      )}
    </div>
  );
}

function AmountSummary({ portion, amount, surcharge }: { portion: number; amount: number; surcharge: number }) {
  return (
    <div className="flex items-end justify-between gap-3 rounded-md bg-muted px-3.5 py-2.5">
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
      className={choiceClass(on, "flex min-w-0 flex-col items-start gap-1 rounded-md px-3 py-2 pr-8 text-left")}
    >
      {/* Logo arriba: los chips van de a 3 por fila y no hay ancho para ponerlo al costado. */}
      {brand && <CardBrandLogo brand={brand} height={16} />}
      <span className="text-[13px] font-semibold">{title}</span>
      <span className="text-[11px] tabular-nums text-muted-foreground">{sub}</span>
    </button>
  );
}
