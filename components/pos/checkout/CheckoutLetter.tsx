"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { FileText, Undo2 } from "lucide-react";
import { Badge } from "@/components/ui/Badge";
import { Button } from "@/components/ui/Button";
import { Modal } from "@/components/ui/Modal";
import { useToast } from "@/components/ui/Toast";
import { cn } from "@/lib/utils/cn";
import { createClient } from "@/lib/supabase/client";
import { letterCheckMessage, letterOptions, overrideRiskText } from "@/lib/billing/cbteOptions";
import { inferLetter } from "@/lib/tax/comprobante";
import { isValidCuit } from "@/lib/tax/catalog";
import { verificationLabel, type FiscalVerification } from "@/lib/customers/padron";
import { useFeature } from "@/modules/saas/gating";
import { useTaxSettings } from "@/modules/tax/hooks";
import { padronApi } from "@/modules/padron/api";

type CustomerFiscal = {
  id: string;
  iva_condition: string | null;
  document_type: string | null;
  document_number: string | null;
  fiscal_verification?: FiscalVerification;
  fiscal_verified_at?: string | null;
};

type LooseFrom = {
  from: (t: string) => {
    select: (c: string) => {
      eq: (c: string, v: string) => { maybeSingle: () => PromiseLike<{ data: unknown; error: { message: string } | null }> };
    };
  };
};

async function fetchCustomerFiscal(id: string): Promise<CustomerFiscal | null> {
  const sb = createClient() as unknown as LooseFrom;
  const full = await sb
    .from("customers")
    .select("id, iva_condition, document_type, document_number, fiscal_verification, fiscal_verified_at")
    .eq("id", id)
    .maybeSingle();
  if (!full.error) return (full.data as CustomerFiscal | null) ?? null;
  // Sin la migración de ADR-133 las columnas nuevas no existen.
  const basic = await sb.from("customers").select("id, iva_condition, document_type, document_number").eq("id", id).maybeSingle();
  return (basic.data as CustomerFiscal | null) ?? null;
}

// Comprobante de la venta en la hoja de cobro (ADR-133): la letra que
// corresponde (inferLetter) y "Cambiar tipo" con SÓLO los tipos que ARCA
// acepta para este negocio y este cliente. Forzar un tipo distinto pide
// confirmación con el riesgo y lo registra el servidor
// (sale_letter_override_set), que lo vuelve a validar al crear la venta.
export function CheckoutLetter({
  open,
  customerId,
  offline = false,
}: {
  open: boolean;
  customerId: string | null;
  offline?: boolean;
}) {
  const { toast } = useToast();
  const arca = useFeature("facturacion_afip");
  const tax = useTaxSettings(open);
  const cust = useQuery({
    queryKey: ["checkout-customer-fiscal", customerId],
    queryFn: () => fetchCustomerFiscal(customerId!),
    enabled: open && Boolean(customerId),
    staleTime: 30_000,
  });
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

  if (arca !== true || !emitter || !suggested) return null;
  const letter = forced ?? suggested;
  const alternatives = options.filter((o) => o.allowed && o.letter !== suggested).length;
  const suggestedProblem = options.find((o) => o.letter === suggested && !o.allowed);
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
    <div className="mt-3 flex flex-wrap items-center justify-between gap-2 rounded-lg bg-fg-4 px-3 py-2 text-[13px]">
      <span className="flex min-w-0 items-center gap-2">
        <FileText size={15} className="shrink-0 text-muted-foreground" aria-hidden />
        <span className="font-medium">Factura {letter}</span>
        {forced ? <Badge tone="warning">Elegida a mano</Badge> : <span className="text-muted-foreground">sugerida</span>}
        {verified && c?.fiscal_verification === "padron" && <Badge tone="success">Cliente verificado en ARCA</Badge>}
      </span>
      <span className="flex items-center gap-1">
        {forced && (
          <Button type="button" variant="ghost" size="sm" loading={busy} onClick={() => void choose(suggested, null)}>
            <Undo2 size={14} aria-hidden /> Volver a {suggested}
          </Button>
        )}
        {!offline && (
          <Button type="button" variant="ghost" size="sm" onClick={() => setPickerOpen(true)}>
            Cambiar tipo
          </Button>
        )}
      </span>
      {suggestedProblem && (
        <p className="w-full text-xs text-warning">{suggestedProblem.reason}</p>
      )}

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
