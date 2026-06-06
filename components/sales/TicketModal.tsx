"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { FileDown, Printer } from "lucide-react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Modal } from "@/components/ui/Modal";
import { Button } from "@/components/ui/Button";
import { useToast } from "@/components/ui/Toast";
import { createClient } from "@/lib/supabase/client";
import { useSaleDetail, useSaleNumberFormat } from "@/modules/sales/hooks";
import { SendReceiptEmail, sendReceiptEmail } from "@/components/sales/SendReceiptEmail";
import { useDefaultTemplate, useTicketBranding } from "@/modules/tickets/hooks";
import { formatSaleNumber } from "@/lib/utils/saleNumber";
import { downloadTicketPdf } from "@/lib/utils/ticketPdf";
import { downloadA4FromNode } from "@/lib/tickets/exportPng";
import { defaultSaleBlocks, type BlocksContent } from "@/lib/tickets/blocks";
import { TicketRenderer, type TicketData } from "@/components/tickets/TicketRenderer";

interface Props {
  open: boolean;
  onOpenChange: (o: boolean) => void;
  saleId: string | null;
  autoPrint?: boolean;
}

export function TicketModal({ open, onOpenChange, saleId, autoPrint }: Props) {
  const { data, isLoading } = useSaleDetail(saleId, open);
  const { data: brand } = useTicketBranding(open);
  const { data: tpl } = useDefaultTemplate("sale", open);
  const { data: numFmt } = useSaleNumberFormat();
  const { toast } = useToast();
  const qc = useQueryClient();
  const ticketRef = useRef<HTMLDivElement>(null);
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
      data.sale.status !== "completed"
    ) {
      return;
    }
    emailedRef.current = true;
    const saleId = data.sale.id;
    const t = setTimeout(() => {
      const node = ticketRef.current;
      if (!node) return;
      sendReceiptEmail(saleId, to, node)
        .then(() => {
          qc.invalidateQueries({ queryKey: ["sales", "detail", saleId] });
          qc.invalidateQueries({ queryKey: ["sales", "list"] });
        })
        .catch((e) => console.warn("auto-email comprobante falló:", e));
    }, 500);
    return () => clearTimeout(t);
  }, [open, data, autoEmailEnabled, qc]);

  // Bloques: gana la plantilla default; si no hay, replica el ticket clásico
  // respetando los flags viejos del branding.
  const blocks = useMemo(() => {
    const fromTpl =
      tpl?.mode === "blocks" ? (tpl.content as unknown as BlocksContent | null)?.blocks : null;
    if (fromTpl?.length) return fromTpl;
    return defaultSaleBlocks().filter((b) => {
      if (b.type === "qr") return brand?.ticket_show_qr === true;
      if (b.type === "logo") return brand?.ticket_show_logo !== false;
      return true;
    });
  }, [tpl, brand]);

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
    (tpl?.paper as "58" | "80" | "a4" | undefined) ??
    (brand?.ticket_width === "58" ? "58" : "80");

  async function handleA4() {
    if (!data) return;
    setDownloading(true);
    try {
      if (tpl && ticketRef.current) {
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
            <TicketRenderer
              blocks={blocks}
              data={ticketData}
              paper={paper}
              showNinjaLogo={Boolean(tpl?.show_ninjasoft_logo)}
              className="ticket-print"
            />
          </div>

          <div className="no-print mt-4 space-y-3">
            <SendReceiptEmail
              saleId={data.sale.id}
              getTicketNode={() => ticketRef.current}
              defaultEmail={data.sale.customers?.email ?? null}
              customerId={data.sale.customer_id}
              sentTo={data.sale.receipt_email_to}
              sentAt={data.sale.receipt_emailed_at}
            />
            <div className="flex flex-wrap justify-end gap-2">
              <Button variant="secondary" onClick={() => onOpenChange(false)}>
                Cerrar
              </Button>
              <Button variant="secondary" onClick={handleA4} disabled={downloading}>
                <FileDown size={16} /> A4 (PDF)
              </Button>
              <Button onClick={() => window.print()}>
                <Printer size={16} /> Imprimir
              </Button>
            </div>
          </div>
        </>
      )}
    </Modal>
  );
}
