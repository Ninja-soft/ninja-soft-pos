"use client";

import { useEffect, useRef, useState } from "react";
import { Gift, ListChecks, MessageSquarePlus, MessageSquareText, Minus, Package, Pencil, Plus, Tag, Trash2 } from "lucide-react";
import { Button } from "@/components/ui/Button";
import { ProductThumb } from "@/components/products/ProductThumb";
import { LINE_NOTE_MAX, lineIsCharged, linePriceToDefine, normalizeLineNote } from "@/lib/pos/cartLine";
import { lineSubtotal, type CartLine } from "@/modules/pos/store";
import { formatQty } from "@/lib/utils/format";
import { cn } from "@/lib/utils/cn";
import { money } from "../ui/posStyles";
import { CheckoutFold } from "./CheckoutFold";

export interface CheckoutItemsActions {
  lines: CartLine[];
  /** Foto del producto de la línea (null = ícono). */
  imageFor?: (l: CartLine) => string | null;
  /** Promos que tocan cada línea (F9, ADR-074). */
  promoByLine?: Record<string, { label: string; amount: number }[]>;
  onQty: (lineId: string, qty: number) => void;
  onRemove: (lineId: string) => void;
  /** Cambio de precio con motivo (ADR-056). Sin handler, el precio no se toca. */
  onEditPrice?: (lineId: string) => void;
  /** Comentario del renglón (line_note, ADR-116): sale en el comprobante. */
  onNote: (lineId: string, note: string | null) => void;
  /** ADR-116: renglones de servicio (aclaraciones predefinidas y descripción). */
  isServiceLine?: (l: CartLine) => boolean;
  onEditService?: (lineId: string) => void;
}

const stepBtn =
  "grid h-8 w-8 place-items-center rounded-md text-foreground transition-colors hover:bg-fg-10 disabled:pointer-events-none disabled:opacity-40 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring [@media(pointer:coarse)]:h-10 [@media(pointer:coarse)]:w-10";
const AREA =
  "w-full resize-none rounded-lg border border-border bg-background px-3 py-2 text-sm leading-relaxed text-foreground outline-none transition placeholder:text-muted-foreground focus:border-ring focus-visible:ring-2 focus-visible:ring-ring/40";

// Pestaña "Ítems" de la hoja de cobro: las líneas de la venta para corregir
// cantidad, precio o quitar algo sin volver al carrito, y un comentario por
// renglón que sale en la factura, el ticket y el A4 debajo del nombre. Los
// totales de la hoja se recalculan solos (leen el mismo carrito).
export function CheckoutItemsBlock({
  open,
  lines,
  imageFor,
  promoByLine,
  onQty,
  onRemove,
  onEditPrice,
  onNote,
  isServiceLine,
  onEditService,
}: CheckoutItemsActions & {
  /** La hoja está abierta (al reabrir arranca cerrada). */
  open: boolean;
}) {
  const [expanded, setExpanded] = useState(false);
  const [noteFor, setNoteFor] = useState<string | null>(null);

  useEffect(() => {
    if (!open) {
      setExpanded(false);
      setNoteFor(null);
    }
  }, [open]);

  const units = lines.reduce((a, l) => a + (l.unit === "kg" ? 1 : l.quantity), 0);
  const withNote = lines.filter((l) => l.lineNote).length;
  const toDefine = lines.filter(linePriceToDefine).length;

  // Un precio sin definir abre la pestaña (una vez por cantidad de faltantes).
  const warned = useRef(0);
  useEffect(() => {
    if (!open) {
      warned.current = 0;
      return;
    }
    if (toDefine > warned.current) setExpanded(true);
    warned.current = toDefine;
  }, [open, toDefine]);

  const summary = [
    `${units} ${units === 1 ? "ítem" : "ítems"}`,
    toDefine > 0 ? (toDefine === 1 ? "Falta un precio" : `Faltan ${toDefine} precios`) : null,
    withNote > 0 ? `${withNote} con comentario` : null,
  ]
    .filter(Boolean)
    .join(" · ");
  const single = lines.length <= 1;

  return (
    <CheckoutFold
      className="mt-3"
      icon={ListChecks}
      title="Ítems"
      summary={summary}
      tone={toDefine > 0 ? "warning" : undefined}
      open={expanded}
      onToggle={() => setExpanded((o) => !o)}
    >
      <ul className="-my-1 divide-y divide-border" aria-label="Ítems de la venta">
        {lines.map((l) => (
          <ItemRow
            key={l.lineId}
            line={l}
            image={imageFor?.(l) ?? null}
            promos={promoByLine?.[l.lineId] ?? []}
            single={single}
            service={Boolean(onEditService && isServiceLine?.(l))}
            editingNote={noteFor === l.lineId}
            onEditNote={(on) => setNoteFor(on ? l.lineId : null)}
            onQty={onQty}
            onRemove={onRemove}
            onEditPrice={onEditPrice}
            onNote={onNote}
            onEditService={onEditService}
          />
        ))}
      </ul>
    </CheckoutFold>
  );
}
CheckoutItemsBlock.displayName = "CheckoutItemsBlock";

function ItemRow({
  line: l,
  image,
  promos,
  single,
  service,
  editingNote,
  onEditNote,
  onQty,
  onRemove,
  onEditPrice,
  onNote,
  onEditService,
}: {
  line: CartLine;
  image: string | null;
  promos: { label: string; amount: number }[];
  /** Es la única línea: no se quita desde acá (para cancelar, Limpiar). */
  single: boolean;
  service: boolean;
  editingNote: boolean;
  onEditNote: (on: boolean) => void;
  onQty: (lineId: string, qty: number) => void;
  onRemove: (lineId: string) => void;
  onEditPrice?: (lineId: string) => void;
  onNote: (lineId: string, note: string | null) => void;
  onEditService?: (lineId: string) => void;
}) {
  const charged = lineIsCharged(l);
  const editable = !l.giftPromoId;
  const toDefine = linePriceToDefine(l);
  const canPrice = Boolean(onEditPrice && charged && l.productId);
  const meta = [l.variantLabel, l.serial ? `S/N ${l.serial}` : null, l.modifiersLabel].filter(Boolean).join(" · ");
  const unitText = l.unit === "kg" ? `${money(l.unitPrice)}/kg` : `${money(l.unitPrice)} c/u`;

  return (
    <li className="py-3" data-line={l.lineId}>
      <div className="flex gap-3">
        <ProductThumb src={image} size={44} className="bg-fg-6" />
        <div className="min-w-0 flex-1">
          <div className="flex items-start gap-2">
            <p className="line-clamp-2 min-w-0 flex-1 break-words text-sm font-medium leading-snug" title={l.name}>
              {l.name}
            </p>
            <span
              className={cn(
                "shrink-0 font-price text-sm font-semibold tabular-nums",
                !charged && "text-success",
                toDefine && "text-muted-foreground",
              )}
              aria-label={`Subtotal de ${l.name}`}
            >
              {charged ? money(lineSubtotal(l)) : "Gratis"}
            </span>
          </div>
          {meta && <p className="mt-0.5 truncate text-xs text-muted-foreground">{meta}</p>}
          {promos.map((pr) => (
            <p key={pr.label} className="mt-0.5 flex min-w-0 items-center gap-1 text-xs font-medium tabular-nums text-success">
              <Tag size={12} className="shrink-0" aria-hidden />
              <span className="truncate">{pr.label}</span>
              <span className="shrink-0">−{money(pr.amount)}</span>
            </p>
          ))}

          <div className="mt-2 flex flex-wrap items-center gap-x-2 gap-y-1.5">
            {l.giftPromoId ? (
              <span className="inline-flex items-center gap-1 rounded-md bg-success/15 px-1.5 py-0.5 text-[11px] font-semibold text-success">
                <Gift size={12} aria-hidden /> Regalo
              </span>
            ) : l.packCreditId ? (
              <span className="inline-flex items-center gap-1 rounded-md bg-success/15 px-1.5 py-0.5 text-[11px] font-semibold text-success">
                <Package size={12} aria-hidden /> Cubierto por el pack
              </span>
            ) : canPrice ? (
              <button
                type="button"
                onClick={() => onEditPrice?.(l.lineId)}
                aria-label={toDefine ? `Definir el precio de ${l.name}` : `Cambiar el precio de ${l.name}`}
                className={cn(
                  "inline-flex h-8 items-center gap-1.5 rounded-md px-2 text-xs font-semibold tabular-nums transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring [@media(pointer:coarse)]:h-10",
                  toDefine ? "bg-warning/15 text-warning hover:bg-warning/20" : "bg-fg-6 text-foreground hover:bg-fg-10",
                )}
              >
                <Pencil size={13} aria-hidden />
                {toDefine ? "Precio a definir" : unitText}
              </button>
            ) : (
              <span className="text-xs font-medium tabular-nums text-muted-foreground">{unitText}</span>
            )}
            {l.priceOverride && l.listPrice != null && (
              <span className="text-xs tabular-nums text-muted-foreground">Lista {money(l.listPrice)}</span>
            )}
            {l.discount > 0 && charged && (
              <span className="rounded-md bg-success/15 px-1.5 py-0.5 text-[11px] font-semibold tabular-nums text-success">
                Desc. −{money(l.discount)}
              </span>
            )}

            <div className="ml-auto flex items-center gap-1">
              {editable && l.unit !== "kg" ? (
                <div className="flex items-center rounded-lg bg-fg-6 p-0.5" role="group" aria-label={`Cantidad de ${l.name}`}>
                  <button
                    type="button"
                    onClick={() => onQty(l.lineId, l.quantity - 1)}
                    disabled={l.quantity <= 1}
                    className={stepBtn}
                    aria-label={`Restar ${l.name}`}
                  >
                    <Minus size={15} aria-hidden />
                  </button>
                  <span className="w-7 text-center text-[13px] font-semibold tabular-nums" aria-live="polite">
                    {l.quantity}
                  </span>
                  <button
                    type="button"
                    onClick={() => onQty(l.lineId, l.quantity + 1)}
                    className={stepBtn}
                    aria-label={`Sumar ${l.name}`}
                  >
                    <Plus size={15} aria-hidden />
                  </button>
                </div>
              ) : (
                <span className="px-1 text-xs font-medium tabular-nums text-muted-foreground">
                  {l.unit === "kg" ? `${formatQty(l.quantity)} kg` : `×${l.quantity}`}
                </span>
              )}
              {editable && (
                <button
                  type="button"
                  onClick={() => onRemove(l.lineId)}
                  disabled={single}
                  title={single ? "Es el único ítem: para cancelar la venta usá Limpiar" : undefined}
                  className={cn(stepBtn, "text-muted-foreground hover:bg-danger/15 hover:text-danger")}
                  aria-label={`Quitar ${l.name}`}
                >
                  <Trash2 size={15} aria-hidden />
                </button>
              )}
            </div>
          </div>

          {editingNote ? (
            <NoteEditor
              lineId={l.lineId}
              initial={l.lineNote ?? ""}
              onCancel={() => onEditNote(false)}
              onSave={(note) => {
                onNote(l.lineId, note);
                onEditNote(false);
              }}
            />
          ) : l.lineNote ? (
            <div className="mt-2 flex items-start gap-2 rounded-md bg-fg-4 px-2.5 py-2 text-xs">
              <MessageSquareText size={13} className="mt-[1px] shrink-0 text-muted-foreground" aria-hidden />
              <p className="min-w-0 flex-1 whitespace-pre-line break-words text-foreground">{l.lineNote}</p>
              <button
                type="button"
                onClick={() => onEditNote(true)}
                className="shrink-0 font-semibold text-muted-foreground underline-offset-2 hover:text-foreground hover:underline"
                aria-label={`Editar el comentario de ${l.name}`}
              >
                Editar
              </button>
            </div>
          ) : (
            <button
              type="button"
              onClick={() => onEditNote(true)}
              className="mt-1.5 inline-flex h-8 items-center gap-1.5 rounded-md px-1.5 text-xs font-semibold text-muted-foreground transition-colors hover:bg-fg-6 hover:text-foreground [@media(pointer:coarse)]:h-10"
              aria-label={`Agregar comentario a ${l.name}`}
            >
              <MessageSquarePlus size={14} aria-hidden /> Agregar comentario
            </button>
          )}
          {service && !editingNote && (
            <button
              type="button"
              onClick={() => onEditService?.(l.lineId)}
              className="ml-1 mt-1.5 inline-flex h-8 items-center gap-1.5 rounded-md px-1.5 text-xs font-semibold text-muted-foreground transition-colors hover:bg-fg-6 hover:text-foreground [@media(pointer:coarse)]:h-10"
            >
              Aclaraciones del servicio
            </button>
          )}
        </div>
      </div>
    </li>
  );
}

function NoteEditor({
  lineId,
  initial,
  onCancel,
  onSave,
}: {
  lineId: string;
  initial: string;
  onCancel: () => void;
  onSave: (note: string | null) => void;
}) {
  const [text, setText] = useState(initial);
  // Una aclaración de servicio más larga (ADR-116 admite 1000) no se corta.
  const max = Math.max(LINE_NOTE_MAX, initial.length);
  const id = `nota-${lineId}`;
  return (
    <div className="mt-2 space-y-1.5">
      <label htmlFor={id} className="block text-xs font-medium text-muted-foreground">
        Comentario para la factura
      </label>
      <textarea
        id={id}
        rows={2}
        autoFocus
        maxLength={max}
        value={text}
        onChange={(e) => setText(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Escape") {
            e.stopPropagation();
            onCancel();
          }
        }}
        placeholder="Ej.: período agosto, visita del 12/10, N° de lote"
        className={AREA}
        aria-describedby={`${id}-ayuda`}
      />
      <div className="flex flex-wrap items-center gap-2">
        <span id={`${id}-ayuda`} className="mr-auto text-[11px] text-muted-foreground">
          Sale debajo del renglón en la factura y el ticket ·{" "}
          <span className="tabular-nums">
            {text.length}/{max}
          </span>
        </span>
        {initial && (
          <Button type="button" variant="ghost" size="sm" onClick={() => onSave(null)}>
            Borrar
          </Button>
        )}
        <Button type="button" variant="secondary" size="sm" onClick={onCancel}>
          Cancelar
        </Button>
        <Button type="button" size="sm" onClick={() => onSave(normalizeLineNote(text, max))}>
          Guardar
        </Button>
      </div>
    </div>
  );
}
