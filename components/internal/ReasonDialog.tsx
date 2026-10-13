"use client";

import { useEffect, useState } from "react";
import { Modal } from "@/components/ui/Modal";
import { Button } from "@/components/ui/Button";
import { Input } from "@/components/ui/Input";
import { MAX_REASON_LENGTH, MIN_REASON_LENGTH } from "@/supabase/functions/_shared/tenantAdmin";

// Confirmación fuerte para acciones críticas del panel interno (ADR-073):
// motivo obligatorio (5 a 500 caracteres) y, opcionalmente, escribir un texto
// exacto (p. ej. el slug del negocio) para habilitar el botón.
export function ReasonDialog({
  open,
  onOpenChange,
  title,
  description,
  confirmLabel,
  danger = false,
  loading = false,
  typeToConfirm,
  extra,
  onConfirm,
}: {
  open: boolean;
  onOpenChange: (o: boolean) => void;
  title: string;
  description?: string;
  confirmLabel: string;
  danger?: boolean;
  loading?: boolean;
  /** Si viene, hay que escribirlo tal cual para confirmar. */
  typeToConfirm?: string;
  /** Campos extra antes del motivo (p. ej. la duración del acceso). */
  extra?: React.ReactNode;
  onConfirm: (reason: string) => void;
}) {
  const [reason, setReason] = useState("");
  const [typed, setTyped] = useState("");
  useEffect(() => {
    if (open) {
      setReason("");
      setTyped("");
    }
  }, [open]);

  const r = reason.trim();
  const reasonOk = r.length >= MIN_REASON_LENGTH && r.length <= MAX_REASON_LENGTH;
  const typedOk = !typeToConfirm || typed.trim() === typeToConfirm;
  const canConfirm = reasonOk && typedOk && !loading;

  return (
    <Modal
      open={open}
      onOpenChange={onOpenChange}
      title={title}
      className="max-w-md"
      footer={
        <>
          <Button variant="secondary" onClick={() => onOpenChange(false)}>
            Cancelar
          </Button>
          <Button
            variant={danger ? "destructive" : "primary"}
            loading={loading}
            disabled={!canConfirm}
            onClick={() => onConfirm(r)}
          >
            {confirmLabel}
          </Button>
        </>
      }
    >
      <div className="space-y-4">
        {description && <p className="text-sm text-muted-foreground">{description}</p>}
        {extra}
        <div>
          <label htmlFor="reason-dialog-text" className="mb-2 block text-sm font-medium text-muted-foreground">
            Motivo (queda en la auditoría)
          </label>
          <textarea
            id="reason-dialog-text"
            autoFocus
            rows={3}
            maxLength={MAX_REASON_LENGTH}
            value={reason}
            onChange={(e) => setReason(e.target.value)}
            placeholder="Ej.: pedido del dueño por WhatsApp, deuda de 2 meses…"
            className="w-full rounded-md border border-input bg-background px-3 py-2 text-sm text-foreground outline-none focus:border-ninja-flameSoft"
          />
          <p className="mt-1 text-xs text-muted-foreground">
            Mínimo {MIN_REASON_LENGTH} caracteres. {r.length}/{MAX_REASON_LENGTH}
          </p>
        </div>
        {typeToConfirm && (
          <Input
            label={`Escribí ${typeToConfirm} para confirmar`}
            value={typed}
            onChange={(e) => setTyped(e.target.value)}
            autoComplete="off"
          />
        )}
      </div>
    </Modal>
  );
}
