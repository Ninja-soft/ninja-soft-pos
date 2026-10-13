"use client";

import { Bell, MessageCircle, X } from "lucide-react";
import { Button } from "@/components/ui/Button";
import { useToast } from "@/components/ui/Toast";
import { useWaitlistMutations, useWaitlistNotices, type WaitlistNotice } from "@/modules/dining/waitlist";
import { waitlistWhatsappLink } from "@/lib/gastro/waitlist";
import { diningErrorMessage } from "@/lib/gastro/tableOps";

// Avisos automáticos de la lista de espera (F13 · H51, ADR-097). Cuando una
// mesa se libera, el servidor deja un aviso pendiente para el primer grupo que
// entra. Acá el mozo lo manda por WhatsApp (link wa.me con el mensaje ya armado,
// sin proveedor) o lo descarta. Todo queda registrado.
export function WaitlistNoticesBanner({ enabled = true, className = "" }: { enabled?: boolean; className?: string }) {
  const { toast } = useToast();
  const { data: notices } = useWaitlistNotices(enabled);
  const { markNoticeSent, dismissNotice } = useWaitlistMutations();
  const list = notices ?? [];
  if (list.length === 0) return null;

  function send(n: WaitlistNotice) {
    // El link se abre en el mismo toque (si no, el navegador lo bloquea).
    const link = waitlistWhatsappLink(n.phone, n.message);
    if (link) window.open(link, "_blank", "noopener,noreferrer");
    markNoticeSent.mutate(n.id, {
      onSuccess: () => {
        if (!link) toast({ title: "Marcado como avisado (sin teléfono: avisale en persona)", variant: "info" });
      },
      onError: (e) => toast({ title: "No se pudo registrar el aviso", description: diningErrorMessage(e), variant: "error" }),
    });
  }

  function dismiss(n: WaitlistNotice) {
    dismissNotice.mutate(n.id, {
      onError: (e) => toast({ title: "No se pudo descartar", description: diningErrorMessage(e), variant: "error" }),
    });
  }

  return (
    <div className={`space-y-2 ${className}`} role="status" aria-live="polite">
      {list.map((n) => {
        const who = n.dining_waitlist?.customer_name ?? "el grupo";
        const party = n.dining_waitlist?.party_size;
        return (
          <div
            key={n.id}
            className="flex flex-wrap items-center gap-3 rounded-md border border-border border-t-2 border-t-ninja-flame bg-card px-3 py-2"
          >
            <Bell size={18} className="shrink-0 text-ninja-flameSoft" />
            <div className="min-w-0 flex-1 text-sm">
              <span className="font-semibold">
                {n.table_label ? `Mesa ${n.table_label} libre` : "Mesa libre"}
              </span>
              <span className="text-muted-foreground">
                {" "}
                · avisale a {who}
                {party ? ` (${party} pers.)` : ""}
              </span>
            </div>
            <div className="flex w-full gap-2 sm:w-auto">
              <Button
                size="sm"
                variant="ghost"
                onClick={() => dismiss(n)}
                disabled={dismissNotice.isPending}
                className="min-h-10 flex-1 sm:flex-none"
              >
                <X size={14} /> Descartar
              </Button>
              <Button
                size="sm"
                onClick={() => send(n)}
                disabled={markNoticeSent.isPending}
                className="min-h-10 flex-1 sm:flex-none"
              >
                {n.phone ? <MessageCircle size={14} /> : <Bell size={14} />}
                {n.phone ? "Enviar WhatsApp" : "Marcar avisado"}
              </Button>
            </div>
          </div>
        );
      })}
    </div>
  );
}
