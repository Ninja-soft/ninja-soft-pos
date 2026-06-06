"use client";

// H9b PR2 — Render del modo canvas: elementos con posición libre (XY).
// El elemento "items" es de flujo: divide el lienzo en zona superior fija,
// tabla de ítems de alto variable, y zona inferior desplazada. Spec H9b.
import { formatCurrency, formatQty } from "@/lib/utils/format";
import type { CanvasContent, CanvasElement } from "@/lib/tickets/blocks";
import type { TicketData } from "@/components/tickets/TicketRenderer";
import { Barcode, alignCls, sizeCls } from "@/components/tickets/TicketRenderer";

interface Props {
  content: CanvasContent["canvas"];
  data: TicketData;
  paper: "58" | "80" | "a4";
  showNinjaLogo: boolean;
  className?: string;
}

export function CanvasTicketRenderer({ content, data, paper, showNinjaLogo, className }: Props) {
  const { sale, items, brand } = data;
  const width = paper === "58" ? "58mm" : paper === "80" ? "80mm" : "210mm";

  const { elements, height } = content;
  const itemsEl = elements.find((e) => e.type === "items");
  const splitY = itemsEl?.y ?? null;

  // Render de un elemento posicionado absolutamente dentro de su zona.
  // `topPx` es la coordenada Y relativa a la zona donde vive el elemento.
  const renderEl = (el: CanvasElement, topPx: number) => {
    const boxStyle = { left: `${el.x}%`, top: `${topPx}px`, width: `${el.w}%` } as const;

    switch (el.type) {
      case "text":
        return (
          <div
            key={el.id}
            className={`absolute ${alignCls(el.align)} ${sizeCls(el.size)} ${el.bold ? "font-bold" : ""} whitespace-pre-wrap`}
            style={boxStyle}
          >
            {el.text}
          </div>
        );
      case "image":
        return el.url ? (
          <div key={el.id} className={`absolute ${alignCls(el.align)}`} style={boxStyle}>
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img src={el.url} alt="" className="w-full" />
          </div>
        ) : null;
      case "logo":
        return brand?.logo_url ? (
          <div key={el.id} className="absolute flex justify-center" style={boxStyle}>
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img src={brand.logo_url} alt="" className="h-12 w-auto object-contain" />
          </div>
        ) : null;
      case "qr":
        return (
          <div key={el.id} className="absolute flex justify-center" style={boxStyle}>
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
        return (
          <div key={el.id} className="absolute" style={boxStyle}>
            <Barcode value={String(sale.number)} />
          </div>
        );
      case "separator":
        return (
          <div
            key={el.id}
            className="absolute border-t border-dashed border-border"
            style={boxStyle}
          />
        );
      default:
        return null;
    }
  };

  // Tabla de ítems en flujo normal: lista + fila TOTAL en negrita.
  const itemsTable = (
    <div>
      <ul className="space-y-1">
        {items.map((it) => (
          <li key={it.id} className="flex justify-between gap-2">
            <span className="truncate">
              {formatQty(it.quantity)}× {it.product_name}
            </span>
            <span>{formatCurrency(it.subtotal)}</span>
          </li>
        ))}
      </ul>
      <div className="mt-1 flex justify-between text-base font-bold">
        <span>TOTAL</span>
        <span>{formatCurrency(sale.total)}</span>
      </div>
    </div>
  );

  // Sin elemento items: una sola zona absoluta del alto total del lienzo.
  const hasItems = splitY !== null;
  const topZoneH = hasItems ? splitY : height;
  const bottomZoneH = hasItems ? Math.max(0, height - splitY) : 0;

  const topEls = elements.filter((e) => e.type !== "items" && (!hasItems || e.y < splitY));
  const bottomEls = hasItems ? elements.filter((e) => e.type !== "items" && e.y >= splitY) : [];

  return (
    <div
      className={`mx-auto rounded-lg border border-border bg-background p-4 font-mono text-sm text-foreground ${className ?? ""}`}
      style={{ width, maxWidth: "100%" }}
    >
      {/* Zona superior: anclada (alto fijo = items.y, o todo el lienzo si no hay items). */}
      <div style={{ position: "relative", height: `${topZoneH}px`, overflow: "visible" }}>
        {topEls.map((el) => renderEl(el, el.y))}
      </div>

      {hasItems && (
        <>
          {/* Tabla de ítems: flujo normal, alto variable según N ítems. */}
          {itemsTable}
          {/* Zona inferior: empujada por la tabla; Y relativa a items.y. */}
          <div style={{ position: "relative", height: `${bottomZoneH}px`, overflow: "visible" }}>
            {bottomEls.map((el) => renderEl(el, el.y - splitY))}
          </div>
        </>
      )}

      {sale.status === "voided" && (
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
