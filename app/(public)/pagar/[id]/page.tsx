"use client";

// F8 · H17b: checkout PROPIO de la tienda (Payway transparente) y, desde
// ADR-069, Getnet con la Checkout API (/pagar/{intent}?p=getnet).
// El cliente llega acá escaneando el QR del POS (/pagar/{intent}): ve la marca
// del negocio, elige tarjeta y cuotas (Planes del negocio, con el interés de
// cada opción), carga la tarjeta y paga. El backend cobra server-side
// recalculando el monto. Tokenización por procesador
// (lib/payments/checkoutProviders.ts):
//   * Payway: el PAN viaja del navegador DIRECTO a Payway (POST tokens con la
//     API Key pública); nuestro backend solo recibe el token de un solo uso.
//   * Getnet: no hay tokenización desde el navegador; la tarjeta va a la Edge
//     getnet_checkout, que la tokeniza en Getnet y la descarta.
//
// Página pública SIEMPRE clara (es del cliente final, fuera del tema del POS).
// El color de acento sale del branding del negocio, ajustado a contraste AA
// (lib/payments/paywayCheckout.ts).

import { useEffect, useMemo, useRef, useState, type CSSProperties, type ReactNode } from "react";
import { useParams, useSearchParams } from "next/navigation";
import { createClient } from "@/lib/supabase/client";
import { cardAppIcon, paymentWordmark } from "@/lib/payments/logos";
import { paywayPayMessage, paywayTokenMessage } from "@/lib/payments/paywayMessages";
import {
  buildGetnetPayBody,
  CHECKOUT_EDGE,
  checkoutProviderOf,
  PROCESSOR_NAME,
  SECURE_COPY,
  type CheckoutProvider,
} from "@/lib/payments/checkoutProviders";
import {
  accentPalette,
  availablePlans,
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
  /** Payway: tokenización en el navegador. */
  public_apikey?: string;
  tokens_url?: string;
  /** Getnet: false = el checkout propio todavía no está habilitado. */
  available?: boolean;
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

type Phase = "form" | "paying" | "done" | "review" | "unavailable" | "disabled";
type Field = keyof CardFieldErrors;

export default function PagarPage() {
  const params = useParams<{ id: string }>();
  const intentId = String(params?.id ?? "");
  const search = useSearchParams();
  const provider: CheckoutProvider = checkoutProviderOf(search?.get("p"));
  const edge = CHECKOUT_EDGE[provider];
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
      .invoke(edge, { body: { action: "info", intent_id: intentId } })
      .then(({ data, error }) => {
        if (error || (data as { error?: string })?.error) setLoadError(true);
        else {
          const i = data as Info;
          setInfo(i);
          if (i.status === "approved") {
            setPaid({ total: i.amount, installments: 0 });
            setPhase("done");
          } else if (i.status !== "pending") setPhase("unavailable");
          else if (i.available === false) setPhase("disabled");
        }
      })
      .catch(() => setLoadError(true));
  }, [intentId, supabase, edge]);

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
      if (provider === "getnet") {
        // Getnet: un solo paso; la Edge tokeniza en Getnet y cobra.
        const { data, error } = await supabase.functions.invoke(edge, {
          body: buildGetnetPayBody(intentId, brand, chosen.installments, { number: cardNumber, exp, cvv, holder, dni }),
        });
        await handlePayResult(data, error);
        return;
      }
      if (!info.tokens_url || !info.public_apikey) {
        fail({ title: "No se pudo completar el pago", text: paywayPayMessage({}) });
        return;
      }
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
      const { data, error } = await supabase.functions.invoke(edge, {
        body: {
          action: "pay",
          intent_id: intentId,
          token: tok.id,
          bin: tok.bin ?? cardDigits.slice(0, 6),
          brand,
          installments: chosen.installments,
        },
      });
      await handlePayResult(data, error);
    } catch {
      fail({ title: "Sin conexión", text: "No se pudo procesar el pago. Revisá tu conexión." });
    }
  }

  // Respuesta del cobro (mismo contrato en payway_checkout y getnet_checkout).
  async function handlePayResult(data: unknown, error: unknown) {
    const res = (data ?? {}) as PayRes;
    if (!error && res.ok) {
      setPaid({ total: quote.total, installments: quote.installments });
      setPhase("done");
      return;
    }
    // FunctionsHttpError: leer el cuerpo real (402 = rechazo del emisor,
    // 502 = falla del procesador, 202 = en revisión).
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
    } else if (result.error === "checkout_api_unavailable") {
      setPhase("disabled");
    } else {
      fail({
        title: result.status === "rejected_attempt" ? "Pago rechazado" : "No se pudo completar el pago",
        text,
      });
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

  const showForm = !loadError && (phase === "form" || phase === "paying");
  const brandLabel = BRAND_LABELS[brand] ?? brand;

  // Estados terminales (error de carga, aprobado, revisión, no disponible):
  // una sola columna angosta y centrada, igual en el celu y en la PC.
  if (!showForm) {
    return (
      <main className="min-h-dvh bg-[#F4F4F7] text-neutral-900 antialiased" style={vars}>
        <div className="mx-auto flex min-h-dvh w-full max-w-[480px] flex-col px-4 md:pt-10 lg:pt-16">
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
                <div className="mt-6 rounded-md border border-neutral-200 bg-neutral-50 px-4 py-3 text-sm">
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
          ) : phase === "disabled" ? (
            <StateCard
              tone="neutral"
              title="El pago con tarjeta no está disponible"
              text="Este comercio todavía no puede cobrar con tarjeta por acá. Pedile al cajero otro medio de pago."
            />
          ) : (
            <StateCard
              tone="neutral"
              title="Este cobro ya no está disponible"
              text={paywayPayMessage({ error: "intent_not_pending" })}
            />
          )}
          <SecureFooter provider={provider} />
        </div>
      </main>
    );
  }

  return (
    <main className="min-h-dvh bg-[#F4F4F7] text-neutral-900 antialiased" style={vars}>
      <div className="mx-auto flex min-h-dvh w-full max-w-[480px] flex-col px-4 md:max-w-[600px] md:px-6 lg:max-w-[1080px] lg:px-8">
        {/* Celu / tablet: comercio arriba y el total fijo mientras se completa. */}
        <div className="lg:hidden">
          <MerchantHeader info={info} accent={pal.base} />
        </div>
        {info && (
          <div className="sticky top-0 z-20 -mx-4 border-b border-transparent bg-[#F4F4F7]/95 px-4 pb-3 pt-3 backdrop-blur-md md:-mx-6 md:px-6 lg:hidden">
            <div className="rounded-lg border border-neutral-200 bg-white px-4 py-3.5">
              <div className="flex items-baseline justify-between gap-3">
                <p className="text-[11px] font-semibold uppercase tracking-wider text-neutral-600">
                  Total a pagar
                </p>
                <p className="shrink-0 text-sm font-semibold tabular-nums">
                  {quote.installments === 1
                    ? "1 pago"
                    : `${quote.installments} × ${fmt(quote.perInstallment)}`}
                </p>
              </div>
              <div className="mt-1 flex flex-wrap items-end justify-between gap-x-3">
                <p className="text-[26px] font-extrabold leading-none tracking-tight tabular-nums">
                  {fmt(quote.total)}
                </p>
                <InterestPill quote={quote} />
              </div>
            </div>
          </div>
        )}

        <div className="flex-1 lg:grid lg:grid-cols-[minmax(0,380px)_minmax(0,1fr)] lg:items-start lg:gap-10 lg:py-12 xl:gap-14">
          {/* PC: resumen de la orden, fijo a la izquierda. */}
          <aside className="hidden lg:sticky lg:top-12 lg:block" aria-label="Resumen del pago">
            {info ? (
              <div className="overflow-hidden rounded-lg border border-neutral-200 bg-white">
                <div className="p-6">
                  <MerchantHeader info={info} accent={pal.base} compact />
                </div>
                <div className="border-t border-neutral-200 p-6">
                  <p className="text-[11px] font-semibold uppercase tracking-wider text-neutral-600">
                    Total a pagar
                  </p>
                  <p className="mt-2 text-[40px] font-extrabold leading-none tracking-tight tabular-nums">
                    {fmt(quote.total)}
                  </p>
                  <dl className="mt-6 space-y-3 text-sm">
                    <SummaryRow label="Tarjeta">
                      <span className="inline-flex items-center gap-2">
                        <BrandIcon brand={brand} label={brandLabel} size={22} />
                        <span className="font-semibold">{brandLabel}</span>
                      </span>
                    </SummaryRow>
                    <SummaryRow label="Forma de pago">
                      <span className="font-semibold tabular-nums">
                        {quote.installments === 1
                          ? "1 pago"
                          : `${quote.installments} cuotas de ${fmt(quote.perInstallment)}`}
                      </span>
                    </SummaryRow>
                    <SummaryRow label="Monto">
                      <span className="tabular-nums">{fmt(base)}</span>
                    </SummaryRow>
                    <div
                      className="flex items-center justify-between gap-3 rounded-md px-3 py-2"
                      style={{ background: "var(--acc-soft)", color: "var(--acc-text)" }}
                    >
                      <dt className="font-medium">Interés</dt>
                      <dd className="text-right font-semibold tabular-nums">
                        {interestLabel(quote, fmt)}
                      </dd>
                    </div>
                  </dl>
                </div>
                <div className="border-t border-neutral-200 bg-neutral-50 p-6">
                  <SecureNote provider={provider} />
                </div>
              </div>
            ) : (
              <div className="h-[460px] animate-pulse rounded-lg bg-white" />
            )}
            <div className="mt-5 px-1">
              <PoweredBy provider={provider} />
              <Legal className="mt-4 text-left" />
            </div>
          </aside>

          {/* Formulario de pago */}
          <div className="pb-4 pt-1 lg:pb-0 lg:pt-0">
            {!info ? (
              <LoadingSkeleton />
            ) : (
              <div className="space-y-3 md:space-y-4">
                <div className="hidden lg:mb-2 lg:block">
                  <h2 className="text-2xl font-bold tracking-tight">Pagá con tarjeta</h2>
                  <p className="mt-1 text-sm text-neutral-600">
                    Elegí la tarjeta y las cuotas, y completá los datos.
                  </p>
                </div>

                {/* 1 · Tarjeta */}
                <Section n={1} title="Elegí tu tarjeta">
                  <div className="grid grid-cols-4 gap-2 md:gap-3" role="radiogroup" aria-label="Tarjeta">
                    {offered.map((br) => {
                      const debit = (info.debit_brands ?? []).includes(br);
                      const active = brand === br;
                      const label = BRAND_LABELS[br] ?? br;
                      return (
                        <button
                          key={br}
                          type="button"
                          role="radio"
                          aria-checked={active}
                          aria-label={`${label} ${debit ? "débito" : "crédito"}`}
                          onClick={() => selectBrand(br)}
                          className={`relative flex flex-col items-center justify-center gap-2 rounded-md border px-1 pb-2 pt-3 transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[color:var(--acc)] focus-visible:ring-offset-1 ${
                            active ? "" : "border-neutral-200 bg-white hover:border-neutral-300 hover:bg-neutral-50"
                          }`}
                          style={
                            active
                              ? { background: "var(--acc-soft)", borderColor: "var(--acc)" }
                              : undefined
                          }
                        >
                          <BrandIcon brand={br} label={label} size={40} />
                          <span
                            className="text-[11px] font-semibold leading-none"
                            style={{ color: active ? "var(--acc-text)" : "#525252" }}
                          >
                            {debit ? "Débito" : "Crédito"}
                          </span>
                          {active && (
                            <span
                              className="absolute right-1 top-1 grid h-4 w-4 place-items-center rounded-full text-white"
                              style={{ background: "var(--acc)" }}
                              aria-hidden
                            >
                              <CheckIcon className="h-2.5 w-2.5" />
                            </span>
                          )}
                        </button>
                      );
                    })}
                  </div>
                  <p className="mt-3 text-xs text-neutral-600">
                    Pagás con <span className="font-semibold text-neutral-800">{brandLabel}</span>
                    {family ? ". La detectamos por el número de tu tarjeta." : "."}
                  </p>
                </Section>

                {/* 2 · Cuotas */}
                <Section n={2} title="Elegí las cuotas">
                  <div
                    className="overflow-hidden rounded-md border border-neutral-200"
                    role="radiogroup"
                    aria-label="Cuotas"
                  >
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
                          className={`flex w-full items-center gap-3 px-4 py-3 text-left transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-[color:var(--acc)] ${
                            idx > 0 ? "border-t border-neutral-200" : ""
                          } ${active ? "" : "bg-white hover:bg-neutral-50"}`}
                          style={active ? { background: "var(--acc-soft)" } : undefined}
                        >
                          <span
                            className="grid h-5 w-5 shrink-0 place-items-center rounded-full text-white transition-colors"
                            style={
                              active
                                ? { background: "var(--acc)" }
                                : { border: "1.5px solid #a3a3a3" }
                            }
                            aria-hidden
                          >
                            {active && <CheckIcon className="h-3 w-3" />}
                          </span>
                          <span className="min-w-0 flex-1 md:flex md:items-center md:justify-between md:gap-4">
                            <span className="flex items-start justify-between gap-3 md:block">
                              <span className="min-w-0">
                                <span className="block text-[13px] text-neutral-600">
                                  {q.installments === 1 ? "1 pago de" : `${q.installments} cuotas de`}
                                </span>
                                <span className="block text-lg font-bold leading-tight tabular-nums">
                                  {fmt(q.perInstallment)}
                                </span>
                              </span>
                              <span className="shrink-0 pt-0.5 text-right md:hidden">
                                <span className="block text-[11px] uppercase tracking-wide text-neutral-600">
                                  Total
                                </span>
                                <span className="block text-sm font-semibold tabular-nums">
                                  {fmt(q.total)}
                                </span>
                              </span>
                            </span>
                            <span className="md:hidden">
                              <InterestPill quote={q} />
                            </span>
                            <span className="hidden shrink-0 text-right md:block">
                              <span className="block text-sm font-semibold tabular-nums">
                                Total {fmt(q.total)}
                              </span>
                              <InterestPill quote={q} />
                            </span>
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
                  <div className="grid grid-cols-2 gap-x-3 gap-y-4">
                    <div className="col-span-2">
                      <Field label="Número de tarjeta" id="cc-number" error={showErr("number")}>
                        <div className="relative">
                          <input
                            id="cc-number"
                            className={`${inputCls(!!showErr("number"))} pr-14`}
                            inputMode="numeric"
                            autoComplete="cc-number"
                            placeholder="0000 0000 0000 0000"
                            value={cardNumber}
                            onChange={(e) => onCardNumber(e.target.value)}
                            onBlur={() => setTouched((t) => ({ ...t, number: true }))}
                            aria-invalid={!!showErr("number")}
                          />
                          {family && cardAppIcon(family) && (
                            <span className="pointer-events-none absolute right-3 top-1/2 -translate-y-1/2">
                              <BrandIcon brand={family} label={BRAND_LABELS[family] ?? family} size={28} />
                            </span>
                          )}
                        </div>
                      </Field>
                    </div>
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
                    <div className="col-span-2 md:col-span-1">
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
                    </div>
                    <div className="col-span-2 md:col-span-1">
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
                  </div>
                </Section>

                {payError && (
                  <div
                    ref={errorRef}
                    role="alert"
                    className="flex gap-3 rounded-lg border border-red-200 bg-red-50 p-4"
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

                <div className="pt-1">
                  <button
                    type="button"
                    disabled={phase === "paying"}
                    onClick={pagar}
                    className="flex h-14 w-full items-center justify-center gap-2.5 rounded-lg text-base font-bold text-white transition hover:brightness-110 active:brightness-95 disabled:cursor-wait disabled:opacity-80 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[color:var(--acc)] focus-visible:ring-offset-2"
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
                    <p className="mt-3 text-center text-xs text-neutral-600">
                      Completá los datos marcados para continuar.
                    </p>
                  )}
                </div>
              </div>
            )}
          </div>
        </div>

        <div className="lg:hidden">
          <SecureFooter provider={provider} />
        </div>
      </div>
    </main>
  );
}

// ── Piezas ───────────────────────────────────────────────────────────────────

function inputCls(invalid: boolean) {
  return `h-12 w-full rounded-md border bg-white px-3.5 text-base text-neutral-900 placeholder:text-neutral-400 outline-none transition-colors focus:border-[color:var(--acc)] focus:ring-2 focus:ring-[color:var(--acc-softer)] ${
    invalid ? "border-red-500" : "border-neutral-300 hover:border-neutral-400"
  }`;
}

// Ícono de app de la red (set de soft.ninja): placa blanca cuadrada con radio
// 22.5% y borde de 1px, sin sombra (como CardBrandLogo, versión plana).
function BrandIcon({ brand, label, size }: { brand: string; label: string; size: number }) {
  const src = cardAppIcon(brand);
  if (!src) {
    return (
      <span
        className="grid place-items-center rounded-[22.5%] border border-neutral-200 bg-white px-1 text-[10px] font-bold text-neutral-700"
        style={{ width: size, height: size }}
      >
        {label.slice(0, 4)}
      </span>
    );
  }
  return (
    <span
      className="grid shrink-0 place-items-center overflow-hidden rounded-[22.5%] bg-white ring-1 ring-black/10"
      style={{ width: size, height: size }}
    >
      {/* eslint-disable-next-line @next/next/no-img-element */}
      <img src={src} alt="" draggable={false} className="h-full w-full select-none object-contain" />
    </span>
  );
}

function SummaryRow({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="flex items-center justify-between gap-3 px-3">
      <dt className="text-neutral-600">{label}</dt>
      <dd className="text-right">{children}</dd>
    </div>
  );
}

function InterestPill({ quote }: { quote: ReturnType<typeof quoteInstallments> }) {
  const free = quote.interest <= 0;
  return (
    <span
      className="mt-1.5 inline-flex items-center whitespace-nowrap rounded-md px-2 py-0.5 text-[11px] font-semibold leading-4 tabular-nums"
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

function MerchantHeader({
  info,
  accent,
  compact = false,
}: {
  info: Info | null;
  accent: string;
  compact?: boolean;
}) {
  const box = compact ? "h-12 w-12" : "h-14 w-14";
  return (
    <header className={`flex items-center gap-3 ${compact ? "" : "pb-1 pt-6"}`}>
      {info?.logo_url ? (
        // eslint-disable-next-line @next/next/no-img-element
        <img
          src={info.logo_url}
          alt=""
          className={`${box} shrink-0 rounded-lg border border-neutral-200 bg-white object-contain p-1.5`}
        />
      ) : (
        <span
          className={`${box} grid shrink-0 place-items-center rounded-lg text-xl font-black text-white`}
          style={{ background: info ? accent : "#d4d4d4" }}
        >
          {(info?.tenant_name ?? "").slice(0, 1).toUpperCase()}
        </span>
      )}
      <div className="min-w-0 flex-1">
        <p className="text-sm text-neutral-600">Estás pagando a</p>
        <h1 className={`truncate font-bold leading-tight ${compact ? "text-lg" : "text-xl"}`}>
          {info?.tenant_name ?? <span className="inline-block h-5 w-32 animate-pulse rounded bg-neutral-200" />}
        </h1>
      </div>
      <span className="inline-flex shrink-0 items-center gap-1 rounded-md border border-emerald-200 bg-emerald-50 px-2.5 py-1 text-[11px] font-semibold text-emerald-800">
        <LockIcon className="h-3 w-3" />
        Seguro
      </span>
    </header>
  );
}

function Section({ n, title, children }: { n: number; title: string; children: ReactNode }) {
  return (
    <section className="rounded-lg border border-neutral-200 bg-white p-4 sm:p-5 lg:p-6">
      <h2 className="mb-4 flex items-center gap-2.5 text-[15px] font-bold">
        <span
          className="grid h-6 w-6 place-items-center rounded-md text-xs font-bold text-white"
          style={{ background: "var(--acc)" }}
          aria-hidden
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
      <span className="grid h-16 w-16 place-items-center rounded-full bg-emerald-600 text-white">
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
    <div className="mt-6 rounded-lg border border-neutral-200 bg-white p-8 text-center">
      <div className="flex justify-center">{icon}</div>
      <h2 className="mt-5 text-xl font-bold">{title}</h2>
      <p className="mx-auto mt-1.5 max-w-xs text-sm leading-relaxed text-neutral-600">{text}</p>
      {children}
    </div>
  );
}

function LoadingSkeleton() {
  return (
    <div className="mt-4 space-y-4 lg:mt-0" aria-busy="true" aria-label="Cargando">
      <div className="h-20 animate-pulse rounded-lg bg-white lg:hidden" />
      <div className="h-48 animate-pulse rounded-lg bg-white" />
      <div className="h-56 animate-pulse rounded-lg bg-white" />
    </div>
  );
}

function SecureNote({ provider }: { provider: CheckoutProvider }) {
  return (
    <div className="flex gap-3">
      <span className="grid h-9 w-9 shrink-0 place-items-center rounded-md border border-emerald-200 bg-emerald-50 text-emerald-700">
        <LockIcon className="h-4 w-4" />
      </span>
      <p className="text-[13px] leading-relaxed text-neutral-700">
        <span className="font-semibold text-neutral-900">Pago seguro.</span> {SECURE_COPY[provider]}
      </p>
    </div>
  );
}

function PoweredBy({ provider }: { provider: CheckoutProvider }) {
  const mark = paymentWordmark(provider);
  return (
    <div className="flex items-end justify-between gap-3">
      <span className="flex flex-col items-start gap-1.5 text-[11px] text-neutral-600">
        Procesado por
        {mark ? (
          // eslint-disable-next-line @next/next/no-img-element
          <img src={mark} alt={PROCESSOR_NAME[provider]} className="h-4 w-auto" />
        ) : (
          <span className="font-semibold text-neutral-800">{PROCESSOR_NAME[provider]}</span>
        )}
      </span>
      <a
        href="https://pos.soft.ninja"
        target="_blank"
        rel="noreferrer"
        className="flex flex-col items-end gap-1.5 rounded-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[color:var(--acc)] focus-visible:ring-offset-2"
      >
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img src="/brand/ninjapos-logo-light-mode.webp" alt="NinjaPOS" className="h-4 w-auto" />
        <span className="whitespace-nowrap text-[11px] text-neutral-600">Un producto de Ninja Soft</span>
      </a>
    </div>
  );
}

function Legal({ className = "" }: { className?: string }) {
  return (
    <p className={`text-[11px] leading-relaxed text-neutral-500 ${className}`}>
      El comercio es el responsable de la venta. NinjaPOS brinda la plataforma de cobro.
      <br />© {new Date().getFullYear()} Ninja Soft · Rosario, Argentina
    </p>
  );
}

function SecureFooter({ provider }: { provider: CheckoutProvider }) {
  return (
    <footer className="mt-auto pb-8 pt-6">
      <div className="rounded-lg border border-neutral-200 bg-white/70 p-5">
        <SecureNote provider={provider} />
        <div className="mt-4 border-t border-neutral-200 pt-4">
          <PoweredBy provider={provider} />
        </div>
      </div>
      <Legal className="mt-4 text-center" />
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
