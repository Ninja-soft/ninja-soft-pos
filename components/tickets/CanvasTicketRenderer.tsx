"use client";

// H9b PR2/PR5 — Render del modo canvas: elementos con posición libre (XY en px).
// El elemento "items" es de flujo: divide el lienzo en zona superior fija,
// tabla de ítems de alto variable, y zona inferior desplazada. Spec H9b.
import { formatCurrency, formatQty } from "@/lib/utils/format";
import { CANVAS_WIDTH, styleProps, type CanvasContent, type CanvasElement } from "@/lib/tickets/blocks";
import { upgradeCanvas } from "@/lib/tickets/canvasCompat";
import type { TicketData } from "@/components/tickets/TicketRenderer";
import { Barcode, alignCls, sizeCls } from "@/components/tickets/TicketRenderer";

interface Props {
  content: CanvasContent["canvas"];
  data: TicketData;
  paper: "58" | "80" | "a4";
  showNinjaLogo: boolean;
  className?: string;
}

/**
 * Visual de un único elemento del canvas (sin posición: ocupa el 100% de su
 * caja contenedora). Lo comparten el renderer (caja absoluta) y el editor
 * (caja react-rnd), de modo que arrastrar/redimensionar muestre exactamente lo
 * que se imprime. Devuelve null cuando no hay nada para mostrar (img vacía).
 */
export function CanvasElementView({
  el,
  data,
}: {
  el: CanvasElement;
  data: TicketData;
}) {
  const { sale, brand } = data;
  switch (el.type) {
    case "text":
      return (
        <div
          className={`h-full w-full ${alignCls(el.align)} ${sizeCls(el.size)} ${el.bold ? "font-bold" : ""} whitespace-pre-wrap`}
          style={styleProps(el)}
        >
          {el.text}
        </div>
      );
    case "image":
      return el.url ? (
        <div className={`flex h-full w-full ${imgJustify(el.align)} items-center`}>
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img src={el.url} alt="" className="h-full w-full object-contain" />
        </div>
      ) : null;
    case "logo":
      return brand?.logo_url ? (
        <div className="flex h-full w-full items-center justify-center">
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img src={brand.logo_url} alt="" className="h-full w-full object-contain" />
        </div>
      ) : null;
    case "qr":
      return (
        <div className="flex h-full w-full items-center justify-center">
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img
            src={`https://api.qrserver.com/v1/create-qr-code/?size=140x140&data=${encodeURIComponent(
              `${brand?.legal_name || "NinjaPos"} | ${sale.numberLabel} | ${formatCurrency(sale.total)} | ${new Date(sale.created_at).toLocaleString("es-AR")}`,
            )}`}
            alt="QR del comprobante"
            className="h-full w-full object-contain"
          />
        </div>
      );
    case "barcode":
      return (
        <div className="flex h-full w-full items-center">
          <Barcode value={String(sale.number)} />
        </div>
      );
    case "separator": {
      const hex = el.color && /^#[0-9a-fA-F]{6}$/.test(el.color) ? el.color : undefined;
      return (
        <div className="flex h-full w-full items-center">
          <div
            className={`w-full border-t border-dashed ${hex ? "" : "border-border"}`}
            style={hex ? { borderTopColor: hex } : undefined}
          />
        </div>
      );
    }
    default:
      return null;
  }
}

function imgJustify(a?: CanvasElement["align"]) {
  return a === "left" ? "justify-start" : a === "right" ? "justify-end" : "justify-center";
}

/**
 * Tabla de ítems de flujo (alto variable). Compartida por renderer y editor.
 */
export function CanvasItemsTable({ data }: { data: TicketData }) {
  const { sale, items } = data;
  return (
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
}

export function CanvasTicketRenderer({ content, data, paper, showNinjaLogo, className }: Props) {
  const { sale } = data;
  const width = CANVAS_WIDTH[paper];

  const upgraded = upgradeCanvas(content, paper);
  const { elements, height } = upgraded;
  const itemsEl = elements.find((e) => e.type === "items");
  const splitY = itemsEl?.y ?? null;

  // Caja absoluta del elemento dentro de su zona. `topPx` es la Y relativa a la
  // zona donde vive el elemento.
  const renderEl = (el: CanvasElement, topPx: number) => {
    const view = <CanvasElementView el={el} data={data} />;
    if (!view) return null;
    return (
      <div
        key={el.id}
        className="absolute"
        style={{
          left: `${el.x}px`,
          top: `${topPx}px`,
          width: `${el.w}px`,
          height: el.h !== undefined ? `${el.h}px` : undefined,
        }}
      >
        {view}
      </div>
    );
  };

  const hasItems = splitY !== null;
  const topZoneH = hasItems ? splitY : height;
  const bottomZoneH = hasItems ? Math.max(0, height - splitY) : 0;

  const topEls = elements.filter((e) => e.type !== "items" && (!hasItems || e.y < splitY));
  const bottomEls = hasItems ? elements.filter((e) => e.type !== "items" && e.y >= splitY) : [];

  return (
    <div
      className={`mx-auto rounded-lg border border-border bg-background p-4 font-mono text-sm text-foreground ${className ?? ""}`}
      style={{ width: `${width}px`, maxWidth: "100%" }}
    >
      {/* Zona superior: anclada (alto fijo = items.y, o todo el lienzo si no hay items). */}
      <div style={{ position: "relative", height: `${topZoneH}px`, overflow: "visible" }}>
        {topEls.map((el) => renderEl(el, el.y))}
      </div>

      {hasItems && (
        <>
          {/* Tabla de ítems: flujo normal, alto variable según N ítems. */}
          <CanvasItemsTable data={data} />
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
