"use client";

// Marcar una parada como entregada (ADR-161, R11): ubicación del momento,
// quién recibe (nombre y DNI), firma en pantalla, fotos y foto del remito
// firmado, según lo que pida Configuración › Logística. Si está lejos de la
// dirección, pide confirmarlo. Todo se guarda en la cola offline.

import { useEffect, useRef, useState } from "react";
import { LocateFixed, MapPinOff } from "lucide-react";
import { Modal } from "@/components/ui/Modal";
import { Button } from "@/components/ui/Button";
import { Input } from "@/components/ui/Input";
import { SignaturePad, type SignaturePadHandle } from "@/components/logistics/SignaturePad";
import { PhotoInput, type PhotoValue } from "@/components/logistics/PhotoInput";
import {
  REQUIREMENT_LABEL,
  distanceM,
  formatDistance,
  isFar,
  missingForDelivery,
  missingText,
  type LogisticsSettings,
} from "@/lib/logistics/logic";
import { currentPosition } from "@/modules/logistics/reparto";

export interface DeliverResult {
  position: { lat: number; lng: number; accuracy: number } | null;
  receivedByName: string;
  receivedByDoc: string;
  signature: Blob | null;
  photos: PhotoValue[];
  remitoPhoto: PhotoValue | null;
  distance: number | null;
  farConfirmed: boolean;
  note: string;
}

export function DeliverSheet({
  open,
  title,
  defaultName,
  stopPoint,
  settings,
  hasRemito,
  onClose,
  onConfirm,
}: {
  open: boolean;
  title: string;
  defaultName: string;
  stopPoint: { lat: number; lng: number } | null;
  settings: LogisticsSettings;
  hasRemito: boolean;
  onClose: () => void;
  onConfirm: (r: DeliverResult) => Promise<void> | void;
}) {
  const sig = useRef<SignaturePadHandle>(null);
  const [pos, setPos] = useState<DeliverResult["position"]>(null);
  const [locating, setLocating] = useState(false);
  const [name, setName] = useState("");
  const [doc, setDoc] = useState("");
  const [signed, setSigned] = useState(false);
  const [photos, setPhotos] = useState<PhotoValue[]>([]);
  const [remito, setRemito] = useState<PhotoValue[]>([]);
  const [far, setFar] = useState(false);
  const [note, setNote] = useState("");
  const [saving, setSaving] = useState(false);

  async function locate() {
    setLocating(true);
    setPos(await currentPosition());
    setLocating(false);
  }

  useEffect(() => {
    if (!open) return;
    setName(defaultName);
    setDoc("");
    setSigned(false);
    setPhotos([]);
    setRemito([]);
    setFar(false);
    setNote("");
    setPos(null);
    void locate();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  const dist = distanceM(pos, stopPoint);
  const tooFar = isFar(dist, settings);
  const missing = missingForDelivery(settings, {
    lat: pos?.lat ?? null,
    lng: pos?.lng ?? null,
    signature: signed,
    photos: photos.length,
    remitoPhoto: remito.length > 0,
    receivedByName: name,
    receivedByDoc: doc,
  });
  const blocked = missing.length > 0 || (tooFar && !far);

  async function confirm() {
    setSaving(true);
    try {
      const signature = settings.require_signature || signed ? await sig.current?.toBlob() : null;
      await onConfirm({
        position: pos,
        receivedByName: name.trim(),
        receivedByDoc: doc.trim(),
        signature: signature ?? null,
        photos,
        remitoPhoto: remito[0] ?? null,
        distance: dist,
        farConfirmed: tooFar && far,
        note: note.trim(),
      });
    } finally {
      setSaving(false);
    }
  }

  return (
    <Modal
      open={open}
      onOpenChange={(o) => !o && !saving && onClose()}
      title="Entregado"
      description={title}
      footer={
        <div className="space-y-2">
          {missing.length > 0 && <p className="text-sm text-warning">{missingText(missing.map((m) => REQUIREMENT_LABEL[m]))}</p>}
          <Button className="h-12 w-full text-base" onClick={confirm} disabled={blocked} loading={saving}>
            Confirmar entrega
          </Button>
        </div>
      }
    >
      <div className="space-y-5">
        <div className="flex items-center justify-between gap-2 rounded-lg bg-muted/40 p-3 text-sm">
          <span className="flex items-center gap-2">
            {pos ? <LocateFixed size={16} className="text-success" aria-hidden /> : <MapPinOff size={16} className="text-warning" aria-hidden />}
            {locating
              ? "Buscando tu ubicación…"
              : pos
                ? dist !== null
                  ? `Estás a ${formatDistance(dist)} de la dirección`
                  : `Ubicación tomada (±${pos.accuracy} m)`
                : settings.require_geo
                  ? "Sin ubicación: activá el GPS"
                  : "Sin ubicación"}
          </span>
          {!locating && (
            <Button size="sm" variant="ghost" onClick={locate}>
              {pos ? "Actualizar" : "Reintentar"}
            </Button>
          )}
        </div>
        {tooFar && (
          <label className="flex items-start gap-3 rounded-lg bg-warning/10 p-3 text-sm">
            <input type="checkbox" className="mt-0.5 h-5 w-5" checked={far} onChange={(e) => setFar(e.target.checked)} />
            <span>
              Estás a más de {formatDistance(settings.max_distance_m)} de la dirección. Confirmo que la entrega se hizo acá.
            </span>
          </label>
        )}

        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
          <Input label={`Recibió${settings.require_receiver_name ? "" : " (opcional)"}`} value={name} maxLength={120} onChange={(e) => setName(e.target.value)} autoComplete="off" />
          <Input
            label={`DNI${settings.require_receiver_doc ? "" : " (opcional)"}`}
            inputMode="numeric"
            value={doc}
            maxLength={12}
            onChange={(e) => setDoc(e.target.value)}
            autoComplete="off"
          />
        </div>

        <SignaturePad ref={sig} onChange={(empty) => setSigned(!empty)} label={settings.require_signature ? "Firma de quien recibe" : "Firma (opcional)"} />

        <PhotoInput label="Fotos de la entrega" required={settings.require_photo} value={photos} onChange={setPhotos} max={3} />
        {(hasRemito || settings.require_remito_photo) && (
          <PhotoInput label="Foto del remito firmado" required={settings.require_remito_photo} value={remito} onChange={setRemito} max={1} />
        )}
        <Input label="Nota (opcional)" value={note} maxLength={500} onChange={(e) => setNote(e.target.value)} />
        <p className="text-xs text-muted-foreground">La ubicación se guarda sólo al marcar cada entrega.</p>
      </div>
    </Modal>
  );
}
DeliverSheet.displayName = "DeliverSheet";
