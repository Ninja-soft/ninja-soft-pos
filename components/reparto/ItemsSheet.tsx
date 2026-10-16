"use client";

// Entrega por producto en la calle (ADR-165, R15 y R16): cuánto se entrega,
// qué llegó roto (con foto y motivo) y qué rechaza el cliente; si la
// configuración lo pide, se escanea cada producto que se entrega. Funciona sin
// señal: el escaneo se compara con los códigos guardados de la hoja y una
// lectura ajena suena y queda para registrarse cuando se sincroniza. Si se
// entrega algo, después sigue la hoja de Entregado (firma, foto, quién recibe).

import { useCallback, useEffect, useRef, useState } from "react";
import { Camera, ScanLine } from "lucide-react";
import { Modal } from "@/components/ui/Modal";
import { Button } from "@/components/ui/Button";
import { BarcodeScanner } from "@/components/pos/BarcodeScanner";
import { DamageFields, OutcomeForm } from "@/components/logistics/expedition/OutcomeForm";
import type { PhotoValue } from "@/components/logistics/PhotoInput";
import { cn } from "@/lib/utils/cn";
import { distanceM, formatDistance, isFar, type LogisticsSettings } from "@/lib/logistics/logic";
import {
  matchLocal,
  normalizeCode,
  outcomeLines,
  outcomeProblem,
  outcomeSummary,
  outcomeTotals,
  type DamageReason,
  type ExpeditionSettings,
  type OutcomeLine,
  type ScanItem,
} from "@/lib/logistics/expedition";
import { currentPosition } from "@/modules/logistics/reparto";
import type { RouteItems } from "@/modules/logistics/expedition";

export interface ItemsResult {
  dispatches: { dispatch_id: string; items: { item_id: string; delivered: number; damaged: number; rejected: number }[] }[];
  scans: Record<string, number>;
  foreignCodes: string[];
  damageReason: DamageReason | null;
  damageNote: string;
  damagePhotos: PhotoValue[];
  anyDelivered: boolean;
  complete: boolean;
  summary: string;
  position: { lat: number; lng: number; accuracy: number } | null;
  farConfirmed: boolean;
}

type Group = { dispatchId: string; number: number; lines: OutcomeLine[]; items: ScanItem[] };

export function ItemsSheet({
  open,
  title,
  mode,
  stopId,
  routeItems,
  settings,
  logistics,
  stopPoint,
  onClose,
  onConfirm,
}: {
  open: boolean;
  title: string;
  /** full: se entrega todo (escaneo obligatorio); partial: parcial, rotura o rechazo. */
  mode: "full" | "partial";
  stopId: string;
  routeItems: RouteItems | null;
  settings: ExpeditionSettings;
  logistics: LogisticsSettings;
  stopPoint: { lat: number; lng: number } | null;
  onClose: () => void;
  onConfirm: (r: ItemsResult) => Promise<void> | void;
}) {
  const [groups, setGroups] = useState<Group[]>([]);
  const [scanned, setScanned] = useState<Record<string, number>>({});
  const [foreign, setForeign] = useState<string[]>([]);
  const [flash, setFlash] = useState<{ ok: boolean; text: string } | null>(null);
  const [code, setCode] = useState("");
  const [camera, setCamera] = useState(false);
  const [reason, setReason] = useState<DamageReason | null>(null);
  const [note, setNote] = useState("");
  const [photos, setPhotos] = useState<PhotoValue[]>([]);
  const [pos, setPos] = useState<ItemsResult["position"]>(null);
  const [far, setFar] = useState(false);
  const [saving, setSaving] = useState(false);
  const input = useRef<HTMLInputElement>(null);
  const scanOn = settings.scan_on_deliver !== "no";

  useEffect(() => {
    if (!open) return;
    const ds = (routeItems?.dispatches ?? []).filter((d) => d.stop_id === stopId && d.outcome === "pendiente");
    setGroups(
      ds.map((d) => ({
        dispatchId: d.dispatch_id,
        number: d.number,
        lines: outcomeLines(d.items.map((i) => ({ id: i.id, name: i.name, qty: i.qty }))),
        items: d.items.map((i) => ({ id: i.id, name: i.name, qty: i.qty, unit: i.unit, codes: i.codes })),
      })),
    );
    setScanned({});
    setForeign([]);
    setFlash(null);
    setReason(null);
    setNote("");
    setPhotos([]);
    setFar(false);
    setPos(null);
    void currentPosition(8000).then(setPos);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  const allItems = groups.flatMap((g) => g.items);
  const read = useCallback(
    (raw: string) => {
      const c = normalizeCode(raw);
      if (!c) return;
      const m = matchLocal(allItems, c, scanned);
      if (m.kind === "ok" && m.itemId) {
        setScanned((s) => ({ ...s, [m.itemId!]: (s[m.itemId!] ?? 0) + 1 }));
        setFlash({ ok: true, text: allItems.find((i) => i.id === m.itemId)?.name ?? "Producto" });
        try {
          navigator.vibrate?.(40);
        } catch {
          // Sin vibración.
        }
      } else {
        if (m.kind === "ajeno") setForeign((f) => (f.includes(c) || f.length >= 20 ? f : [...f, c]));
        setFlash({ ok: false, text: m.kind === "excedente" ? "Ya está completo" : "No es de esta entrega: no lo entregues" });
        try {
          navigator.vibrate?.([120, 60, 120]);
        } catch {
          // Sin vibración.
        }
      }
      input.current?.focus();
    },
    [allItems, scanned],
  );
  const onCamera = useCallback((c: string) => read(c), [read]);

  const lines = groups.flatMap((g) => g.lines);
  const t = outcomeTotals(lines);
  const damaged = t.damaged > 0;
  const missingScans = scanOn && settings.scan_on_deliver === "obligatorio" ? lines.filter((l) => (scanned[l.itemId] ?? 0) + 0.0005 < l.delivered) : [];
  const dist = distanceM(pos, stopPoint);
  const tooFar = !t.anyDelivered && isFar(dist, logistics);
  const problem =
    outcomeProblem(lines, { settings, photos: photos.length, reason, note }) ??
    (missingScans.length ? `Falta escanear: ${missingScans.map((l) => l.name).join(", ")}.` : null) ??
    (tooFar && !far ? "Confirmá dónde estás." : null);

  async function confirm() {
    setSaving(true);
    try {
      await onConfirm({
        dispatches: groups.map((g) => ({
          dispatch_id: g.dispatchId,
          items: g.lines.map((l) => ({ item_id: l.itemId, delivered: l.delivered, damaged: l.damaged, rejected: l.rejected })),
        })),
        scans: scanned,
        foreignCodes: foreign,
        damageReason: damaged ? reason : null,
        damageNote: damaged ? note.trim() : "",
        damagePhotos: damaged ? photos : [],
        anyDelivered: t.anyDelivered,
        complete: t.complete,
        summary: outcomeSummary(lines),
        position: pos,
        farConfirmed: tooFar && far,
      });
    } finally {
      setSaving(false);
    }
  }

  return (
    <Modal
      open={open}
      onOpenChange={(o) => !o && !saving && onClose()}
      title={mode === "full" ? "Escanear lo que se entrega" : "Parcial, rotura o rechazo"}
      description={title}
      footer={
        <div className="space-y-2">
          <p className="text-sm text-muted-foreground">{outcomeSummary(lines)}</p>
          {problem && <p className="text-sm text-warning">{problem}</p>}
          <Button className="h-12 w-full text-base" onClick={() => void confirm()} disabled={Boolean(problem) || groups.length === 0} loading={saving}>
            {t.anyDelivered ? "Seguir: quién recibe" : "Guardar: vuelve a Expedición"}
          </Button>
        </div>
      }
    >
      <div className="space-y-4">
        {scanOn && (
          <div className="space-y-2">
            <form
              className="flex gap-2"
              onSubmit={(e) => {
                e.preventDefault();
                read(code);
                setCode("");
              }}
            >
              <div className="relative min-w-0 flex-1">
                <ScanLine size={18} className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-muted-foreground" aria-hidden />
                <input
                  ref={input}
                  aria-label="Código"
                  value={code}
                  onChange={(e) => setCode(e.target.value)}
                  placeholder="Escaneá cada producto"
                  autoComplete="off"
                  className="h-12 w-full rounded-lg border border-input bg-background pl-10 pr-3 text-base"
                />
              </div>
              <Button type="button" variant="secondary" className="h-12" onClick={() => setCamera(true)} aria-label="Escanear con la cámara">
                <Camera size={18} />
              </Button>
            </form>
            <div aria-live="assertive" className="min-h-[2.5rem]">
              {flash && <p className={cn("rounded-lg px-3 py-2 text-sm font-semibold", flash.ok ? "bg-success/10 text-success" : "bg-danger/10 text-danger")}>{flash.text}</p>}
            </div>
          </div>
        )}
        {groups.map((g, gi) => (
          <div key={g.dispatchId} className="space-y-2">
            {groups.length > 1 && <p className="text-xs font-semibold text-muted-foreground">Entrega {g.number}</p>}
            {scanOn && (
              <ul className="space-y-0.5 text-xs text-muted-foreground">
                {g.lines.map((l) => (
                  <li key={l.itemId} className="flex justify-between gap-2">
                    <span className="truncate">{l.name}</span>
                    <span className={cn("tabular-nums", (scanned[l.itemId] ?? 0) >= l.delivered ? "text-success" : "")}>
                      escaneado {scanned[l.itemId] ?? 0} de {l.delivered}
                    </span>
                  </li>
                ))}
              </ul>
            )}
            <OutcomeForm lines={g.lines} onChange={(v) => setGroups((x) => x.map((y, k) => (k === gi ? { ...y, lines: v } : y)))} />
          </div>
        ))}
        {groups.length === 0 && <p className="text-sm text-muted-foreground">No hay productos para esta parada (actualizá la hoja con señal).</p>}
        {damaged && (
          <DamageFields
            reason={reason}
            onReason={setReason}
            note={note}
            onNote={setNote}
            photos={photos}
            onPhotos={setPhotos}
            photoRequired={settings.damage_requires_photo}
          />
        )}
        {tooFar && (
          <label className="flex items-start gap-3 rounded-lg bg-warning/10 p-3 text-sm">
            <input type="checkbox" className="mt-0.5 h-5 w-5" checked={far} onChange={(e) => setFar(e.target.checked)} />
            <span>Estás a más de {formatDistance(logistics.max_distance_m)} de la dirección. Confirmo que estoy en el lugar.</span>
          </label>
        )}
        {foreign.length > 0 && (
          <p className="text-xs text-danger">
            {foreign.length === 1 ? "1 lectura" : `${foreign.length} lecturas`} de productos que no son de esta entrega: queda registrado.
          </p>
        )}
      </div>
      <BarcodeScanner open={camera} onOpenChange={setCamera} onDetected={onCamera} />
    </Modal>
  );
}
ItemsSheet.displayName = "ItemsSheet";
