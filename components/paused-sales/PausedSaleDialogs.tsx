"use client";

import { useEffect, useState } from "react";
import { AlertTriangle, Eraser, Hourglass, Pause, Play } from "lucide-react";
import { Button } from "@/components/ui/Button";
import { Callout } from "@/components/ui/Callout";
import { Checkbox } from "@/components/ui/Checkbox";
import { Input } from "@/components/ui/Input";
import { Modal } from "@/components/ui/Modal";
import { money } from "@/components/pos/ui/posStyles";
import { classifyPayments, discardRule, pausedTitle, type PausedSale } from "@/modules/paused-sales/logic";

// Diálogos de "Pausar venta" y "Limpiar" (ADR-106). Botones de 44 px o más,
// sin sombras ni bordes de color.

// ── Descartar una venta pausada ─────────────────────────────────────────────
export function DiscardPausedDialog({
  sale,
  role,
  onClose,
  onResume,
  onConfirm,
}: {
  sale: PausedSale | null;
  role: string | null;
  onClose: () => void;
  onResume: (s: PausedSale) => void;
  onConfirm: (s: PausedSale, reason: string | null, refundConfirmed: boolean) => Promise<void>;
}) {
  const [checked, setChecked] = useState(false);
  const [reason, setReason] = useState("");
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    setChecked(false);
    setReason("");
    setBusy(false);
  }, [sale?.id]);
  if (!sale) return null;
  const rule = discardRule(sale.payments, role);
  const title = pausedTitle(sale);
  const canConfirm =
    rule.kind === "free"
      ? true
      : rule.kind === "confirm_cash"
        ? checked
        : rule.canOverride && checked && reason.trim().length > 0;

  async function go() {
    if (!sale || !canConfirm) return;
    setBusy(true);
    await onConfirm(sale, reason.trim() || null, rule.kind === "needs_refund");
    setBusy(false);
  }

  return (
    <Modal
      open
      onOpenChange={(o) => !o && onClose()}
      title={`¿Descartar "${title}"?`}
      className="max-w-md"
      footer={
        <>
          <Button variant="secondary" onClick={onClose}>
            Volver
          </Button>
          {rule.kind === "needs_refund" && !rule.canOverride ? (
            <Button onClick={() => onResume(sale)}>
              <Play size={16} aria-hidden /> Retomar y cobrar
            </Button>
          ) : (
            <Button variant="destructive" loading={busy} disabled={!canConfirm} onClick={() => void go()}>
              Descartar
            </Button>
          )}
        </>
      }
    >
      <div className="space-y-4 text-sm">
        <p className="text-muted-foreground">
          {money(sale.total)} · {sale.cart.lines.length} {sale.cart.lines.length === 1 ? "producto" : "productos"}. La
          venta no se registra y el carrito se pierde.
          {rule.kind !== "needs_refund" && rule.pendingIntents > 0
            ? " El QR o link que esperaba el pago se cancela."
            : ""}
        </p>
        {rule.kind === "confirm_cash" && (
          <label className="flex min-h-11 cursor-pointer items-center gap-3 rounded-lg bg-fg-4 px-3">
            <Checkbox checked={checked} onCheckedChange={setChecked} aria-label="Ya devolví el efectivo" />
            <span>
              Ya le devolví <strong className="tabular-nums">{money(rule.cash)}</strong> en efectivo al cliente
            </span>
          </label>
        )}
        {rule.kind === "needs_refund" && (
          <>
            <Callout tone="warning" icon={AlertTriangle} title={`Tiene ${money(rule.credited)} ya cobrados`}>
              No se descarta sin resolver ese pago. Podés:
              <ul className="mt-1.5 list-disc space-y-1 pl-4">
                <li>Retomarla y terminar la venta (podés sacar productos y cobrar la diferencia).</li>
                <li>
                  Devolver el pago: QR o link desde Ventas, Cobros QR (Devolver); tarjeta en posnet, anulando el cupón
                  en la terminal; transferencia, devolviéndola desde la cuenta.
                </li>
                <li>Después, un encargado o el dueño confirma acá que se devolvió.</li>
              </ul>
            </Callout>
            {rule.canOverride && (
              <div className="space-y-3">
                <label className="flex min-h-11 cursor-pointer items-center gap-3 rounded-lg bg-fg-4 px-3">
                  <Checkbox checked={checked} onCheckedChange={setChecked} aria-label="Ya se devolvió el pago" />
                  <span>Ya se devolvió el pago al cliente</span>
                </label>
                <Input
                  label="Motivo"
                  value={reason}
                  maxLength={300}
                  onChange={(e) => setReason(e.target.value)}
                  placeholder="Ej.: el cliente no volvió, se devolvió por Mercado Pago"
                />
              </div>
            )}
          </>
        )}
      </div>
    </Modal>
  );
}

// ── Limpiar: confirmación breve ─────────────────────────────────────────────
export function ClearConfirmDialog({
  open,
  onOpenChange,
  total,
  cash,
  pendingIntents,
  onConfirm,
}: {
  open: boolean;
  onOpenChange: (o: boolean) => void;
  total: number;
  cash: number;
  pendingIntents: number;
  onConfirm: () => void;
}) {
  return (
    <Modal
      open={open}
      onOpenChange={onOpenChange}
      title="¿Limpiar la venta?"
      className="max-w-sm"
      footer={
        <>
          <Button variant="secondary" onClick={() => onOpenChange(false)}>
            No
          </Button>
          <Button variant="destructive" autoFocus onClick={onConfirm} aria-keyshortcuts="Shift+F4 Enter">
            <Eraser size={16} aria-hidden /> Sí, limpiar
          </Button>
        </>
      }
    >
      <p className="text-sm text-muted-foreground">
        Se vacían los productos, el cliente, los descuentos y los pagos sin confirmar ({money(total)}). Podés deshacerlo
        unos segundos.
        {cash > 0 ? ` Devolvé ${money(cash)} en efectivo al cliente.` : ""}
        {pendingIntents > 0 ? " El QR que esperaba el pago se cancela." : ""}
      </p>
    </Modal>
  );
}

// ── Limpiar con pagos cobrados: no se puede ─────────────────────────────────
export function ClearBlockedDialog({
  credited,
  onClose,
  onPause,
}: {
  credited: number | null;
  onClose: () => void;
  onPause: () => void;
}) {
  return (
    <Modal
      open={credited != null}
      onOpenChange={(o) => !o && onClose()}
      title="Hay pagos ya cobrados"
      className="max-w-md"
      footer={
        <>
          <Button variant="secondary" onClick={onClose}>
            Volver
          </Button>
          <Button onClick={onPause}>
            <Pause size={16} aria-hidden /> Pausar venta
          </Button>
        </>
      }
    >
      <div className="space-y-3 text-sm text-muted-foreground">
        <p>
          Esta venta tiene <strong className="tabular-nums text-foreground">{money(credited ?? 0)}</strong> cobrados con
          QR, tarjeta o transferencia. Si la limpiás, ese pago queda sin venta.
        </p>
        <p>
          Pausala para atender a otro cliente: el pago queda guardado con la venta. Si hay que devolverlo, hacelo desde
          Ventas, Cobros QR (o anulando el cupón en el posnet) y después descartala desde Pausadas.
        </p>
      </div>
    </Modal>
  );
}

// ── Retomar con el QR todavía esperando ─────────────────────────────────────
export function IntentWaitDialog({
  sale,
  onClose,
  onCancelAndResume,
}: {
  sale: PausedSale | null;
  onClose: () => void;
  onCancelAndResume: (s: PausedSale) => void;
}) {
  if (!sale) return null;
  const pend = classifyPayments(sale.payments).pendingIntents;
  const amount = pend.reduce((a, p) => a + p.amount, 0);
  return (
    <Modal
      open
      onOpenChange={(o) => !o && onClose()}
      title="El QR todavía no se pagó"
      className="max-w-md"
      footer={
        <>
          <Button variant="secondary" onClick={onClose}>
            <Hourglass size={16} aria-hidden /> Seguir esperando
          </Button>
          <Button onClick={() => onCancelAndResume(sale)}>Cancelar el QR y retomar</Button>
        </>
      }
    >
      <p className="text-sm text-muted-foreground">
        &quot;{pausedTitle(sale)}&quot; tiene un QR o link de <strong className="tabular-nums text-foreground">{money(amount)}</strong>{" "}
        esperando el pago. Si el cliente lo va a pagar, dejala pausada: cuando se acredite, aparece como cobrado. Si no,
        cancelalo y cobrá de nuevo al retomar.
      </p>
    </Modal>
  );
}

// ── Retomar con otra venta en curso ─────────────────────────────────────────
export function SwitchSaleDialog({
  sale,
  onClose,
  onSwitch,
}: {
  sale: PausedSale | null;
  onClose: () => void;
  onSwitch: (s: PausedSale) => void;
}) {
  if (!sale) return null;
  return (
    <Modal
      open
      onOpenChange={(o) => !o && onClose()}
      title="Tenés una venta en curso"
      className="max-w-md"
      footer={
        <>
          <Button variant="secondary" onClick={onClose}>
            Volver
          </Button>
          <Button onClick={() => onSwitch(sale)}>
            <Pause size={16} aria-hidden /> Pausarla y retomar
          </Button>
        </>
      }
    >
      <p className="text-sm text-muted-foreground">
        Para retomar &quot;{pausedTitle(sale)}&quot;, la venta que estás cargando se pausa (queda en Pausadas con sus
        pagos).
      </p>
    </Modal>
  );
}

// ── Cerrar caja con ventas pausadas ─────────────────────────────────────────
export function PausedOnCloseDialog({
  list,
  onClose,
  onCarry,
  onDiscardFree,
}: {
  list: PausedSale[] | null;
  onClose: () => void;
  onCarry: () => void;
  onDiscardFree: () => Promise<void>;
}) {
  const [busy, setBusy] = useState(false);
  if (!list) return null;
  const withPayments = list.filter((s) => classifyPayments(s.payments).paid > 0 || classifyPayments(s.payments).pendingIntents.length > 0);
  const free = list.length - withPayments.length;
  const total = list.reduce((a, s) => a + s.total, 0);
  return (
    <Modal
      open
      onOpenChange={(o) => !o && onClose()}
      title="Hay ventas pausadas en esta caja"
      className="max-w-md"
      footer={
        <>
          <Button variant="secondary" onClick={onClose}>
            Volver
          </Button>
          {free > 0 && (
            <Button
              variant="secondary"
              loading={busy}
              onClick={async () => {
                setBusy(true);
                await onDiscardFree();
                setBusy(false);
              }}
            >
              Descartar {free === 1 ? "la que no tiene pagos" : `las ${free} sin pagos`}
            </Button>
          )}
          <Button onClick={onCarry}>Pasarlas y cerrar</Button>
        </>
      }
    >
      <div className="space-y-3 text-sm text-muted-foreground">
        <p>
          {list.length === 1 ? "1 venta pausada" : `${list.length} ventas pausadas`} por{" "}
          <strong className="tabular-nums text-foreground">{money(total)}</strong>. No son ventas todavía: no entran en
          el arqueo.
        </p>
        <p>
          Al cerrar, pasan solas a la próxima apertura de esta caja.
          {withPayments.length > 0
            ? ` ${withPayments.length === 1 ? "Una tiene" : `${withPayments.length} tienen`} pagos guardados: esas pasan siempre (no se pierde ningún cobro).`
            : ""}
        </p>
      </div>
    </Modal>
  );
}
