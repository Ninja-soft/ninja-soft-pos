"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useToast } from "@/components/ui/Toast";
import { createClient } from "@/lib/supabase/client";
import { useSaleDetail, useSaleNumberFormat } from "@/modules/sales/hooks";
import { ExchangeTicketModal } from "@/components/sales/ExchangeTicketModal";
import { brandDisplayName } from "@/lib/branding/businessName";
import {
  SendReceiptEmail,
  SendReceiptEmailButton,
  sendReceiptEmail,
} from "@/components/sales/SendReceiptEmail";
import { usePrintProfiles, usePrintTarget, useTenantSmtpStatus, useTicketBranding } from "@/modules/tickets/hooks";
import { printTicketIsolated } from "@/lib/print/webPrint";
import { formatSaleNumber } from "@/lib/utils/saleNumber";
import { downloadInvoicePdf, invoicePdfFile } from "@/lib/invoices/exportPdf";
import type { SampleTicketData as TicketData } from "@/lib/tickets/sample";
import { useBranches } from "@/modules/branches/hooks";
import { ticketLocation } from "@/lib/tickets/location";
import { printTargetLabel } from "@/lib/print/printers";
import { SalePayments } from "@/components/sales/SalePayments";
import { useSaleTaxLines } from "@/modules/tax/hooks";
import { saleTaxTicket } from "@/lib/tax/ticket";
import { useArcaStatus, useSaleFiscalDocuments } from "@/modules/arca/hooks";
import { arcaApi } from "@/modules/arca/api";
import { ticketFiscal } from "@/lib/arca/ticket";
import { arcaErrorMessage } from "@/lib/arca/labels";
import { humanError } from "@/supabase/functions/_shared/arca/errors";
import { FiscalStatus } from "@/components/arca/FiscalStatus";
import { useSalePromotions } from "@/modules/promotions/hooks";
import type { SalePromotion } from "@/modules/promotions/api";
import { useMyTenant } from "@/modules/tenants/hooks";
import {
  AUTHORIZING_SLOW_MS,
  postSalePhase,
  previewVisible,
  silentStep,
} from "@/lib/tickets/postSale";
import { TicketSheet, type DetailTab, type PrintFormat } from "@/components/sales/ticket/TicketSheet";
import { useInvoiceStyle } from "@/modules/invoices/hooks";
import { useProductPhotos, withPhotos } from "@/modules/invoices/photos";
import { InvoiceDocument } from "@/components/invoices/InvoiceDocument";
import { InvoicePreview, ticketStyle } from "@/components/invoices/InvoicePreview";
import { docOptions, invoiceFromTicket } from "@/lib/invoices/fromTicket";
import { serviceOfItem, serviceOfSale } from "@/lib/invoices/serviceFields";
import { warrantyOfItem } from "@/lib/warranty/ticket";

export type { DetailTab };

interface Props {
  open: boolean;
  onOpenChange: (o: boolean) => void;
  saleId: string | null;
  /** Preferencia del equipo "Imprimir ticket al cobrar". */
  autoPrint?: boolean;
  /** Pestaña con la que abre (los avisos de contracargo abren en Cobros, ADR-064). */
  initialTab?: DetailTab;
  /**
   * Recién cobrada con "Imprimir ticket al cobrar" (ADR-111): imprime sola
   * (con CAE si es fiscal) y no abre la ventana; la abre sólo si ARCA falla,
   * tarda demasiado o la impresión falla.
   */
  silent?: boolean;
  /** Desde el POS: botón "Nueva venta" (Enter) que cierra y vuelve a vender. */
  onNewSale?: () => void;
  /**
   * Acción directa (ficha del cliente, ADR-169): "print" reimprime al quedar
   * listo (sin el envío automático por email); "email" abre el envío.
   */
  startWith?: "print" | "email";
}

export function TicketModal({ open, onOpenChange, saleId, autoPrint, initialTab, silent, onNewSale, startWith }: Props) {
  const { data } = useSaleDetail(saleId, open);
  // H159: ticket de cambio sin precios.
  const [exchangeOpen, setExchangeOpen] = useState(false);
  // ADR-068: percepciones como líneas aparte y transparencia fiscal (B).
  const taxLines = useSaleTaxLines(open ? saleId : null);
  // F3 · ADR-072: factura electrónica de la venta (CAE + QR en el ticket).
  // Mientras se espera el CAE se refresca seguido (ADR-111).
  const fiscalDocs = useSaleFiscalDocuments(open ? saleId : null, { fastPoll: true });
  const saleFiscalDoc = (fiscalDocs.data ?? []).find((d) => d.origin === "sale") ?? null;
  // ADR-074: promociones aplicadas, una línea por promo en el ticket.
  const salePromos = useSalePromotions(open ? saleId : null);
  // Marca efectiva de la sucursal de la venta (logo y datos propios, ADR-049).
  const { data: brand } = useTicketBranding(
    open,
    (data?.sale as { store_id?: string | null } | undefined)?.store_id ?? null,
  );
  // ADR-112: modelo de comprobante, color, logo y sello del negocio, y la
  // marca con los datos fiscales del emisor (IIBB, inicio de actividades).
  const invoice = useInvoiceStyle(brand ?? null, open);
  // ADR-119: fotos de producto precargadas (sólo si el negocio las muestra).
  const photos = useProductPhotos(
    (data?.items ?? []).map((it) => it.product_id),
    open && (invoice.style.showPhotos || invoice.style.ticketPhotos),
  );
  const { data: numFmt } = useSaleNumberFormat();
  // Estado del SMTP del negocio. allowed:true && !configured = el dueño aún no
  // lo configuró → gateamos el botón. Para cajeros la RPC responde
  // allowed:false (estado desconocido) y NO gateamos: el server rechaza con
  // error amable si falta el SMTP. Ver useTenantSmtpStatus.
  const { data: smtp } = useTenantSmtpStatus(open);
  const smtpMissing = Boolean(smtp?.allowed && !smtp.configured);
  // Perfil de impresión del tipo "ticket de venta" (H22): formato, copias y
  // auto/manual configurados por el negocio en Configuración → Impresión.
  // F17 · ADR-049: perfil efectivo de la caja e impresora registrada (o la
  // del equipo) donde sale el ticket.
  const printProfilesQ = usePrintProfiles(open);
  const printProfiles = printProfilesQ.data;
  const printTarget = usePrintTarget("sale", open);
  const saleProfile = printTarget?.profile ?? printProfiles?.sale;
  const { data: me } = useMyTenant();
  const canFix = me?.role === "owner" || me?.role === "manager";
  const arcaStatus = useArcaStatus(open);
  const { toast } = useToast();
  const qc = useQueryClient();
  const [emailOpen, setEmailOpen] = useState(false);
  // Nodo que se imprime y exporta a PDF (en el formato elegido) y el del email
  // (en el formato del email del negocio): fuera de la hoja (portal al body)
  // para que la impresión no la recorte el scroll del diálogo.
  const printRef = useRef<HTMLDivElement>(null);
  const emailRef = useRef<HTMLDivElement>(null);
  // ADR-119: formato de impresión elegido en la ventana (null = el del perfil).
  const [formatChoice, setFormatChoice] = useState<PrintFormat | null>(null);
  const autoDoneRef = useRef(false);
  const [downloading, setDownloading] = useState(false);
  const [sharing, setSharing] = useState(false);
  const [retrying, setRetrying] = useState(false);
  // Detalle de la venta (ADR-061). Cada apertura arranca en Ticket (o en la
  // pestaña pedida).
  const [tab, setTab] = useState<DetailTab>(initialTab ?? "ticket");
  // ADR-111: comprobante provisorio (sin CAE) pedido a mano, ventana visible
  // en modo silencioso, falla de impresión y detalle fiscal desplegado.
  const [provisional, setProvisional] = useState(false);
  const [printProvisional, setPrintProvisional] = useState(false);
  const [shown, setShown] = useState(!silent);
  const shownRef = useRef(!silent);
  shownRef.current = shown;
  const [printFailed, setPrintFailed] = useState(false);
  const [fiscalOpen, setFiscalOpen] = useState(false);
  const [openedAt, setOpenedAt] = useState(() => Date.now());
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!open) return;
    setTab(initialTab ?? "ticket");
    setProvisional(false);
    setPrintProvisional(false);
    setShown(!silent);
    setPrintFailed(false);
    setFiscalOpen(false);
    setFormatChoice(null);
    const t0 = Date.now();
    setOpenedAt(t0);
    setNow(t0);
    // Re-evalúa "ARCA está tardando" al cumplirse el plazo.
    const t = setTimeout(() => setNow(Date.now()), AUTHORIZING_SLOW_MS + 50);
    return () => clearTimeout(t);
  }, [open, saleId, initialTab, silent]);

  const phase = postSalePhase({
    saleLoaded: Boolean(data),
    docsSettled: !open || !saleId || fiscalDocs.isSuccess || fiscalDocs.isError,
    doc: saleFiscalDoc,
    elapsedMs: now - openedAt,
  });
  const visible = previewVisible(phase, provisional);

  // Sucursal y caja de la venta (F17 · H90): sólo con 2+ sucursales.
  const { data: branches } = useBranches();
  const saleStoreId = (data?.sale as { store_id?: string | null } | undefined)?.store_id ?? null;
  const saleShiftId = (data?.sale as { cash_shift_id?: string | null } | undefined)?.cash_shift_id ?? null;
  const multiBranch = (branches ?? []).filter((b) => !b.deleted_at).length > 1;
  const { data: saleRegisterId } = useQuery({
    queryKey: ["sales", "shift-register", saleShiftId],
    enabled: open && multiBranch && Boolean(saleShiftId),
    staleTime: Infinity,
    queryFn: async () => {
      const { data: shiftRow } = await createClient()
        .from("cash_shifts")
        .select("cash_register_id")
        .eq("id", saleShiftId!)
        .maybeSingle();
      return (shiftRow?.cash_register_id as string | undefined) ?? null;
    },
  });
  const location = useMemo(
    () => ticketLocation(branches ?? [], saleStoreId, saleRegisterId ?? null),
    [branches, saleStoreId, saleRegisterId],
  );

  // Preferencia del POS: enviar comprobante por email automáticamente.
  const autoEmailQ = useQuery({
    queryKey: ["pos-settings", "auto-email-receipt"],
    enabled: open,
    queryFn: async (): Promise<boolean> => {
      const supabase = createClient();
      const { data } = await supabase
        .from("pos_settings")
        .select("auto_email_receipt")
        .maybeSingle();
      return Boolean(data?.auto_email_receipt);
    },
  });
  const autoEmailEnabled = autoEmailQ.data;

  // Auto-imprimir: lo pide el perfil del negocio (Impresión → ticket de venta
  // en automático) o la preferencia del equipo "Imprimir ticket al cobrar".
  // Respeta la cantidad de copias del perfil (web print: N window.print()).
  const reprint = startWith === "print";
  const autoPrintEnabled = reprint || Boolean(autoPrint) || Boolean(silent) || Boolean(saleProfile?.auto);
  const saleCopies = saleProfile?.copies ?? 1;

  const printNow = useCallback((): boolean => {
    const ok = printTicketIsolated(printRef.current, saleCopies);
    setPrintFailed(!ok);
    return ok;
  }, [saleCopies]);

  // Modo silencioso: si ARCA falla o tarda, o la impresión falló, se abre.
  const step = silent && !shown ? silentStep(phase, { printFailed }) : null;
  useEffect(() => {
    if (open && step === "show") setShown(true);
  }, [open, step]);

  // Auto-imprimir y auto-email, una sola vez por apertura y recién con el
  // comprobante listo: si la venta es fiscal, con el CAE (ADR-111). Nunca
  // bloquean ni molestan el flujo de venta: el email falla en silencio.
  const prefsReady = printProfilesQ.isFetched && !autoEmailQ.isPending;
  const ready = open && phase.kind === "ready" && Boolean(data) && prefsReady;
  useEffect(() => {
    if (!open) {
      autoDoneRef.current = false;
      return;
    }
    if (!ready || !data || autoDoneRef.current) return;
    const to = data.sale.customers?.email;
    const shouldEmail = Boolean(
      !reprint &&
        autoEmailEnabled &&
        !data.sale.receipt_emailed_at &&
        to &&
        data.sale.status === "completed" &&
        // El dueño aún no configuró el SMTP: evitamos una llamada que fallaría.
        !smtpMissing,
    );
    if (!autoPrintEnabled && !shouldEmail) {
      autoDoneRef.current = true;
      return;
    }
    autoDoneRef.current = true;
    let cancelled = false;
    let fired = false;
    const sid = data.sale.id;
    const t = setTimeout(async () => {
      fired = true;
      const printOk = autoPrintEnabled ? printNow() : true;
      if (shouldEmail && to) {
        // Nodo de email: el formato del email del negocio (ticket o A4).
        const node = emailRef.current;
        if (node) {
          await sendReceiptEmail(sid, to, node)
            .then(() => {
              qc.invalidateQueries({ queryKey: ["sales", "detail", sid] });
              qc.invalidateQueries({ queryKey: ["sales", "list"] });
            })
            .catch((e) => console.warn("auto-email comprobante falló:", e));
        }
      }
      if (cancelled) return;
      if (silent && !shownRef.current) {
        if (printOk) onOpenChange(false);
        else toast({ title: "No se pudo imprimir el ticket", variant: "error" });
      }
    }, 300);
    return () => {
      cancelled = true;
      clearTimeout(t);
      // Si se cortó antes de correr, que la próxima pasada lo intente.
      if (!fired) autoDoneRef.current = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, ready]);

  // Desde la ficha del cliente: "Reenviar" abre el envío por email directo.
  useEffect(() => {
    if (open && startWith === "email") setEmailOpen(true);
  }, [open, startWith]);

  // "Imprimir provisorio": se imprime apenas el comprobante está montado.
  useEffect(() => {
    if (!printProvisional || !visible) return;
    const t = setTimeout(() => {
      printNow();
      setPrintProvisional(false);
    }, 150);
    return () => clearTimeout(t);
  }, [printProvisional, visible, printNow]);

  const fiscal = ticketFiscal(saleFiscalDoc);
  const ticketData: TicketData | null = data
    ? {
        sale: {
          number: data.sale.number,
          numberLabel: formatSaleNumber(data.sale.number, numFmt),
          created_at: data.sale.created_at,
          subtotal: data.sale.subtotal,
          discount_total: data.sale.discount_total,
          total: data.sale.total,
          status: data.sale.status,
          ...saleTaxTicket(data.sale, taxLines.data ?? []),
          fiscal,
          promotions: salePromotionsForTicket(data.sale, salePromos.data ?? []),
          // ADR-116: período del servicio y vencimiento del pago.
          ...serviceOfSale(data.sale),
        },
        items: withPhotos(
          data.items.map((it) => ({
            id: it.id,
            product_id: it.product_id,
            product_name: it.product_name,
            quantity: it.quantity,
            unit_price: it.unit_price,
            subtotal: it.subtotal,
            ...serviceOfItem(it),
            ...warrantyOfItem(it),
          })),
          photos.data,
        ),
        payments: data.payments.map((p) => ({ id: p.id, method: p.method, amount: p.amount })),
        customer: data.sale.customers
          ? {
              name: data.sale.customers.name,
              email: data.sale.customers.email,
              document_type: data.sale.customers.document_type ?? null,
              document_number: data.sale.customers.document_number ?? null,
              iva_condition: data.sale.customers.iva_condition ?? null,
              address: data.sale.customers.address ?? null,
            }
          : null,
        brand: invoice.brand ?? brand ?? null,
        location,
      }
    : null;

  // ADR-119: todo comprobante sale del motor nuevo. Formato de impresión:
  // Ticket o A4, preseleccionado con el del perfil "ticket de venta" (H22) y
  // elegible en la ventana; el ancho del rollo, el del perfil o el del
  // branding. La impresión automática usa el predeterminado.
  // Formato al abrir: el elegido en Comprobantes; "auto" = según la impresora.
  const posFormat = invoice.style.posFormat;
  const defaultFormat: PrintFormat =
    posFormat === "ticket" || posFormat === "a4" ? posFormat : saleProfile?.paper === "a4" ? "a4" : "ticket";
  const printFormat: PrintFormat = formatChoice ?? defaultFormat;
  const rollPaper: "80" | "58" =
    saleProfile?.paper === "58" || saleProfile?.paper === "80"
      ? saleProfile.paper
      : brand?.ticket_width === "58"
        ? "58"
        : "80";
  const invoiceDoc = ticketData ? invoiceFromTicket(ticketData, docOptions(invoice.style)) : null;
  const rollStyle = ticketStyle(invoice.style, brand?.ticket_show_logo);
  const emailFormat: PrintFormat = invoice.style.emailFormat === "a4" ? "a4" : "ticket";
  const getEmailNode = (): HTMLElement | null => emailRef.current;
  const renderDoc = (fmt: PrintFormat, printable = false) =>
    invoiceDoc ? (
      fmt === "a4" ? (
        <InvoiceDocument doc={invoiceDoc} style={invoice.style} format="a4" printable={printable} />
      ) : (
        <InvoiceDocument doc={invoiceDoc} style={rollStyle} format={rollPaper} />
      )
    ) : null;

  async function handleA4() {
    if (!data || !printRef.current) return;
    setDownloading(true);
    try {
      await downloadInvoicePdf(printRef.current, `comprobante-${data.sale.number}.pdf`);
    } catch {
      toast({ title: "No se pudo generar el PDF", variant: "error" });
    } finally {
      setDownloading(false);
    }
  }

  // Compartir (Web Share con el PDF): en el celular abre WhatsApp, mail, etc.
  const [canShare, setCanShare] = useState(false);
  useEffect(() => {
    try {
      const probe = new File(["x"], "comprobante.pdf", { type: "application/pdf" });
      setCanShare(typeof navigator !== "undefined" && Boolean(navigator.canShare?.({ files: [probe] })));
    } catch {
      setCanShare(false);
    }
  }, []);
  async function handleShare() {
    const node = printRef.current;
    if (!node || !data) return;
    setSharing(true);
    try {
      const label = formatSaleNumber(data.sale.number, numFmt);
      const file = await invoicePdfFile(node, `comprobante-${label}.pdf`);
      await navigator.share({ files: [file], title: `Comprobante ${label}` });
    } catch (e) {
      if ((e as { name?: string })?.name !== "AbortError") {
        toast({ title: "No se pudo compartir el comprobante", variant: "error" });
      }
    } finally {
      setSharing(false);
    }
  }

  async function handleRetry() {
    if (!data) return;
    setRetrying(true);
    try {
      await arcaApi.emitirVenta(data.sale.id);
    } catch (e) {
      toast({ title: "No se pudo reintentar", description: arcaErrorMessage(e), variant: "error" });
    } finally {
      setRetrying(false);
      void qc.invalidateQueries({ queryKey: ["arca", "sale", data.sale.id] });
    }
  }

  const docs = fiscalDocs.data ?? [];
  const showFiscalDetail =
    docs.length > 0 || Boolean(arcaStatus.data?.enabled && canFix && data?.sale.status === "completed");
  const errorText =
    phase.kind === "retrying" || phase.kind === "failed" ? humanError(phase.errorCode, phase.errorMsg) : null;
  const nextAttemptLabel =
    phase.kind === "retrying" && phase.nextAttemptAt
      ? new Date(phase.nextAttemptAt).toLocaleTimeString("es-AR", { hour: "2-digit", minute: "2-digit" })
      : null;
  const printHint = [
    printFormat === "a4" ? "Hoja A4" : `Ticket ${rollPaper} mm`,
    saleCopies > 1 ? `${saleCopies} copias` : null,
    printTarget ? printTargetLabel(printTarget) : null,
  ]
    .filter(Boolean)
    .join(" · ");

  const preview = invoiceDoc ? (
    <InvoicePreview
      doc={invoiceDoc}
      style={printFormat === "a4" ? invoice.style : rollStyle}
      format={printFormat === "a4" ? "a4" : rollPaper}
    />
  ) : null;

  const portalTarget = typeof document !== "undefined" ? document.body : null;
  const offscreen =
    open && invoiceDoc && visible && portalTarget
      ? createPortal(
          <>
            <div ref={printRef} aria-hidden className="pointer-events-none fixed -left-[9999px] top-0">
              <div className="ticket-print">{renderDoc(printFormat, true)}</div>
            </div>
            {/* Nodo del email (formato del email del negocio). SIN clase
                `ticket-print`: no debe verse al imprimir. */}
            <div ref={emailRef} aria-hidden className="pointer-events-none fixed -left-[9999px] top-0">
              {renderDoc(emailFormat)}
            </div>
          </>,
          portalTarget,
        )
      : null;

  const close = (o: boolean) => {
    if (!o) setEmailOpen(false);
    onOpenChange(o);
  };

  return (
    <>
      {offscreen}
      {data && (
        <ExchangeTicketModal
          open={exchangeOpen}
          onOpenChange={setExchangeOpen}
          businessName={brandDisplayName(brand ?? null)}
          saleLabel={formatSaleNumber(data.sale.number, numFmt)}
          saleDate={data.sale.created_at}
          items={data.items}
        />
      )}
      <TicketSheet
        open={open && shown}
        onOpenChange={close}
        phase={phase}
        provisional={provisional}
        onShowProvisional={() => setProvisional(true)}
        onPrintProvisional={() => {
          setProvisional(true);
          setPrintProvisional(true);
        }}
        tab={tab}
        onTab={setTab}
        preview={preview}
        format={printFormat}
        onFormat={setFormatChoice}
        payments={
          data ? (
            <SalePayments
              saleId={data.sale.id}
              saleCreatedAt={data.sale.created_at}
              initialPayments={data.payments}
              active={open && tab === "cobros"}
            />
          ) : null
        }
        summary={
          data
            ? {
                numberLabel: formatSaleNumber(data.sale.number, numFmt),
                total: Number(data.sale.total) || 0,
                createdAt: data.sale.created_at,
                customerName: data.sale.customers?.name ?? null,
                customerId: (data.sale as { customer_id?: string | null }).customer_id ?? null,
                itemsCount: data.items.length,
                fiscalLabel:
                  phase.kind === "ready" && fiscal?.numero ? `${fiscal.cbteLabel} N° ${fiscal.numero}` : null,
                homologacion: Boolean(fiscal?.homologacion),
                statusLabel: data.sale.status === "voided" ? "Anulada" : null,
              }
            : null
        }
        onNewSale={
          onNewSale
            ? () => {
                close(false);
                onNewSale();
              }
            : undefined
        }
        onPrint={() => {
          if (!printNow()) toast({ title: "No se pudo imprimir el ticket", variant: "error" });
        }}
        printHint={printHint}
        printFailed={printFailed}
        onPdf={handleA4}
        pdfBusy={downloading}
        onShare={canShare ? handleShare : undefined}
        onExchangeTicket={data && data.sale.status !== "voided" ? () => setExchangeOpen(true) : undefined}
        shareBusy={sharing}
        emailButton={
          <SendReceiptEmailButton
            open={emailOpen}
            onToggle={() => setEmailOpen((v) => !v)}
            sentAt={data?.sale.receipt_emailed_at}
            smtpMissing={smtpMissing}
            busy={!visible}
            short
          />
        }
        emailPanel={
          data ? (
            <SendReceiptEmail
              saleId={data.sale.id}
              getTicketNode={getEmailNode}
              defaultEmail={data.sale.customers?.email ?? null}
              customerId={data.sale.customer_id}
              sentTo={data.sale.receipt_email_to}
              sentAt={data.sale.receipt_emailed_at}
              smtpMissing={smtpMissing}
              open={emailOpen && visible}
              onOpenChange={setEmailOpen}
            />
          ) : null
        }
        saleHref={data ? `/ventas?venta=${data.sale.id}` : "/ventas"}
        fiscalDetail={
          data && showFiscalDetail ? (
            <FiscalStatus
              saleId={data.sale.id}
              docs={docs}
              saleStatus={data.sale.status}
              nonFiscal={Boolean((data.sale as { non_fiscal?: boolean }).non_fiscal)}
            />
          ) : null
        }
        fiscalDetailOpen={fiscalOpen}
        onFiscalDetail={setFiscalOpen}
        onRetry={phase.kind === "retrying" ? handleRetry : undefined}
        retryBusy={retrying}
        errorText={errorText}
        nextAttemptLabel={nextAttemptLabel}
        canFix={canFix}
      />
    </>
  );
}

// Promos del ticket: las de sale_promotions o, en ventas anteriores a
// ADR-074, la única promo guardada en la venta.
function salePromotionsForTicket(sale: unknown, rows: SalePromotion[]) {
  if (rows.length > 0) return rows.map((r) => ({ label: r.label, kind: r.kind, amount: r.discount }));
  const s = sale as { promo_name?: string | null; promo_discount?: number | string | null };
  const amount = Number(s.promo_discount) || 0;
  return amount > 0 ? [{ label: s.promo_name || "Promoción", kind: "discount" as const, amount }] : [];
}
