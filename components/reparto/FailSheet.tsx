"use client";

// No se pudo entregar (ADR-161, R10): motivo de la lista de Configuración ›
// Logística ("No estaba en el domicilio", "Cerrado"...), foto si el motivo
// la pide y nota. La entrega vuelve a Expedición con el motivo.

import { useEffect, useState } from "react";
import { Modal } from "@/components/ui/Modal";
import { Button } from "@/components/ui/Button";
import { Input } from "@/components/ui/Input";
import { PhotoInput, type PhotoValue } from "@/components/logistics/PhotoInput";
import { cn } from "@/lib/utils/cn";
import { distanceM, formatDistance, isFar, missingForFailure, type FailureReason, type LogisticsSettings } from "@/lib/logistics/logic";
import { currentPosition } from "@/modules/logistics/reparto";

export interface FailResult {
  reason: FailureReason;
  note: string;
  photos: PhotoValue[];
  position: { lat: number; lng: number; accuracy: number } | null;
  distance: number | null;
  farConfirmed: boolean;
}

export function FailSheet({
  open,
  title,
  settings,
  stopPoint,
  onClose,
  onConfirm,
}: {
  open: boolean;
  title: string;
  settings: LogisticsSettings;
  stopPoint: { lat: number; lng: number } | null;
  onClose: () => void;
  onConfirm: (r: FailResult) => Promise<void> | void;
}) {
  const reasons = settings.failure_reasons.filter((r) => r.active);
  const [key, setKey] = useState<string | null>(null);
  const [note, setNote] = useState("");
  const [photos, setPhotos] = useState<PhotoValue[]>([]);
  const [pos, setPos] = useState<FailResult["position"]>(null);
  const [far, setFar] = useState(false);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    if (!open) return;
    setKey(null);
    setNote("");
    setPhotos([]);
    setFar(false);
    setPos(null);
    void currentPosition().then(setPos);
  }, [open]);

  const reason = reasons.find((r) => r.key === key) ?? null;
  const missing = missingForFailure(reason, { photos: photos.length, note });
  const dist = distanceM(pos, stopPoint);
  const tooFar = isFar(dist, settings);
  const blocked = missing.length > 0 || (tooFar && !far);

  async function confirm() {
    if (!reason) return;
    setSaving(true);
    try {
      await onConfirm({ reason, note: note.trim(), photos, position: pos, distance: dist, farConfirmed: tooFar && far });
    } finally {
      setSaving(false);
    }
  }

  return (
    <Modal
      open={open}
      onOpenChange={(o) => !o && !saving && onClose()}
      title="No se pudo entregar"
      description={title}
      footer={
        <Button className="h-12 w-full text-base" variant="destructive" onClick={confirm} disabled={blocked} loading={saving}>
          Guardar y seguir
        </Button>
      }
    >
      <div className="space-y-5">
        <div className="grid gap-2" role="radiogroup" aria-label="Motivo">
          {reasons.map((r) => (
            <button
              key={r.key}
              type="button"
              role="radio"
              aria-checked={key === r.key}
              onClick={() => setKey(r.key)}
              className={cn(
                "flex min-h-12 items-center justify-between gap-2 rounded-lg px-4 py-3 text-left text-sm font-medium transition",
                key === r.key ? "bg-ninja-flame/15 text-ninja-flameSoft" : "bg-muted/50 hover:bg-muted",
              )}
            >
              {r.label}
              {(r.requires_photo || r.requires_note) && (
                <span className="text-xs font-normal text-muted-foreground">
                  {[r.requires_photo ? "pide foto" : null, r.requires_note ? "pide nota" : null].filter(Boolean).join(" y ")}
                </span>
              )}
            </button>
          ))}
        </div>
        <Input label={reason?.requires_note ? "Nota" : "Nota (opcional)"} value={note} maxLength={500} onChange={(e) => setNote(e.target.value)} placeholder="Qué pasó" />
        <PhotoInput label="Foto" required={Boolean(reason?.requires_photo)} value={photos} onChange={setPhotos} max={3} hint="Del frente o del lugar" />
        {tooFar && (
          <label className="flex items-start gap-3 rounded-lg bg-warning/10 p-3 text-sm">
            <input type="checkbox" className="mt-0.5 h-5 w-5" checked={far} onChange={(e) => setFar(e.target.checked)} />
            <span>Estás a {formatDistance(dist)} de la dirección. Confirmo que estoy en el lugar.</span>
          </label>
        )}
      </div>
    </Modal>
  );
}
FailSheet.displayName = "FailSheet";
