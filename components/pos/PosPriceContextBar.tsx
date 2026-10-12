"use client";

import { useState } from "react";
import { Check, ChevronDown, Tags } from "lucide-react";
import * as Popover from "@radix-ui/react-popover";
import { cn } from "@/lib/utils/cn";
import { formatCurrency } from "@/lib/utils/format";
import { usePricingContext } from "@/lib/prices/pricingContext";
import type { ProList, PaymentTerm } from "@/modules/prices/proApi";

// Lista y condición de pago del POS (F18 · H100, ADR-058). Sólo aparece si el
// negocio tiene listas elegibles en el POS o condiciones de pago (PRO). Al
// elegir una condición se ve el total del carrito en cada plazo.
export function PosPriceContextBar({
  lists,
  appliedListName,
  terms,
  customerTermId,
  totalWithTerm,
}: {
  lists: ProList[];
  appliedListName: string | null;
  terms: PaymentTerm[];
  customerTermId: string | null;
  totalWithTerm: (termId: string) => number | null;
}) {
  const listId = usePricingContext((s) => s.listId);
  const termId = usePricingContext((s) => s.termId);
  const setList = usePricingContext((s) => s.setList);
  const setTerm = usePricingContext((s) => s.setTerm);
  const [openList, setOpenList] = useState(false);
  const [openTerm, setOpenTerm] = useState(false);

  if (lists.length === 0 && terms.length === 0) return null;

  const effectiveTerm = termId === "none" ? null : (termId ?? customerTermId);
  const term = terms.find((t) => t.id === effectiveTerm) ?? null;
  const listLabel = listId ? (lists.find((l) => l.id === listId)?.name ?? "Lista") : (appliedListName ?? "Precio de venta");

  const chip =
    "inline-flex h-8 max-w-[48%] items-center gap-1.5 rounded-md bg-muted px-2.5 text-xs font-medium text-foreground transition hover:bg-muted/70";
  const row = "flex w-full items-center justify-between gap-3 rounded px-2.5 py-2 text-left text-sm hover:bg-muted";

  return (
    <div className="flex flex-wrap items-center gap-2" aria-label="Contexto de precio">
      {lists.length > 0 && (
        <Popover.Root open={openList} onOpenChange={setOpenList}>
          <Popover.Trigger className={chip} title="Lista de precios">
            <Tags size={13} className="shrink-0 text-muted-foreground" />
            <span className="truncate">{listLabel}</span>
            {listId && <span className="text-muted-foreground">· elegida</span>}
            <ChevronDown size={13} className="shrink-0 text-muted-foreground" />
          </Popover.Trigger>
          <Popover.Portal>
            <Popover.Content
              align="start"
              sideOffset={6}
              className="z-50 w-64 rounded-md border border-border bg-popover p-1 text-popover-foreground"
            >
              <button
                type="button"
                className={row}
                onClick={() => {
                  setList(null);
                  setOpenList(false);
                }}
              >
                <span>
                  Automática
                  <span className="block text-xs text-muted-foreground">Cliente, sucursal o mostrador</span>
                </span>
                {!listId && <Check size={15} />}
              </button>
              {lists.map((l) => (
                <button
                  key={l.id}
                  type="button"
                  className={row}
                  onClick={() => {
                    setList(l.id);
                    setOpenList(false);
                  }}
                >
                  <span className="truncate">{l.name}</span>
                  {listId === l.id && <Check size={15} />}
                </button>
              ))}
            </Popover.Content>
          </Popover.Portal>
        </Popover.Root>
      )}

      {terms.length > 0 && (
        <Popover.Root open={openTerm} onOpenChange={setOpenTerm}>
          <Popover.Trigger className={chip} title="Condición de pago">
            <span className="truncate">{term ? term.name : "Contado"}</span>
            {term && Number(term.surcharge_pct) !== 0 && (
              <span className="text-muted-foreground">
                {Number(term.surcharge_pct) > 0 ? "+" : ""}
                {Number(term.surcharge_pct)}%
              </span>
            )}
            <ChevronDown size={13} className="shrink-0 text-muted-foreground" />
          </Popover.Trigger>
          <Popover.Portal>
            <Popover.Content
              align="start"
              sideOffset={6}
              className="z-50 w-72 rounded-md border border-border bg-popover p-1 text-popover-foreground"
            >
              <p className="px-2.5 pb-1 pt-1.5 text-xs text-muted-foreground">Total del carrito en cada plazo</p>
              {[{ id: "none", name: "Contado", days: 0, surcharge_pct: 0 } as const, ...terms].map((t) => {
                const total = totalWithTerm(t.id);
                const active = t.id === "none" ? !term : term?.id === t.id;
                return (
                  <button
                    key={t.id}
                    type="button"
                    className={cn(row, active && "bg-muted")}
                    onClick={() => {
                      setTerm(t.id === (customerTermId ?? "none") ? null : t.id);
                      setOpenTerm(false);
                    }}
                  >
                    <span className="min-w-0">
                      <span className="block truncate">{t.name}</span>
                      <span className="block text-xs text-muted-foreground">
                        {t.days > 0 ? `${t.days} días` : "En el momento"}
                        {Number(t.surcharge_pct) !== 0 ? ` · recargo ${Number(t.surcharge_pct)}%` : ""}
                        {t.id === customerTermId ? " · del cliente" : ""}
                      </span>
                    </span>
                    <span className="shrink-0 font-price tabular-nums">
                      {total == null ? "" : formatCurrency(total)}
                    </span>
                  </button>
                );
              })}
            </Popover.Content>
          </Popover.Portal>
        </Popover.Root>
      )}
    </div>
  );
}
