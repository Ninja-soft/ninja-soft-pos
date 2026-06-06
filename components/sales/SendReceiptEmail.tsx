"use client";

import { useState } from "react";
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
}

export function SendReceiptEmail({
  saleId,
  getTicketNode,
  defaultEmail,
  customerId,
  sentTo,
  sentAt,
}: Props) {
  const { toast } = useToast();
  const qc = useQueryClient();
  const [open, setOpen] = useState(false);
  const [email, setEmail] = useState(defaultEmail ?? "");
  const [save, setSave] = useState(false);
  const [busy, setBusy] = useState(false);

  async function handleSend() {
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
      setOpen(false);
      qc.invalidateQueries({ queryKey: ["sales", "detail", saleId] });
      qc.invalidateQueries({ queryKey: ["sales", "list"] });
    } catch (e) {
      const msg = e instanceof Error ? e.message : "send_failed";
      toast({ title: mapError(msg), variant: "error" });
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="w-full">
      <div className="flex items-center justify-between gap-2">
        <Button
          variant="secondary"
          onClick={() => setOpen((v) => !v)}
          disabled={busy}
        >
          <Mail size={16} /> {sentAt ? "Reenviar email" : "Enviar por email"}
        </Button>
      </div>

      {sentAt && (
        <p className="mt-1 text-xs text-muted-foreground">
          Enviado a {sentTo ?? "—"} · {new Date(sentAt).toLocaleString("es-AR")}
        </p>
      )}

      {open && (
        <div className="mt-3 space-y-2 rounded-lg border border-border bg-muted/30 p-3">
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
    </div>
  );
}
