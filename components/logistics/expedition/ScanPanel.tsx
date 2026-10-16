"use client";

// Control por escaneo (ADR-165, R15): lector USB o Bluetooth (escribe el
// código y Enter en el campo, que queda siempre enfocado), teclado o cámara
// del teléfono. Cada lectura va al servidor (dispatch_scan): suma al renglón,
// avisa si ya estaba completo y, si el producto es de otra entrega (cruce) o
// no va acá, suena un error y queda registrado. Lo que no se puede escanear
// se justifica con motivo; un producto sin código se confirma a mano.

import { useCallback, useEffect, useRef, useState } from "react";
import { Camera, CheckCircle2, Hand, RotateCcw, ScanLine } from "lucide-react";
import { BarcodeScanner } from "@/components/pos/BarcodeScanner";
import { Button } from "@/components/ui/Button";
import { Badge } from "@/components/ui/Badge";
import { cn } from "@/lib/utils/cn";
import { selectCls } from "@/components/stock/transfers/shared";
import {
  DIFFERENCE_REASON_LABEL,
  checkProgress,
  expeditionErrorMessage,
  itemChecked,
  normalizeCode,
  scanFeedback,
  type CheckState,
  type DifferenceReason,
  type ScanFeedback,
  type ScanMode,
  type ScanStage,
} from "@/lib/logistics/expedition";
import { expeditionApi, type ScanScope } from "@/modules/logistics/expedition";

export interface ScanPanelItem {
  id: string;
  name: string;
  qty: number;
  unit?: string | null;
  /** Sin código ni SKU: se confirma a mano. */
  hasCode: boolean;
  /** Entrega a la que pertenece (en la carga de una hoja). */
  group?: string | null;
}

const FEEDBACK_TONE: Record<ScanFeedback["tone"], string> = {
  success: "bg-success/10 text-success",
  warning: "bg-warning/10 text-warning",
  danger: "bg-danger/10 text-danger",
};

/** Pitido corto (bien) o doble y grave (error). Sin archivos de audio. */
function beep(ok: boolean) {
  try {
    const Ctx = (window as unknown as { AudioContext?: typeof AudioContext; webkitAudioContext?: typeof AudioContext }).AudioContext
      ?? (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
    if (!Ctx) return;
    const ctx = new Ctx();
    const tones = ok ? [[880, 0, 0.08]] : [[220, 0, 0.15], [180, 0.2, 0.15]];
    for (const [f, at, len] of tones) {
      const o = ctx.createOscillator();
      const g = ctx.createGain();
      o.frequency.value = f!;
      g.gain.value = 0.08;
      o.connect(g);
      g.connect(ctx.destination);
      o.start(ctx.currentTime + at!);
      o.stop(ctx.currentTime + at! + len!);
    }
    setTimeout(() => void ctx.close(), 600);
  } catch {
    // Sin audio: alcanza con el aviso en pantalla.
  }
  try {
    navigator.vibrate?.(ok ? 40 : [120, 60, 120]);
  } catch {
    // Sin vibración.
  }
}

function newId(): string {
  if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") return crypto.randomUUID();
  return "xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx".replace(/[xy]/g, (c) => {
    const r = (Math.random() * 16) | 0;
    return (c === "x" ? r : (r & 0x3) | 0x8).toString(16);
  });
}

export function ScanPanel({
  stage,
  scope,
  mode,
  items,
  checks,
  onChanged,
  disabled = false,
}: {
  stage: ScanStage;
  scope: ScanScope;
  mode: ScanMode;
  items: ScanPanelItem[];
  checks: Record<string, CheckState | undefined>;
  onChanged: () => void;
  disabled?: boolean;
}) {
  const [code, setCode] = useState("");
  const [busy, setBusy] = useState(false);
  const [camera, setCamera] = useState(false);
  const [feedback, setFeedback] = useState<ScanFeedback | null>(null);
  const [justifying, setJustifying] = useState<string | null>(null);
  const [reason, setReason] = useState<DifferenceReason>("faltante");
  const [note, setNote] = useState("");
  const input = useRef<HTMLInputElement>(null);
  const chain = useRef<Promise<void>>(Promise.resolve());
  const progress = checkProgress(items, checks);

  useEffect(() => {
    if (!disabled) input.current?.focus();
  }, [disabled]);

  const send = useCallback(
    (raw: { code?: string; itemId?: string }) => {
      // En orden: un lector rápido no pisa una lectura con otra.
      chain.current = chain.current.then(async () => {
        setBusy(true);
        try {
          const r = await expeditionApi.scan(scope, stage, { id: newId(), code: raw.code ?? null, itemId: raw.itemId ?? null });
          const f = scanFeedback(r);
          setFeedback(f);
          beep(f.tone === "success");
          onChanged();
        } catch (e) {
          setFeedback({ tone: "danger", title: "No se pudo leer", description: expeditionErrorMessage(e) });
          beep(false);
        } finally {
          setBusy(false);
          input.current?.focus();
        }
      });
    },
    [scope, stage, onChanged],
  );

  // Estable: BarcodeScanner reinicia la cámara si cambia.
  const onCamera = useCallback(
    (c: string) => {
      const n = normalizeCode(c);
      if (n) send({ code: n });
    },
    [send],
  );

  function submit() {
    const c = normalizeCode(code);
    setCode("");
    if (c) send({ code: c });
  }

  async function justify(itemId: string) {
    try {
      await expeditionApi.justify(scope, stage, itemId, reason, note.trim() || null);
      setJustifying(null);
      setNote("");
      setFeedback({ tone: "warning", title: "Diferencia justificada", description: DIFFERENCE_REASON_LABEL[reason] });
      onChanged();
    } catch (e) {
      setFeedback({ tone: "danger", title: "No se pudo justificar", description: expeditionErrorMessage(e) });
    }
  }

  async function reset() {
    try {
      await expeditionApi.reset(scope, stage);
      setFeedback(null);
      onChanged();
    } catch (e) {
      setFeedback({ tone: "danger", title: "No se pudo reiniciar", description: expeditionErrorMessage(e) });
    }
  }

  let lastGroup: string | null | undefined;
  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <p className="text-sm">
          <span className="font-semibold tabular-nums">
            {progress.done} de {progress.total}
          </span>{" "}
          <span className="text-muted-foreground">controlados</span>
        </p>
        <Badge tone={mode === "obligatorio" ? (progress.complete ? "success" : "warning") : "neutral"}>
          {mode === "obligatorio" ? (progress.complete ? "Completo" : "Obligatorio") : "Opcional"}
        </Badge>
      </div>

      <form
        className="flex gap-2"
        onSubmit={(e) => {
          e.preventDefault();
          submit();
        }}
      >
        <div className="relative min-w-0 flex-1">
          <ScanLine size={18} className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-muted-foreground" aria-hidden />
          <input
            ref={input}
            aria-label="Código"
            value={code}
            disabled={disabled}
            onChange={(e) => setCode(e.target.value)}
            placeholder="Escaneá o escribí el código"
            autoComplete="off"
            autoCapitalize="characters"
            inputMode="text"
            className="h-12 w-full rounded-lg border border-input bg-background pl-10 pr-3 text-base"
          />
        </div>
        <Button type="button" variant="secondary" className="h-12" onClick={() => setCamera(true)} disabled={disabled} aria-label="Escanear con la cámara">
          <Camera size={18} />
          <span className="hidden sm:inline">Cámara</span>
        </Button>
      </form>

      <div aria-live="assertive" className="min-h-[3.25rem]">
        {feedback ? (
          <div className={cn("rounded-lg px-3 py-2 text-sm", FEEDBACK_TONE[feedback.tone])}>
            <p className="font-semibold">{feedback.title}</p>
            {feedback.description && <p className="text-xs opacity-90">{feedback.description}</p>}
          </div>
        ) : (
          <p className="px-1 py-2 text-xs text-muted-foreground">{busy ? "Leyendo…" : "Con el lector, apuntá y disparé: el código entra solo."}</p>
        )}
      </div>

      <ul className="divide-y divide-border rounded-lg ring-1 ring-border">
        {items.map((i) => {
          const c = checks[i.id];
          const done = itemChecked(i.qty, c);
          const header = i.group && i.group !== lastGroup ? i.group : null;
          lastGroup = i.group;
          return (
            <li key={i.id} className="px-3 py-2.5">
              {header && <p className="pb-1 text-xs font-semibold text-muted-foreground">{header}</p>}
              <div className="flex items-center justify-between gap-3">
                <span className="flex min-w-0 items-center gap-2 text-sm">
                  {done ? <CheckCircle2 size={16} className="shrink-0 text-success" aria-hidden /> : <span className="h-4 w-4 shrink-0 rounded-full ring-1 ring-border" aria-hidden />}
                  <span className="truncate">{i.name}</span>
                </span>
                <span className="shrink-0 text-sm font-semibold tabular-nums">
                  {Number(c?.scanned ?? 0).toLocaleString("es-AR", { maximumFractionDigits: 3 })} de{" "}
                  {i.qty.toLocaleString("es-AR", { maximumFractionDigits: 3 })} {i.unit ?? ""}
                </span>
              </div>
              {c?.reason && <p className="ml-6 text-xs text-warning">Justificado: {DIFFERENCE_REASON_LABEL[c.reason]}</p>}
              {!done && !disabled && (
                <div className="ml-6 mt-1 flex flex-wrap gap-3 text-xs font-medium">
                  {!i.hasCode && (
                    <button type="button" className="inline-flex items-center gap-1 text-ninja-flameSoft" onClick={() => send({ itemId: i.id })}>
                      <Hand size={13} aria-hidden /> Confirmar a mano
                    </button>
                  )}
                  <button type="button" className="text-muted-foreground underline-offset-2 hover:underline" onClick={() => setJustifying(justifying === i.id ? null : i.id)}>
                    No se puede escanear
                  </button>
                </div>
              )}
              {justifying === i.id && (
                <div className="ml-6 mt-2 space-y-2">
                  <select aria-label="Motivo" className={cn(selectCls, "h-10 w-full")} value={reason} onChange={(e) => setReason(e.target.value as DifferenceReason)}>
                    {(Object.keys(DIFFERENCE_REASON_LABEL) as DifferenceReason[]).map((k) => (
                      <option key={k} value={k} className="bg-popover text-popover-foreground">
                        {DIFFERENCE_REASON_LABEL[k]}
                      </option>
                    ))}
                  </select>
                  <input
                    aria-label="Nota"
                    value={note}
                    maxLength={300}
                    onChange={(e) => setNote(e.target.value)}
                    placeholder={reason === "otro" ? "Contá qué pasó" : "Nota (opcional)"}
                    className="h-10 w-full rounded-lg border border-input bg-background px-3 text-sm"
                  />
                  <Button size="sm" onClick={() => void justify(i.id)} disabled={reason === "otro" && note.trim().length < 3}>
                    Guardar el motivo
                  </Button>
                </div>
              )}
            </li>
          );
        })}
      </ul>

      {!disabled && progress.done > 0 && (
        <button type="button" onClick={() => void reset()} className="inline-flex items-center gap-1.5 text-xs font-medium text-muted-foreground hover:text-foreground">
          <RotateCcw size={13} aria-hidden /> Volver a contar desde cero
        </button>
      )}

      <BarcodeScanner
        open={camera}
        onOpenChange={setCamera}
        onDetected={onCamera}
      />
    </div>
  );
}
ScanPanel.displayName = "ScanPanel";
