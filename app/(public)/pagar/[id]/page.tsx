"use client";

// F8 · H17b — Checkout PROPIO de la tienda (Payway transparente).
// El cliente llega acá escaneando el QR del POS (/pagar/{intent}): ve la marca
// del negocio, elige tarjeta y cuotas (Planes del negocio, con el interés de
// cada opción), carga la tarjeta y paga. PCI: el PAN viaja del navegador
// DIRECTO a Payway (POST tokens con la API Key pública); nuestro backend solo
// recibe el token de un solo uso y cobra server-side recalculando el monto.
//
// Página pública SIEMPRE clara (es del cliente final, fuera del tema del POS).
// El color de acento sale del branding del negocio, ajustado a contraste AA
// (lib/payments/paywayCheckout.ts).

import { useEffect, useMemo, useRef, useState, type CSSProperties, type ReactNode } from "react";
import { useParams } from "next/navigation";
import { createClient } from "@/lib/supabase/client";
import { brandLogo } from "@/modules/pos/planConstants";
import { paymentWordmark } from "@/lib/payments/logos";
import { paywayPayMessage, paywayTokenMessage } from "@/lib/payments/paywayMessages";
import {
  accentPalette,
  availablePlans,
  brandFamily,
  brandForDetected,
  detectCardFamily,
  formatCardNumber,
  formatExpiry,
  interestLabel,
  quoteInstallments,
  validateCard,
  type CardFieldErrors,
  type CheckoutPlan,
} from "@/lib/payments/paywayCheckout";

type Info = {
  status: string;
  amount: number;
  tenant_name: string;
  logo_url: string | null;
  accent: string | null;
  plans: CheckoutPlan[];
  brands: string[];
  debit_brands?: string[];
  public_apikey: string;
  tokens_url: string;
};

type PayRes = { ok?: boolean; status?: string; error?: string; reason?: string };

const BRAND_LABELS: Record<string, string> = {
  visa: "Visa",
  visa_debito: "Visa Débito",
  master: "Mastercard",
  maestro: "Maestro",
  cabal: "Cabal",
  amex: "Amex",
  naranja: "Naranja X",
  diners: "Diners",
};

const fmt = (n: number) => n.toLocaleString("es-AR", { style: "currency", currency: "ARS" });

type Phase = "form" | "paying" | "done" | "review" | "unavailable";
type Field = keyof CardFieldErrors;

export default function PagarPage() {
  const params = useParams<{ id: string }>();
  const intentId = String(params?.id ?? "");
  const supabase = useMemo(() => createClient(), []);

  const [info, setInfo] = useState<Info | null>(null);
  const [loadError, setLoadError] = useState(false);
  // review: Payway dejó el pago en revisión; no se ofrece reintentar.
  const [phase, setPhase] = useState<Phase>("form");
  const [payError, setPayError] = useState<{ title: string; text: string } | null>(null);
  const [paid, setPaid] = useState<{ total: number; installments: number } | null>(null);

  const [brand, setBrand] = useState<string>("visa");
  const [installments, setInstallments] = useState(1);
  const [cardNumber, setCardNumber] = useState("");
  const [exp, setExp] = useState("");
  const [cvv, setCvv] = useState("");
  const [holder, setHolder] = useState("");
  const [dni, setDni] = useState("");
  const [touched, setTouched] = useState<Partial<Record<Field, boolean>>>({});
  const errorRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!intentId) return;
    supabase.functions
      .invoke("payway_checkout", { body: { action: "info", intent_id: intentId } })
      .then(({ data, error }) => {
        if (error || (data as { error?: string })?.error) setLoadError(true);
        else {
          const i = data as Info;
          setInfo(i);
          if (i.status === "approved") {
            setPaid({ total: i.amount, installments: 0 });
            setPhase("done");
          } else if (i.status !== "pending") setPhase("unavailable");
        }
      })
      .catch(() => setLoadError(true));
  }, [intentId, supabase]);

  const pal = useMemo(() => accentPalette(info?.accent), [info?.accent]);
  const offered = useMemo(() => info?.brands ?? [], [info]);
  const isDebit = (info?.debit_brands ?? []).includes(brand);
  const base = info?.amount ?? 0;

  const cuotas = useMemo(
    () => availablePlans(info?.plans ?? [], brand, isDebit),
    [info, brand, isDebit],
  );
  const chosen = cuotas.find((c) => c.installments === installments) ?? cuotas[0];
  const quote = quoteInstallments(base, chosen ?? { installments: 1, surcharge_pct: 0 });

  const family = detectCardFamily(cardNumber);
  const errors = validateCard({ number: cardNumber, exp, cvv, holder, dni });
  const formOk = Object.keys(errors).length === 0;
  const showErr = (f: Field) => (touched[f] ? errors[f] : undefined);

  function selectBrand(br: string) {
    if (br === brand) return;
    setBrand(br);
    setInstallments(1);
  }

  function onCardNumber(v: string) {
    const formatted = formatCardNumber(v);
    setCardNumber(formatted);
    const next = brandForDetected(brand, detectCardFamily(formatted), offered);
    if (next !== brand) selectBrand(next);
  }

  async function pagar() {
    if (!info || !chosen || phase === "paying") return;
    if (!formOk) {
      setTouched({ number: true, exp: true, cvv: true, holder: true, dni: true });
      return;
    }
    setPayError(null);
    setPhase("paying");
    const cardDigits = cardNumber.replace(/\D/g, "");
    const [expMonth, expYear] = exp.split("/");
    try {
      // 1) Token: PAN directo del navegador a Payway (API Key PÚBLICA).
      const tokRes = await fetch(info.tokens_url, {
        method: "POST",
        headers: { apikey: info.public_apikey, "Content-Type": "application/json" },
        body: JSON.stringify({
          card_number: cardDigits,
          card_expiration_month: expMonth,
          card_expiration_year: expYear,
          security_code: cvv.replace(/\D/g, ""),
          card_holder_name: holder.trim().toUpperCase(),
          card_holder_identification: { type: "dni", number: dni.replace(/\D/g, "") },
        }),
      });
      const tok = (await tokRes.json().catch(() => ({}))) as { id?: string; bin?: string };
      if (!tokRes.ok || !tok.id) {
        fail({ title: "Revisá la tarjeta", text: paywayTokenMessage(tok) });
        return;
      }
      // 2) Cobro server-side (el monto se recalcula en el backend).
      const { data, error } = await supabase.functions.invoke("payway_checkout", {
        body: {
          action: "pay",
          intent_id: intentId,
          token: tok.id,
          bin: tok.bin ?? cardDigits.slice(0, 6),
          brand,
          installments: chosen.installments,
        },
      });
      const res = (data ?? {}) as PayRes;
      if (!error && res.ok) {
        setPaid({ total: quote.total, installments: quote.installments });
        setPhase("done");
        return;
      }
      // FunctionsHttpError: leer el cuerpo real (402 = rechazo del emisor,
      // 502 payway_error = falla del procesador, 202 = en revisión).
      let result: PayRes = res;
      const ctx = (error as { context?: Response } | null)?.context;
      if (ctx) {
        const body = (await ctx.json().catch(() => null)) as PayRes | null;
        if (body) result = body;
      }
      const text = paywayPayMessage(result);
      if (result.status === "pending_review" || result.error === "payment_in_review") {
        setPayError({ title: "Pago en revisión", text });
        setPhase("review");
      } else if (result.error === "intent_not_pending") {
        setPhase("unavailable");
      } else {
        fail({
          title: result.status === "rejected_attempt" ? "Pago rechazado" : "No se pudo completar el pago",
          text,
        });
      }
    } catch {
      fail({ title: "Sin conexión", text: "No se pudo procesar el pago. Revisá tu conexión." });
    }
  }

  function fail(e: { title: string; text: string }) {
    setPayError(e);
    setPhase("form");
    requestAnimationFrame(() =>
      errorRef.current?.scrollIntoView({ behavior: "smooth", block: "center" }),
    );
  }

  const vars = {
    "--acc": pal.solid,
    "--acc-text": pal.text,
    "--acc-soft": pal.soft,
    "--acc-softer": pal.softer,
  } as CSSProperties;

  return (
    <main className="min-h-dvh bg-[#F4F4F7] text-neutral-900 antialiased" style={vars}>
      <div className="mx-auto flex min-h-dvh w-full max-w-[440px] flex-col px-4">
        <MerchantHeader info={info} accent={pal.base} />

        {loadError ? (
          <StateCard
            tone="neutral"
            title="No encontramos este cobro"
            text="Pedile al cajero que genere el QR de nuevo."
          />
        ) : phase === "done" ? (
          <StateCard
            tone="success"
            title="¡Pago aprobado!"
            text="Listo, ya podés cerrar esta pantalla. El mostrador registra la venta automáticamente."
          >
            {paid && paid.total > 0 && (
              <div className="mt-5 rounded-2xl bg-neutral-50 px-4 py-3 text-sm">
                <div className="flex items-baseline justify-between gap-3">
                  <span className="text-neutral-600">Pagaste</span>
                  <span className="text-lg font-bold tabular-nums">{fmt(paid.total)}</span>
                </div>
                {paid.installments > 1 && (
                  <p className="mt-0.5 text-right text-neutral-600">
                    en {paid.installments} cuotas de {fmt(paid.total / paid.installments)}
                  </p>
                )}
              </div>
            )}
          </StateCard>
        ) : phase === "review" ? (
          <StateCard tone="warning" title="Pago en revisión" text={payError?.text ?? ""} />
        ) : phase === "unavailable" ? (
          <StateCard
            tone="neutral"
            title="Este cobro ya no está disponible"
            text={paywayPayMessage({ error: "intent_not_pending" })}
          />
        ) : !info ? (
          <LoadingSkeleton />
        ) : (
          <>
            {/* Resumen del monto: fijo arriba mientras se completa el pago. */}
            <div className="sticky top-0 z-20 -mx-4 bg-[#F4F4F7]/90 px-4 pb-3 pt-3 backdrop-blur-md">
              <div className="rounded-3xl bg-white px-5 py-4 shadow-[0_1px_2px_rgba(16,24,40,.06),0_8px_24px_-12px_rgba(16,24,40,.18)] ring-1 ring-black/[0.04]">
                <div className="flex items-end justify-between gap-3">
                  <div className="min-w-0">
                    <p className="text-xs font-medium uppercase tracking-wide text-neutral-600">
                      Total a pagar
                    </p>
                    <p className="mt-0.5 text-[28px] font-extrabold leading-none tracking-tight tabular-nums">
                      {fmt(quote.total)}
                    </p>
                  </div>
                  <div className="shrink-0 text-right text-sm">
                    <p className="font-semibold tabular-nums">
                      {quote.installments === 1
                        ? "1 pago"
                        : `${quote.installments} × ${fmt(quote.perInstallment)}`}
                    </p>
                    <InterestPill quote={quote} />
                  </div>
                </div>
              </div>
            </div>

            <div className="space-y-4 pb-4">
              {/* 1 · Tarjeta */}
              <Section n={1} title="Elegí tu tarjeta">
                <div className="grid grid-cols-4 gap-2" role="radiogroup" aria-label="Tarjeta">
                  {offered.map((br) => {
                    const debit = (info.debit_brands ?? []).includes(br);
                    const logo = brandLogo(brandFamily(br));
                    const active = brand === br;
                    const label = BRAND_LABELS[br] ?? br;
                    return (
                      <button
                        key={br}
                        type="button"
                        role="radio"
                        aria-checked={active}
                        aria-label={label}
                        onClick={() => selectBrand(br)}
                        className="relative flex h-[68px] flex-col items-center justify-center gap-1 rounded-2xl px-2 pb-1.5 pt-2 transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[color:var(--acc)]"
                        style={{ background: active ? "var(--acc-soft)" : "#F6F6F8" }}
                      >
                        {logo ? (
                          // eslint-disable-next-line @next/next/no-img-element
                          <img src={logo} alt="" className="h-7 w-auto max-w-full object-contain" />
                        ) : (
                          <span className="text-xs font-bold text-neutral-700">{label}</span>
                        )}
                        <span
                          className="text-[10px] font-semibold leading-none"
                          style={{ color: active ? "var(--acc-text)" : "#525252" }}
                        >
                          {debit ? "Débito" : "Crédito"}
                        </span>
                        {active && (
                          <span
                            className="absolute right-1.5 top-1.5 grid h-4 w-4 place-items-center rounded-full text-white"
                            style={{ background: "var(--acc)" }}
                          >
                            <CheckIcon className="h-2.5 w-2.5" />
                          </span>
                        )}
                      </button>
                    );
                  })}
                </div>
                <p className="mt-3 text-xs text-neutral-600">
                  Pagás con <span className="font-semibold text-neutral-800">{BRAND_LABELS[brand] ?? brand}</span>
                  {family ? ". La detectamos por el número de tu tarjeta." : "."}
                </p>
              </Section>

              {/* 2 · Cuotas */}
              <Section n={2} title="Elegí las cuotas">
                <div className="overflow-hidden rounded-2xl ring-1 ring-neutral-200" role="radiogroup" aria-label="Cuotas">
                  {cuotas.map((c, idx) => {
                    const q = quoteInstallments(base, c);
                    const active = quote.installments === q.installments;
                    return (
                      <button
                        key={c.installments}
                        type="button"
                        role="radio"
                        aria-checked={active}
                        onClick={() => setInstallments(c.installments)}
                        className={`flex w-full items-center gap-3 px-4 py-3.5 text-left transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-[color:var(--acc)] ${
                          idx > 0 ? "border-t border-neutral-200" : ""
                        }`}
                        style={{ background: active ? "var(--acc-soft)" : "#fff" }}
                      >
                        <span
                          className="grid h-5 w-5 shrink-0 place-items-center rounded-full text-white transition-colors"
                          style={
                            active
                              ? { background: "var(--acc)" }
                              : { boxShadow: "inset 0 0 0 1.5px #a3a3a3" }
                          }
                          aria-hidden
                        >
                          {active && <CheckIcon className="h-3 w-3" />}
                        </span>
                        <span className="min-w-0 flex-1">
                          <span className="flex items-start justify-between gap-3">
                            <span className="min-w-0">
                              <span className="block text-[13px] text-neutral-600">
                                {q.installments === 1 ? "1 pago de" : `${q.installments} cuotas de`}
                              </span>
                              <span className="block text-lg font-bold leading-tight tabular-nums">
                                {fmt(q.perInstallment)}
                              </span>
                            </span>
                            <span className="shrink-0 pt-0.5 text-right">
                              <span className="block text-[11px] uppercase tracking-wide text-neutral-600">
                                Total
                              </span>
                              <span className="block text-sm font-semibold tabular-nums">
                                {fmt(q.total)}
                              </span>
                            </span>
                          </span>
                          <InterestPill quote={q} />
                        </span>
                      </button>
                    );
                  })}
                </div>
                {isDebit && (
                  <p className="mt-3 text-xs text-neutral-600">Con débito se paga en 1 pago.</p>
                )}
              </Section>

              {/* 3 · Datos de la tarjeta */}
              <Section n={3} title="Datos de la tarjeta">
                <div className="space-y-3">
                  <Field label="Número de tarjeta" id="cc-number" error={showErr("number")}>
                    <div className="relative">
                      <input
                        id="cc-number"
                        className={inputCls(!!showErr("number"))}
                        inputMode="numeric"
                        autoComplete="cc-number"
                        placeholder="0000 0000 0000 0000"
                        value={cardNumber}
                        onChange={(e) => onCardNumber(e.target.value)}
                        onBlur={() => setTouched((t) => ({ ...t, number: true }))}
                        aria-invalid={!!showErr("number")}
                      />
                      {family && brandLogo(family) && (
                        // eslint-disable-next-line @next/next/no-img-element
                        <img
                          src={brandLogo(family)!}
                          alt={BRAND_LABELS[family] ?? family}
                          className="pointer-events-none absolute right-3 top-1/2 h-6 w-auto -translate-y-1/2"
                        />
                      )}
                    </div>
                  </Field>
                  <div className="grid grid-cols-2 gap-3">
                    <Field label="Vencimiento" id="cc-exp" error={showErr("exp")}>
                      <input
                        id="cc-exp"
                        className={inputCls(!!showErr("exp"))}
                        inputMode="numeric"
                        autoComplete="cc-exp"
                        placeholder="MM/AA"
                        value={exp}
                        onChange={(e) => setExp(formatExpiry(e.target.value))}
                        onBlur={() => setTouched((t) => ({ ...t, exp: true }))}
                        aria-invalid={!!showErr("exp")}
                      />
                    </Field>
                    <Field label="Código de seguridad" id="cc-csc" error={showErr("cvv")}>
                      <input
                        id="cc-csc"
                        className={inputCls(!!showErr("cvv"))}
                        inputMode="numeric"
                        autoComplete="cc-csc"
                        placeholder={family === "amex" ? "4 dígitos" : "CVV"}
                        value={cvv}
                        onChange={(e) => setCvv(e.target.value.replace(/\D/g, "").slice(0, 4))}
                        onBlur={() => setTouched((t) => ({ ...t, cvv: true }))}
                        aria-invalid={!!showErr("cvv")}
                      />
                    </Field>
                  </div>
                  <Field label="Nombre del titular" id="cc-name" error={showErr("holder")}>
                    <input
                      id="cc-name"
                      className={inputCls(!!showErr("holder"))}
                      autoComplete="cc-name"
                      autoCapitalize="characters"
                      placeholder="Como figura en la tarjeta"
                      value={holder}
                      onChange={(e) => setHolder(e.target.value)}
                      onBlur={() => setTouched((t) => ({ ...t, holder: true }))}
                      aria-invalid={!!showErr("holder")}
                    />
                  </Field>
                  <Field label="DNI del titular" id="cc-dni" error={showErr("dni")}>
                    <input
                      id="cc-dni"
                      className={inputCls(!!showErr("dni"))}
                      inputMode="numeric"
                      autoComplete="off"
                      placeholder="Sin puntos"
                      value={dni}
                      onChange={(e) => setDni(e.target.value.replace(/\D/g, "").slice(0, 9))}
                      onBlur={() => setTouched((t) => ({ ...t, dni: true }))}
                      aria-invalid={!!showErr("dni")}
                    />
                  </Field>
                </div>
              </Section>

              {payError && (
                <div
                  ref={errorRef}
                  role="alert"
                  className="flex gap-3 rounded-2xl bg-red-50 p-4 ring-1 ring-red-200"
                >
                  <span className="mt-0.5 grid h-6 w-6 shrink-0 place-items-center rounded-full bg-red-600 text-white">
                    <AlertIcon className="h-3.5 w-3.5" />
                  </span>
                  <div className="text-sm">
                    <p className="font-semibold text-red-800">{payError.title}</p>
                    <p className="mt-0.5 text-red-700">{payError.text}</p>
                  </div>
                </div>
              )}

              <button
                type="button"
                disabled={phase === "paying"}
                onClick={pagar}
                className="flex h-14 w-full items-center justify-center gap-2.5 rounded-2xl text-base font-bold text-white shadow-[0_8px_20px_-8px_var(--acc)] transition active:scale-[0.99] disabled:cursor-wait disabled:opacity-80 focus-visible:outline-none focus-visible:ring-4 focus-visible:ring-[color:var(--acc-softer)]"
                style={{ background: "var(--acc)" }}
              >
                {phase === "paying" ? (
                  <>
                    <span
                      className="h-5 w-5 animate-spin rounded-full border-2 border-white/40 border-t-white"
                      aria-hidden
                    />
                    Procesando pago…
                  </>
                ) : (
                  <>
                    <LockIcon className="h-4 w-4" />
                    Pagar {fmt(quote.total)}
                  </>
                )}
              </button>
              {!formOk && Object.keys(touched).length > 0 && (
                <p className="text-center text-xs text-neutral-600">
                  Completá los datos marcados para continuar.
                </p>
              )}
            </div>
          </>
        )}

        <SecureFooter />
      </div>
    </main>
  );
}

// ── Piezas ───────────────────────────────────────────────────────────────────

function inputCls(invalid: boolean) {
  return `h-12 w-full rounded-xl border bg-white px-4 text-base text-neutral-900 placeholder:text-neutral-400 outline-none transition-shadow focus:border-[color:var(--acc)] focus:ring-4 focus:ring-[color:var(--acc-soft)] ${
    invalid ? "border-red-500" : "border-neutral-300"
  }`;
}

function InterestPill({ quote }: { quote: ReturnType<typeof quoteInstallments> }) {
  const free = quote.interest <= 0;
  return (
    <span
      className="mt-1.5 inline-flex items-center whitespace-nowrap rounded-full px-2 py-0.5 text-[11px] font-semibold leading-4 tabular-nums"
      style={
        free
          ? { background: "var(--acc)", color: "#fff" }
          : { background: "var(--acc-softer)", color: "var(--acc-text)" }
      }
    >
      {interestLabel(quote, fmt)}
    </span>
  );
}

function MerchantHeader({ info, accent }: { info: Info | null; accent: string }) {
  return (
    <header className="flex items-center gap-3 pb-1 pt-6">
      {info?.logo_url ? (
        // eslint-disable-next-line @next/next/no-img-element
        <img
          src={info.logo_url}
          alt=""
          className="h-14 w-14 rounded-2xl bg-white object-contain p-1.5 shadow-sm ring-1 ring-black/5"
        />
      ) : (
        <span
          className="grid h-14 w-14 place-items-center rounded-2xl text-xl font-black text-white shadow-sm"
          style={{ background: info ? accent : "#d4d4d4" }}
        >
          {(info?.tenant_name ?? "").slice(0, 1).toUpperCase()}
        </span>
      )}
      <div className="min-w-0 flex-1">
        <p className="text-sm text-neutral-600">Estás pagando a</p>
        <h1 className="truncate text-xl font-bold leading-tight">
          {info?.tenant_name ?? <span className="inline-block h-5 w-32 animate-pulse rounded bg-neutral-200" />}
        </h1>
      </div>
      <span className="inline-flex shrink-0 items-center gap-1 rounded-full bg-emerald-50 px-2.5 py-1 text-[11px] font-semibold text-emerald-800 ring-1 ring-emerald-200">
        <LockIcon className="h-3 w-3" />
        Seguro
      </span>
    </header>
  );
}

function Section({ n, title, children }: { n: number; title: string; children: ReactNode }) {
  return (
    <section className="rounded-3xl bg-white p-5 shadow-[0_1px_2px_rgba(16,24,40,.05)] ring-1 ring-black/[0.04]">
      <h2 className="mb-4 flex items-center gap-2.5 text-[15px] font-bold">
        <span
          className="grid h-6 w-6 place-items-center rounded-full text-xs font-bold text-white"
          style={{ background: "var(--acc)" }}
        >
          {n}
        </span>
        {title}
      </h2>
      {children}
    </section>
  );
}

function Field({
  label,
  id,
  error,
  children,
}: {
  label: string;
  id: string;
  error?: string;
  children: ReactNode;
}) {
  return (
    <div>
      <label htmlFor={id} className="mb-1.5 block text-[13px] font-medium text-neutral-700">
        {label}
      </label>
      {children}
      {error && <p className="mt-1 text-xs font-medium text-red-700">{error}</p>}
    </div>
  );
}

function StateCard({
  tone,
  title,
  text,
  children,
}: {
  tone: "success" | "warning" | "neutral";
  title: string;
  text: string;
  children?: ReactNode;
}) {
  const icon =
    tone === "success" ? (
      <span className="grid h-16 w-16 place-items-center rounded-full bg-emerald-600 text-white shadow-[0_10px_30px_-10px_rgba(5,150,105,.8)]">
        <CheckIcon className="h-8 w-8" />
      </span>
    ) : tone === "warning" ? (
      <span className="grid h-16 w-16 place-items-center rounded-full bg-amber-100 text-amber-700">
        <ClockIcon className="h-8 w-8" />
      </span>
    ) : (
      <span className="grid h-16 w-16 place-items-center rounded-full bg-neutral-100 text-neutral-600">
        <AlertIcon className="h-7 w-7" />
      </span>
    );
  return (
    <div className="mt-6 rounded-3xl bg-white p-8 text-center shadow-[0_1px_2px_rgba(16,24,40,.05)] ring-1 ring-black/[0.04]">
      <div className="flex justify-center">{icon}</div>
      <h2 className="mt-5 text-xl font-bold">{title}</h2>
      <p className="mx-auto mt-1.5 max-w-xs text-sm leading-relaxed text-neutral-600">{text}</p>
      {children}
    </div>
  );
}

function LoadingSkeleton() {
  return (
    <div className="mt-4 space-y-4" aria-busy="true" aria-label="Cargando">
      <div className="h-20 animate-pulse rounded-3xl bg-white" />
      <div className="h-48 animate-pulse rounded-3xl bg-white" />
      <div className="h-56 animate-pulse rounded-3xl bg-white" />
    </div>
  );
}

function SecureFooter() {
  const payway = paymentWordmark("payway");
  return (
    <footer className="mt-auto pb-8 pt-6">
      <div className="rounded-3xl bg-white/70 p-5 ring-1 ring-black/[0.04]">
        <div className="flex gap-3">
          <span className="grid h-9 w-9 shrink-0 place-items-center rounded-full bg-emerald-50 text-emerald-700 ring-1 ring-emerald-200">
            <LockIcon className="h-4 w-4" />
          </span>
          <p className="text-[13px] leading-relaxed text-neutral-700">
            <span className="font-semibold text-neutral-900">Pago seguro.</span> Tus datos de
            tarjeta van cifrados directo a Payway. NinjaPOS y el comercio no los ven ni los
            guardan.
          </p>
        </div>
        <div className="mt-4 flex items-end justify-between gap-3 border-t border-neutral-200 pt-4">
          <span className="flex flex-col items-start gap-1.5 text-[11px] text-neutral-600">
            Procesado por
            {payway && (
              // eslint-disable-next-line @next/next/no-img-element
              <img src={payway} alt="Payway" className="h-4 w-auto" />
            )}
          </span>
          <a
            href="https://pos.soft.ninja"
            target="_blank"
            rel="noreferrer"
            className="flex flex-col items-end gap-1.5"
          >
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img src="/brand/ninjapos-logo-light-mode.webp" alt="NinjaPOS" className="h-4 w-auto" />
            <span className="whitespace-nowrap text-[11px] text-neutral-600">
              Un producto de Ninja Soft
            </span>
          </a>
        </div>
      </div>
      <p className="mt-4 text-center text-[11px] leading-relaxed text-neutral-500">
        El comercio es el responsable de la venta. NinjaPOS brinda la plataforma de cobro.
        <br />© {new Date().getFullYear()} Ninja Soft · Rosario, Argentina
      </p>
    </footer>
  );
}

// ── Íconos (inline, sin dependencias) ────────────────────────────────────────

function CheckIcon({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={3} strokeLinecap="round" strokeLinejoin="round" className={className} aria-hidden>
      <path d="M5 12.5l4.5 4.5L19 7.5" />
    </svg>
  );
}

function LockIcon({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2.2} strokeLinecap="round" strokeLinejoin="round" className={className} aria-hidden>
      <rect x="4.5" y="10.5" width="15" height="10" rx="2.5" />
      <path d="M8 10.5V7.5a4 4 0 018 0v3" />
    </svg>
  );
}

function AlertIcon({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2.6} strokeLinecap="round" className={className} aria-hidden>
      <path d="M12 7v6M12 17h.01" />
    </svg>
  );
}

function ClockIcon({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2.2} strokeLinecap="round" strokeLinejoin="round" className={className} aria-hidden>
      <circle cx="12" cy="12" r="8.5" />
      <path d="M12 7.5V12l3 2" />
    </svg>
  );
}
