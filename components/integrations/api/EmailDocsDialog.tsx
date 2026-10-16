"use client";

import { useState } from "react";
import { Mail } from "lucide-react";
import { Button } from "@/components/ui/Button";
import { Input } from "@/components/ui/Input";
import { Modal } from "@/components/ui/Modal";
import { useToast } from "@/components/ui/Toast";
import { apiPublicaErrorMessage } from "@/modules/api-publica/api";
import { useSendApiDocs } from "@/modules/api-publica/hooks";

// Enviar la documentación de la API por email (ADR-163). Va por el sistema de
// emails (api_docs_send_email -> enqueue_system_email) y queda en la
// auditoría. Manda links a /developers y al HTML / PDF: nunca credenciales.

const EMAIL_RE = /^[^@\s<>"',;]+@[^@\s<>"',;]+\.[^@\s<>"',;]+$/;
export const DOCS_NOTE_MAX = 500;

export function EmailDocsDialog({ open, onOpenChange }: { open: boolean; onOpenChange: (o: boolean) => void }) {
  const { toast } = useToast();
  const send = useSendApiDocs();
  const [email, setEmail] = useState("");
  const [note, setNote] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [lastOpen, setLastOpen] = useState(open);
  if (open !== lastOpen) {
    setLastOpen(open);
    if (open) {
      setEmail("");
      setNote("");
      setError(null);
    }
  }

  const submit = () => {
    const to = email.trim();
    if (!EMAIL_RE.test(to) || to.length > 254) {
      setError("Revisá el email: no parece válido.");
      return;
    }
    if (note.length > DOCS_NOTE_MAX) {
      setError(`La nota puede tener hasta ${DOCS_NOTE_MAX} caracteres.`);
      return;
    }
    setError(null);
    send.mutate(
      { email: to, note: note.trim() || null },
      {
        onSuccess: () => {
          toast({ title: "Documentación enviada", description: `Le llega a ${to.toLowerCase()} en unos minutos.`, variant: "success" });
          onOpenChange(false);
        },
        onError: (e) => setError(apiPublicaErrorMessage(e)),
      },
    );
  };

  return (
    <Modal
      open={open}
      onOpenChange={onOpenChange}
      title="Enviar la documentación por email"
      description="Le llega un link al portal de desarrolladores y a la documentación en HTML y PDF. Las credenciales no viajan por email."
      footer={
        <div className="flex justify-end gap-2">
          <Button variant="secondary" onClick={() => onOpenChange(false)}>
            Cancelar
          </Button>
          <Button onClick={submit} disabled={send.isPending}>
            <Mail size={15} /> Enviar
          </Button>
        </div>
      }
    >
      <div className="space-y-4">
        <Input
          variant="filled"
          type="email"
          label="Email del integrador"
          placeholder="dev@tuproveedor.com"
          autoComplete="email"
          value={email}
          onChange={(e) => setEmail(e.target.value)}
        />
        <label className="block">
          <span className="mb-1.5 block text-xs font-medium text-muted-foreground">Nota (opcional)</span>
          <textarea
            className="min-h-24 w-full rounded-xl border-0 bg-muted px-3 py-2 text-sm text-foreground outline-none transition focus:bg-secondary"
            maxLength={DOCS_NOTE_MAX}
            placeholder="Por ejemplo: es para sincronizar la tienda online."
            value={note}
            onChange={(e) => setNote(e.target.value)}
          />
          <span className="mt-1 block text-right text-xs text-muted-foreground">
            {note.length}/{DOCS_NOTE_MAX}
          </span>
        </label>
        {error && <p className="text-sm text-danger">{error}</p>}
        <p className="text-xs text-muted-foreground">Queda registrado en la auditoría del negocio. Hasta 20 envíos por día.</p>
      </div>
    </Modal>
  );
}
EmailDocsDialog.displayName = "EmailDocsDialog";
