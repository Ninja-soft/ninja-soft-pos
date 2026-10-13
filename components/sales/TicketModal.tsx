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
  usePrintProfiles,
  usePrintTarget,
  useTenantSmtpStatus,
  useTicketBranding,
} from "@/modules/tickets/hooks";
import { emailTemplateDiffers } from "@/modules/tickets/api";
import { webPrintCopies } from "@/lib/print/webPrint";
import { formatSaleNumber } from "@/lib/utils/saleNumber";
import { downloadTicketPdf } from "@/lib/utils/ticketPdf";
import { downloadA4FromNode } from "@/lib/tickets/exportPng";
import { defaultSaleBlocks } from "@/lib/tickets/blocks";
import { type TicketData } from "@/components/tickets/TicketRenderer";
import { TemplateRenderer } from "@/components/tickets/TemplateRenderer";
import { useBranches } from "@/modules/branches/hooks";
import { ticketLocation } from "@/lib/tickets/location";
import { printTargetLabel } from "@/lib/print/printers";
import { SpinnerBlock } from "@/components/ui/Spinner";
import { Segmented } from "@/components/ui/Segmented";
import { cn } from "@/lib/utils/cn";
import { SalePayments } from "@/components/sales/SalePayments";

export type DetailTab = "ticket" | "cobros";
const TABS: { value: DetailTab; label: string }[] = [
  { value: "ticket", label: "Ticket" },
  { value: "cobros", label: "Cobros" },
];

interface Props {
  open: boolean;
  onOpenChange: (o: boolean) => void;
  saleId: string | null;
  autoPrint?: boolean;
  /** Pestaña con la que abre (los avisos de contracargo abren en Cobros, ADR-064). */
  initialTab?: DetailTab;
}

export function TicketModal({ open, onOpenChange, saleId, autoPrint, initialTab }: Props) {
  const { data, isLoading } = useSaleDetail(saleId, open);
  // Marca efectiva de la sucursal de la venta (logo y datos propios, ADR-049).
  const { data: brand } = useTicketBranding(
    open,
    (data?.sale as { store_id?: string | null } | undefined)?.store_id ?? null,
  );
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
  // Perfil de impresión del tipo "ticket de venta" (H22): formato, copias y
  // auto/manual configurados por el negocio en Configuración → Impresión.
  // F17 · ADR-049: perfil efectivo de la caja e impresora registrada (o la
  // del equipo) donde sale el ticket.
  const { data: printProfiles } = usePrintProfiles(open);
  const printTarget = usePrintTarget("sale", open);
  const saleProfile = printTarget?.profile ?? printProfiles?.sale;
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
  // Detalle de la venta (ADR-061): el ticket queda montado aunque se vea la
  // pestaña Cobros (imprimir y el email lo usan). Cada apertura arranca en Ticket
  // (o en la pestaña pedida).
  const [tab, setTab] = useState<DetailTab>(initialTab ?? "ticket");
  useEffect(() => {
    if (open) setTab(initialTab ?? "ticket");
  }, [open, saleId, initialTab]);

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

  // Auto-imprimir al abrir, una sola vez por apertura. Se dispara si lo pide el
  // perfil del negocio (Impresión → ticket de venta en automático) o la
  // preferencia por dispositivo "Imprimir al cobrar". Respeta la cantidad de
  // copias del perfil (web print: N llamadas a window.print()).
  const autoPrintEnabled = Boolean(autoPrint) || Boolean(saleProfile?.auto);
  const saleCopies = saleProfile?.copies ?? 1;
  useEffect(() => {
    if (!open) {
      printedRef.current = false;
      return;
    }
    if (autoPrintEnabled && data && !printedRef.current) {
      printedRef.current = true;
      const t = setTimeout(() => webPrintCopies(saleCopies), 300);
      return () => clearTimeout(t);
    }
  }, [open, autoPrintEnabled, saleCopies, data]);

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
        location,
      }
    : null;

  // Formato del ticket. La plantilla de impresión activa manda (H9b); si no hay,
  // usa el formato del perfil "ticket de venta" (H22) y, como último recurso, el
  // ancho del branding.
  const paper =
    (printTpl?.paper as "58" | "80" | "a4" | undefined) ??
    saleProfile?.paper ??
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
        await downloadTicketPdf({
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
    <Modal
      open={open}
      onOpenChange={onOpenChange}
      title={tab === "cobros" ? "Cobros de la venta" : "Ticket"}
      className={tab === "cobros" ? "max-w-2xl" : "max-w-sm"}
    >
      {isLoading || !data || !ticketData ? (
        <SpinnerBlock className="py-6" />
      ) : (
        <>
          <Segmented
            value={tab}
            options={TABS}
            onChange={setTab}
            aria-label="Vista del detalle"
            size="sm"
            fill
            className="no-print mb-3"
          />
          {/* En Cobros el ticket sale de pantalla pero sigue montado: imprimir
              (visibility) y el PNG del email lo necesitan. */}
          <div
            ref={ticketRef}
            aria-hidden={tab === "cobros" || undefined}
            className={cn(tab === "cobros" && "pointer-events-none fixed -left-[9999px] top-0")}
          >
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

          {/* Cobros (ADR-061): procesador, tarjeta, cupón, ids, conciliación y
              datos del procesador. Reemplaza el bloque de voucher (H27). */}
          {tab === "cobros" && (
            <div className="no-print">
              <SalePayments
                saleId={data.sale.id}
                saleCreatedAt={data.sale.created_at}
                initialPayments={data.payments}
                active={open && tab === "cobros"}
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
                  onClick={() => webPrintCopies(saleCopies)}
                  className="h-10 w-10 p-0"
                  title={`${saleCopies > 1 ? `Imprimir (${saleCopies} copias)` : "Imprimir"}${printTarget ? ` · ${printTargetLabel(printTarget)}` : ""}`}
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
