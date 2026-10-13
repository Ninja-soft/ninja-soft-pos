"use client";

// Certificados de retención de una orden de pago (F18 · H106, ADR-079):
// descargar el PDF o imprimirlo. Sólo dueño o encargado (RLS de
// tax_withholdings); para el resto la lista llega vacía y no se muestra.
import { useState } from "react";
import { Download, Printer } from "lucide-react";
import { Badge } from "@/components/ui/Badge";
import { Button } from "@/components/ui/Button";
import { useToast } from "@/components/ui/Toast";
import { formatCurrency } from "@/lib/utils/format";
import { RET_TAX_LABEL } from "@/lib/tax/retentions";
import { openRetentionCertificate } from "@/lib/tax/retentionCertificate";
import type { WithholdingRecord } from "@/modules/tax/api";
import { usePaymentWithholdings } from "@/modules/tax/hooks";
import { useFeature } from "@/modules/saas/gating";

export function CertificateButtons({ row, compact }: { row: WithholdingRecord; compact?: boolean }) {
  const { toast } = useToast();
  const [busy, setBusy] = useState<"download" | "print" | null>(null);
  async function go(mode: "download" | "print") {
    setBusy(mode);
    try {
      await openRetentionCertificate(row, mode);
    } catch {
      toast({ title: "No se pudo generar el certificado", variant: "error" });
    } finally {
      setBusy(null);
    }
  }
  return (
    <div className="flex shrink-0 gap-1">
      <Button
        size="sm"
        variant="ghost"
        aria-label={`Descargar certificado ${row.certificate ?? ""}`}
        loading={busy === "download"}
        onClick={() => void go("download")}
      >
        <Download size={14} />
        {!compact && "PDF"}
      </Button>
      <Button
        size="sm"
        variant="ghost"
        aria-label={`Imprimir certificado ${row.certificate ?? ""}`}
        loading={busy === "print"}
        onClick={() => void go("print")}
      >
        <Printer size={14} />
        {!compact && "Imprimir"}
      </Button>
    </div>
  );
}

export function PaymentRetentionCertificates({ paymentId }: { paymentId: string }) {
  const enabled = useFeature("percepciones_retenciones") === true;
  const { data: rows = [] } = usePaymentWithholdings(paymentId, enabled);
  if (rows.length === 0) return null;
  return (
    <section className="no-print space-y-2">
      <h3 className="text-sm font-semibold">Certificados de retención</h3>
      <ul className="space-y-1.5">
        {rows.map((r) => (
          <li key={r.id} className="flex flex-wrap items-center justify-between gap-2 rounded-md bg-muted/50 px-3 py-2 text-sm">
            <div className="min-w-0">
              <div className="flex flex-wrap items-center gap-2 font-medium">
                {r.certificate}
                {r.status === "voided" && <Badge tone="danger">Anulado</Badge>}
              </div>
              <div className="text-xs text-muted-foreground">
                {RET_TAX_LABEL[r.tax]}
                {r.concept_name ? ` · ${r.concept_name}` : ""} · {formatCurrency(r.amount)}
              </div>
            </div>
            <CertificateButtons row={r} />
          </li>
        ))}
      </ul>
    </section>
  );
}
