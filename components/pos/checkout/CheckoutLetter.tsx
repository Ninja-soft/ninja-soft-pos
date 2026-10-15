"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { FileText, Undo2 } from "lucide-react";
import { Badge } from "@/components/ui/Badge";
import { Button } from "@/components/ui/Button";
import { Modal } from "@/components/ui/Modal";
import { useToast } from "@/components/ui/Toast";
import { cn } from "@/lib/utils/cn";
import { letterCheckMessage, letterOptions, overrideRiskText } from "@/lib/billing/cbteOptions";
import { inferLetter } from "@/lib/tax/comprobante";
import { isValidCuit } from "@/lib/tax/catalog";
import { verificationLabel } from "@/lib/customers/padron";
import { useCheckoutCustomerFiscal } from "@/modules/customers/checkoutFiscal";
import { useFeature } from "@/modules/saas/gating";
import { useTaxSettings } from "@/modules/tax/hooks";
import { padronApi } from "@/modules/padron/api";

// Comprobante de la venta en la hoja de cobro (ADR-133): la letra que
// corresponde (inferLetter) y "Cambiar tipo" con SÓLO los tipos que ARCA
// acepta para este negocio y este cliente. Forzar un tipo distinto pide
// confirmación con el riesgo y lo registra el servidor
// (sale_letter_override_set), que lo vuelve a validar al crear la venta.
export interface CheckoutLetterState {
  /** Letra con la que sale la venta (la sugerida o la elegida a mano). */
  letter: string;
  suggested: string;
  forced: boolean;
  /** Por qué ARCA no acepta la sugerida (p. ej. falta el CUIT). */
  problem: string | null;
}

export function CheckoutLetter({
  open,
  customerId,
  offline = false,
  embedded = false,
  onState,
}: {
  open: boolean;
  customerId: string | null;
  offline?: boolean;
  /** Dentro del bloque Cliente (ADR-146): sin fondo propio. */
  embedded?: boolean;
  /** Avisa la letra vigente (el bloque Cliente la muestra cerrado). */
  onState?: (s: CheckoutLetterState | null) => void;
}) {
  const { toast } = useToast();
  const arca = useFeature("facturacion_afip");
  const tax = useTaxSettings(open);
  const cust = useCheckoutCustomerFiscal(customerId, open);
  const [forced, setForced] = useState<string | null>(null);
  const [pickerOpen, setPickerOpen] = useState(false);
  const [confirm, setConfirm] = useState<string | null>(null);
  const [reason, setReason] = useState("");
  const [busy, setBusy] = useState(false);
  const forcedRef = useRef<string | null>(null);
  forcedRef.current = forced;

  // Se cerró la hoja sin cobrar o cambió el cliente: el tipo elegido se descarta.
  useEffect(() => {
    if (!open || forcedRef.current) {
      if (forcedRef.current) void padronApi.clearLetterOverride().catch(() => undefined);
      setForced(null);
    }
  }, [open, customerId]);

  const emitter = tax.data?.iva_condition ?? null;
  const issuesM = tax.data?.issues_cbte_m ?? false;
  const c = customerId ? cust.data : null;
  const receptor = c?.iva_condition || "consumidor_final";
  const hasCuit = c?.document_type === "cuit" && isValidCuit(c?.document_number);
  const suggested = inferLetter(emitter, receptor, { issuesM });
  const options = useMemo(() => letterOptions(emitter, receptor, { hasCuit, issuesM }), [emitter, receptor, hasCuit, issuesM]);

  const visible = arca === true && Boolean(emitter) && Boolean(suggested);
  const letter = forced ?? suggested;
  const suggestedProblem = options.find((o) => o.letter === suggested && !o.allowed);
  const problem = suggestedProblem?.reason ?? null;

  // El bloque Cliente muestra la letra vigente en su línea cerrada.
  const onStateRef = useRef(onState);
  onStateRef.current = onState;
  useEffect(() => {
    onStateRef.current?.(visible && letter && suggested ? { letter, suggested, forced: Boolean(forced), problem } : null);
  }, [visible, letter, suggested, forced, problem]);

  if (!visible || !suggested || !letter) return null;
  const alternatives = options.filter((o) => o.allowed && o.letter !== suggested).length;
  const verified = verificationLabel(c?.fiscal_verification ?? null, c?.fiscal_verified_at);

  async function choose(l: string, why: string | null) {
    setBusy(true);
    try {
      const r = await padronApi.setLetterOverride(customerId, l, why);
      setForced(r.forced ? l : null);
      setPickerOpen(false);
      setConfirm(null);
      setReason("");
      if (r.forced) toast({ title: `Esta venta va con Factura ${l}`, variant: "success" });
    } catch (e) {
      const code = e instanceof Error ? e.message : "";
      toast({ title: "ARCA no acepta ese tipo", description: letterCheckMessage(code, { letter: l, receptor, emitter }), variant: "error" });
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className={cn("text-[13px]", embedded ? "rounded-lg bg-fg-4 px-3 py-2" : "mt-3 rounded-lg bg-fg-4 px-3 py-2")}>
      {/* Fila 1: la letra (nunca se parte) y sus marcas, que bajan de línea si
          no entran; las acciones quedan chicas a la derecha de la misma fila. */}
      <div className="flex items-start gap-2">
        <FileText size={15} className="mt-[3px] shrink-0 text-muted-foreground" aria-hidden />
        <div className="flex min-w-0 flex-1 flex-wrap items-center gap-x-2 gap-y-1">
          <span className="whitespace-nowrap font-medium">Factura {letter}</span>
          {forced ? (
            <Badge tone="warning">Elegida a mano</Badge>
          ) : (
            <span className="whitespace-nowrap text-muted-foreground">sugerida</span>
          )}
          {verified && c?.fiscal_verification === "padron" && <Badge tone="success">Cliente verificado en ARCA</Badge>}
        </div>
        {(forced || !offline) && (
          <div className="-my-0.5 -mr-1 flex shrink-0 items-center gap-0.5">
            {forced && (
              <Button
                type="button"
                variant="ghost"
                size="sm"
                className="h-7 gap-1 whitespace-nowrap px-2 text-xs"
                loading={busy}
                onClick={() => void choose(suggested, null)}
              >
                <Undo2 size={13} aria-hidden /> Volver a {suggested}
              </Button>
            )}
            {!offline && (
              <Button
                type="button"
                variant="ghost"
                size="sm"
                className="h-7 whitespace-nowrap px-2 text-xs"
                onClick={() => setPickerOpen(true)}
              >
                Cambiar tipo
              </Button>
            )}
          </div>
        )}
      </div>
      {suggestedProblem && !embedded && <p className="mt-1.5 text-xs text-warning">{suggestedProblem.reason}</p>}

      <Modal open={pickerOpen} onOpenChange={setPickerOpen} title="Tipo de comprobante">
        <div className="space-y-3">
          <p className="text-sm text-muted-foreground">
            Te mostramos sólo los tipos que ARCA acepta para tu negocio y este cliente. La que corresponde es la{" "}
            <span className="font-medium text-foreground">Factura {suggested}</span>.
            {alternatives === 0 ? " Para esta venta no hay otra opción válida." : ""}
          </p>
          <ul className="space-y-1.5">
            {options.map((o) => (
              <li key={o.letter}>
                <button
                  type="button"
                  disabled={!o.allowed || busy}
                  onClick={() => (o.letter === suggested ? void choose(o.letter, null) : setConfirm(o.letter))}
                  className={cn(
                    "flex min-h-11 w-full items-start justify-between gap-3 rounded-lg px-3 py-2 text-left text-sm transition-colors",
                    o.allowed ? "hover:bg-fg-6" : "cursor-not-allowed opacity-60",
                    o.letter === letter && "choice-on",
                  )}
                >
                  <span className="min-w-0">
                    <span className="block font-semibold">Factura {o.letter}</span>
                    {o.reason && <span className="block text-xs text-muted-foreground">{o.reason}</span>}
                  </span>
                  {o.suggested && <Badge tone="info">Corresponde</Badge>}
                </button>
              </li>
            ))}
          </ul>
        </div>
      </Modal>

      <Modal open={confirm !== null} onOpenChange={(o) => !o && setConfirm(null)} title={`¿Hacer Factura ${confirm ?? ""}?`}>
        <div className="space-y-3">
          <p className="text-sm text-muted-foreground">{confirm ? overrideRiskText(suggested, confirm) : null}</p>
          <label className="block text-sm font-medium text-muted-foreground">
            Motivo (opcional)
            <input
              value={reason}
              onChange={(e) => setReason(e.target.value)}
              maxLength={300}
              placeholder="Ej. el cliente la pidió así"
              className="mt-1 h-10 w-full rounded-lg border border-input bg-background px-3 text-sm text-foreground outline-none focus:border-ninja-flameSoft"
            />
          </label>
          <div className="flex justify-end gap-2">
            <Button type="button" variant="secondary" onClick={() => setConfirm(null)}>
              Cancelar
            </Button>
            <Button type="button" loading={busy} onClick={() => confirm && void choose(confirm, reason.trim() || null)}>
              Sí, hacer Factura {confirm}
            </Button>
          </div>
        </div>
      </Modal>
    </div>
  );
}
CheckoutLetter.displayName = "CheckoutLetter";
