"use client";

// Detalle de un presupuesto (ADR-122): vista previa A4 o ticket con el motor
// de comprobantes, PDF, impresión, envío por WhatsApp, email o link público
// de aceptación, cambios de estado, revisiones, duplicar, editar y convertir
// en venta (abre el POS con el carrito cargado).
import { useRef, useState } from "react";
import { createPortal } from "react-dom";
import { useRouter } from "next/navigation";
import type { Route } from "next";
import {
  CheckCircle2,
  Copy,
  Download,
  FileText,
  History,
  Link2,
  Mail,
  MessageCircle,
  Pencil,
  Printer,
  ShoppingCart,
  Trash2,
  XCircle,
  Send,
} from "lucide-react";
import { Modal } from "@/components/ui/Modal";
import { Button } from "@/components/ui/Button";
import { Badge } from "@/components/ui/Badge";
import { Segmented } from "@/components/ui/Segmented";
import { SpinnerBlock } from "@/components/ui/Spinner";
import { ConfirmDialog } from "@/components/ui/ConfirmDialog";
import { useToast } from "@/components/ui/Toast";
import { InvoiceFit } from "@/components/invoices/InvoiceFit";
import { QuoteDocument } from "@/components/quotes/QuoteDocument";
import { QuoteFormModal } from "@/components/quotes/QuoteFormModal";
import { useQuote, useQuoteMutations, useQuoteRevisions } from "@/modules/quotes/hooks";
import { useQuoteBrand } from "@/modules/quotes/useQuoteBrand";
import { downloadInvoiceA4 } from "@/lib/tickets/exportPng";
import { printTicketIsolated } from "@/lib/print/webPrint";
import { fmtDate } from "@/lib/invoices/legal";
import {
  QUOTE_STATUS_LABEL,
  QUOTE_STATUS_TONE,
  effectiveQuoteStatus,
  mailtoUrl,
  publicQuoteUrl,
  quoteConvertible,
  quoteEditable,
  quoteErrorMessage,
  quoteNumberLabel,
  quoteShareText,
  whatsappUrl,
} from "@/lib/quotes/logic";
import { formatCurrency } from "@/lib/utils/format";

type Fmt = "a4" | "ticket";

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
  const [fmt, setFmt] = useState<Fmt>("a4");
  const [editOpen, setEditOpen] = useState(false);
  const [rejectOpen, setRejectOpen] = useState(false);
  const [deleteOpen, setDeleteOpen] = useState(false);
  const [historyOpen, setHistoryOpen] = useState(false);
  const { data: revisions = [] } = useQuoteRevisions(quoteId, historyOpen);
  const a4Ref = useRef<HTMLDivElement>(null);
  const printRef = useRef<HTMLDivElement>(null);

  const eff = q ? effectiveQuoteStatus(q.status, q.valid_until) : null;
  const label = q ? quoteNumberLabel(q.pto_vta, q.number) : "";
  const businessName = brand?.trade_name || brand?.legal_name || "nuestro negocio";

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

  async function shareEmail() {
    if (!q) return;
    const url = await ensureLink();
    window.location.href = mailtoUrl(q.customer_email, `Presupuesto N° ${label} de ${businessName}`, quoteShareText(q, businessName, url));
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
    if (!a4Ref.current) return;
    try {
      await downloadInvoiceA4(a4Ref.current, `presupuesto-${label}.pdf`);
    } catch {
      toast({ title: "No se pudo generar el PDF", variant: "error" });
    }
  }

  function print() {
    if (!printTicketIsolated(printRef.current)) toast({ title: "No se pudo imprimir", variant: "error" });
  }

  const doc =
    q && style ? (
      <QuoteDocument quote={q} items={q.items} brand={brand} style={style} format={fmt === "a4" ? "a4" : ticketWidth} />
    ) : null;

  const offscreen =
    q && typeof document !== "undefined"
      ? createPortal(
          <>
            <div ref={a4Ref} aria-hidden className="pointer-events-none fixed -left-[9999px] top-0">
              <QuoteDocument quote={q} items={q.items} brand={brand} style={style} format="a4" />
            </div>
            <div ref={printRef} aria-hidden className="pointer-events-none fixed -left-[9999px] top-0">
              <div className="ticket-print">
                <QuoteDocument quote={q} items={q.items} brand={brand} style={style} format={fmt === "a4" ? "a4" : ticketWidth} printable />
              </div>
            </div>
          </>,
          document.body,
        )
      : null;

  return (
    <>
      {open && offscreen}
      <Modal
        open={open && !editOpen}
        onOpenChange={onOpenChange}
        title={q ? `Presupuesto ${label}` : "Presupuesto"}
        className="sm:max-w-4xl"
        header={
          q ? (
            <div className="flex flex-wrap items-start justify-between gap-3">
              <div className="min-w-0">
                <p className="text-xs font-medium text-muted-foreground">Presupuesto</p>
                <p className="font-display text-lg font-bold tabular-nums">N° {label}</p>
                <p className="truncate text-sm text-muted-foreground">
                  {q.customer_name || "Consumidor final"} · válido hasta el {fmtDate(q.valid_until)}
                  {q.version > 1 ? ` · revisión ${q.version}` : ""}
                </p>
              </div>
              <div className="flex flex-col items-end gap-1">
                {eff && (
                  <Badge tone={QUOTE_STATUS_TONE[eff]} className="rounded-md">
                    {QUOTE_STATUS_LABEL[eff]}
                  </Badge>
                )}
                <span className="font-price text-xl font-bold tabular-nums">{formatCurrency(q.total)}</span>
              </div>
            </div>
          ) : undefined
        }
        footer={
          q && eff ? (
            <div className="flex w-full flex-wrap items-center justify-end gap-2">
              {eff !== "converted" && canManage && (
                <Button variant="ghost" className="mr-auto text-danger" onClick={() => setDeleteOpen(true)}>
                  <Trash2 size={15} /> Eliminar
                </Button>
              )}
              {quoteEditable(q.status) && (
                <Button variant="secondary" onClick={() => setEditOpen(true)}>
                  <Pencil size={15} /> Editar
                </Button>
              )}
              {quoteConvertible(eff) && (
                <Button onClick={() => router.push(`/pos?quote=${q.id}` as Route)}>
                  <ShoppingCart size={15} /> Convertir en venta
                </Button>
              )}
            </div>
          ) : undefined
        }
      >
        {isLoading || !q || !eff ? (
          <SpinnerBlock />
        ) : (
          <div className="space-y-5">
            {/* Acciones */}
            <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
              <Button variant="secondary" size="sm" onClick={downloadPdf}>
                <Download size={15} /> PDF
              </Button>
              <Button variant="secondary" size="sm" onClick={print}>
                <Printer size={15} /> Imprimir
              </Button>
              <Button variant="secondary" size="sm" onClick={shareWhatsapp} disabled={eff === "rejected" || eff === "converted"}>
                <MessageCircle size={15} /> WhatsApp
              </Button>
              <Button variant="secondary" size="sm" onClick={shareEmail} disabled={eff === "rejected" || eff === "converted"}>
                <Mail size={15} /> Email
              </Button>
              <Button variant="secondary" size="sm" onClick={copyLink} disabled={eff === "rejected" || eff === "converted"}>
                <Link2 size={15} /> Copiar link
              </Button>
              <Button
                variant="secondary"
                size="sm"
                onClick={async () => {
                  const r = await run(() => m.duplicate.mutateAsync(q.id), "Presupuesto duplicado");
                  if (r) onOpenQuote?.(r.id);
                }}
              >
                <Copy size={15} /> Duplicar
              </Button>
              {q.status === "draft" && (
                <Button variant="secondary" size="sm" onClick={() => run(() => m.setStatus.mutateAsync({ id: q.id, status: "sent" }), "Marcado como enviado")}>
                  <Send size={15} /> Marcar enviado
                </Button>
              )}
              {(eff === "draft" || eff === "sent") && (
                <Button variant="secondary" size="sm" onClick={() => run(() => m.setStatus.mutateAsync({ id: q.id, status: "accepted" }), "Presupuesto aceptado")}>
                  <CheckCircle2 size={15} /> Aceptado
                </Button>
              )}
              {(eff === "draft" || eff === "sent" || eff === "accepted" || eff === "expired") && q.status !== "rejected" && (
                <Button variant="secondary" size="sm" onClick={() => setRejectOpen(true)}>
                  <XCircle size={15} /> Rechazado
                </Button>
              )}
            </div>

            {eff === "expired" && (
              <p className="rounded-lg bg-warning/10 px-3 py-2 text-sm text-warning">
                Venció el {fmtDate(q.valid_until)}. Editalo para extender la validez antes de enviarlo o aceptarlo.
              </p>
            )}
            {q.status === "accepted" && (
              <p className="rounded-lg bg-success/10 px-3 py-2 text-sm text-success">
                Aceptado{q.accepted_by_name ? ` por ${q.accepted_by_name}` : ""} el {fmtDate(q.accepted_at)}
                {q.accepted_via === "link" ? " desde el link" : ""}. Ya lo podés convertir en venta.
              </p>
            )}
            {q.status === "rejected" && (
              <p className="rounded-lg bg-danger/10 px-3 py-2 text-sm text-danger">
                Rechazado el {fmtDate(q.rejected_at)}
                {q.rejection_reason ? `: ${q.rejection_reason}` : "."} Podés editarlo para mandar una revisión.
              </p>
            )}
            {q.status === "converted" && (
              <p className="rounded-lg bg-fg-4 px-3 py-2 text-sm text-muted-foreground">
                Convertido en venta el {fmtDate(q.converted_at)}.
              </p>
            )}

            {/* Vista previa */}
            <div className="flex items-center justify-between gap-2">
              <span className="flex items-center gap-2 text-sm font-semibold">
                <FileText size={16} className="text-muted-foreground" aria-hidden /> Vista previa
              </span>
              <Segmented<Fmt>
                size="sm"
                value={fmt}
                onChange={setFmt}
                options={[
                  { value: "a4", label: "Hoja A4" },
                  { value: "ticket", label: `Ticket ${ticketWidth} mm` },
                ]}
              />
            </div>
            <div className="overflow-hidden rounded-lg border border-border bg-white p-2">
              {fmt === "a4" ? <InvoiceFit>{doc}</InvoiceFit> : <div className="mx-auto max-w-[340px]">{doc}</div>}
            </div>

            {/* Revisiones */}
            {q.version > 1 && (
              <div>
                <button
                  type="button"
                  onClick={() => setHistoryOpen((o) => !o)}
                  className="flex items-center gap-2 text-sm font-semibold text-muted-foreground hover:text-foreground"
                  aria-expanded={historyOpen}
                >
                  <History size={15} /> Revisiones anteriores ({q.version - 1})
                </button>
                {historyOpen && (
                  <ul className="mt-2 divide-y divide-border rounded-lg border border-border text-sm">
                    {revisions.map((r) => (
                      <li key={r.id} className="flex flex-wrap items-center justify-between gap-2 px-3 py-2">
                        <span>
                          Revisión {r.version} · {fmtDate(r.created_at)}
                          {r.reason ? <span className="text-muted-foreground"> · {r.reason}</span> : null}
                        </span>
                        <span className="font-price tabular-nums text-muted-foreground">
                          {formatCurrency(Number(r.snapshot?.quote?.total ?? 0))} · {r.snapshot?.items?.length ?? 0} renglones
                        </span>
                      </li>
                    ))}
                  </ul>
                )}
              </div>
            )}
          </div>
        )}
      </Modal>

      {q && (
        <QuoteFormModal open={editOpen} onOpenChange={setEditOpen} quote={q} />
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
