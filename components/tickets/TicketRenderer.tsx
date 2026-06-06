"use client";

// H9b — Render puro de una plantilla de bloques. Lo usan: editor (preview),
// TicketModal (térmica), A4/PDF y el email (export a PNG). Sin fetches.
import { formatCurrency, formatQty } from "@/lib/utils/format";
import { PAYMENT_METHOD_LABELS as METHOD_LABELS } from "@/lib/utils/paymentMethods";
import { code39Segments } from "@/lib/barcode/code39";
import type { Align, TextSize, TicketBlock } from "@/lib/tickets/blocks";
import type { SampleTicketData } from "@/lib/tickets/sample";

export type TicketData = SampleTicketData;

const alignCls = (a?: Align) =>
  a === "left" ? "text-left" : a === "right" ? "text-right" : "text-center";
const sizeCls = (s?: TextSize) =>
  s === "sm" ? "text-[10px]" : s === "lg" ? "text-base" : "text-xs";

function Barcode({ value }: { value: string }) {
  let segs;
  try {
    segs = code39Segments(value, 3);
  } catch {
    return null;
  }
  const total = segs.reduce((a, s) => a + s.width, 0);
  let x = 0;
  return (
    <svg viewBox={`0 0 ${total} 40`} className="mx-auto h-10 w-full max-w-[60mm]" preserveAspectRatio="none">
      {segs.map((s, i) => {
        const r = s.on ? <rect key={i} x={x} y={0} width={s.width} height={40} fill="black" /> : null;
        x += s.width;
        return r;
      })}
    </svg>
  );
}

interface Props {
  blocks: TicketBlock[];
  data: TicketData;
  paper: "58" | "80" | "a4";
  showNinjaLogo: boolean;
  className?: string;
}

export function TicketRenderer({ blocks, data, paper, showNinjaLogo, className }: Props) {
  const { sale, items, payments, customer, brand } = data;
  const width = paper === "58" ? "58mm" : paper === "80" ? "80mm" : "210mm";

  const renderBlock = (b: TicketBlock) => {
    if (b.hidden) return null;
    switch (b.type) {
      case "logo":
        return brand?.logo_url ? (
          // eslint-disable-next-line @next/next/no-img-element
          <img key={b.id} src={brand.logo_url} alt="" className="mx-auto mb-1 h-12 w-auto object-contain" />
        ) : null;
      case "business":
        return (
          <div key={b.id} className="text-center">
            {b.showLegalName !== false && (
              <div className="font-display text-base font-bold">{brand?.legal_name || "NinjaSoft POS"}</div>
            )}
            <div className="text-[10px] leading-tight text-muted-foreground">
              {b.showCuit !== false && brand?.cuit && <div>CUIT {brand.cuit}</div>}
              {b.showAddress !== false && brand?.address && <div>{brand.address}</div>}
              {b.showPhone !== false && brand?.phone && <div>{brand.phone}</div>}
            </div>
          </div>
        );
      case "title":
        return (
          <div key={b.id} className={`${alignCls(b.align)} ${sizeCls(b.size)} ${b.bold ? "font-bold" : ""} text-muted-foreground`}>
            {b.text || brand?.ticket_title || "Comprobante no fiscal"}
          </div>
        );
      case "saleInfo":
        return (
          <div key={b.id} className="flex justify-between text-xs text-muted-foreground">
            {b.showNumber !== false && <span>Comprobante {sale.numberLabel}</span>}
            {b.showDate !== false && <span>{new Date(sale.created_at).toLocaleString("es-AR")}</span>}
          </div>
        );
      case "customer":
        return customer?.name ? (
          <div key={b.id} className="text-xs text-muted-foreground">Cliente: {customer.name}</div>
        ) : null;
      case "items":
        return (
          <ul key={b.id} className="space-y-1">
            {items.map((it) => (
              <li key={it.id} className="flex justify-between gap-2">
                <span className="truncate">
                  {formatQty(it.quantity)}× {it.product_name}
                  {b.showUnitPrice && ` (${formatCurrency(it.unit_price)})`}
                </span>
                <span>{formatCurrency(it.subtotal)}</span>
              </li>
            ))}
          </ul>
        );
      case "totals":
        return (
          <div key={b.id}>
            <div className="flex justify-between text-xs">
              <span>Subtotal</span>
              <span>{formatCurrency(sale.subtotal)}</span>
            </div>
            {sale.discount_total > 0 && (
              <div className="flex justify-between text-xs">
                <span>Descuento</span>
                <span>-{formatCurrency(sale.discount_total)}</span>
              </div>
            )}
            <div className="mt-1 flex justify-between text-base font-bold">
              <span>TOTAL</span>
              <span>{formatCurrency(sale.total)}</span>
            </div>
          </div>
        );
      case "payments":
        return (
          <div key={b.id}>
            {payments.map((p) => (
              <div key={p.id} className="flex justify-between text-xs">
                <span>{METHOD_LABELS[p.method] ?? p.method}</span>
                <span>{formatCurrency(p.amount)}</span>
              </div>
            ))}
          </div>
        );
      case "qr":
        return (
          <div key={b.id} className="flex justify-center">
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img
              src={`https://api.qrserver.com/v1/create-qr-code/?size=140x140&data=${encodeURIComponent(
                `${brand?.legal_name || "NinjaPos"} | ${sale.numberLabel} | ${formatCurrency(sale.total)} | ${new Date(sale.created_at).toLocaleString("es-AR")}`,
              )}`}
              alt="QR del comprobante"
              width={110}
              height={110}
              className="h-[110px] w-[110px]"
            />
          </div>
        );
      case "barcode":
        return <div key={b.id}><Barcode value={String(sale.number)} /></div>;
      case "text":
        return (
          <div key={b.id} className={`${alignCls(b.align)} ${sizeCls(b.size)} ${b.bold ? "font-bold" : ""} whitespace-pre-wrap`}>
            {b.text}
          </div>
        );
      case "image":
        return b.url ? (
          <div key={b.id} className={alignCls(b.align)}>
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img src={b.url} alt="" style={{ width: `${b.widthPct ?? 100}%` }} className="inline-block" />
          </div>
        ) : null;
      case "separator":
        return <div key={b.id} className="my-3 border-t border-dashed border-border" />;
      case "footer":
        return (
          <div key={b.id} className="text-center">
            <div className="text-xs text-muted-foreground">{b.text || brand?.ticket_footer || "¡Gracias por su compra!"}</div>
            {brand?.ticket_legend && (
              <div className="mt-1 text-[10px] leading-tight text-muted-foreground">{brand.ticket_legend}</div>
            )}
          </div>
        );
      default:
        return null;
    }
  };

  return (
    <div
      className={`mx-auto space-y-2 rounded-lg border border-border bg-background p-4 font-mono text-sm text-foreground ${className ?? ""}`}
      style={{ width, maxWidth: "100%" }}
    >
      {blocks.map(renderBlock)}
      {data.sale.status === "voided" && (
        <div className="mt-3 text-center text-xs font-bold text-red-500">** ANULADA **</div>
      )}
      {showNinjaLogo && (
        <div className="mt-3 flex justify-center opacity-70">
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img src="/brand/ninjasoft-wordmark.webp" alt="NinjaSoft" className="h-4 w-auto" />
        </div>
      )}
    </div>
  );
}
