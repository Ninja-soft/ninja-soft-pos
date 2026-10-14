"use client";

// Enviar el presupuesto por email (ADR-123). Reemplaza el mailto: el negocio
// elige los destinatarios (emails DEL CLIENTE, como chips), revisa el asunto y
// el mensaje (prellenados con la plantilla de Configuración → Presupuestos o
// la de NinjaSoft) y ve cómo le llega. Sale por la Edge send_quote_email con
// el PDF de la vista previa adjunto; cada envío queda en el historial.
import { useEffect, useMemo, useState } from "react";
import { Eye, Mail, Paperclip, PenLine } from "lucide-react";
import { Modal } from "@/components/ui/Modal";
import { Button } from "@/components/ui/Button";
import { Input } from "@/components/ui/Input";
import { Segmented } from "@/components/ui/Segmented";
import { useToast } from "@/components/ui/Toast";
import { EmailChipsInput } from "@/components/quotes/EmailChipsInput";
import { useQuoteMutations, useQuoteSettings } from "@/modules/quotes/hooks";
import { buildQuoteEmailHtml } from "@/lib/email/quoteTemplate";
import {
  QUOTE_EMAIL_DEFAULT_MESSAGE,
  QUOTE_EMAIL_DEFAULT_SUBJECT,
  fillQuoteTemplate,
  quoteEmailVars,
  quoteErrorMessage,
  quoteNumberLabel,
  quoteRecipients,
  quoteValidityText,
  type Quote,
  type QuoteBrand,
} from "@/lib/quotes/logic";
import { formatCurrency } from "@/lib/utils/format";

type Tab = "edit" | "preview";

export function QuoteEmailDialog({
  open,
  onOpenChange,
  quote,
  brand,
  accent,
  logoUrl,
  formatLabel,
  getPdfNode,
}: {
  open: boolean;
  onOpenChange: (o: boolean) => void;
  quote: Quote;
  brand: QuoteBrand | null;
  /** Color y logo del negocio (los del comprobante). */
  accent: string;
  logoUrl: string | null;
  /** "Hoja A4" / "Ticket 80 mm": el PDF adjunto es el de la vista previa. */
  formatLabel: string;
  getPdfNode: () => HTMLElement | null;
}) {
  const { toast } = useToast();
  const m = useQuoteMutations();
  const { data: settings } = useQuoteSettings(open);
  const businessName = brand?.trade_name || brand?.legal_name || "Mi negocio";
  const [to, setTo] = useState<string[]>([]);
  const [subject, setSubject] = useState("");
  const [message, setMessage] = useState("");
  const [tab, setTab] = useState<Tab>("edit");

  useEffect(() => {
    if (!open) return;
    const vars = quoteEmailVars(quote, businessName);
    setTo(quoteRecipients(quote));
    setSubject(fillQuoteTemplate(settings?.email_subject?.trim() || QUOTE_EMAIL_DEFAULT_SUBJECT, vars));
    setMessage(fillQuoteTemplate(settings?.email_message?.trim() || QUOTE_EMAIL_DEFAULT_MESSAGE, vars));
    setTab("edit");
    // Al abrir: plantilla con los datos de este presupuesto.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, quote.id, settings?.email_subject, settings?.email_message]);

  const label = quoteNumberLabel(quote.pto_vta, quote.number);
  const html = useMemo(
    () =>
      tab === "preview"
        ? buildQuoteEmailHtml({
            accent,
            logoUrl: logoUrl ?? "",
            businessName,
            numberLabel: label,
            message,
            totalText: formatCurrency(Number(quote.total)),
            validityText: quoteValidityText(quote.valid_until),
            issuedBy: quote.created_by_name ?? "",
            link: "https://pos.soft.ninja/presupuesto/vista-previa",
            contactText: [brand?.phone ? `Tel. ${brand.phone}` : "", brand?.email ?? ""].filter(Boolean).join(" · "),
          })
        : "",
    [tab, accent, logoUrl, businessName, label, message, quote.total, quote.valid_until, quote.created_by_name, brand?.phone, brand?.email],
  );

  async function send() {
    if (to.length === 0) {
      toast({ title: "Cargá al menos un email del cliente", variant: "error" });
      return;
    }
    if (!subject.trim()) {
      toast({ title: "Escribí el asunto", variant: "error" });
      return;
    }
    const node = getPdfNode();
    if (!node) {
      toast({ title: "No se pudo generar el PDF", variant: "error" });
      return;
    }
    try {
      const r = await m.sendEmail.mutateAsync({
        quoteId: quote.id,
        to,
        subject: subject.trim(),
        message: message.trim(),
        node,
        pdfName: `presupuesto-${label}.pdf`,
      });
      if (r.failed === 0) {
        toast({ title: to.length === 1 ? "Presupuesto enviado" : `Presupuesto enviado a ${r.sent} destinatarios`, variant: "success" });
        onOpenChange(false);
      } else if (r.sent > 0) {
        const bad = r.results.filter((x) => !x.ok).map((x) => x.recipient);
        toast({ title: `Enviado a ${r.sent}, falló con ${bad.join(", ")}`, description: "Quedó en el historial. Probá de nuevo con esos.", variant: "warning" });
        setTo(bad);
      } else {
        toast({ title: "No se pudo enviar", description: quoteErrorMessage("send_failed"), variant: "error" });
      }
    } catch (e) {
      toast({ title: "No se pudo enviar", description: quoteErrorMessage(e), variant: "error" });
    }
  }

  return (
    <Modal
      open={open}
      onOpenChange={onOpenChange}
      title="Enviar por email"
      description={`Presupuesto N° ${label} con el PDF adjunto.`}
      className="sm:max-w-2xl"
      footer={
        <div className="flex w-full flex-col-reverse gap-2 sm:flex-row sm:items-center sm:justify-between">
          <p className="flex items-center gap-1.5 text-xs text-muted-foreground">
            <Paperclip size={13} aria-hidden /> presupuesto-{label}.pdf ({formatLabel})
          </p>
          <div className="flex gap-2">
            <Button variant="secondary" onClick={() => onOpenChange(false)}>
              Cancelar
            </Button>
            <Button onClick={send} loading={m.sendEmail.isPending} disabled={to.length === 0}>
              <Mail size={15} /> Enviar{to.length > 1 ? ` a ${to.length}` : ""}
            </Button>
          </div>
        </div>
      }
    >
      <div className="space-y-4">
        <EmailChipsInput
          label="Email del cliente"
          hint="Le llega a cada uno por separado. Se precargan los del presupuesto."
          value={to}
          onChange={setTo}
        />
        <div className="flex justify-end">
          <Segmented<Tab>
            size="sm"
            value={tab}
            onChange={setTab}
            aria-label="Mensaje o vista previa"
            options={[
              { value: "edit", label: "Mensaje", icon: <PenLine size={14} aria-hidden /> },
              { value: "preview", label: "Cómo le llega", icon: <Eye size={14} aria-hidden /> },
            ]}
          />
        </div>
        {tab === "edit" ? (
          <>
            <Input variant="filled" label="Asunto" value={subject} onChange={(e) => setSubject(e.target.value)} maxLength={200} />
            <label className="block text-xs font-medium text-muted-foreground">
              Mensaje
              <textarea
                value={message}
                onChange={(e) => setMessage(e.target.value)}
                maxLength={4000}
                rows={9}
                className="mt-1.5 w-full rounded-lg border border-border bg-background/40 px-3 py-2 text-sm leading-relaxed text-foreground outline-none placeholder:text-muted-foreground focus:border-[color-mix(in_srgb,var(--foreground)_30%,transparent)]"
              />
            </label>
            <p className="text-xs text-muted-foreground">
              Debajo del mensaje va el resumen ({formatCurrency(Number(quote.total))} · {quoteValidityText(quote.valid_until).toLowerCase()}) y el botón para verlo y aceptarlo en línea.
              {brand?.email ? ` Las respuestas llegan a ${brand.email}.` : " Cargá tu email de contacto en Configuración → Presupuestos para recibir las respuestas."}
            </p>
          </>
        ) : (
          <div className="overflow-hidden rounded-lg border border-border">
            <p className="border-b border-border bg-fg-4 px-3 py-2 text-xs text-muted-foreground">
              <span className="font-semibold text-foreground">{subject || "(sin asunto)"}</span> · De: {businessName}
            </p>
            <iframe title="Vista previa del email" srcDoc={html} sandbox="" className="h-[460px] w-full bg-white" />
          </div>
        )}
      </div>
    </Modal>
  );
}
