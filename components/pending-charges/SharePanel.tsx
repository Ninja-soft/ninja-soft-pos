"use client";

import { useState } from "react";
import { Check, Copy, Mail, MessageCircle, MessageSquareText, Send, Share2 } from "lucide-react";
import { Button } from "@/components/ui/Button";
import { Input } from "@/components/ui/Input";
import { useToast } from "@/components/ui/Toast";
import { cn } from "@/lib/utils/cn";
import {
  buildShareMessage,
  isValidEmail,
  mailtoUrl,
  shareSubject,
  smsUrl,
  whatsappUrl,
  type ShareChannel,
} from "@/modules/pending-charges/logic";

// Compartir el link de pago (ADR-048): compartir del sistema (Web Share API)
// cuando el navegador lo tiene, y opciones explícitas: WhatsApp con el texto
// armado, email (envío del servidor con el diseño del negocio, o la app de
// correo), copiar link y SMS. Cada uso se informa con onShared para la línea
// de tiempo del cobro.

const opt =
  "flex min-h-[64px] flex-col items-center justify-center gap-1.5 rounded-xl bg-fg-4 px-2 py-2.5 text-xs font-medium text-foreground transition hover:bg-fg-6 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring";

export function SharePanel({
  url,
  amountLabel,
  businessName,
  customerName,
  customerPhone,
  customerEmail,
  onShared,
  onServerEmail,
  serverEmailLabel = "Enviar email",
  className,
}: {
  url: string;
  amountLabel: string;
  businessName: string | null;
  customerName: string | null;
  customerPhone?: string | null;
  customerEmail?: string | null;
  onShared?: (via: ShareChannel, to?: string | null) => void;
  /** Envío por el servidor (Edge pending_charge_share). Sin esto, mailto. */
  onServerEmail?: (to: string, note: string) => Promise<void>;
  serverEmailLabel?: string;
  className?: string;
}) {
  const { toast } = useToast();
  const [copied, setCopied] = useState(false);
  const [emailOpen, setEmailOpen] = useState(false);
  const [email, setEmail] = useState(customerEmail ?? "");
  const [note, setNote] = useState("");
  const [phone, setPhone] = useState(customerPhone ?? "");
  const [sending, setSending] = useState(false);
  const text = buildShareMessage({ businessName, customerName, amountLabel, url });
  const subject = shareSubject({ businessName, amountLabel });
  const canNative = typeof navigator !== "undefined" && typeof navigator.share === "function";

  async function native() {
    try {
      await navigator.share({ title: subject, text, url });
      onShared?.("native");
    } catch {
      /* el usuario cerró el diálogo de compartir */
    }
  }

  async function copy() {
    try {
      await navigator.clipboard.writeText(url);
      setCopied(true);
      setTimeout(() => setCopied(false), 1800);
      onShared?.("copy");
      toast({ title: "Link copiado", variant: "success" });
    } catch {
      toast({ title: "No se pudo copiar el link", variant: "error" });
    }
  }

  function open(href: string, via: ShareChannel, to?: string | null) {
    window.open(href, "_blank", "noopener,noreferrer");
    onShared?.(via, to ?? null);
  }

  async function sendEmail() {
    const to = email.trim();
    if (!isValidEmail(to)) {
      toast({ title: "Escribí un email válido", variant: "error" });
      return;
    }
    if (!onServerEmail) {
      open(mailtoUrl(to, subject, text), "email", to);
      setEmailOpen(false);
      return;
    }
    setSending(true);
    try {
      await onServerEmail(to, note.trim());
      toast({ title: `Link enviado a ${to}`, variant: "success" });
      setEmailOpen(false);
    } catch (e) {
      const code = e instanceof Error ? e.message : "";
      toast({
        title:
          code === "rate_limited"
            ? "Se alcanzó el límite de envíos por email. Probá más tarde o compartilo por WhatsApp."
            : code === "no_email_provider"
              ? "El envío de emails no está configurado. Usá tu app de correo."
              : "No se pudo enviar el email",
        variant: "error",
      });
    } finally {
      setSending(false);
    }
  }

  return (
    <div className={cn("space-y-3 text-left", className)}>
      <div className="grid grid-cols-3 gap-2 sm:grid-cols-5">
        {canNative && (
          <button type="button" className={opt} onClick={native}>
            <Share2 size={18} aria-hidden /> Compartir
          </button>
        )}
        <button type="button" className={opt} onClick={() => open(whatsappUrl(phone || null, text), "whatsapp", phone || null)}>
          <MessageCircle size={18} aria-hidden className="text-success" /> WhatsApp
        </button>
        <button type="button" className={cn(opt, emailOpen && "bg-fg-10")} onClick={() => setEmailOpen((v) => !v)} aria-expanded={emailOpen}>
          <Mail size={18} aria-hidden /> Email
        </button>
        <button type="button" className={opt} onClick={copy}>
          {copied ? <Check size={18} aria-hidden className="text-success" /> : <Copy size={18} aria-hidden />}
          {copied ? "Copiado" : "Copiar link"}
        </button>
        <button type="button" className={opt} onClick={() => open(smsUrl(phone || null, text), "sms", phone || null)}>
          <MessageSquareText size={18} aria-hidden /> SMS
        </button>
      </div>

      <Input
        label="Celular del cliente (opcional, para WhatsApp y SMS)"
        inputMode="tel"
        placeholder="341 555 1234"
        value={phone}
        onChange={(e) => setPhone(e.target.value)}
      />

      {emailOpen && (
        <div className="space-y-2 rounded-xl bg-fg-4 p-3">
          <Input
            label="Email del cliente"
            type="email"
            autoComplete="email"
            placeholder="cliente@mail.com"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
          />
          {onServerEmail && (
            <Input
              label="Mensaje (opcional)"
              placeholder="Gracias por tu compra"
              value={note}
              maxLength={400}
              onChange={(e) => setNote(e.target.value)}
            />
          )}
          <div className="flex flex-wrap justify-end gap-2">
            {onServerEmail && (
              <Button
                variant="ghost"
                size="sm"
                onClick={() => open(mailtoUrl(email.trim() || null, subject, text), "email", email.trim() || null)}
              >
                Usar mi app de correo
              </Button>
            )}
            <Button size="sm" loading={sending} onClick={sendEmail}>
              <Send size={14} aria-hidden /> {onServerEmail ? serverEmailLabel : "Abrir email"}
            </Button>
          </div>
        </div>
      )}
    </div>
  );
}
