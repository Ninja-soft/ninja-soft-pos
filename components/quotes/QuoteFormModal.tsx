"use client";

// Alta y edición de un presupuesto (ADR-122, ADR-123). Mismo lenguaje que la
// hoja de cobro del POS (PosSheet xl): en la compu, a la izquierda el cliente,
// los renglones y las condiciones; a la derecha el total, la validez (o "sin
// vencimiento"), a quién se le manda (emails y WhatsApp DEL CLIENTE), tus
// datos de contacto impresos y el botón de guardar. En el celular, apilado con
// el botón fijo abajo. Los totales los recalcula la base (quote_save).
import { useEffect, useMemo, useState } from "react";
import { BriefcaseBusiness, Minus, Package, PenLine, Plus, Search, Trash2, User, X } from "lucide-react";
import { PosSheet } from "@/components/pos/ui/PosSheet";
import { POS_CTA, POS_EYEBROW } from "@/components/pos/ui/posStyles";
import { Input } from "@/components/ui/Input";
import { Segmented } from "@/components/ui/Segmented";
import { Spinner } from "@/components/ui/Spinner";
import { Switch } from "@/components/ui/Switch";
import { useToast } from "@/components/ui/Toast";
import { ProductSearchCombobox } from "@/components/products/ProductSearchCombobox";
import { EmailChipsInput } from "@/components/quotes/EmailChipsInput";
import { QuoteContactCard } from "@/components/quotes/QuoteContactCard";
import { useCustomersForPicker } from "@/modules/customers/hooks";
import { variantLabel, variantPrice } from "@/modules/products/api";
import { useQuoteMutations, useQuoteSettings } from "@/modules/quotes/hooks";
import { useQuoteBrand } from "@/modules/quotes/useQuoteBrand";
import type { QuoteSaveResult } from "@/modules/quotes/api";
import {
  QUOTE_NO_EXPIRY_LEGEND,
  addDaysIso,
  lineSubtotal,
  parseEmails,
  quoteErrorMessage,
  quoteNumberLabel,
  quoteRecipients,
  quoteTotals,
  todayArIso,
  type Quote,
  type QuoteItem,
} from "@/lib/quotes/logic";
import { formatCurrency } from "@/lib/utils/format";
import { cn } from "@/lib/utils/cn";

interface DraftItem {
  key: string;
  product_id: string | null;
  variant_id: string | null;
  variant_label: string | null;
  name: string;
  sku: string | null;
  quantity: number;
  unit_price: number;
  discount: number;
  is_service: boolean;
  line_note: string;
  /** undefined = la del servicio (la base la completa). */
  line_detail?: string;
  /** Aclaraciones elegidas (se conservan al editar). */
  clarification_ids?: string[];
  service_type_name: string | null;
}

type Validity = "date" | "none";

const textareaCls =
  "min-h-[76px] w-full rounded-lg border border-border bg-background/40 px-3 py-2 text-sm text-foreground outline-none transition-colors placeholder:text-muted-foreground focus:border-[color-mix(in_srgb,var(--foreground)_30%,transparent)]";
const smallNum =
  "h-9 w-full rounded-md border border-border bg-background/40 px-2 text-right text-sm tabular-nums text-foreground outline-none focus:border-[color-mix(in_srgb,var(--foreground)_30%,transparent)]";
const fieldCls =
  "h-11 w-full rounded-lg border border-border bg-background/40 px-3 text-sm text-foreground outline-none placeholder:text-muted-foreground focus:border-[color-mix(in_srgb,var(--foreground)_30%,transparent)]";

function fromQuoteItem(it: QuoteItem): DraftItem {
  return {
    key: crypto.randomUUID(),
    product_id: it.product_id,
    variant_id: it.variant_id ?? null,
    variant_label: it.variant_label ?? null,
    name: it.name,
    sku: it.sku ?? null,
    quantity: Number(it.quantity),
    unit_price: Number(it.unit_price),
    discount: Number(it.discount) || 0,
    is_service: it.is_service,
    line_note: it.line_note ?? "",
    ...(it.is_service ? { line_detail: it.line_detail ?? "", clarification_ids: it.clarification_ids ?? [] } : {}),
    service_type_name: it.service_type_name ?? null,
  };
}

/** Bloque con título de la hoja (mismo ritmo que la hoja de cobro). */
function Block({ title, action, children, className }: { title: string; action?: React.ReactNode; children: React.ReactNode; className?: string }) {
  return (
    <section className={cn("space-y-3", className)}>
      <div className="flex min-h-8 items-center justify-between gap-2">
        <h3 className="font-display text-base font-bold tracking-tight">{title}</h3>
        {action}
      </div>
      {children}
    </section>
  );
}

export function QuoteFormModal({
  open,
  onOpenChange,
  quote,
  onSaved,
}: {
  open: boolean;
  onOpenChange: (o: boolean) => void;
  /** Con presupuesto: edición. */
  quote?: (Quote & { items: QuoteItem[] }) | null;
  onSaved?: (r: QuoteSaveResult) => void;
}) {
  const { toast } = useToast();
  const m = useQuoteMutations();
  const { data: settings } = useQuoteSettings(open);
  const { brand } = useQuoteBrand(open);

  const [customerId, setCustomerId] = useState<string | null>(null);
  const [customerName, setCustomerName] = useState("");
  const [customerDoc, setCustomerDoc] = useState("");
  const [customerEmails, setCustomerEmails] = useState<string[]>([]);
  const [customerPhone, setCustomerPhone] = useState("");
  const [search, setSearch] = useState("");
  const [items, setItems] = useState<DraftItem[]>([]);
  const [discount, setDiscount] = useState(0);
  const [validity, setValidity] = useState<Validity>("date");
  const [validUntil, setValidUntil] = useState("");
  const [terms, setTerms] = useState("");
  const [notes, setNotes] = useState("");
  const [signature, setSignature] = useState(true);
  const [reason, setReason] = useState("");
  const [openKey, setOpenKey] = useState<string | null>(null);

  const editing = Boolean(quote);
  const wasSent = quote ? quote.status !== "draft" : false;

  useEffect(() => {
    if (!open) return;
    const today = todayArIso();
    const days = settings?.validity_days ?? 15;
    if (quote) {
      setCustomerId(quote.customer_id);
      setCustomerName(quote.customer_name ?? "");
      setCustomerDoc(quote.customer_doc ?? "");
      setCustomerEmails(quoteRecipients(quote));
      setCustomerPhone(quote.customer_phone ?? "");
      setItems(quote.items.map(fromQuoteItem));
      setDiscount(Number(quote.discount_total) || 0);
      setValidity(quote.valid_until ? "date" : "none");
      setValidUntil(
        !quote.valid_until || quote.valid_until.slice(0, 10) < today ? addDaysIso(today, days) : quote.valid_until.slice(0, 10),
      );
      setTerms(quote.terms ?? "");
      setNotes(quote.notes ?? "");
      setSignature(quote.show_signature);
    } else {
      setCustomerId(null);
      setCustomerName("");
      setCustomerDoc("");
      setCustomerEmails([]);
      setCustomerPhone("");
      setItems([]);
      setDiscount(0);
      setValidity(settings?.no_expiry_default ? "none" : "date");
      setValidUntil(addDaysIso(today, days));
      setTerms(settings?.default_terms ?? "");
      setNotes("");
      setSignature(settings?.show_signature ?? true);
    }
    setSearch("");
    setReason("");
    setOpenKey(null);
    // settings: sólo los defaults de un alta.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, quote?.id, settings?.validity_days, settings?.no_expiry_default]);

  const { data: customers = [] } = useCustomersForPicker(search.trim(), open && !customerId && search.trim().length > 0);
  const totals = useMemo(() => quoteTotals(items, discount), [items, discount]);

  function patch(key: string, p: Partial<DraftItem>) {
    setItems((xs) => xs.map((x) => (x.key === key ? { ...x, ...p } : x)));
  }

  function addFree() {
    const key = crypto.randomUUID();
    setItems((xs) => [
      ...xs,
      { key, product_id: null, variant_id: null, variant_label: null, name: "", sku: null, quantity: 1, unit_price: 0, discount: 0, is_service: false, line_note: "", service_type_name: null },
    ]);
    setOpenKey(key);
  }

  async function submit() {
    if (items.length === 0) {
      toast({ title: "Agregá al menos un renglón", variant: "error" });
      return;
    }
    if (items.some((i) => !i.name.trim())) {
      toast({ title: "Cada renglón necesita un nombre", variant: "error" });
      return;
    }
    if (validity === "date" && (!validUntil || validUntil < todayArIso())) {
      toast({ title: "Elegí hasta cuándo vale", description: "O marcá Sin vencimiento.", variant: "error" });
      return;
    }
    try {
      const r = await m.save.mutateAsync({
        quote: {
          ...(quote ? { id: quote.id } : {}),
          customer_id: customerId,
          customer_name: customerId ? null : customerName.trim() || null,
          customer_doc: customerId ? null : customerDoc.trim() || null,
          customer_emails: customerEmails,
          customer_email: customerEmails[0] ?? null,
          customer_phone: customerPhone.trim() || null,
          no_expiry: validity === "none",
          valid_until: validity === "none" ? null : validUntil,
          terms: terms.trim(),
          notes: notes.trim(),
          discount_total: totals.discount,
          show_signature: signature,
          reason: reason.trim() || null,
        },
        items: items.map((i) => ({
          ...(i.product_id ? { product_id: i.product_id } : {}),
          ...(i.variant_id ? { variant_id: i.variant_id, variant_label: i.variant_label } : {}),
          name: i.name.trim(),
          sku: i.sku,
          quantity: i.quantity,
          unit_price: i.unit_price,
          discount: i.discount,
          ...(i.line_note.trim() ? { line_note: i.line_note.trim() } : {}),
          ...(i.is_service && i.line_detail !== undefined ? { line_detail: i.line_detail } : {}),
          ...(i.is_service && i.clarification_ids !== undefined ? { clarification_ids: i.clarification_ids } : {}),
        })),
      });
      toast({
        title: editing ? `Presupuesto ${quoteNumberLabel(r.pto_vta, r.number)} actualizado` : `Presupuesto ${quoteNumberLabel(r.pto_vta, r.number)} creado`,
        description: editing && r.version > (quote?.version ?? 1) ? `Quedó como revisión ${r.version}, en borrador.` : undefined,
        variant: "success",
      });
      onOpenChange(false);
      onSaved?.(r);
    } catch (e) {
      toast({ title: "No se pudo guardar", description: quoteErrorMessage(e), variant: "error" });
    }
  }

  const title = quote ? `Editar presupuesto ${quoteNumberLabel(quote.pto_vta, quote.number)}` : "Nuevo presupuesto";

  const cta = (
    <div className="space-y-2">
      <button
        type="button"
        onClick={submit}
        disabled={m.save.isPending}
        className={cn(
          POS_CTA,
          "flex h-12 w-full items-center justify-center gap-2 rounded-lg text-base font-semibold",
          "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-popover",
        )}
      >
        {m.save.isPending ? <Spinner size={18} className="border-current/30 border-t-current" /> : null}
        {editing ? "Guardar cambios" : "Guardar presupuesto"}
      </button>
      <p className="text-center text-xs text-muted-foreground">No cobra ni mueve stock.</p>
    </div>
  );

  return (
    <PosSheet
      open={open}
      onOpenChange={onOpenChange}
      title={title}
      description={`Total ${formatCurrency(totals.total)}`}
      size="xl"
      focusContainer
      className="md:h-[min(92dvh,860px)] md:max-w-5xl"
    >
      <div className="slim-scrollbar flex min-h-0 flex-1 flex-col overflow-y-auto md:grid md:grid-cols-[minmax(0,1fr)_minmax(340px,380px)] md:overflow-hidden">
        {/* Cliente, renglones y condiciones */}
        <section className="space-y-7 px-4 pb-6 pt-3 md:slim-scrollbar md:min-h-0 md:overflow-y-auto md:px-6 md:pt-6">
          <div className="pr-10 md:pr-0">
            <p className={POS_EYEBROW}>{quote ? `Presupuesto N° ${quoteNumberLabel(quote.pto_vta, quote.number)}` : "Presupuesto"}</p>
            <h2 className="mt-1 font-display text-xl font-bold tracking-tight">{quote ? "Editar presupuesto" : "Nuevo presupuesto"}</h2>
            <p className="mt-1 text-sm text-muted-foreground">
              {wasSent
                ? "Ya lo vio el cliente: al guardar se crea una revisión nueva y vuelve a borrador."
                : "Lo convertís en venta con un click cuando el cliente acepte."}
            </p>
          </div>

          <Block title="Cliente">
            {customerId ? (
              <div className="flex h-12 items-center gap-2.5 rounded-lg border border-border bg-card pl-2 pr-1.5 text-sm">
                <span className="grid h-8 w-8 place-items-center rounded-md bg-fg-6 text-muted-foreground">
                  <User size={16} aria-hidden />
                </span>
                <span className="min-w-0 flex-1 truncate font-medium">{customerName}</span>
                <button
                  type="button"
                  onClick={() => {
                    setCustomerId(null);
                    setCustomerName("");
                  }}
                  className="grid h-9 w-9 place-items-center rounded-md text-muted-foreground hover:bg-fg-6 hover:text-foreground"
                  aria-label="Quitar cliente"
                >
                  <X size={16} />
                </button>
              </div>
            ) : (
              <>
                <div className="relative">
                  <Search size={15} className="pointer-events-none absolute left-3 top-[22px] -translate-y-1/2 text-muted-foreground" />
                  <input
                    value={search}
                    onChange={(e) => setSearch(e.target.value)}
                    placeholder="Buscar en tus clientes por nombre, documento o teléfono"
                    aria-label="Buscar cliente"
                    className={cn(fieldCls, "pl-9")}
                  />
                  {search.trim() && customers.length > 0 && (
                    <div className="mt-1 max-h-44 space-y-0.5 overflow-y-auto rounded-lg border border-border bg-card p-1">
                      {customers.slice(0, 8).map((c) => (
                        <button
                          key={c.id}
                          type="button"
                          onClick={() => {
                            setCustomerId(c.id);
                            setCustomerName(c.name);
                            // Destinatarios: los de la ficha del cliente.
                            setCustomerEmails(c.email ? parseEmails(c.email).valid : []);
                            setCustomerPhone(c.phone ?? "");
                            setSearch("");
                          }}
                          className="flex w-full items-center justify-between gap-2 rounded-md px-2.5 py-2 text-left text-sm hover:bg-muted"
                        >
                          <span className="min-w-0 truncate font-medium">{c.name}</span>
                          <span className="shrink-0 text-xs text-muted-foreground">{c.document_number ?? c.phone ?? ""}</span>
                        </button>
                      ))}
                    </div>
                  )}
                </div>
                <div className="grid gap-3 sm:grid-cols-2">
                  <Input variant="filled" label="Nombre o razón social del cliente" value={customerName} onChange={(e) => setCustomerName(e.target.value)} maxLength={160} />
                  <Input variant="filled" label="CUIT o DNI del cliente" value={customerDoc} onChange={(e) => setCustomerDoc(e.target.value)} maxLength={40} />
                </div>
              </>
            )}
          </Block>

          <Block
            title="Productos y servicios"
            action={
              <button
                type="button"
                onClick={addFree}
                className="inline-flex h-9 items-center gap-1.5 rounded-lg px-2.5 text-sm font-semibold text-muted-foreground hover:bg-fg-6 hover:text-foreground"
              >
                <Plus size={15} /> Renglón libre
              </button>
            }
          >
            <ProductSearchCombobox
              enabled={open}
              placeholder="Buscar un servicio o producto del catálogo"
              onPick={(p, v) => {
                const isService = Boolean((p as { is_service?: boolean }).is_service);
                const key = crypto.randomUUID();
                setItems((xs) => [
                  ...xs,
                  {
                    key,
                    product_id: p.id,
                    variant_id: v?.id ?? null,
                    variant_label: v ? variantLabel(v) : null,
                    name: p.name,
                    sku: v?.sku ?? p.sku ?? null,
                    quantity: 1,
                    unit_price: v ? variantPrice(v, Number(p.price)) : Number(p.price),
                    discount: 0,
                    is_service: isService,
                    line_note: "",
                    service_type_name: null,
                  },
                ]);
              }}
            />
            {items.length === 0 ? (
              <p className="rounded-lg bg-fg-4 px-3 py-6 text-center text-sm text-muted-foreground">
                Buscá un servicio o producto, o agregá un renglón libre.
              </p>
            ) : (
              <ul className="space-y-2">
                {items.map((it) => {
                  const expanded = openKey === it.key;
                  return (
                    <li key={it.key} className="rounded-lg border border-border bg-card p-2.5">
                      <div className="flex items-start gap-2">
                        <span
                          className={cn(
                            "mt-1 hidden h-7 w-7 shrink-0 place-items-center rounded-md bg-fg-6 sm:grid",
                            it.is_service ? "text-ninja-flameSoft" : "text-muted-foreground",
                          )}
                          aria-hidden
                        >
                          {it.is_service ? <BriefcaseBusiness size={14} /> : <Package size={14} />}
                        </span>
                        <div className="min-w-0 flex-1">
                          {it.product_id ? (
                            <p className="truncate text-sm font-medium">
                              {it.name}
                              {it.variant_label ? <span className="text-muted-foreground"> · {it.variant_label}</span> : null}
                            </p>
                          ) : (
                            <input
                              value={it.name}
                              onChange={(e) => patch(it.key, { name: e.target.value })}
                              placeholder="Descripción del renglón"
                              aria-label="Descripción del renglón"
                              maxLength={200}
                              className="h-9 w-full rounded-md border border-border bg-background/40 px-2 text-sm outline-none focus:border-[color-mix(in_srgb,var(--foreground)_30%,transparent)]"
                            />
                          )}
                          {it.line_note && !expanded && <p className="mt-0.5 line-clamp-2 whitespace-pre-line text-xs text-muted-foreground">{it.line_note}</p>}
                          <div className="mt-2 grid grid-cols-2 items-end gap-2 sm:grid-cols-[auto_8rem_8rem_1fr]">
                            <div className="col-span-2 flex w-max items-center rounded-md bg-fg-4 sm:col-span-1">
                              <button type="button" className="grid h-9 w-9 place-items-center rounded-md hover:bg-fg-10" aria-label="Menos" onClick={() => patch(it.key, { quantity: Math.max(0.001, +(it.quantity - 1).toFixed(3)) || 1 })}>
                                <Minus size={14} />
                              </button>
                              <input
                                type="number"
                                inputMode="decimal"
                                min={0}
                                step="any"
                                value={it.quantity}
                                aria-label="Cantidad"
                                onChange={(e) => patch(it.key, { quantity: Math.max(0, Number(e.target.value) || 0) })}
                                className="h-9 w-12 bg-transparent text-center text-sm tabular-nums outline-none"
                              />
                              <button type="button" className="grid h-9 w-9 place-items-center rounded-md hover:bg-fg-10" aria-label="Más" onClick={() => patch(it.key, { quantity: +(it.quantity + 1).toFixed(3) })}>
                                <Plus size={14} />
                              </button>
                            </div>
                            <label className="text-[11px] text-muted-foreground">
                              Precio
                              <input type="number" inputMode="decimal" min={0} step="0.01" value={it.unit_price} onChange={(e) => patch(it.key, { unit_price: Math.max(0, Number(e.target.value) || 0) })} className={smallNum} />
                            </label>
                            <label className="text-[11px] text-muted-foreground">
                              Descuento
                              <input type="number" inputMode="decimal" min={0} step="0.01" value={it.discount || ""} placeholder="0" onChange={(e) => patch(it.key, { discount: Math.max(0, Number(e.target.value) || 0) })} className={smallNum} />
                            </label>
                            <p className="col-span-2 text-right font-price text-sm font-semibold tabular-nums sm:col-span-1 sm:self-center">
                              {formatCurrency(lineSubtotal(it))}
                            </p>
                          </div>
                          {expanded && (
                            <div className="mt-2 space-y-2">
                              {it.is_service && (
                                <label className="block text-xs text-muted-foreground">
                                  Descripción ampliada (vacía = la del servicio)
                                  <textarea
                                    className={cn(textareaCls, "mt-1")}
                                    value={it.line_detail ?? ""}
                                    onChange={(e) => patch(it.key, { line_detail: e.target.value })}
                                    maxLength={2000}
                                    placeholder={"Recuento de aerobios mesófilos\n- Informe firmado"}
                                  />
                                </label>
                              )}
                              <label className="block text-xs text-muted-foreground">
                                Aclaración del renglón
                                <textarea
                                  className={cn(textareaCls, "mt-1")}
                                  value={it.line_note}
                                  onChange={(e) => patch(it.key, { line_note: e.target.value })}
                                  maxLength={1000}
                                  placeholder="Lote, dirección del relevamiento, N° de muestra, normativa"
                                />
                              </label>
                            </div>
                          )}
                        </div>
                        <div className="flex shrink-0 flex-col gap-1">
                          <button
                            type="button"
                            onClick={() => setOpenKey(expanded ? null : it.key)}
                            className={cn("grid h-9 w-9 place-items-center rounded-md hover:bg-fg-6", expanded ? "text-foreground" : "text-muted-foreground")}
                            aria-label="Aclaración del renglón"
                            aria-expanded={expanded}
                          >
                            <PenLine size={15} />
                          </button>
                          <button
                            type="button"
                            onClick={() => setItems((xs) => xs.filter((x) => x.key !== it.key))}
                            className="grid h-9 w-9 place-items-center rounded-md text-muted-foreground hover:bg-danger/15 hover:text-danger"
                            aria-label="Quitar renglón"
                          >
                            <Trash2 size={15} />
                          </button>
                        </div>
                      </div>
                    </li>
                  );
                })}
              </ul>
            )}
          </Block>

          <Block title="Condiciones y notas">
            <label className="block text-xs font-medium text-muted-foreground">
              Condiciones (forma de pago, plazos, qué incluye)
              <textarea className={cn(textareaCls, "mt-1.5")} value={terms} onChange={(e) => setTerms(e.target.value)} maxLength={2000} placeholder="50 % de anticipo y saldo contra entrega del informe. Plazo de entrega: 10 días hábiles." />
            </label>
            <label className="block text-xs font-medium text-muted-foreground">
              Notas para el cliente
              <textarea className={cn(textareaCls, "mt-1.5")} value={notes} onChange={(e) => setNotes(e.target.value)} maxLength={2000} />
            </label>
            <label className="flex min-h-11 cursor-pointer items-center justify-between gap-3 rounded-lg bg-fg-4 px-3 py-2 text-sm">
              <span>
                Espacio para firma de aceptación
                <span className="block text-xs text-muted-foreground">Firma, aclaración y fecha al pie del documento.</span>
              </span>
              <Switch checked={signature} onCheckedChange={setSignature} label="Espacio para firma" />
            </label>
            {wasSent && (
              <Input variant="filled" label="Motivo del cambio (opcional, queda en el historial)" value={reason} onChange={(e) => setReason(e.target.value)} maxLength={300} />
            )}
          </Block>
        </section>

        {/* Total, validez, envío y guardar */}
        <aside className="flex flex-col border-t border-border bg-fg-4 md:min-h-0 md:border-l md:border-t-0">
          <div className="flex-1 space-y-6 px-4 pb-5 pt-4 md:slim-scrollbar md:min-h-0 md:overflow-y-auto md:px-5 md:pt-6">
            <div className="md:pr-8">
              <p className={POS_EYEBROW}>Total del presupuesto</p>
              <p className="mt-1 font-price text-4xl font-bold leading-tight tracking-tight tabular-nums text-foreground">{formatCurrency(totals.total)}</p>
              <div className="mt-3 space-y-1.5 text-sm">
                <div className="flex justify-between text-muted-foreground">
                  <span>Subtotal</span>
                  <span className="font-price tabular-nums">{formatCurrency(totals.subtotal)}</span>
                </div>
                <div className="flex items-center justify-between gap-2 text-muted-foreground">
                  <span>Descuento general</span>
                  <input type="number" inputMode="decimal" min={0} step="0.01" value={discount || ""} placeholder="0" aria-label="Descuento general" onChange={(e) => setDiscount(Math.max(0, Number(e.target.value) || 0))} className={cn(smallNum, "w-28 bg-card")} />
                </div>
              </div>
            </div>

            <div className="space-y-2.5">
              <p className={POS_EYEBROW}>Validez</p>
              <Segmented<Validity>
                value={validity}
                onChange={setValidity}
                fill
                aria-label="Validez del presupuesto"
                options={[
                  { value: "date", label: "Con vencimiento" },
                  { value: "none", label: "Sin vencimiento" },
                ]}
              />
              {validity === "date" ? (
                <Input variant="filled" type="date" label="Válido hasta" value={validUntil} min={todayArIso()} onChange={(e) => setValidUntil(e.target.value)} />
              ) : (
                <p className="rounded-lg bg-card px-3 py-2.5 text-xs leading-relaxed text-muted-foreground">
                  Precio de referencia: nunca pasa a vencido. El documento dice «{QUOTE_NO_EXPIRY_LEGEND}»
                </p>
              )}
            </div>

            <div className="space-y-3">
              <div>
                <p className={POS_EYEBROW}>A quién se lo mandás</p>
                <p className="mt-1 text-xs text-muted-foreground">
                  Datos del cliente. {customerId ? "Vienen de su ficha; los podés cambiar para este presupuesto." : "Elegí un cliente para traer los de su ficha."}
                </p>
              </div>
              <EmailChipsInput
                label="Email del cliente"
                hint="Podés cargar varios: el presupuesto le llega a cada uno."
                value={customerEmails}
                onChange={setCustomerEmails}
              />
              <Input
                variant="filled"
                label="WhatsApp del cliente"
                inputMode="tel"
                placeholder="341 555-1234"
                value={customerPhone}
                onChange={(e) => setCustomerPhone(e.target.value)}
                maxLength={40}
              />
            </div>

            <QuoteContactCard brand={brand} />
          </div>
          <div className="hidden shrink-0 border-t border-border bg-popover px-5 py-4 md:block">{cta}</div>
        </aside>
      </div>
      {/* Celular: guardar siempre a mano. */}
      <div className="shrink-0 border-t border-border bg-popover px-4 pb-3 pt-3 md:hidden">{cta}</div>
    </PosSheet>
  );
}
