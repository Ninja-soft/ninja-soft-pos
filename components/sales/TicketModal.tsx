"use client";

import { useEffect, useRef } from "react";
import { FileDown, Printer } from "lucide-react";
import { useQuery } from "@tanstack/react-query";
import { Modal } from "@/components/ui/Modal";
import { Button } from "@/components/ui/Button";
import { createClient } from "@/lib/supabase/client";
import { useSaleDetail, useSaleNumberFormat } from "@/modules/sales/hooks";
import { formatCurrency, formatQty } from "@/lib/utils/format";
import { formatSaleNumber } from "@/lib/utils/saleNumber";
import { downloadTicketPdf } from "@/lib/utils/ticketPdf";
import { PAYMENT_METHOD_LABELS as METHOD_LABELS } from "@/lib/utils/paymentMethods";

type Branding = {
  logo_url: string | null;
  legal_name: string | null;
  cuit: string | null;
  phone: string | null;
  address: string | null;
  ticket_footer: string | null;
  ticket_width: string | null;
  ticket_title: string | null;
  ticket_legend: string | null;
  ticket_show_qr: boolean | null;
  ticket_show_logo: boolean | null;
};

function useBranding(enabled: boolean) {
  const supabase = createClient();
  return useQuery({
    queryKey: ["ticket-branding"],
    enabled,
    queryFn: async (): Promise<Branding | null> => {
      const { data } = await supabase
        .from("tenant_branding")
        .select(
          "logo_url, legal_name, cuit, phone, address, ticket_footer, ticket_width, ticket_title, ticket_legend, ticket_show_qr, ticket_show_logo",
        )
        .maybeSingle();
      return (data as Branding | null) ?? null;
    },
  });
}

interface Props {
  open: boolean;
  onOpenChange: (o: boolean) => void;
  saleId: string | null;
  autoPrint?: boolean;
}

export function TicketModal({ open, onOpenChange, saleId, autoPrint }: Props) {
  const { data, isLoading } = useSaleDetail(saleId, open);
  const { data: brand } = useBranding(open);
  const { data: numFmt } = useSaleNumberFormat();
  const printedRef = useRef(false);

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

  return (
    <Modal open={open} onOpenChange={onOpenChange} title="Ticket" className="max-w-sm">
      {isLoading || !data ? (
        <p className="py-6 text-center text-sm text-muted-foreground">Cargando…</p>
      ) : (
        <>
          <div
            className="ticket-print mx-auto rounded-lg border border-border bg-background p-4 font-mono text-sm text-foreground"
            style={{ width: brand?.ticket_width === "58" ? "58mm" : "80mm" }}
          >
            <div className="text-center">
              {brand?.logo_url && brand?.ticket_show_logo !== false && (
                // eslint-disable-next-line @next/next/no-img-element
                <img
                  src={brand.logo_url}
                  alt=""
                  className="mx-auto mb-1 h-12 w-auto object-contain"
                />
              )}
              <div className="font-display text-base font-bold">
                {brand?.legal_name || "NinjaSoft POS"}
              </div>
              {(brand?.cuit || brand?.phone || brand?.address) && (
                <div className="text-[10px] leading-tight text-muted-foreground">
                  {brand?.cuit && <div>CUIT {brand.cuit}</div>}
                  {brand?.address && <div>{brand.address}</div>}
                  {brand?.phone && <div>{brand.phone}</div>}
                </div>
              )}
              <div className="text-xs text-muted-foreground">
                {brand?.ticket_title || "Comprobante no fiscal"}
              </div>
            </div>
            <div className="my-3 border-t border-dashed border-border" />
            <div className="flex justify-between text-xs text-muted-foreground">
              <span>Comprobante {formatSaleNumber(data.sale.number, numFmt)}</span>
              <span>{new Date(data.sale.created_at).toLocaleString("es-AR")}</span>
            </div>
            <div className="my-3 border-t border-dashed border-border" />
            <ul className="space-y-1">
              {data.items.map((it) => (
                <li key={it.id} className="flex justify-between gap-2">
                  <span className="truncate">
                    {formatQty(it.quantity)}× {it.product_name}
                  </span>
                  <span>{formatCurrency(it.subtotal)}</span>
                </li>
              ))}
            </ul>
            <div className="my-3 border-t border-dashed border-border" />
            <div className="flex justify-between text-xs">
              <span>Subtotal</span>
              <span>{formatCurrency(data.sale.subtotal)}</span>
            </div>
            {data.sale.discount_total > 0 && (
              <div className="flex justify-between text-xs">
                <span>Descuento</span>
                <span>-{formatCurrency(data.sale.discount_total)}</span>
              </div>
            )}
            <div className="mt-1 flex justify-between text-base font-bold">
              <span>TOTAL</span>
              <span>{formatCurrency(data.sale.total)}</span>
            </div>
            <div className="my-3 border-t border-dashed border-border" />
            {data.payments.map((p) => (
              <div key={p.id} className="flex justify-between text-xs">
                <span>{METHOD_LABELS[p.method] ?? p.method}</span>
                <span>{formatCurrency(p.amount)}</span>
              </div>
            ))}
            {data.sale.status === "voided" && (
              <div className="mt-3 text-center text-xs font-bold text-red-500">
                ** ANULADA **
              </div>
            )}
            {brand?.ticket_show_qr && (
              <div className="mt-4 flex justify-center">
                {/* eslint-disable-next-line @next/next/no-img-element */}
                <img
                  src={`https://api.qrserver.com/v1/create-qr-code/?size=140x140&data=${encodeURIComponent(
                    `${brand?.legal_name || "NinjaPos"} | ${formatSaleNumber(
                      data.sale.number,
                      numFmt,
                    )} | ${formatCurrency(
                      data.sale.total,
                    )} | ${new Date(data.sale.created_at).toLocaleString("es-AR")}`,
                  )}`}
                  alt="QR del comprobante"
                  width={110}
                  height={110}
                  className="h-[110px] w-[110px]"
                />
              </div>
            )}
            <div className="mt-4 text-center text-xs text-muted-foreground">
              {brand?.ticket_footer || "¡Gracias por su compra!"}
            </div>
            {brand?.ticket_legend && (
              <div className="mt-1 text-center text-[10px] leading-tight text-muted-foreground">
                {brand.ticket_legend}
              </div>
            )}
          </div>

          <div className="no-print mt-4 flex flex-wrap justify-end gap-2">
            <Button variant="secondary" onClick={() => onOpenChange(false)}>
              Cerrar
            </Button>
            <Button
              variant="secondary"
              onClick={() =>
                downloadTicketPdf({
                  sale: data.sale,
                  items: data.items,
                  payments: data.payments,
                  brand: brand ?? null,
                  numberLabel: formatSaleNumber(data.sale.number, numFmt),
                })
              }
            >
              <FileDown size={16} /> A4 (PDF)
            </Button>
            <Button onClick={() => window.print()}>
              <Printer size={16} /> Imprimir
            </Button>
          </div>
        </>
      )}
    </Modal>
  );
}
