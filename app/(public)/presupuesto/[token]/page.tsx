"use client";

// Link público de un presupuesto (ADR-122): el cliente lo ve con la marca del
// negocio y lo acepta (con su nombre) o lo rechaza. Sin sesión: todo pasa por
// quote_public_get / quote_public_respond con el token (244 bits), que sólo
// devuelven datos del presupuesto y de la marca. Página SIEMPRE clara (es del
// cliente final, fuera del tema del POS), como el checkout de /pagar.
import { useEffect, useState } from "react";
import { useParams } from "next/navigation";
import { CheckCircle2, XCircle } from "lucide-react";
import { quotesApi, type PublicQuote } from "@/modules/quotes/api";
import { QUOTE_STATUS_LABEL, quoteDetailLines, quoteErrorMessage, quoteNumberLabel } from "@/lib/quotes/logic";
import { fmtDate, ivaConditionLabel } from "@/lib/invoices/legal";
import { accentPalette } from "@/lib/invoices/style";
import { businessDisplayName, invoiceTradeName } from "@/lib/branding/businessName";
import { formatCurrency, formatQty } from "@/lib/utils/format";
import { unitLabel } from "@/lib/catalog/mode";

type Phase = "loading" | "ready" | "missing";

export default function PublicQuotePage() {
  const { token } = useParams<{ token: string }>();
  const [phase, setPhase] = useState<Phase>("loading");
  const [q, setQ] = useState<PublicQuote | null>(null);
  const [name, setName] = useState("");
  const [comment, setComment] = useState("");
  const [mode, setMode] = useState<"idle" | "reject">("idle");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function load() {
    try {
      const r = await quotesApi.publicGet(String(token ?? ""));
      setQ(r);
      setPhase(r ? "ready" : "missing");
    } catch {
      setPhase("missing");
    }
  }
  useEffect(() => {
    void load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [token]);

  async function respond(accept: boolean) {
    setError(null);
    if (accept && !name.trim()) {
      setError("Escribí tu nombre para aceptar.");
      return;
    }
    setBusy(true);
    try {
      await quotesApi.publicRespond(String(token), accept, name.trim(), comment.trim());
      await load();
      setMode("idle");
    } catch (e) {
      setError(quoteErrorMessage(e));
    } finally {
      setBusy(false);
    }
  }

  const pal = accentPalette(q?.issuer.accent ?? "#FF4B22");
  const tradeName = q ? invoiceTradeName({ tradeName: q.issuer.trade_name, legalName: q.issuer.name }) : null;
  const displayName = q ? businessDisplayName({ tradeName: q.issuer.trade_name, legalName: q.issuer.name }) : null;
  useEffect(() => {
    if (displayName) document.title = `Presupuesto de ${displayName}`;
  }, [displayName]);
  const open = q && (q.status === "draft" || q.status === "sent");

  return (
    <main style={{ background: "#f4f5f7", minHeight: "100dvh", color: "#1b1f2a" }} className="px-4 py-6 sm:py-10">
      <div className="mx-auto w-full max-w-2xl">
        {phase === "loading" && <p className="py-20 text-center text-sm" style={{ color: "#6b7080" }}>Abriendo el presupuesto</p>}
        {phase === "missing" && (
          <div className="rounded-xl bg-white p-8 text-center">
            <p className="text-lg font-bold">Presupuesto no disponible</p>
            <p className="mt-1 text-sm" style={{ color: "#6b7080" }}>
              El link no es válido o el negocio lo dio de baja. Pedile uno nuevo.
            </p>
          </div>
        )}
        {phase === "ready" && q && (
          <article className="overflow-hidden rounded-xl bg-white" style={{ border: "1px solid #e4e6eb" }}>
            <header className="flex flex-wrap items-start justify-between gap-4 p-5 sm:p-7" style={{ borderBottom: "1px solid #e4e6eb" }}>
              <div className="min-w-0">
                {q.issuer.logo_url && (
                  // eslint-disable-next-line @next/next/no-img-element
                  <img src={q.issuer.logo_url} alt="" style={{ maxHeight: 48, maxWidth: 180, objectFit: "contain" }} className="mb-3" />
                )}
                {/* ADR-123: nombre de fantasía arriba; la razón social con los datos fiscales. */}
                {tradeName && <p className="text-lg font-bold leading-tight">{tradeName}</p>}
                <p className={tradeName ? "text-sm font-medium" : "text-base font-bold"}>{q.issuer.name}</p>
                <p className="text-xs" style={{ color: "#6b7080" }}>
                  {[q.issuer.cuit ? `CUIT ${q.issuer.cuit}` : null, q.issuer.iva_condition ? ivaConditionLabel(q.issuer.iva_condition) : null, q.issuer.address, q.issuer.phone]
                    .filter(Boolean)
                    .join(" · ")}
                </p>
              </div>
              <div className="text-right">
                <p className="text-2xl font-black tracking-wide" style={{ color: pal.accentText }}>
                  PRESUPUESTO
                </p>
                <p className="font-mono text-sm font-bold tabular-nums">N° {quoteNumberLabel(q.pto_vta, q.number)}</p>
                <p className="text-xs" style={{ color: "#6b7080" }}>
                  {fmtDate(q.issue_date)} · válido hasta el {fmtDate(q.valid_until)}
                </p>
                <span
                  className="mt-2 inline-block rounded-md px-2 py-0.5 text-xs font-semibold"
                  style={{ background: "#eef0f3", color: "#1b1f2a" }}
                >
                  {QUOTE_STATUS_LABEL[q.status]}
                </span>
              </div>
            </header>

            <section className="p-5 sm:p-7">
              {q.customer_name && (
                <p className="mb-4 text-sm">
                  <span style={{ color: "#6b7080" }}>Para: </span>
                  <b>{q.customer_name}</b>
                  {q.customer_doc ? <span style={{ color: "#6b7080" }}> · {q.customer_doc}</span> : null}
                </p>
              )}
              <ul style={{ borderTop: "1px solid #e4e6eb" }}>
                {q.items.map((it, i) => (
                  <li key={i} className="flex gap-3 py-3" style={{ borderBottom: "1px solid #e4e6eb" }}>
                    <div className="min-w-0 flex-1">
                      <p className="text-sm font-semibold">{it.name}</p>
                      {quoteDetailLines(it).map((l, j) => (
                        <p key={j} className="text-xs" style={{ color: "#6b7080" }}>
                          {l.bullet ? "• " : ""}
                          {l.text}
                        </p>
                      ))}
                      <p className="mt-1 text-xs tabular-nums" style={{ color: "#6b7080" }}>
                        {formatQty(it.quantity)} {it.unit_label ? unitLabel(it.unit_label) : "u."} × {formatCurrency(it.unit_price)}
                        {it.discount > 0 ? ` · descuento ${formatCurrency(it.discount)}` : ""}
                      </p>
                    </div>
                    <p className="shrink-0 text-sm font-semibold tabular-nums">{formatCurrency(it.subtotal)}</p>
                  </li>
                ))}
              </ul>
              <div className="ml-auto mt-4 max-w-xs space-y-1 text-sm">
                {q.discount_total > 0 && (
                  <>
                    <div className="flex justify-between" style={{ color: "#6b7080" }}>
                      <span>Subtotal</span>
                      <span className="tabular-nums">{formatCurrency(q.subtotal)}</span>
                    </div>
                    <div className="flex justify-between" style={{ color: "#6b7080" }}>
                      <span>Descuento</span>
                      <span className="tabular-nums">-{formatCurrency(q.discount_total)}</span>
                    </div>
                  </>
                )}
                <div className="flex items-baseline justify-between pt-1" style={{ borderTop: "1px solid #e4e6eb" }}>
                  <span className="font-semibold">Total</span>
                  <span className="text-2xl font-bold tabular-nums">{formatCurrency(q.total)}</span>
                </div>
              </div>

              {q.terms && (
                <div className="mt-6">
                  <p className="text-xs font-bold uppercase tracking-wider" style={{ color: "#6b7080" }}>
                    Condiciones
                  </p>
                  <p className="mt-1 whitespace-pre-wrap text-sm">{q.terms}</p>
                </div>
              )}
              {q.notes && (
                <div className="mt-4">
                  <p className="text-xs font-bold uppercase tracking-wider" style={{ color: "#6b7080" }}>
                    Notas
                  </p>
                  <p className="mt-1 whitespace-pre-wrap text-sm">{q.notes}</p>
                </div>
              )}
              <p className="mt-6 text-xs font-semibold uppercase" style={{ color: "#6b7080" }}>
                Documento no válido como factura
              </p>
            </section>

            <footer className="p-5 sm:p-7" style={{ background: "#f8f9fb", borderTop: "1px solid #e4e6eb" }}>
              {q.status === "accepted" || q.status === "converted" ? (
                <p className="flex items-center gap-2 text-sm font-semibold" style={{ color: "#1e7d4f" }}>
                  <CheckCircle2 size={18} aria-hidden /> Aceptado{q.accepted_by_name ? ` por ${q.accepted_by_name}` : ""}
                  {q.accepted_at ? ` el ${fmtDate(q.accepted_at)}` : ""}. ¡Gracias!
                </p>
              ) : q.status === "rejected" ? (
                <p className="flex items-center gap-2 text-sm font-semibold" style={{ color: "#b42318" }}>
                  <XCircle size={18} aria-hidden /> Presupuesto rechazado.
                </p>
              ) : q.status === "expired" ? (
                <p className="text-sm font-semibold" style={{ color: "#8a5a00" }}>
                  Este presupuesto venció el {fmtDate(q.valid_until)}. Pedile al negocio una versión actualizada.
                </p>
              ) : open ? (
                <div className="space-y-3">
                  <label className="block text-sm font-medium">
                    Tu nombre y apellido
                    <input
                      value={name}
                      onChange={(e) => setName(e.target.value)}
                      maxLength={160}
                      autoComplete="name"
                      className="mt-1 h-11 w-full rounded-lg bg-white px-3 text-sm outline-none"
                      style={{ border: "1px solid #d5d8de" }}
                    />
                  </label>
                  {mode === "reject" && (
                    <label className="block text-sm font-medium">
                      Contanos por qué (opcional)
                      <textarea
                        value={comment}
                        onChange={(e) => setComment(e.target.value)}
                        maxLength={400}
                        className="mt-1 min-h-[72px] w-full rounded-lg bg-white px-3 py-2 text-sm outline-none"
                        style={{ border: "1px solid #d5d8de" }}
                      />
                    </label>
                  )}
                  {error && (
                    <p className="text-sm" style={{ color: "#b42318" }}>
                      {error}
                    </p>
                  )}
                  <div className="flex flex-col gap-2 sm:flex-row">
                    {mode === "reject" ? (
                      <>
                        <button type="button" disabled={busy} onClick={() => respond(false)} className="h-12 w-full rounded-lg text-sm font-semibold sm:flex-1" style={{ background: "#1b1f2a", color: "#fff" }}>
                          Confirmar rechazo
                        </button>
                        <button type="button" disabled={busy} onClick={() => setMode("idle")} className="h-12 w-full rounded-lg text-sm font-semibold sm:flex-1" style={{ background: "#eef0f3" }}>
                          Volver
                        </button>
                      </>
                    ) : (
                      <>
                        <button
                          type="button"
                          disabled={busy}
                          onClick={() => respond(true)}
                          className="h-12 w-full rounded-lg text-sm font-semibold sm:flex-1"
                          style={{ background: pal.accent, color: pal.accentInk }}
                        >
                          Aceptar presupuesto
                        </button>
                        <button type="button" disabled={busy} onClick={() => setMode("reject")} className="h-12 w-full rounded-lg text-sm font-semibold sm:flex-1" style={{ background: "#eef0f3" }}>
                          Rechazar
                        </button>
                      </>
                    )}
                  </div>
                  <p className="text-xs" style={{ color: "#6b7080" }}>
                    Al aceptar, el negocio recibe tu confirmación con tu nombre, la fecha y la hora.
                  </p>
                </div>
              ) : null}
            </footer>
          </article>
        )}
        <p className="mt-6 text-center text-xs" style={{ color: "#9097a3" }}>
          Un software de Ninja Soft
        </p>
      </div>
    </main>
  );
}
