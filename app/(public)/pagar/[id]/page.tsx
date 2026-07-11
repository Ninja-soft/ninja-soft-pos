"use client";

// F8 · H17b — Checkout PROPIO de la tienda (Payway transparente).
// El cliente llega acá escaneando el QR del POS (/pagar/{intent}): ve la marca
// del negocio, elige tarjeta y cuotas (Planes del negocio, recargo en vivo),
// carga la tarjeta y paga. PCI: el PAN viaja del navegador DIRECTO a Payway
// (POST tokens con la API Key pública) — nuestro backend solo recibe el token
// de un solo uso y cobra server-side recalculando el monto.
//
// Página pública SIEMPRE clara (es del cliente final, fuera del tema del POS).

import { useEffect, useMemo, useState } from "react";
import { useParams } from "next/navigation";
import { createClient } from "@/lib/supabase/client";

type Plan = {
  brand: string | null;
  installments: number;
  label: string;
  surcharge_pct: number;
};
type Info = {
  status: string;
  amount: number;
  tenant_name: string;
  logo_url: string | null;
  accent: string | null;
  plans: Plan[];
  brands: string[];
  public_apikey: string;
  tokens_url: string;
};

const BRAND_LABELS: Record<string, string> = {
  visa: "Visa",
  master: "Mastercard",
  maestro: "Maestro",
  cabal: "Cabal",
  amex: "Amex",
  naranja: "Naranja X",
  diners: "Diners",
};

const fmt = (n: number) =>
  n.toLocaleString("es-AR", { style: "currency", currency: "ARS" });
const round2 = (n: number) => Math.round(n * 100) / 100;

export default function PagarPage() {
  const params = useParams<{ id: string }>();
  const intentId = String(params?.id ?? "");
  const supabase = useMemo(() => createClient(), []);

  const [info, setInfo] = useState<Info | null>(null);
  const [loadError, setLoadError] = useState(false);
  const [phase, setPhase] = useState<"form" | "paying" | "done">("form");
  const [payError, setPayError] = useState("");

  const [brand, setBrand] = useState<string>("visa");
  const [installments, setInstallments] = useState(1);
  const [cardNumber, setCardNumber] = useState("");
  const [exp, setExp] = useState("");
  const [cvv, setCvv] = useState("");
  const [holder, setHolder] = useState("");
  const [dni, setDni] = useState("");

  useEffect(() => {
    if (!intentId) return;
    supabase.functions
      .invoke("payway_checkout", { body: { action: "info", intent_id: intentId } })
      .then(({ data, error }) => {
        if (error || (data as { error?: string })?.error) setLoadError(true);
        else {
          const i = data as Info;
          setInfo(i);
          if (i.status === "approved") setPhase("done");
        }
      })
      .catch(() => setLoadError(true));
  }, [intentId, supabase]);

  const accent = info?.accent || "#EC3F17";

  // Cuotas disponibles para la marca elegida (plan de la marca o genérico).
  const cuotas = useMemo(() => {
    const list = new Map<number, Plan>();
    for (const p of info?.plans ?? []) {
      if (p.brand && p.brand !== brand) continue;
      const prev = list.get(p.installments);
      // El plan específico de la marca pisa al genérico.
      if (!prev || (p.brand && !prev.brand)) list.set(p.installments, p);
    }
    if (!list.has(1)) {
      list.set(1, { brand: null, installments: 1, label: "1 pago", surcharge_pct: 0 });
    }
    return [...list.values()].sort((a, b) => a.installments - b.installments);
  }, [info, brand]);

  const chosen = cuotas.find((c) => c.installments === installments) ?? cuotas[0];
  const total = round2((info?.amount ?? 0) * (1 + (chosen?.surcharge_pct ?? 0) / 100));
  const porCuota = chosen ? round2(total / chosen.installments) : total;

  const cardDigits = cardNumber.replace(/\D/g, "");
  const [expMonth, expYear] = exp.split("/").map((v) => v?.trim() ?? "");
  const formOk =
    cardDigits.length >= 14 &&
    /^\d{2}$/.test(expMonth ?? "") &&
    /^\d{2}$/.test(expYear ?? "") &&
    cvv.replace(/\D/g, "").length >= 3 &&
    holder.trim().length >= 3 &&
    dni.replace(/\D/g, "").length >= 6;

  async function pagar() {
    if (!info || !chosen || !formOk || phase === "paying") return;
    setPayError("");
    setPhase("paying");
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
          card_holder_identification: {
            type: "dni",
            number: dni.replace(/\D/g, ""),
          },
        }),
      });
      const tok = (await tokRes.json().catch(() => ({}))) as {
        id?: string;
        bin?: string;
      };
      if (!tokRes.ok || !tok.id) {
        setPayError("No pudimos validar la tarjeta. Revisá los datos.");
        setPhase("form");
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
      const res = (data ?? {}) as { ok?: boolean; status?: string };
      if (!error && res.ok) {
        setPhase("done");
        return;
      }
      // FunctionsHttpError: leer el cuerpo real (402 = rechazo del emisor).
      let code = res.status ?? "";
      const ctx = (error as { context?: Response } | null)?.context;
      if (ctx) {
        const body = (await ctx.json().catch(() => null)) as {
          status?: string;
          error?: string;
        } | null;
        code = body?.status ?? body?.error ?? code;
      }
      setPayError(
        code === "rejected_attempt"
          ? "El pago fue rechazado por el emisor de la tarjeta. Probá con otra tarjeta."
          : code === "intent_not_pending"
            ? "Este cobro ya no está disponible. Pedile al cajero que lo genere de nuevo."
            : "No se pudo procesar el pago. Probá de nuevo.",
      );
      setPhase("form");
    } catch {
      setPayError("No se pudo procesar el pago. Revisá tu conexión.");
      setPhase("form");
    }
  }

  const inputCls =
    "h-12 w-full rounded-xl border border-neutral-300 bg-white px-4 text-base text-neutral-900 outline-none focus:border-neutral-500";

  return (
    <main className="min-h-dvh bg-neutral-100 text-neutral-900">
      <div className="mx-auto flex min-h-dvh w-full max-w-md flex-col px-4 py-6">
        {/* Marca del negocio */}
        <header className="flex items-center gap-3">
          {info?.logo_url ? (
            // eslint-disable-next-line @next/next/no-img-element
            <img
              src={info.logo_url}
              alt=""
              className="h-12 w-12 rounded-xl bg-white object-contain p-1 shadow-sm"
            />
          ) : (
            <span
              className="grid h-12 w-12 place-items-center rounded-xl text-lg font-black text-white shadow-sm"
              style={{ background: accent }}
            >
              {(info?.tenant_name ?? "N").slice(0, 1).toUpperCase()}
            </span>
          )}
          <div>
            <p className="text-sm text-neutral-500">Estás pagando a</p>
            <h1 className="text-lg font-bold leading-tight">
              {info?.tenant_name ?? "…"}
            </h1>
          </div>
        </header>

        {loadError ? (
          <div className="mt-10 rounded-2xl bg-white p-6 text-center shadow-sm">
            <p className="font-semibold">No encontramos este cobro.</p>
            <p className="mt-1 text-sm text-neutral-500">
              Pedile al cajero que genere el QR de nuevo.
            </p>
          </div>
        ) : phase === "done" ? (
          <div className="mt-10 rounded-2xl bg-white p-8 text-center shadow-sm">
            <span
              className="mx-auto grid h-16 w-16 place-items-center rounded-full text-3xl text-white"
              style={{ background: "#059669" }}
            >
              ✓
            </span>
            <h2 className="mt-4 text-xl font-bold">¡Pago aprobado!</h2>
            <p className="mt-1 text-sm text-neutral-500">
              Listo, ya podés cerrar esta pantalla. El mostrador registra la
              venta automáticamente.
            </p>
          </div>
        ) : !info ? (
          <div className="mt-10 rounded-2xl bg-white p-8 text-center text-sm text-neutral-500 shadow-sm">
            Cargando…
          </div>
        ) : (
          <>
            {/* Total */}
            <div className="mt-5 rounded-2xl bg-white p-5 shadow-sm">
              <div className="flex items-baseline justify-between">
                <span className="text-sm text-neutral-500">Total a pagar</span>
                <span className="text-2xl font-black tracking-tight">
                  {fmt(total)}
                </span>
              </div>
              {chosen && chosen.installments > 1 && (
                <p className="mt-1 text-right text-sm text-neutral-500">
                  {chosen.installments} cuotas de {fmt(porCuota)}
                </p>
              )}
            </div>

            {/* Tarjeta y cuotas */}
            <div className="mt-4 rounded-2xl bg-white p-5 shadow-sm">
              <p className="text-sm font-semibold">Tarjeta</p>
              <div className="mt-2 flex flex-wrap gap-2">
                {(info.brands ?? []).map((br) => (
                  <button
                    key={br}
                    type="button"
                    onClick={() => {
                      setBrand(br);
                      setInstallments(1);
                    }}
                    className="rounded-full border px-3 py-1.5 text-sm font-medium transition"
                    style={
                      brand === br
                        ? { borderColor: accent, color: accent, background: `${accent}14` }
                        : { borderColor: "#d4d4d4", color: "#525252" }
                    }
                  >
                    {BRAND_LABELS[br] ?? br}
                  </button>
                ))}
              </div>

              <p className="mt-4 text-sm font-semibold">Cuotas</p>
              <div className="mt-2 grid gap-2">
                {cuotas.map((c) => {
                  const t = round2(info.amount * (1 + c.surcharge_pct / 100));
                  const active = installments === c.installments;
                  return (
                    <button
                      key={c.installments}
                      type="button"
                      onClick={() => setInstallments(c.installments)}
                      className="flex items-center justify-between rounded-xl border px-4 py-3 text-left transition"
                      style={
                        active
                          ? { borderColor: accent, background: `${accent}0d` }
                          : { borderColor: "#e5e5e5" }
                      }
                    >
                      <span className="text-sm font-medium">
                        {c.installments === 1
                          ? "1 pago"
                          : `${c.installments} cuotas de ${fmt(round2(t / c.installments))}`}
                      </span>
                      <span className="text-sm font-semibold">{fmt(t)}</span>
                    </button>
                  );
                })}
              </div>
            </div>

            {/* Datos de la tarjeta */}
            <div className="mt-4 space-y-3 rounded-2xl bg-white p-5 shadow-sm">
              <input
                className={inputCls}
                inputMode="numeric"
                autoComplete="cc-number"
                placeholder="Número de tarjeta"
                value={cardNumber}
                onChange={(e) =>
                  setCardNumber(
                    e.target.value
                      .replace(/\D/g, "")
                      .slice(0, 19)
                      .replace(/(\d{4})(?=\d)/g, "$1 "),
                  )
                }
              />
              <div className="grid grid-cols-2 gap-3">
                <input
                  className={inputCls}
                  inputMode="numeric"
                  autoComplete="cc-exp"
                  placeholder="MM/AA"
                  value={exp}
                  onChange={(e) => {
                    const d = e.target.value.replace(/\D/g, "").slice(0, 4);
                    setExp(d.length > 2 ? `${d.slice(0, 2)}/${d.slice(2)}` : d);
                  }}
                />
                <input
                  className={inputCls}
                  inputMode="numeric"
                  autoComplete="cc-csc"
                  placeholder="CVV"
                  value={cvv}
                  onChange={(e) => setCvv(e.target.value.replace(/\D/g, "").slice(0, 4))}
                />
              </div>
              <input
                className={inputCls}
                autoComplete="cc-name"
                placeholder="Nombre como figura en la tarjeta"
                value={holder}
                onChange={(e) => setHolder(e.target.value)}
              />
              <input
                className={inputCls}
                inputMode="numeric"
                placeholder="DNI del titular"
                value={dni}
                onChange={(e) => setDni(e.target.value.replace(/\D/g, "").slice(0, 9))}
              />
            </div>

            {payError && (
              <p className="mt-3 rounded-xl bg-red-50 p-3 text-sm font-medium text-red-700">
                {payError}
              </p>
            )}

            <button
              type="button"
              disabled={!formOk || phase === "paying"}
              onClick={pagar}
              className="mt-4 h-14 w-full rounded-2xl text-base font-bold text-white shadow-md transition active:scale-[0.99] disabled:opacity-50"
              style={{ background: accent }}
            >
              {phase === "paying" ? "Procesando…" : `Pagar ${fmt(total)}`}
            </button>

            <p className="mt-3 pb-2 text-center text-[11px] leading-relaxed text-neutral-400">
              Pago procesado por Payway. Los datos de tu tarjeta viajan cifrados
              directo al procesador: esta tienda no los ve ni los guarda.
            </p>
          </>
        )}
      </div>
    </main>
  );
}
