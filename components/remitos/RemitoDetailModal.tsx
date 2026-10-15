"use client";

// Detalle de un remito (ADR-136): vista previa A4 (la misma hoja que se
// imprime, se baja en PDF y va adjunta al email), COT, transporte y recepción
// editables mientras está emitido, y anulación con motivo (dueño o encargado).

import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { Download, Mail, Printer } from "lucide-react";
import { Modal } from "@/components/ui/Modal";
import { Button } from "@/components/ui/Button";
import { Input } from "@/components/ui/Input";
import { Badge } from "@/components/ui/Badge";
import { ConfirmDialog } from "@/components/ui/ConfirmDialog";
import { Skeleton } from "@/components/ui/Skeleton";
import { useToast } from "@/components/ui/Toast";
import { InvoiceFit } from "@/components/invoices/InvoiceFit";
import { RemitoDocument } from "@/components/remitos/RemitoDocument";
import { downloadInvoicePdf, exportInvoicePdfBase64 } from "@/lib/invoices/exportPdf";
import { printTicketIsolated } from "@/lib/print/webPrint";
import {
  COT_JURISDICTION_SHORT,
  cotRequired,
  cotValid,
  cuitValid,
  normalizeCuit,
  remitoErrorMessage,
  remitoFileName,
  remitoNumberLabel,
} from "@/lib/remitos/logic";
import { useRemito, useRemitoConfig, useRemitoMutations } from "@/modules/remitos/api";
import { useTicketBranding } from "@/modules/tickets/hooks";
import { useInvoiceStyle } from "@/modules/invoices/hooks";

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export function RemitoDetailModal({
  id,
  canManage,
  onClose,
}: {
  id: string | null;
  canManage: boolean;
  onClose: () => void;
}) {
  const { toast } = useToast();
  const { data: r, isLoading } = useRemito(id);
  const { data: cfg } = useRemitoConfig(Boolean(id));
  const { data: ticketBrand } = useTicketBranding(Boolean(id), r?.store_id ?? null);
  const { style } = useInvoiceStyle(ticketBrand ?? null, Boolean(id));
  const m = useRemitoMutations();
  const printRef = useRef<HTMLDivElement>(null);
  const [mounted, setMounted] = useState(false);
  const [busy, setBusy] = useState<"pdf" | "mail" | null>(null);
  const [to, setTo] = useState("");
  const [cot, setCot] = useState("");
  const [cotUntil, setCotUntil] = useState("");
  const [carrier, setCarrier] = useState("");
  const [carrierCuit, setCarrierCuit] = useState("");
  const [plate, setPlate] = useState("");
  const [received, setReceived] = useState("");
  const [voiding, setVoiding] = useState(false);

  useEffect(() => setMounted(true), []);
  useEffect(() => {
    if (!r) return;
    setCot(r.cot_number ?? "");
    setCotUntil(r.cot_valid_until ?? "");
    setCarrier(r.carrier_name ?? "");
    setCarrierCuit(r.carrier_cuit ?? "");
    setPlate(r.vehicle_plate ?? "");
    setReceived(r.received_name ?? "");
    setTo(r.emailed_to ?? "");
  }, [r]);

  if (!id) return null;
  const label = r ? remitoNumberLabel(r.pto_vta, r.number) : "";
  const editable = r?.status === "emitido";
  const missingCot = r ? !r.cot_number && cotRequired(cfg?.cot_threshold ?? null, r.cot_jurisdiction, r.declared_value) : false;
  const dirty =
    r &&
    (cot !== (r.cot_number ?? "") ||
      cotUntil !== (r.cot_valid_until ?? "") ||
      carrier !== (r.carrier_name ?? "") ||
      (normalizeCuit(carrierCuit) ?? "") !== (r.carrier_cuit ?? "") ||
      plate !== (r.vehicle_plate ?? "") ||
      received !== (r.received_name ?? ""));
  const formOk = cotValid(cot) && cuitValid(carrierCuit);

  async function save() {
    if (!r) return;
    try {
      await m.update.mutateAsync({
        id: r.id,
        data: {
          cot_number: cot.trim() || null,
          cot_valid_until: cotUntil || null,
          carrier_name: carrier.trim() || null,
          carrier_cuit: normalizeCuit(carrierCuit),
          vehicle_plate: plate.trim() || null,
          received_name: received.trim() || null,
        },
      });
      toast({ title: "Remito actualizado", variant: "success" });
    } catch (e) {
      toast({ title: "No se pudo guardar", description: remitoErrorMessage(e), variant: "error" });
    }
  }

  async function pdf() {
    if (!printRef.current || !r) return;
    setBusy("pdf");
    try {
      await downloadInvoicePdf(printRef.current, remitoFileName(r));
    } catch {
      toast({ title: "No se pudo generar el PDF", variant: "error" });
    } finally {
      setBusy(null);
    }
  }

  async function mail() {
    if (!printRef.current || !r) return;
    setBusy("mail");
    try {
      const b64 = await exportInvoicePdfBase64(printRef.current);
      await m.email.mutateAsync({ id: r.id, to: to.trim().toLowerCase(), pdf: b64 });
      toast({ title: `Remito enviado a ${to.trim()}`, variant: "success" });
    } catch (e) {
      const msg = e instanceof Error ? e.message : "";
      toast({
        title: "No se pudo enviar",
        description: /tenant_smtp_not_configured/.test(msg) ? "Configurá el email de tu negocio en Configuración › Email." : remitoErrorMessage(e),
        variant: "error",
      });
    } finally {
      setBusy(null);
    }
  }

  const offscreen =
    r && mounted
      ? createPortal(
          <div ref={printRef} aria-hidden className="pointer-events-none fixed -left-[9999px] top-0">
            <div className="ticket-print">
              <RemitoDocument remito={r} style={style} printable />
            </div>
          </div>,
          document.body,
        )
      : null;

  return (
    <>
      {offscreen}
      <Modal
        open
        onOpenChange={(o) => !o && onClose()}
        title={r ? `Remito ${label}` : "Remito"}
        description={r ? `${r.kind === "envio" ? "De envío" : "De entrega"} · ${r.receiver_name}` : undefined}
        className="sm:max-w-5xl"
      >
        {isLoading || !r ? (
          <Skeleton className="mx-auto aspect-[210/297] w-full max-w-xl rounded-lg" />
        ) : (
          <div className="grid gap-5 md:grid-cols-[minmax(0,1fr)_320px]">
            <div className="overflow-hidden rounded-lg border border-border bg-white p-2">
              <InvoiceFit>
                <RemitoDocument remito={r} style={style} />
              </InvoiceFit>
            </div>
            <aside className="space-y-5">
              <div className="flex flex-wrap items-center gap-1.5">
                <Badge tone={r.status === "emitido" ? "success" : "neutral"}>{r.status === "emitido" ? "Emitido" : "Anulado"}</Badge>
                {r.cot_number ? (
                  <Badge tone="info">COT {r.cot_jurisdiction ? COT_JURISDICTION_SHORT[r.cot_jurisdiction] : ""}</Badge>
                ) : missingCot ? (
                  <Badge tone="warning">Falta el COT</Badge>
                ) : null}
                {r.emailed_at && <Badge tone="neutral">Enviado por email</Badge>}
              </div>

              <div className="grid grid-cols-2 gap-2">
                <Button variant="secondary" onClick={pdf} loading={busy === "pdf"}>
                  <Download size={15} /> PDF
                </Button>
                <Button
                  variant="secondary"
                  onClick={() => {
                    if (!printTicketIsolated(printRef.current)) toast({ title: "No se pudo imprimir", variant: "error" });
                  }}
                >
                  <Printer size={15} /> Imprimir
                </Button>
              </div>

              <div className="space-y-2">
                <Input label="Enviar por email" type="email" placeholder="cliente@correo.com" value={to} onChange={(e) => setTo(e.target.value)} />
                <Button className="w-full" variant="secondary" onClick={mail} disabled={!EMAIL_RE.test(to.trim())} loading={busy === "mail"}>
                  <Mail size={15} /> Enviar con el PDF
                </Button>
              </div>

              {editable && (
                <div className="space-y-3 rounded-lg bg-muted/40 p-3">
                  <p className="text-sm font-semibold">COT, transporte y recepción</p>
                  <Input label="Número de COT" value={cot} onChange={(e) => setCot(e.target.value.trim())} maxLength={40} error={cotValid(cot) ? undefined : "6 a 40 letras, números o guiones."} />
                  <Input label="COT válido hasta" type="date" value={cotUntil} onChange={(e) => setCotUntil(e.target.value)} />
                  <Input label="Transporte" value={carrier} onChange={(e) => setCarrier(e.target.value)} maxLength={120} />
                  <div className="grid grid-cols-2 gap-2">
                    <Input label="CUIT" value={carrierCuit} onChange={(e) => setCarrierCuit(e.target.value)} maxLength={13} error={cuitValid(carrierCuit) ? undefined : "11 dígitos."} />
                    <Input label="Patente" value={plate} onChange={(e) => setPlate(e.target.value.toUpperCase())} maxLength={20} />
                  </div>
                  <Input label="Recibió (aclaración)" value={received} onChange={(e) => setReceived(e.target.value)} maxLength={120} />
                  <Button className="w-full" onClick={save} disabled={!dirty || !formOk} loading={m.update.isPending}>
                    Guardar
                  </Button>
                </div>
              )}

              {editable && canManage && (
                <Button variant="ghost" className="w-full text-danger" onClick={() => setVoiding(true)}>
                  Anular remito
                </Button>
              )}
              {r.status === "anulado" && r.void_reason && <p className="text-xs text-muted-foreground">Anulado: {r.void_reason}</p>}
            </aside>
          </div>
        )}
      </Modal>
      <ConfirmDialog
        open={voiding}
        onOpenChange={setVoiding}
        title={`Anular el remito ${label}`}
        description="El número no se vuelve a usar. Si hace falta, emití uno nuevo."
        confirmLabel="Anular"
        danger
        withReason
        loading={m.void.isPending}
        onConfirm={async (reason) => {
          if (!r) return;
          try {
            await m.void.mutateAsync({ id: r.id, reason: reason ?? "" });
            toast({ title: `Remito ${label} anulado`, variant: "success" });
            setVoiding(false);
          } catch (e) {
            toast({ title: "No se pudo anular", description: remitoErrorMessage(e), variant: "error" });
          }
        }}
      />
    </>
  );
}
