"use client";

import { useEffect, useRef, useState } from "react";
import { BadgeCheck, ExternalLink, UserPlus, UserRound, UserSearch, X } from "lucide-react";
import { Badge } from "@/components/ui/Badge";
import { Button } from "@/components/ui/Button";
import { inferLetter } from "@/lib/tax/comprobante";
import { FISCAL_CONDITION_LABEL, emitterDiscriminatesIva, isValidCuit, type FiscalCondition } from "@/lib/tax/catalog";
import { useCheckoutCustomerFiscal } from "@/modules/customers/checkoutFiscal";
import { useFeature } from "@/modules/saas/gating";
import { useTaxSettings } from "@/modules/tax/hooks";
import { CheckoutFold } from "./CheckoutFold";
import type { CheckoutLetterState } from "./CheckoutLetter";

export interface CheckoutCustomerActions {
  /** Cliente de la venta (null = consumidor final). */
  customer: { id: string; name: string } | null;
  /** Abre el buscador de clientes (el mismo del carrito, F4). */
  onPick: () => void;
  /** Abre el alta rápida con CUIT y "Verificar en ARCA" (ADR-133). */
  onNew: () => void;
  /** Vuelve a consumidor final. */
  onClear: () => void;
}

// Condición corta para la línea cerrada del bloque.
const SHORT_IVA: Partial<Record<FiscalCondition, string>> = {
  responsable_inscripto: "Resp. inscripto",
  monotributo_social: "Monotributo social",
  no_categorizado: "No categorizado",
  iva_liberado: "IVA liberado",
  exterior: "Exterior",
};

function cuitText(n: string | null | undefined): string {
  const d = String(n ?? "").replace(/\D/g, "");
  return d.length === 11 ? `${d.slice(0, 2)}-${d.slice(2, 10)}-${d.slice(10)}` : d;
}

// Bloque "Cliente" de la hoja de cobro (ADR-146): quién compra, su condición
// frente al IVA y la factura que le corresponde (en vivo: cambia al elegir o
// crear el cliente). La letra y "Cambiar tipo" (CheckoutLetter) viven adentro
// y quedan montadas aunque el bloque esté cerrado.
export function CheckoutCustomerBlock({
  open,
  customer,
  offline = false,
  onPick,
  onNew,
  onClear,
  letter,
  letterState,
}: CheckoutCustomerActions & {
  /** La hoja está abierta (habilita las consultas). */
  open: boolean;
  offline?: boolean;
  /** <CheckoutLetter embedded /> */
  letter?: React.ReactNode;
  letterState: CheckoutLetterState | null;
}) {
  const [expanded, setExpanded] = useState(false);
  const arca = useFeature("facturacion_afip");
  const tax = useTaxSettings(open);
  const fiscal = useCheckoutCustomerFiscal(customer?.id ?? null, open);
  const c = customer ? fiscal.data : null;
  const receptor = (c?.iva_condition || "consumidor_final") as FiscalCondition;
  const ivaLabel = FISCAL_CONDITION_LABEL[receptor] ?? receptor;
  const hasCuit = c?.document_type === "cuit" && isValidCuit(c?.document_number);
  const emitter = tax.data?.iva_condition ?? null;
  // La letra vigente la informa CheckoutLetter (puede estar elegida a mano);
  // mientras tanto, la que corresponde.
  const fallback = arca === true ? inferLetter(emitter, receptor, { issuesM: tax.data?.issues_cbte_m }) : null;
  const letterNow = letterState?.letter ?? fallback;
  const suggested = letterState?.suggested ?? fallback;
  const cuitMissing = Boolean(customer) && (suggested === "A" || suggested === "M") && !hasCuit;
  const warning = cuitMissing
    ? `La Factura ${suggested} necesita el CUIT del cliente.`
    : (letterState?.problem ?? null);
  const offerCompany = !customer && arca === true && Boolean(emitter) && emitterDiscriminatesIva(emitter);

  // Un aviso nuevo abre el bloque (una vez por aviso).
  const warned = useRef<string | null>(null);
  useEffect(() => {
    if (warning && warned.current !== warning) setExpanded(true);
    warned.current = warning;
  }, [warning]);

  const who = customer?.name ?? "Consumidor final";
  const summary = cuitMissing
    ? `${who} · Falta el CUIT`
    : customer && c?.iva_condition
      ? `${who} · ${SHORT_IVA[receptor] ?? ivaLabel}`
      : who;
  const aside = letterNow ? `Factura ${letterNow}${letterState?.forced ? " a mano" : ""}` : null;

  return (
    <CheckoutFold
      className="mt-3"
      icon={UserRound}
      title="Cliente"
      summary={summary}
      aside={aside}
      tone={warning ? "warning" : undefined}
      open={expanded}
      onToggle={() => setExpanded((o) => !o)}
      keep={letter}
    >
      <div className="flex items-start justify-between gap-2">
        <div className="min-w-0">
          <p className="truncate text-sm font-medium">{who}</p>
          <p className="truncate text-xs text-muted-foreground">
            {customer ? ivaLabel : "Sin datos del cliente"}
            {hasCuit ? ` · CUIT ${cuitText(c?.document_number)}` : c?.document_number ? ` · Doc. ${c.document_number}` : ""}
          </p>
        </div>
      </div>
      {c?.fiscal_verification === "padron" && (
        <Badge tone="success">
          <BadgeCheck size={12} aria-hidden /> Verificado en ARCA
        </Badge>
      )}
      {warning && (
        <div className="space-y-1.5 rounded-lg bg-warning/10 px-3 py-2 text-xs">
          <p className="font-medium text-warning">{warning}</p>
          {cuitMissing && customer && (
            <a
              href={`/clientes/${encodeURIComponent(customer.id)}`}
              target="_blank"
              rel="noopener noreferrer"
              className="inline-flex items-center gap-1 font-medium text-foreground underline-offset-2 hover:underline"
            >
              Cargar el CUIT en la ficha <ExternalLink size={12} aria-hidden />
            </a>
          )}
        </div>
      )}
      <div className="grid grid-cols-2 gap-2 sm:flex sm:flex-wrap">
        <Button
          type="button"
          variant="secondary"
          size="sm"
          onClick={onPick}
          aria-keyshortcuts="F4"
          title="Elegir cliente (F4)"
        >
          <UserSearch size={15} aria-hidden /> Elegir cliente
        </Button>
        <Button
          type="button"
          variant="secondary"
          size="sm"
          onClick={onNew}
          disabled={offline}
          title={offline ? "Sin conexión no se dan de alta clientes" : undefined}
        >
          <UserPlus size={15} aria-hidden /> Nuevo cliente
        </Button>
        {customer && (
          <Button type="button" variant="ghost" size="sm" onClick={onClear} className="col-span-2 sm:col-span-1">
            <X size={15} aria-hidden /> Quitar
          </Button>
        )}
      </div>
      {offerCompany && (
        <p className="text-xs text-muted-foreground">
          ¿Te pide factura a nombre de una empresa? Cargalo con su CUIT y lo verificamos en ARCA.
        </p>
      )}
    </CheckoutFold>
  );
}
CheckoutCustomerBlock.displayName = "CheckoutCustomerBlock";
