"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { FileDown, Printer, X } from "lucide-react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Modal } from "@/components/ui/Modal";
import { Button } from "@/components/ui/Button";
import { useToast } from "@/components/ui/Toast";
import { createClient } from "@/lib/supabase/client";
import { useSaleDetail, useSaleNumberFormat } from "@/modules/sales/hooks";
import {
  SendReceiptEmail,
  SendReceiptEmailButton,
  sendReceiptEmail,
} from "@/components/sales/SendReceiptEmail";
import {
  useActiveTemplate,
  useTenantSmtpStatus,
  useTicketBranding,
} from "@/modules/tickets/hooks";
import { emailTemplateDiffers } from "@/modules/tickets/api";
import { formatSaleNumber } from "@/lib/utils/saleNumber";
import { downloadTicketPdf } from "@/lib/utils/ticketPdf";
import { downloadA4FromNode } from "@/lib/tickets/exportPng";
import { defaultSaleBlocks } from "@/lib/tickets/blocks";
import { type TicketData } from "@/components/tickets/TicketRenderer";
import { TemplateRenderer } from "@/components/tickets/TemplateRenderer";

interface Props {
  open: boolean;
  onOpenChange: (o: boolean) => void;
  saleId: string | null;
  autoPrint?: boolean;
}

export function TicketModal({ open, onOpenChange, saleId, autoPrint }: Props) {
  const { data, isLoading } = useSaleDetail(saleId, open);
  const { data: brand } = useTicketBranding(open);
  // Plantilla activa por DESTINO: impresión vs email pueden diferir.
  const { data: printTpl } = useActiveTemplate("print", open);
  const { data: emailTpl } = useActiveTemplate("email", open);
  const { data: numFmt } = useSaleNumberFormat();
  // Estado del SMTP del negocio. allowed:true && !configured = el dueño aún no
  // lo configuró → gateamos el botón. Para cajeros la RPC responde
  // allowed:false (estado desconocido) y NO gateamos: el server rechaza con
  // error amable si falta el SMTP. Ver useTenantSmtpStatus.
  const { data: smtp } = useTenantSmtpStatus(open);
  const smtpMissing = Boolean(smtp?.allowed && !smtp.configured);
  const { toast } = useToast();
  const qc = useQueryClient();
  const [emailOpen, setEmailOpen] = useState(false);
  const ticketRef = useRef<HTMLDivElement>(null);
  const emailRef = useRef<HTMLDivElement>(null);
  // Espejo de `emailDiffers` para leerlo dentro del setTimeout del auto-envío
  // sin re-disparar el efecto cuando las plantillas cargan tarde.
  const emailDiffersRef = useRef(false);
  const printedRef = useRef(false);
  const emailedRef = useRef(false);
  const [downloading, setDownloading] = useState(false);

  // Preferencia del POS: enviar comprobante por email automáticamente.
  const { data: autoEmailEnabled } = useQuery({
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

  // Auto-imprimir al abrir (preferencia del POS), una sola vez por apertura.
  useEffect(() => {
    if (!open) {
      printedRef.current = false;
      return;
    }
    if (autoPrint && data && !printedRef.current) {
      printedRef.current = true;
      const t = setTimeout(() => window.print(), 300);
      return () => clearTimeout(t);
    }
  }, [open, autoPrint, data]);

  // Auto-envío del comprobante por email (preferencia del POS), una sola vez
  // por apertura. Nunca debe bloquear ni molestar el flujo de venta: ante
  // cualquier fallo, solo console.warn.
  useEffect(() => {
    if (!open) {
      emailedRef.current = false;
      return;
    }
    const to = data?.sale.customers?.email;
    if (
      !data ||
      emailedRef.current ||
      !autoEmailEnabled ||
      data.sale.receipt_emailed_at ||
      !to ||
      data.sale.status !== "completed" ||
      // El dueño aún no configuró el SMTP: evitamos una llamada que fallaría.
      smtpMissing
    ) {
      return;
    }
    emailedRef.current = true;
    const saleId = data.sale.id;
    const t = setTimeout(() => {
      // Misma resolución de nodo que el botón manual: nodo de email oculto si
      // la plantilla de email difiere de la de impresión, si no el visible.
      const node = emailDiffersRef.current ? emailRef.current : ticketRef.current;
      if (!node) return;
      sendReceiptEmail(saleId, to, node)
        .then(() => {
          qc.invalidateQueries({ queryKey: ["sales", "detail", saleId] });
          qc.invalidateQueries({ queryKey: ["sales", "list"] });
        })
        .catch((e) => console.warn("auto-email comprobante falló:", e));
    }, 500);
    return () => clearTimeout(t);
  }, [open, data, autoEmailEnabled, smtpMissing, qc]);

  // Fallback de bloques (legacy-compat): si no hay plantilla, replica el ticket
  // clásico respetando los flags viejos del branding. El despacho por modo lo
  // resuelve TemplateRenderer.
  const fallbackBlocks = useMemo(() => {
    return defaultSaleBlocks().filter((b) => {
      if (b.type === "qr") return brand?.ticket_show_qr === true;
      if (b.type === "logo") return brand?.ticket_show_logo !== false;
      return true;
    });
  }, [brand]);

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
        },
        items: data.items.map((it) => ({
          id: it.id,
          product_name: it.product_name,
          quantity: it.quantity,
          unit_price: it.unit_price,
          subtotal: it.subtotal,
        })),
        payments: data.payments.map((p) => ({ id: p.id, method: p.method, amount: p.amount })),
        customer: data.sale.customers
          ? { name: data.sale.customers.name, email: data.sale.customers.email }
          : null,
        brand: brand ?? null,
      }
    : null;

  const paper =
    (printTpl?.paper as "58" | "80" | "a4" | undefined) ??
    (brand?.ticket_width === "58" ? "58" : "80");

  // El email usa la plantilla de email si difiere de la de impresión. Cuando
  // coincide (o no hay plantilla de email), reutiliza el ticket visible.
  const emailDiffers = emailTemplateDiffers(printTpl, emailTpl);
  emailDiffersRef.current = emailDiffers;
  const emailPaper = (emailTpl?.paper as "58" | "80" | "a4" | undefined) ?? paper;

  // Resolución única del nodo a exportar a PNG para email: nodo oculto si la
  // plantilla de email difiere, si no el ticket visible. Usado por el botón
  // manual y por el auto-envío.
  const getEmailNode = (): HTMLElement | null =>
    emailDiffers ? emailRef.current : ticketRef.current;

  async function handleA4() {
    if (!data) return;
    setDownloading(true);
    try {
      if (printTpl && ticketRef.current) {
        await downloadA4FromNode(ticketRef.current, data.sale.number);
      } else {
        downloadTicketPdf({
          sale: data.sale,
          items: data.items,
          payments: data.payments,
          brand: brand ?? null,
          numberLabel: formatSaleNumber(data.sale.number, numFmt),
        });
      }
    } catch {
      toast({ title: "No se pudo generar el PDF", variant: "error" });
    } finally {
      setDownloading(false);
    }
  }

  return (
    <Modal open={open} onOpenChange={onOpenChange} title="Ticket" className="max-w-sm">
      {isLoading || !data || !ticketData ? (
        <p className="py-6 text-center text-sm text-muted-foreground">Cargando…</p>
      ) : (
        <>
          <div ref={ticketRef}>
            <TemplateRenderer
              template={printTpl ?? null}
              fallbackBlocks={fallbackBlocks}
              data={ticketData}
              paperOverride={paper}
              className="ticket-print"
            />
          </div>

          {/* Nodo de email oculto cuando la plantilla de email difiere de la de
              impresión. SIN clase `ticket-print`: no debe verse al imprimir. */}
          {emailDiffers && (
            <div
              ref={emailRef}
              aria-hidden
              className="pointer-events-none fixed -left-[9999px] top-0"
            >
              <TemplateRenderer
                template={emailTpl ?? null}
                fallbackBlocks={fallbackBlocks}
                data={ticketData}
                paperOverride={emailPaper}
              />
            </div>
          )}

          <div className="no-print mt-4 space-y-3">
            {/* Estado de envío + hint SMTP + formulario inline (bloque propio). */}
            <SendReceiptEmail
              saleId={data.sale.id}
              getTicketNode={getEmailNode}
              defaultEmail={data.sale.customers?.email ?? null}
              customerId={data.sale.customer_id}
              sentTo={data.sale.receipt_email_to}
              sentAt={data.sale.receipt_emailed_at}
              smtpMissing={smtpMissing}
              open={emailOpen}
              onOpenChange={setEmailOpen}
            />

            {/* Fila compacta solo-ícono: Cerrar a la izquierda; acciones a la
                derecha (Mail / A4 / Imprimir). Tooltips via title + aria-label. */}
            <div className="flex items-center gap-2">
              <Button
                variant="ghost"
                onClick={() => onOpenChange(false)}
                className="h-10 w-10 p-0"
                title="Cerrar"
                aria-label="Cerrar"
              >
                <X size={18} />
              </Button>
              <div className="ml-auto flex items-center gap-2">
                <SendReceiptEmailButton
                  open={emailOpen}
                  onToggle={() => setEmailOpen((v) => !v)}
                  sentAt={data.sale.receipt_emailed_at}
                  smtpMissing={smtpMissing}
                  className="h-10 w-10 p-0"
                  iconOnly
                />
                <Button
                  variant="secondary"
                  onClick={handleA4}
                  disabled={downloading}
                  className="h-10 w-10 p-0"
                  title="Descargar A4"
                  aria-label="Descargar A4"
                >
                  <FileDown size={18} />
                </Button>
                <Button
                  onClick={() => window.print()}
                  className="h-10 w-10 p-0"
                  title="Imprimir"
                  aria-label="Imprimir"
                >
                  <Printer size={18} />
                </Button>
              </div>
            </div>
          </div>
        </>
      )}
    </Modal>
  );
}
