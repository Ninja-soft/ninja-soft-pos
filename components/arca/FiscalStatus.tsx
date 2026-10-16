"use client";

import { FileCheck2, RotateCcw } from "lucide-react";
import { Badge } from "@/components/ui/Badge";
import { Button } from "@/components/ui/Button";
import { useToast } from "@/components/ui/Toast";
import { humanError } from "@/supabase/functions/_shared/arca/errors";
import { qrSvgDataUrl } from "@/lib/qr/qrcode";
import { arcaErrorMessage, ENV_SHORT, formatFiscalDate, statusInfo } from "@/lib/arca/labels";
import type { FiscalDocument } from "@/modules/arca/api";
import { useArcaMutations, useArcaStatus } from "@/modules/arca/hooks";
import { useMyTenant } from "@/modules/tenants/hooks";
import { docLabel } from "./ArcaMonitor";
import { FiscalStatusBadge } from "./shared";
import { WhyLetter } from "./WhyLetter";
import { letterOfTipo } from "@/supabase/functions/_shared/arca/comprobante";

// Estado fiscal en el detalle de la venta (ADR-072): comprobante, estado, CAE
// o CAEA con vencimiento, QR, y reproceso o emisión para dueño y encargado.
export function FiscalStatus({
  saleId,
  docs,
  saleStatus,
  nonFiscal = false,
}: {
  saleId: string;
  docs: FiscalDocument[];
  saleStatus: string;
  /** ADR-155: se cobró con sólo ticket (no va a ARCA salvo que se pida). */
  nonFiscal?: boolean;
}) {
  const m = useArcaMutations();
  const { toast } = useToast();
  const { data: me } = useMyTenant();
  const status = useArcaStatus();
  const manager = me?.role === "owner" || me?.role === "manager";

  if (docs.length === 0) {
    if (!status.data?.enabled || !manager || saleStatus !== "completed") return null;
    return (
      <div className="flex flex-col gap-2 rounded-md bg-muted p-3 text-sm sm:flex-row sm:items-center sm:justify-between">
        <p className="text-muted-foreground">
          {nonFiscal
            ? "Se cobró con sólo ticket (no fiscal). Si el cliente la pide, podés hacer la factura ahora."
            : "Esta venta no tiene factura electrónica."}
        </p>
        <Button
          size="sm"
          variant="secondary"
          loading={m.enqueueSale.isPending}
          onClick={async () => {
            try {
              await m.enqueueSale.mutateAsync(saleId);
              toast({ title: "Factura en camino", variant: "success" });
            } catch (e) {
              toast({ title: "No se pudo emitir", description: arcaErrorMessage(e), variant: "error" });
            }
          }}
        >
          <FileCheck2 size={15} /> {nonFiscal ? "Hacer la factura" : "Emitir factura"}
        </Button>
      </div>
    );
  }

  return (
    <div className="space-y-2">
      {docs.map((d) => {
        const h = d.last_error_code && d.status !== "aprobado" ? humanError(d.last_error_code, d.last_error_msg) : null;
        const canRetry = manager && (d.status === "rechazado" || d.status === "requiere_accion");
        return (
          <div key={d.id} className="rounded-md border border-border bg-card p-3 text-sm">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
                <p className="font-semibold">{docLabel(d)}</p>
                <WhyLetter letter={(d.cbte_tipo != null ? letterOfTipo(d.cbte_tipo) : null) ?? d.cbte_letter} cbteTipo={d.cbte_tipo} />
              </div>
              <span className="flex flex-wrap items-center gap-1.5">
                {d.environment === "homologacion" && <Badge tone="neutral">{ENV_SHORT.homologacion}</Badge>}
                {d.emission_type === "CAEA" && <Badge tone="info">Contingencia</Badge>}
                <FiscalStatusBadge status={d.status} />
              </span>
            </div>
            {d.status === "aprobado" ? (
              <div className="mt-2 flex items-start gap-3">
                {d.qr_url && (
                  // eslint-disable-next-line @next/next/no-img-element
                  <img src={qrSvgDataUrl(d.qr_url)} alt="QR fiscal de ARCA" width={72} height={72} className="h-[72px] w-[72px] shrink-0 rounded bg-white p-1" />
                )}
                <dl className="grid gap-1">
                  <div>
                    <dt className="inline text-muted-foreground">{d.emission_type === "CAEA" ? "CAEA" : "CAE"}: </dt>
                    <dd className="inline font-mono">{d.cae}</dd>
                  </div>
                  <div>
                    <dt className="inline text-muted-foreground">Vencimiento: </dt>
                    <dd className="inline">{formatFiscalDate(d.cae_vto)}</dd>
                  </div>
                  {d.emission_type === "CAEA" && (
                    <div className="text-muted-foreground">
                      {d.inform_status === "informado" ? "Informada a ARCA." : "Se informa a ARCA cuando vuelva a responder."}
                    </div>
                  )}
                </dl>
              </div>
            ) : (
              <p className="mt-1 text-muted-foreground">{h ? `${h.title}. ${h.action}` : statusInfo(d.status).hint}</p>
            )}
            {canRetry && (
              <Button
                size="sm"
                variant="secondary"
                className="mt-2"
                loading={m.retry.isPending}
                onClick={async () => {
                  try {
                    const r = await m.retry.mutateAsync(d.id);
                    toast({
                      title: r.status === "pendiente" ? "Vuelve a la cola" : "Todavía falta algo",
                      description: r.blocker ? humanError(r.blocker).action : undefined,
                      variant: r.status === "pendiente" ? "success" : "error",
                    });
                  } catch (e) {
                    toast({ title: "No se pudo reprocesar", description: arcaErrorMessage(e), variant: "error" });
                  }
                }}
              >
                <RotateCcw size={15} /> Reprocesar
              </Button>
            )}
          </div>
        );
      })}
    </div>
  );
}
FiscalStatus.displayName = "FiscalStatus";
