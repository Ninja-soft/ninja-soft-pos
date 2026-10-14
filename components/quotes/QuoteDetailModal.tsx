"use client";

// Detalle de un presupuesto (ADR-122, ADR-123). Mismo ancho y lenguaje que la
// hoja de cobro y la ventana del ticket (PosSheet xl): en la compu, vista
// previa del documento (A4 o ticket, motor ADR-112/119) a la izquierda y el
// resumen y las acciones a la derecha; en el celular, resumen y acciones
// arriba, vista previa abajo y la acción principal fija abajo. Envío por email
// con el PDF adjunto (send_quote_email), WhatsApp, link de aceptación, PDF,
// impresión, estados, historial de envíos y revisiones, duplicar, editar,
// eliminar y convertir en venta (abre el POS con el carrito cargado).
import { useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { useRouter } from "next/navigation";
import type { Route } from "next";
import {
  CheckCircle2,
  ChevronDown,
  Copy,
  FileDown,
  History,
  Link2,
  Mail,
  MessageCircle,
  Pencil,
  Printer,
  Send,
  ShoppingCart,
  Trash2,
  XCircle,
} from "lucide-react";
import { PosSheet } from "@/components/pos/ui/PosSheet";
import { POS_CTA, POS_EYEBROW, POS_QUIET } from "@/components/pos/ui/posStyles";
import { Button } from "@/components/ui/Button";
import { Badge } from "@/components/ui/Badge";
import { Callout } from "@/components/ui/Callout";
import { Segmented } from "@/components/ui/Segmented";
import { Skeleton } from "@/components/ui/Skeleton";
import { ConfirmDialog } from "@/components/ui/ConfirmDialog";
import { useToast } from "@/components/ui/Toast";
import { InvoiceFit } from "@/components/invoices/InvoiceFit";
import { QuoteDocument } from "@/components/quotes/QuoteDocument";
import { QuoteFormModal } from "@/components/quotes/QuoteFormModal";
import { QuoteEmailDialog } from "@/components/quotes/QuoteEmailDialog";
import { useQuote, useQuoteEmails, useQuoteMutations, useQuoteRevisions } from "@/modules/quotes/hooks";
import { useQuoteBrand } from "@/modules/quotes/useQuoteBrand";
import { useQuoteImages } from "@/modules/quotes/useQuoteImages";
import type { QuoteEmailLog } from "@/modules/quotes/api";
import { downloadInvoicePdf } from "@/lib/invoices/exportPdf";
import { printTicketIsolated } from "@/lib/print/webPrint";
import { fmtDate } from "@/lib/invoices/legal";
import {
  QUOTE_STATUS_LABEL,
  QUOTE_STATUS_TONE,
  effectiveQuoteStatus,
  publicQuoteUrl,
  quoteConvertible,
  quoteEditable,
  quoteErrorMessage,
  quoteNumberLabel,
  quoteRecipients,
  quoteShareText,
  quoteValidityText,
  whatsappUrl,
} from "@/lib/quotes/logic";
import { formatCurrency } from "@/lib/utils/format";
import { cn } from "@/lib/utils/cn";

type Fmt = "a4" | "ticket";

const fmtDateTime = (iso: string) =>
  new Date(iso).toLocaleString("es-AR", { dateStyle: "short", timeStyle: "short", timeZone: "America/Argentina/Buenos_Aires" });

/** Envíos agrupados por tanda (un click en Enviar = una tanda). */
function groupBatches(rows: QuoteEmailLog[]) {
  const map = new Map<string, QuoteEmailLog[]>();
  for (const r of rows) map.set(r.batch_id, [...(map.get(r.batch_id) ?? []), r]);
  return Array.from(map.values());
}

const EMAIL_STATUS: Record<QuoteEmailLog["status"], { label: string; tone: "success" | "danger" | "neutral" }> = {
  sent: { label: "Enviado", tone: "success" },
  failed: { label: "Falló", tone: "danger" },
  pending: { label: "Enviando", tone: "neutral" },
};

export function QuoteDetailModal({
  quoteId,
  onOpenChange,
  onOpenQuote,
  canManage,
}: {
  quoteId: string | null;
  onOpenChange: (o: boolean) => void;
  /** Abre otro presupuesto (la copia recién duplicada). */
  onOpenQuote?: (id: string) => void;
  canManage: boolean;
}) {
  const open = quoteId != null;
  const router = useRouter();
  const { toast } = useToast();
  const { data: q, isLoading } = useQuote(quoteId);
  const m = useQuoteMutations();
  const { style, brand, ticketWidth } = useQuoteBrand(open);
  // ADR-119: fotos de los productos (el motor las muestra si el negocio las prendió).
  const images = useQuoteImages(q?.items ?? null, open && (style.showPhotos || style.ticketPhotos || style.a4Model === "catalogo"));
  const [fmt, setFmt] = useState<Fmt>("a4");
  const [editOpen, setEditOpen] = useState(false);
  const [emailOpen, setEmailOpen] = useState(false);
  const [rejectOpen, setRejectOpen] = useState(false);
  const [deleteOpen, setDeleteOpen] = useState(false);
  const [historyOpen, setHistoryOpen] = useState(false);
  const [pdfBusy, setPdfBusy] = useState(false);
  const { data: revisions = [] } = useQuoteRevisions(quoteId, historyOpen);
  const { data: emails = [] } = useQuoteEmails(quoteId, open);
  const printRef = useRef<HTMLDivElement>(null);
  // El portal de las hojas fuera de pantalla sólo en el cliente (sin desfase de hidratación).
  const [mounted, setMounted] = useState(false);
  useEffect(() => setMounted(true), []);
  useEffect(() => {
    if (!open) {
      setHistoryOpen(false);
      setFmt("a4");
    }
  }, [open]);

  const eff = q ? effectiveQuoteStatus(q.status, q.valid_until) : null;
  const label = q ? quoteNumberLabel(q.pto_vta, q.number) : "";
  const businessName = brand?.trade_name || brand?.legal_name || "nuestro negocio";
  const closed = eff === "rejected" || eff === "converted";
  const recipients = q ? quoteRecipients(q) : [];
  const batches = useMemo(() => groupBatches(emails), [emails]);
  const lastSent = emails.find((e) => e.status === "sent");

  async function run<T>(fn: () => Promise<T>, ok: string) {
    try {
      const r = await fn();
      toast({ title: ok, variant: "success" });
      return r;
    } catch (e) {
      toast({ title: "No se pudo completar", description: quoteErrorMessage(e), variant: "error" });
      return null;
    }
  }

  async function ensureLink(): Promise<string | null> {
    if (!q) return null;
    try {
      const r = await m.share.mutateAsync(q.id);
      return publicQuoteUrl(window.location.origin, r.token);
    } catch (e) {
      toast({ title: "No se pudo generar el link", description: quoteErrorMessage(e), variant: "error" });
      return null;
    }
  }

  async function shareWhatsapp() {
    if (!q) return;
    // La pestaña se abre antes del await para que el navegador no la bloquee.
    const w = window.open("about:blank", "_blank");
    const url = await ensureLink();
    const href = whatsappUrl(q.customer_phone, quoteShareText(q, businessName, url));
    if (w) w.location.href = href;
    else window.location.href = href;
  }

  async function copyLink() {
    const url = await ensureLink();
    if (!url) return;
    try {
      await navigator.clipboard.writeText(url);
      toast({ title: "Link copiado", description: "El cliente lo abre, lo ve y lo acepta o rechaza.", variant: "success" });
    } catch {
      toast({ title: "Link del presupuesto", description: url, variant: "info" });
    }
  }

  async function downloadPdf() {
    if (!printRef.current) return;
    setPdfBusy(true);
    try {
      // Mismo nodo que la vista previa: hoja A4 o rollo, según lo elegido.
      await downloadInvoicePdf(printRef.current, `presupuesto-${label}.pdf`);
    } catch {
      toast({ title: "No se pudo generar el PDF", variant: "error" });
    } finally {
      setPdfBusy(false);
    }
  }

  function print() {
    if (!printTicketIsolated(printRef.current)) toast({ title: "No se pudo imprimir", variant: "error" });
  }

  const docFormat = fmt === "a4" ? "a4" : ticketWidth;
  const formatLabel = fmt === "a4" ? "Hoja A4" : `Ticket ${ticketWidth} mm`;

  const offscreen =
    q && mounted
      ? createPortal(
          <div ref={printRef} aria-hidden className="pointer-events-none fixed -left-[9999px] top-0">
            <div className="ticket-print">
              <QuoteDocument quote={q} items={q.items} brand={brand} style={style} images={images} format={docFormat} printable />
            </div>
          </div>,
          document.body,
        )
      : null;

  const mainAction =
    q && eff && quoteConvertible(eff) ? (
      <button
        type="button"
        onClick={() => router.push(`/pos?quote=${q.id}` as Route)}
        className={cn(POS_CTA, "flex h-12 w-full items-center justify-center gap-2 rounded-lg text-base font-semibold")}
      >
        <ShoppingCart size={18} aria-hidden /> Convertir en venta
      </button>
    ) : (
      <Button variant="secondary" size="lg" className="w-full" onClick={() => onOpenChange(false)}>
        Cerrar
      </Button>
    );

  return (
    <>
      {open && offscreen}
      <PosSheet
        open={open && !editOpen}
        onOpenChange={onOpenChange}
        title={q ? `Presupuesto ${label}` : "Presupuesto"}
        description={q ? `Total ${formatCurrency(q.total)}` : undefined}
        size="xl"
        focusContainer
        className="md:h-[min(92dvh,860px)] md:max-w-5xl"
      >
        <div className="slim-scrollbar flex min-h-0 flex-1 flex-col overflow-y-auto md:grid md:grid-cols-[minmax(0,1fr)_minmax(340px,380px)] md:overflow-hidden">
          {/* Vista previa */}
          <section
            aria-label="Vista previa del presupuesto"
            className="flex flex-col bg-fg-4 px-4 pb-5 pt-3 md:slim-scrollbar md:min-h-0 md:overflow-y-auto md:px-8 md:pb-8 md:pt-6"
          >
            <div className="mb-4 flex items-center justify-between gap-3">
              <p className={POS_EYEBROW}>Vista previa</p>
              <Segmented<Fmt>
                size="sm"
                value={fmt}
                onChange={setFmt}
                aria-label="Formato del presupuesto"
                options={[
                  { value: "a4", label: "Hoja A4" },
                  { value: "ticket", label: `Ticket ${ticketWidth} mm` },
                ]}
              />
            </div>
            {q ? (
              <div className="overflow-hidden rounded-lg border border-border bg-white p-2">
                {fmt === "a4" ? (
                  <InvoiceFit>
                    <QuoteDocument quote={q} items={q.items} brand={brand} style={style} images={images} format="a4" />
                  </InvoiceFit>
                ) : (
                  <div className="mx-auto max-w-[340px]">
                    <QuoteDocument quote={q} items={q.items} brand={brand} style={style} images={images} format={ticketWidth} />
                  </div>
                )}
              </div>
            ) : (
              <Skeleton className="mx-auto aspect-[210/297] w-full max-w-xl rounded-lg" />
            )}
          </section>

          {/* Resumen y acciones */}
          <aside className="order-first flex flex-col border-border md:order-none md:min-h-0 md:border-l">
            <div className="flex-1 px-4 pb-4 pt-4 md:slim-scrollbar md:min-h-0 md:overflow-y-auto md:px-5 md:pt-6">
              {isLoading || !q || !eff ? (
                <div className="space-y-2 pr-10" aria-busy>
                  <Skeleton className="h-3 w-32" />
                  <Skeleton className="h-9 w-44" />
                  <Skeleton className="h-3 w-52" />
                </div>
              ) : (
                <>
                  <div className="pr-10 md:pr-8">
                    <p className={POS_EYEBROW}>Presupuesto N° {label}</p>
                    <p className="mt-1 font-price text-[2rem] font-semibold leading-none tabular-nums text-foreground">
                      {formatCurrency(q.total)}
                    </p>
                    <div className="mt-3 flex flex-wrap items-center gap-1.5">
                      <Badge tone={QUOTE_STATUS_TONE[eff]}>{QUOTE_STATUS_LABEL[eff]}</Badge>
                      {!q.valid_until && <Badge tone="neutral">Sin vencimiento</Badge>}
                      {q.version > 1 && <Badge tone="neutral">Revisión {q.version}</Badge>}
                    </div>
                  </div>

                  <dl className="mt-4 divide-y divide-border rounded-lg border border-border bg-card text-sm">
                    {[
                      ["Cliente", q.customer_name || "Consumidor final"],
                      ["Emitido", `${fmtDate(q.issue_date)}${q.created_by_name ? ` por ${q.created_by_name}` : ""}`],
                      ["Validez", quoteValidityText(q.valid_until)],
                      ...(q.updated_by_name && (q.updated_by_name !== q.created_by_name || q.version > 1)
                        ? [["Último cambio", `${fmtDate(q.updated_at)} por ${q.updated_by_name}`]]
                        : []),
                    ].map(([k, v]) => (
                      <div key={k} className="flex items-baseline justify-between gap-3 px-3 py-2">
                        <dt className="shrink-0 text-xs text-muted-foreground">{k}</dt>
                        <dd className="min-w-0 truncate text-right font-medium">{v}</dd>
                      </div>
                    ))}
                  </dl>

                  <div className="mt-3 space-y-2">
                    {eff === "expired" && q.valid_until && (
                      <Callout tone="warning" title={`Venció el ${fmtDate(q.valid_until)}`}>
                        Editalo para extender la validez antes de enviarlo o aceptarlo.
                      </Callout>
                    )}
                    {q.status === "accepted" && (
                      <Callout tone="success" title={`Aceptado${q.accepted_by_name ? ` por ${q.accepted_by_name}` : ""}`}>
                        El {fmtDate(q.accepted_at)}
                        {q.accepted_via === "link" ? " desde el link" : ""}. Ya lo podés convertir en venta.
                      </Callout>
                    )}
                    {q.status === "rejected" && (
                      <Callout tone="danger" title={`Rechazado el ${fmtDate(q.rejected_at)}`}>
                        {q.rejection_reason ? `${q.rejection_reason}. ` : ""}Podés editarlo para mandar una revisión.
                      </Callout>
                    )}
                    {q.status === "converted" && (
                      <Callout tone="neutral" title="Convertido en venta">
                        El {fmtDate(q.converted_at)}.
                      </Callout>
                    )}
                  </div>

                  {/* Enviar al cliente */}
                  <div className="mt-5 space-y-2">
                    <p className={POS_EYEBROW}>Enviar al cliente</p>
                    <button
                      type="button"
                      onClick={() => setEmailOpen(true)}
                      disabled={closed}
                      className={cn(POS_QUIET, "flex min-h-12 w-full items-center gap-3 rounded-lg px-3.5 py-2.5 text-left")}
                    >
                      <Mail size={18} aria-hidden className="shrink-0" />
                      <span className="min-w-0 flex-1">
                        <span className="block text-sm font-semibold">{lastSent ? "Reenviar por email" : "Enviar por email"}</span>
                        <span className="block truncate text-xs text-muted-foreground">
                          {recipients.length
                            ? recipients.join(", ")
                            : "Con el PDF adjunto y el link para aceptarlo"}
                        </span>
                      </span>
                    </button>
                    <div className="grid grid-cols-2 gap-2">
                      <Button variant="secondary" className="h-11 w-full" onClick={shareWhatsapp} disabled={closed}>
                        <MessageCircle size={16} aria-hidden /> WhatsApp
                      </Button>
                      <Button variant="secondary" className="h-11 w-full" onClick={copyLink} disabled={closed}>
                        <Link2 size={16} aria-hidden /> Copiar link
                      </Button>
                    </div>
                    {lastSent && (
                      <p className="text-xs text-muted-foreground">
                        Último envío: {fmtDateTime(lastSent.sent_at ?? lastSent.created_at)} a {lastSent.recipient}
                      </p>
                    )}
                  </div>

                  {/* Documento */}
                  <div className="mt-5 space-y-2">
                    <p className={POS_EYEBROW}>Documento</p>
                    <div className="grid grid-cols-2 gap-2">
                      <Button variant="secondary" className="h-11 w-full" onClick={downloadPdf} disabled={pdfBusy}>
                        <FileDown size={16} aria-hidden /> PDF
                      </Button>
                      <Button variant="secondary" className="h-11 w-full" onClick={print}>
                        <Printer size={16} aria-hidden /> Imprimir
                      </Button>
                    </div>
                  </div>

                  {/* Estado */}
                  {q.status !== "rejected" && eff !== "converted" && (
                    <div className="mt-5 space-y-2">
                      <p className={POS_EYEBROW}>Respuesta del cliente</p>
                      <div className="grid grid-cols-2 gap-2">
                        {q.status === "draft" && (
                          <Button variant="secondary" className="h-11 w-full" onClick={() => run(() => m.setStatus.mutateAsync({ id: q.id, status: "sent" }), "Marcado como enviado")}>
                            <Send size={16} aria-hidden /> Marcar enviado
                          </Button>
                        )}
                        {(eff === "draft" || eff === "sent") && (
                          <Button variant="secondary" className="h-11 w-full" onClick={() => run(() => m.setStatus.mutateAsync({ id: q.id, status: "accepted" }), "Presupuesto aceptado")}>
                            <CheckCircle2 size={16} aria-hidden /> Aceptado
                          </Button>
                        )}
                        <Button variant="secondary" className="h-11 w-full" onClick={() => setRejectOpen(true)}>
                          <XCircle size={16} aria-hidden /> Rechazado
                        </Button>
                      </div>
                    </div>
                  )}

                  {/* Más acciones */}
                  <div className="mt-5 grid grid-cols-2 gap-2">
                    {quoteEditable(q.status) && (
                      <Button variant="secondary" className="h-11 w-full" onClick={() => setEditOpen(true)}>
                        <Pencil size={16} aria-hidden /> Editar
                      </Button>
                    )}
                    <Button
                      variant="secondary"
                      className="h-11 w-full"
                      onClick={async () => {
                        const r = await run(() => m.duplicate.mutateAsync(q.id), "Presupuesto duplicado");
                        if (r) onOpenQuote?.(r.id);
                      }}
                    >
                      <Copy size={16} aria-hidden /> Duplicar
                    </Button>
                    {eff !== "converted" && canManage && (
                      <Button variant="ghost" className="h-11 w-full text-danger hover:bg-danger/10" onClick={() => setDeleteOpen(true)}>
                        <Trash2 size={16} aria-hidden /> Eliminar
                      </Button>
                    )}
                  </div>

                  {/* Historial */}
                  <div className="mt-5">
                    <button
                      type="button"
                      onClick={() => setHistoryOpen((o) => !o)}
                      className="flex w-full items-center justify-between rounded-lg px-1 py-1.5 text-left"
                      aria-expanded={historyOpen}
                    >
                      <span className={cn(POS_EYEBROW, "flex items-center gap-1.5")}>
                        <History size={13} aria-hidden /> Historial
                        {batches.length + Math.max(0, q.version - 1) > 0 ? ` (${batches.length + Math.max(0, q.version - 1)})` : ""}
                      </span>
                      <ChevronDown size={16} aria-hidden className={cn("text-muted-foreground transition-transform", historyOpen && "rotate-180")} />
                    </button>
                    {historyOpen && (
                      <div className="mt-2 space-y-3">
                        {batches.length === 0 && q.version <= 1 && (
                          <p className="rounded-lg bg-fg-4 px-3 py-3 text-xs text-muted-foreground">Todavía no se envió por email ni tiene revisiones.</p>
                        )}
                        {batches.length > 0 && (
                          <ul className="divide-y divide-border rounded-lg border border-border bg-card text-sm">
                            {batches.map((b) => (
                              <li key={b[0]!.batch_id} className="px-3 py-2.5">
                                <p className="flex items-center justify-between gap-2 text-xs text-muted-foreground">
                                  <span>
                                    Email · {fmtDateTime(b[0]!.created_at)}
                                    {b[0]!.sent_by_name ? ` · ${b[0]!.sent_by_name}` : ""}
                                  </span>
                                  {b[0]!.quote_version > 1 && <span>rev. {b[0]!.quote_version}</span>}
                                </p>
                                <ul className="mt-1.5 space-y-1">
                                  {b.map((e) => (
                                    <li key={e.id} className="flex items-center justify-between gap-2">
                                      <span className="min-w-0 truncate" title={e.error_message ?? undefined}>
                                        {e.recipient}
                                      </span>
                                      <Badge tone={EMAIL_STATUS[e.status].tone}>{EMAIL_STATUS[e.status].label}</Badge>
                                    </li>
                                  ))}
                                </ul>
                              </li>
                            ))}
                          </ul>
                        )}
                        {q.version > 1 && (
                          <ul className="divide-y divide-border rounded-lg border border-border bg-card text-sm">
                            {revisions.map((r) => (
                              <li key={r.id} className="flex flex-wrap items-center justify-between gap-2 px-3 py-2">
                                <span>
                                  Revisión {r.version} · {fmtDate(r.created_at)}
                                  {r.reason ? <span className="text-muted-foreground"> · {r.reason}</span> : null}
                                </span>
                                <span className="font-price tabular-nums text-muted-foreground">
                                  {formatCurrency(Number(r.snapshot?.quote?.total ?? 0))}
                                </span>
                              </li>
                            ))}
                          </ul>
                        )}
                      </div>
                    )}
                  </div>
                </>
              )}
            </div>
            <div className="hidden shrink-0 border-t border-border px-5 py-4 md:block">{mainAction}</div>
          </aside>
        </div>
        {/* Celular: la acción principal queda siempre a mano. */}
        <div className="shrink-0 border-t border-border bg-popover px-4 pb-3 pt-3 md:hidden">{mainAction}</div>
      </PosSheet>

      {q && <QuoteFormModal open={editOpen} onOpenChange={setEditOpen} quote={q} />}

      {q && (
        <QuoteEmailDialog
          open={emailOpen}
          onOpenChange={setEmailOpen}
          quote={q}
          brand={brand}
          accent={style.accent}
          logoUrl={style.logoIsDefault ? null : style.logoUrl}
          formatLabel={formatLabel}
          getPdfNode={() => printRef.current}
        />
      )}

      <ConfirmDialog
        open={rejectOpen}
        onOpenChange={setRejectOpen}
        title="Marcar como rechazado"
        description="Queda en el historial. Después lo podés editar para mandar una revisión."
        confirmLabel="Rechazado"
        withReason
        reasonLabel="Motivo"
        reasonPlaceholder="Precio, plazo, eligió otro proveedor"
        loading={m.setStatus.isPending}
        onConfirm={async (reason) => {
          if (!q) return;
          const r = await run(() => m.setStatus.mutateAsync({ id: q.id, status: "rejected", reason }), "Marcado como rechazado");
          if (r) setRejectOpen(false);
        }}
      />

      <ConfirmDialog
        open={deleteOpen}
        onOpenChange={setDeleteOpen}
        title="Eliminar presupuesto"
        description="Deja de verse en la lista y el link deja de funcionar. Queda registrado en la auditoría."
        confirmLabel="Eliminar"
        danger
        loading={m.remove.isPending}
        onConfirm={async () => {
          if (!q) return;
          const r = await run(() => m.remove.mutateAsync(q.id), "Presupuesto eliminado");
          if (r) {
            setDeleteOpen(false);
            onOpenChange(false);
          }
        }}
      />
    </>
  );
}
