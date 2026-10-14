"use client";

// Alta y edición de un presupuesto (ADR-122). Cliente (de la ficha o datos
// sueltos), renglones de productos y servicios (con la aclaración de cada
// renglón y la descripción ampliada de ADR-116), descuento, validez,
// condiciones, notas y firma. Los totales los recalcula la base (quote_save).
import { useEffect, useMemo, useState } from "react";
import { BriefcaseBusiness, Minus, Package, PenLine, Plus, Search, Trash2, User, X } from "lucide-react";
import { Modal } from "@/components/ui/Modal";
import { Button } from "@/components/ui/Button";
import { Input } from "@/components/ui/Input";
import { Switch } from "@/components/ui/Switch";
import { useToast } from "@/components/ui/Toast";
import { ProductSearchCombobox } from "@/components/products/ProductSearchCombobox";
import { useCustomersForPicker } from "@/modules/customers/hooks";
import { variantLabel, variantPrice } from "@/modules/products/api";
import { useQuoteMutations, useQuoteSettings } from "@/modules/quotes/hooks";
import type { QuoteSaveResult } from "@/modules/quotes/api";
import {
  addDaysIso,
  lineSubtotal,
  quoteErrorMessage,
  quoteNumberLabel,
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

const textareaCls =
  "min-h-[76px] w-full rounded-lg border border-border bg-background/40 px-3 py-2 text-sm text-foreground outline-none transition-colors placeholder:text-muted-foreground focus:border-[color-mix(in_srgb,var(--foreground)_30%,transparent)]";
const smallNum =
  "h-9 w-full rounded-md border border-border bg-background/40 px-2 text-right text-sm tabular-nums text-foreground outline-none focus:border-[color-mix(in_srgb,var(--foreground)_30%,transparent)]";

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

  const [customerId, setCustomerId] = useState<string | null>(null);
  const [customerName, setCustomerName] = useState("");
  const [customerDoc, setCustomerDoc] = useState("");
  const [customerEmail, setCustomerEmail] = useState("");
  const [customerPhone, setCustomerPhone] = useState("");
  const [search, setSearch] = useState("");
  const [items, setItems] = useState<DraftItem[]>([]);
  const [discount, setDiscount] = useState(0);
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
    if (quote) {
      setCustomerId(quote.customer_id);
      setCustomerName(quote.customer_name ?? "");
      setCustomerDoc(quote.customer_doc ?? "");
      setCustomerEmail(quote.customer_email ?? "");
      setCustomerPhone(quote.customer_phone ?? "");
      setItems(quote.items.map(fromQuoteItem));
      setDiscount(Number(quote.discount_total) || 0);
      setValidUntil(quote.valid_until.slice(0, 10) < today ? addDaysIso(today, settings?.validity_days ?? 15) : quote.valid_until.slice(0, 10));
      setTerms(quote.terms ?? "");
      setNotes(quote.notes ?? "");
      setSignature(quote.show_signature);
    } else {
      setCustomerId(null);
      setCustomerName("");
      setCustomerDoc("");
      setCustomerEmail("");
      setCustomerPhone("");
      setItems([]);
      setDiscount(0);
      setValidUntil(addDaysIso(today, settings?.validity_days ?? 15));
      setTerms(settings?.default_terms ?? "");
      setNotes("");
      setSignature(settings?.show_signature ?? true);
    }
    setSearch("");
    setReason("");
    setOpenKey(null);
    // settings: sólo los defaults de un alta.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, quote?.id, settings?.validity_days]);

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
    try {
      const r = await m.save.mutateAsync({
        quote: {
          ...(quote ? { id: quote.id } : {}),
          customer_id: customerId,
          customer_name: customerId ? null : customerName.trim() || null,
          customer_doc: customerId ? null : customerDoc.trim() || null,
          customer_email: customerEmail.trim() || null,
          customer_phone: customerPhone.trim() || null,
          valid_until: validUntil,
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

  return (
    <Modal
      open={open}
      onOpenChange={onOpenChange}
      title={quote ? `Editar presupuesto ${quoteNumberLabel(quote.pto_vta, quote.number)}` : "Nuevo presupuesto"}
      description={
        wasSent
          ? "Ya lo vio el cliente: al guardar se crea una revisión nueva y vuelve a borrador."
          : "No cobra ni mueve stock. Lo podés convertir en venta cuando el cliente acepte."
      }
      className="sm:max-w-3xl"
      footer={
        <div className="flex w-full flex-col-reverse gap-2 sm:flex-row sm:items-center sm:justify-between">
          <p className="text-sm text-muted-foreground">
            Total <span className="font-price text-lg font-bold tabular-nums text-foreground">{formatCurrency(totals.total)}</span>
          </p>
          <div className="flex gap-2">
            <Button variant="secondary" onClick={() => onOpenChange(false)}>
              Cancelar
            </Button>
            <Button onClick={submit} loading={m.save.isPending}>
              {editing ? "Guardar cambios" : "Guardar presupuesto"}
            </Button>
          </div>
        </div>
      }
    >
      <div className="space-y-6">
        {/* Cliente */}
        <section className="space-y-3">
          <h3 className="text-sm font-semibold">Cliente</h3>
          {customerId ? (
            <div className="flex h-11 items-center gap-2.5 rounded-lg bg-fg-4 pl-2 pr-1.5 text-sm">
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
                className="grid h-8 w-8 place-items-center rounded-md text-muted-foreground hover:bg-fg-6 hover:text-foreground"
                aria-label="Quitar cliente"
              >
                <X size={16} />
              </button>
            </div>
          ) : (
            <>
              <div className="relative">
                <Search size={15} className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-muted-foreground" />
                <input
                  value={search}
                  onChange={(e) => setSearch(e.target.value)}
                  placeholder="Buscar en tus clientes por nombre, documento o teléfono"
                  aria-label="Buscar cliente"
                  className="h-11 w-full rounded-lg border border-border bg-background/40 pl-9 pr-3 text-sm text-foreground outline-none placeholder:text-muted-foreground focus:border-[color-mix(in_srgb,var(--foreground)_30%,transparent)]"
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
                          setCustomerEmail(c.email ?? "");
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
                <Input variant="filled" label="Nombre o razón social" value={customerName} onChange={(e) => setCustomerName(e.target.value)} maxLength={160} />
                <Input variant="filled" label="CUIT o DNI" value={customerDoc} onChange={(e) => setCustomerDoc(e.target.value)} maxLength={40} />
              </div>
            </>
          )}
          <div className="grid gap-3 sm:grid-cols-2">
            <Input variant="filled" label="Email" type="email" value={customerEmail} onChange={(e) => setCustomerEmail(e.target.value)} maxLength={160} />
            <Input variant="filled" label="Teléfono (WhatsApp)" inputMode="tel" value={customerPhone} onChange={(e) => setCustomerPhone(e.target.value)} maxLength={40} />
          </div>
        </section>

        {/* Renglones */}
        <section className="space-y-3">
          <div className="flex items-center justify-between gap-2">
            <h3 className="text-sm font-semibold">Productos y servicios</h3>
            <Button size="sm" variant="ghost" onClick={addFree}>
              <Plus size={15} /> Renglón libre
            </Button>
          </div>
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
            <p className="rounded-lg bg-fg-4 px-3 py-4 text-center text-sm text-muted-foreground">
              Buscá un servicio o producto, o agregá un renglón libre.
            </p>
          ) : (
            <ul className="divide-y divide-border rounded-lg border border-border">
              {items.map((it) => {
                const expanded = openKey === it.key;
                return (
                  <li key={it.key} className="p-2.5">
                    <div className="flex items-start gap-2">
                      <span
                        className={cn(
                          "mt-1 grid h-7 w-7 shrink-0 place-items-center rounded-md bg-fg-6",
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
                        <div className="mt-2 grid grid-cols-[auto_1fr_1fr] items-center gap-2 sm:grid-cols-[auto_8rem_8rem_1fr]">
                          <div className="flex items-center rounded-md bg-fg-4">
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
                          <p className="col-span-3 text-right font-price text-sm font-semibold tabular-nums sm:col-span-1">
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
          <div className="ml-auto max-w-xs space-y-1.5 text-sm">
            <div className="flex justify-between text-muted-foreground">
              <span>Subtotal</span>
              <span className="font-price tabular-nums">{formatCurrency(totals.subtotal)}</span>
            </div>
            <div className="flex items-center justify-between gap-2 text-muted-foreground">
              <span>Descuento general</span>
              <input type="number" inputMode="decimal" min={0} step="0.01" value={discount || ""} placeholder="0" aria-label="Descuento general" onChange={(e) => setDiscount(Math.max(0, Number(e.target.value) || 0))} className={cn(smallNum, "w-28")} />
            </div>
            <div className="flex justify-between border-t border-border pt-2 font-semibold">
              <span>Total</span>
              <span className="font-price tabular-nums">{formatCurrency(totals.total)}</span>
            </div>
          </div>
        </section>

        {/* Validez y condiciones */}
        <section className="space-y-3">
          <h3 className="text-sm font-semibold">Validez y condiciones</h3>
          <div className="grid gap-3 sm:grid-cols-2">
            <Input variant="filled" type="date" label="Válido hasta" value={validUntil} min={todayArIso()} onChange={(e) => setValidUntil(e.target.value)} />
            <div className="flex items-end">
              <label className="flex h-11 w-full cursor-pointer items-center justify-between gap-2 rounded-lg bg-fg-4 px-3 text-sm">
                <span>Espacio para firma de aceptación</span>
                <Switch checked={signature} onCheckedChange={setSignature} label="Espacio para firma" />
              </label>
            </div>
          </div>
          <label className="block text-xs font-medium text-muted-foreground">
            Condiciones (forma de pago, plazos, qué incluye)
            <textarea className={cn(textareaCls, "mt-1.5")} value={terms} onChange={(e) => setTerms(e.target.value)} maxLength={2000} placeholder="50 % de anticipo y saldo contra entrega del informe. Plazo de entrega: 10 días hábiles." />
          </label>
          <label className="block text-xs font-medium text-muted-foreground">
            Notas para el cliente
            <textarea className={cn(textareaCls, "mt-1.5")} value={notes} onChange={(e) => setNotes(e.target.value)} maxLength={2000} />
          </label>
          {wasSent && (
            <Input variant="filled" label="Motivo del cambio (opcional, queda en el historial)" value={reason} onChange={(e) => setReason(e.target.value)} maxLength={300} />
          )}
        </section>
      </div>
    </Modal>
  );
}
