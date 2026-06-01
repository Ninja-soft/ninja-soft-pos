"use client";

import { useEffect, useState } from "react";
import { Modal } from "@/components/ui/Modal";
import { Button } from "@/components/ui/Button";
import { Input } from "@/components/ui/Input";

// Diálogo de confirmación (reemplaza window.confirm/prompt nativos).
// Si withReason = true, pide un texto obligatorio y lo pasa a onConfirm.
export function ConfirmDialog({
  open,
  onOpenChange,
  title,
  description,
  confirmLabel = "Confirmar",
  cancelLabel = "Cancelar",
  danger = false,
  loading = false,
  withReason = false,
  reasonLabel = "Motivo",
  reasonPlaceholder,
  onConfirm,
}: {
  open: boolean;
  onOpenChange: (o: boolean) => void;
  title: string;
  description?: string;
  confirmLabel?: string;
  cancelLabel?: string;
  danger?: boolean;
  loading?: boolean;
  withReason?: boolean;
  reasonLabel?: string;
  reasonPlaceholder?: string;
  onConfirm: (reason: string) => void;
}) {
  const [reason, setReason] = useState("");
  useEffect(() => {
    if (open) setReason("");
  }, [open]);

  const canConfirm = !withReason || reason.trim().length > 0;

  return (
    <Modal open={open} onOpenChange={onOpenChange} title={title} className="max-w-sm">
      <div className="space-y-4">
        {description && <p className="text-sm text-muted-foreground">{description}</p>}
        {withReason && (
          <Input
            label={reasonLabel}
            autoFocus
            value={reason}
            onChange={(e) => setReason(e.target.value)}
            placeholder={reasonPlaceholder}
            onKeyDown={(e) => {
              if (e.key === "Enter" && canConfirm && !loading) onConfirm(reason.trim());
            }}
          />
        )}
        <div className="flex justify-end gap-2">
          <Button variant="secondary" onClick={() => onOpenChange(false)}>
            {cancelLabel}
          </Button>
          <Button
            variant={danger ? "destructive" : "primary"}
            loading={loading}
            disabled={!canConfirm}
            onClick={() => onConfirm(reason.trim())}
          >
            {confirmLabel}
          </Button>
        </div>
      </div>
    </Modal>
  );
}
