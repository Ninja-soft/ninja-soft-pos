"use client";

import { useRef, useState } from "react";
import { Mail } from "lucide-react";
import { useQueryClient } from "@tanstack/react-query";
import { createClient } from "@/lib/supabase/client";
import { exportNodePng } from "@/lib/tickets/exportPng";
import { Button } from "@/components/ui/Button";
import { useToast } from "@/components/ui/Toast";

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

// Helper compartido: exporta el ticket a PNG e invoca la Edge Function.
// Lanza Error con el código mapeable (smtp_not_configured, send_failed, …)
// como message. Reutilizado por el botón manual y el auto-envío del modal.
export async function sendReceiptEmail(
  saleId: string,
  to: string,
  node: HTMLElement,
): Promise<void> {
  const supabase = createClient();
  const png = await exportNodePng(node);
  const { data, error } = await supabase.functions.invoke("send_receipt_email", {
    body: { sale_id: saleId, to, png },
  });
  if (error) throw error;
  const errCode = (data as { error?: string } | null)?.error;
  if (errCode) throw new Error(errCode);
}

function mapError(message: string): string {
  if (message === "smtp_not_configured")
    return "El envío de emails no está configurado todavía.";
  return "No se pudo enviar el comprobante.";
}

interface Props {
  saleId: string;
  getTicketNode: () => HTMLElement | null;
  defaultEmail?: string | null;
  customerId?: string | null;
  sentTo?: string | null;
  sentAt?: string | null;
  // Cuando el dueño NO configuró el SMTP, deshabilitamos el botón con tooltip.
  // Solo se setea para owners (allowed:true && !configured): para cajeros el
  // estado es desconocido y NO gateamos (el server rechaza con error amable).
  smtpMissing?: boolean;
  // El estado abierto/cerrado del formulario lo controla el modal (el botón
  // disparador vive en la fila de acciones junto a Imprimir / A4).
  open: boolean;
  onOpenChange: (o: boolean) => void;
}

export function SendReceiptEmail({
  saleId,
  getTicketNode,
  defaultEmail,
  customerId,
  sentTo,
  sentAt,
  smtpMissing,
  open,
  onOpenChange,
}: Props) {
  const { toast } = useToast();
  const qc = useQueryClient();
  const [email, setEmail] = useState(defaultEmail ?? "");
  const [save, setSave] = useState(false);
  const [busy, setBusy] = useState(false);
  const busyRef = useRef(false);

  async function handleSend() {
    // Guard sincrónico anti doble-click (busy via estado llega un render tarde).
    if (busyRef.current) return;
    const to = email.trim();
    if (!EMAIL_RE.test(to)) {
      toast({ title: "Email inválido", variant: "error" });
      return;
    }
    const node = getTicketNode();
    if (!node) {
      toast({ title: "No se pudo generar el comprobante", variant: "error" });
      return;
    }
    busyRef.current = true;
    setBusy(true);
    try {
      await sendReceiptEmail(saleId, to, node);

      if (save && customerId) {
        const supabase = createClient();
        const { error } = await supabase
          .from("customers")
          .update({ email: to })
          .eq("id", customerId);
        if (error) {
          toast({
            title: "Comprobante enviado, pero no se pudo guardar el email en la ficha",
            variant: "error",
          });
        }
      }

      toast({ title: "Comprobante enviado", variant: "success" });
      onOpenChange(false);
      qc.invalidateQueries({ queryKey: ["sales", "detail", saleId] });
      qc.invalidateQueries({ queryKey: ["sales", "list"] });
    } catch (e) {
      const msg = e instanceof Error ? e.message : "send_failed";
      toast({ title: mapError(msg), variant: "error" });
    } finally {
      busyRef.current = false;
      setBusy(false);
    }
  }

  return (
    <>
      {/* Estado de envío: línea breve y atenuada, a todo el ancho, ARRIBA de
          la fila de botones (ya no apretada al costado del botón). */}
      {sentAt && (
        <p className="text-xs text-muted-foreground">
          Enviado a {sentTo ?? "—"} · {new Date(sentAt).toLocaleString("es-AR")}
        </p>
      )}

      {smtpMissing && (
        <p className="text-xs text-muted-foreground">
          Configurá el email del negocio en Configuración → Email para poder
          enviar comprobantes.
        </p>
      )}

      {/* Formulario inline como bloque propio (no apretado en la fila). */}
      {open && !smtpMissing && (
        <div className="w-full space-y-2 rounded-lg border border-border bg-muted/30 p-3">
          <input
            type="email"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            placeholder="cliente@ejemplo.com"
            className="h-9 w-full rounded-md border border-input bg-background px-3 text-sm text-foreground outline-none focus:border-ninja-flameSoft"
          />
          {customerId && (
            <label className="flex items-center gap-2 text-xs text-muted-foreground">
              <input
                type="checkbox"
                checked={save}
                onChange={(e) => setSave(e.target.checked)}
                className="h-4 w-4 rounded border-input accent-ninja-flameSoft"
              />
              Guardar en la ficha del cliente
            </label>
          )}
          <div className="flex justify-end">
            <Button onClick={handleSend} loading={busy} size="sm">
              <Mail size={14} /> Enviar
            </Button>
          </div>
        </div>
      )}
    </>
  );
}

// Botón disparador "Enviar por email" para la fila de acciones del ticket.
// Deshabilitado solo cuando el dueño aún no configuró el SMTP (smtpMissing).
export function SendReceiptEmailButton({
  open,
  onToggle,
  sentAt,
  smtpMissing,
  busy,
  className,
  iconOnly,
}: {
  open: boolean;
  onToggle: () => void;
  sentAt?: string | null;
  smtpMissing?: boolean;
  busy?: boolean;
  className?: string;
  // Modo compacto: solo el ícono Mail (fila de acciones del ticket).
  iconOnly?: boolean;
}) {
  const label = sentAt ? "Reenviar email" : "Enviar por email";
  const title = smtpMissing
    ? "Configurá el email del negocio en Configuración → Email"
    : iconOnly
      ? label
      : undefined;
  return (
    <Button
      variant="secondary"
      className={className}
      onClick={onToggle}
      disabled={busy || smtpMissing}
      aria-expanded={open}
      aria-label={iconOnly ? label : undefined}
      title={title}
    >
      <Mail size={16} /> {!iconOnly && label}
    </Button>
  );
}
