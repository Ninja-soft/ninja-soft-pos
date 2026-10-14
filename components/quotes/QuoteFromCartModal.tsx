"use client";

// "Presupuesto" del POS (ADR-122): guarda el carrito como presupuesto sin
// cobrar ni mover stock. Pide validez, condiciones y el contacto para
// mandarlo; después ofrece verlo o mandarlo por WhatsApp.
import { useEffect, useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import type { Route } from "next";
import { CheckCircle2, ExternalLink, MessageCircle } from "lucide-react";
import { Modal } from "@/components/ui/Modal";
import { Button } from "@/components/ui/Button";
import { Input } from "@/components/ui/Input";
import { useToast } from "@/components/ui/Toast";
import { useQuoteMutations, useQuoteSettings } from "@/modules/quotes/hooks";
import type { QuoteSaveResult } from "@/modules/quotes/api";
import {
  addDaysIso,
  cartToQuoteItems,
  publicQuoteUrl,
  quoteErrorMessage,
  quoteNumberLabel,
  quoteShareText,
  quoteTotals,
  todayArIso,
  whatsappUrl,
  type CartLineLike,
} from "@/lib/quotes/logic";
import { formatCurrency } from "@/lib/utils/format";
import { cn } from "@/lib/utils/cn";

const textareaCls =
  "mt-1.5 min-h-[72px] w-full rounded-lg border border-border bg-background/40 px-3 py-2 text-sm text-foreground outline-none placeholder:text-muted-foreground focus:border-[color-mix(in_srgb,var(--foreground)_30%,transparent)]";

export function QuoteFromCartModal({
  open,
  onOpenChange,
  lines,
  discountTotal,
  customer,
  servicePeriod,
  businessName,
  onSaved,
}: {
  open: boolean;
  onOpenChange: (o: boolean) => void;
  lines: CartLineLike[];
  discountTotal: number;
  customer: { id: string; name: string } | null;
  servicePeriod?: { from: string; to: string } | null;
  businessName: string;
  /** El carrito ya quedó guardado como presupuesto: el POS lo vacía. */
  onSaved: (r: QuoteSaveResult) => void;
}) {
  const { toast } = useToast();
  const router = useRouter();
  const m = useQuoteMutations();
  const { data: settings } = useQuoteSettings(open);
  const [name, setName] = useState("");
  const [phone, setPhone] = useState("");
  const [email, setEmail] = useState("");
  const [validUntil, setValidUntil] = useState("");
  const [terms, setTerms] = useState("");
  const [notes, setNotes] = useState("");
  const [saved, setSaved] = useState<(QuoteSaveResult & { valid_until: string }) | null>(null);

  useEffect(() => {
    if (!open) return;
    setSaved(null);
    setName("");
    setPhone("");
    setEmail("");
    setNotes("");
    setValidUntil(addDaysIso(todayArIso(), settings?.validity_days ?? 15));
    setTerms(settings?.default_terms ?? "");
  }, [open, settings?.validity_days, settings?.default_terms]);

  const items = useMemo(() => cartToQuoteItems(lines), [lines]);
  const totals = useMemo(
    () =>
      quoteTotals(
        lines.filter((l) => !l.giftPromoId && !l.packCreditId).map((l) => ({ quantity: l.quantity, unit_price: l.unitPrice, discount: l.discount })),
        discountTotal,
      ),
    [lines, discountTotal],
  );

  async function save() {
    if (items.length === 0) {
      toast({ title: "El carrito está vacío", variant: "error" });
      return;
    }
    try {
      const r = await m.save.mutateAsync({
        quote: {
          customer_id: customer?.id ?? null,
          customer_name: customer ? null : name.trim() || null,
          customer_phone: phone.trim() || null,
          customer_email: email.trim() || null,
          valid_until: validUntil,
          terms: terms.trim(),
          notes: notes.trim(),
          discount_total: totals.discount,
          service_from: servicePeriod?.from ?? null,
          service_to: servicePeriod?.to ?? null,
        },
        items,
      });
      setSaved({ ...r, valid_until: validUntil });
      onSaved(r);
    } catch (e) {
      toast({ title: "No se pudo guardar el presupuesto", description: quoteErrorMessage(e), variant: "error" });
    }
  }

  async function sendWhatsapp() {
    if (!saved) return;
    const w = window.open("about:blank", "_blank");
    let url: string | null = null;
    try {
      const s = await m.share.mutateAsync(saved.id);
      url = publicQuoteUrl(window.location.origin, s.token);
    } catch (e) {
      toast({ title: "No se pudo generar el link", description: quoteErrorMessage(e), variant: "error" });
    }
    const href = whatsappUrl(phone, quoteShareText({ ...saved, valid_until: saved.valid_until }, businessName, url));
    if (w) w.location.href = href;
    else window.location.href = href;
  }

  if (saved) {
    return (
      <Modal
        open={open}
        onOpenChange={onOpenChange}
        title="Presupuesto guardado"
        footer={
          <div className="flex w-full flex-col gap-2 sm:flex-row sm:justify-end">
            <Button variant="secondary" onClick={() => router.push(`/presupuestos?id=${saved.id}` as Route)}>
              <ExternalLink size={15} /> Ver presupuesto
            </Button>
            <Button variant="secondary" onClick={sendWhatsapp} loading={m.share.isPending}>
              <MessageCircle size={15} /> Mandar por WhatsApp
            </Button>
            <Button onClick={() => onOpenChange(false)}>Listo</Button>
          </div>
        }
      >
        <div className="flex flex-col items-center gap-2 py-2 text-center">
          <CheckCircle2 size={36} className="text-success" aria-hidden />
          <p className="font-display text-xl font-bold tabular-nums">N° {quoteNumberLabel(saved.pto_vta, saved.number)}</p>
          <p className="text-sm text-muted-foreground">
            {formatCurrency(saved.total)} · no se cobró ni se movió stock. El carrito quedó libre para otra venta.
          </p>
        </div>
      </Modal>
    );
  }

  return (
    <Modal
      open={open}
      onOpenChange={onOpenChange}
      title="Guardar como presupuesto"
      description="No se cobra ni se mueve stock. Después lo convertís en venta con un click."
      footer={
        <div className="flex w-full items-center justify-between gap-2">
          <span className="font-price text-lg font-bold tabular-nums">{formatCurrency(totals.total)}</span>
          <div className="flex gap-2">
            <Button variant="secondary" onClick={() => onOpenChange(false)}>
              Cancelar
            </Button>
            <Button onClick={save} loading={m.save.isPending} disabled={items.length === 0}>
              Guardar presupuesto
            </Button>
          </div>
        </div>
      }
    >
      <div className="space-y-4">
        <div className="rounded-lg bg-fg-4 px-3 py-2.5 text-sm">
          <p className="font-medium">{customer ? customer.name : "Sin cliente elegido"}</p>
          <p className="text-xs text-muted-foreground">
            {items.length} {items.length === 1 ? "renglón" : "renglones"}
            {lines.length !== items.length ? " (los regalos y sesiones de pack no van al presupuesto)" : ""}
          </p>
        </div>
        {!customer && (
          <Input variant="filled" label="Nombre o razón social del cliente" value={name} onChange={(e) => setName(e.target.value)} maxLength={160} />
        )}
        <div className="grid gap-3 sm:grid-cols-2">
          <Input variant="filled" label="WhatsApp" inputMode="tel" value={phone} onChange={(e) => setPhone(e.target.value)} maxLength={40} />
          <Input variant="filled" label="Email" type="email" value={email} onChange={(e) => setEmail(e.target.value)} maxLength={160} />
        </div>
        <Input variant="filled" type="date" label="Válido hasta" min={todayArIso()} value={validUntil} onChange={(e) => setValidUntil(e.target.value)} />
        <label className="block text-xs font-medium text-muted-foreground">
          Condiciones
          <textarea className={textareaCls} value={terms} onChange={(e) => setTerms(e.target.value)} maxLength={2000} placeholder="Forma de pago, plazo de entrega, qué incluye" />
        </label>
        <label className={cn("block text-xs font-medium text-muted-foreground")}>
          Notas para el cliente
          <textarea className={textareaCls} value={notes} onChange={(e) => setNotes(e.target.value)} maxLength={2000} />
        </label>
      </div>
    </Modal>
  );
}
