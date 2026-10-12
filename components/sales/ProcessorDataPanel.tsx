"use client";

// "Datos del procesador" de un cobro (ADR-061): se piden a la API del
// proveedor bajo demanda (Edge payment_provider_data) con la credencial que
// creó el cobro. Si ya hay una foto guardada, se muestra en el acto.
import Link from "next/link";
import type { Route } from "next";
import { RefreshCw, Server } from "lucide-react";
import { Button } from "@/components/ui/Button";
import { Badge } from "@/components/ui/Badge";
import { Spinner } from "@/components/ui/Spinner";
import { formatCurrency, formatRelative } from "@/lib/utils/format";
import { cn } from "@/lib/utils/cn";
import { paymentTypeLabel, type ProcessorPaymentData } from "@/supabase/functions/_shared/processorData";
import { providerErrorMessage } from "@/lib/sales/paymentDetail";
import { useProviderData, useProviderSnapshot, useRefreshProviderData } from "@/modules/sales/providerData";

const dt = (iso: string | null) =>
  iso ? new Date(iso).toLocaleString("es-AR", { dateStyle: "short", timeStyle: "short" }) : null;
const d = (iso: string | null) => (iso ? new Date(iso).toLocaleDateString("es-AR", { dateStyle: "medium" }) : null);

export function ProcessorDataPanel({
  paymentId,
  providerLabel,
  canSeeFees,
  requested,
  onRequest,
  live,
}: {
  paymentId: string;
  providerLabel: string | null;
  canSeeFees: boolean;
  requested: boolean;
  onRequest: () => void;
  live: boolean;
}) {
  const snapshot = useProviderSnapshot(paymentId, canSeeFees);
  const snapReleased = snapshot.data?.normalized.released;
  const query = useProviderData(paymentId, {
    enabled: requested,
    // Se re-consulta sola mientras el cobro está pendiente o falta acreditar.
    live: requested && (live || snapReleased === false),
  });
  const refresh = useRefreshProviderData(paymentId);
  const res = query.data;
  const p = providerLabel ?? "El procesador";

  let data: ProcessorPaymentData | null = null;
  let fetchedAt: string | null = null;
  let notice: string | null = null;
  if (res && (res.status === "ok" || res.status === "stale")) {
    data = res.data;
    fetchedAt = res.fetched_at;
    if (res.status === "stale") notice = `${providerErrorMessage(res.error, p)} Mostramos la última consulta.`;
  } else if (snapshot.data) {
    data = snapshot.data.normalized;
    fetchedAt = snapshot.data.fetched_at;
  }

  const errorBlock = (() => {
    if (!res || data) return null;
    if (res.status === "no_api") {
      return `${p} no ofrece la consulta de un pago por API: mostramos lo que guardó el POS.`;
    }
    if (res.status === "no_provider") return "Este cobro no pasó por un procesador integrado.";
    if (res.status === "error") return providerErrorMessage(res.error, p);
    return null;
  })();
  const notConnected = res?.status === "error" && res.error === "not_connected";

  return (
    <div className="rounded-lg border border-border">
      <div className="flex items-center gap-2 border-b border-border px-3 py-2">
        <Server size={14} className="shrink-0 text-muted-foreground" />
        <span className="min-w-0 flex-1 truncate text-sm font-semibold">Datos del procesador</span>
        {fetchedAt && (
          <span className="hidden text-xs text-muted-foreground sm:inline">{formatRelative(fetchedAt)}</span>
        )}
        {requested || data ? (
          <Button
            variant="ghost"
            size="sm"
            className="h-8 px-2"
            disabled={refresh.isPending || query.isFetching}
            onClick={() => (requested ? refresh.mutate() : onRequest())}
            aria-label="Actualizar datos del procesador"
            title="Actualizar"
          >
            <RefreshCw size={14} className={cn((refresh.isPending || query.isFetching) && "animate-spin")} />
            <span className="ml-1 text-xs">Actualizar</span>
          </Button>
        ) : null}
      </div>

      <div className="px-3 py-3 text-sm">
        {!requested && !data && (
          <div className="flex flex-col items-start gap-2">
            <p className="text-muted-foreground">
              Comisiones, neto, fecha de acreditación, cuotas y tarjeta según {p}.
            </p>
            <Button variant="secondary" size="sm" onClick={onRequest}>
              Ver datos del procesador
            </Button>
          </div>
        )}
        {requested && !data && query.isLoading && (
          <div className="flex items-center gap-2 text-muted-foreground">
            <Spinner /> Consultando a {p}...
          </div>
        )}
        {errorBlock && (
          <p className="text-muted-foreground">
            {errorBlock}{" "}
            {notConnected && (
              <Link href={"/configuracion?seccion=pagos" as Route} className="font-medium text-ninja-flameSoft underline-offset-2 hover:underline">
                Ir a Medios de pago
              </Link>
            )}
          </p>
        )}
        {notice && <p className="mb-2 text-xs text-warning">{notice}</p>}
        {data && <ProcessorData data={data} canSeeFees={canSeeFees} />}
      </div>
    </div>
  );
}

function Row({ label, value, strong, mono }: { label: string; value: React.ReactNode; strong?: boolean; mono?: boolean }) {
  return (
    <div className="flex items-baseline justify-between gap-3 py-1">
      <span className="text-muted-foreground">{label}</span>
      <span className={cn("text-right tabular-nums", strong && "font-semibold", mono && "font-mono text-xs")}>{value}</span>
    </div>
  );
}

function ProcessorData({ data, canSeeFees }: { data: ProcessorPaymentData; canSeeFees: boolean }) {
  const approved = data.status === "approved" || data.status === "authorized";
  const tone = approved ? "success" : ["rejected", "cancelled", "voided", "annulled", "charged_back"].includes(data.status) ? "danger" : "warning";
  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center gap-2">
        <Badge tone={tone}>{data.status_label}</Badge>
        {data.status_detail && <span className="text-xs text-muted-foreground">{data.status_detail}</span>}
        {data.release_date && (
          <Badge tone={data.released ? "success" : "info"}>
            {data.released ? "Acreditado" : "Pendiente de acreditación"}
          </Badge>
        )}
      </div>

      <div className="divide-y divide-border">
        {data.gross != null && <Row label="Bruto" value={formatCurrency(data.gross)} />}
        {canSeeFees ? (
          <>
            {data.fees.map((f, i) => (
              <Row key={`${f.label}-${i}`} label={f.label} value={`- ${formatCurrency(f.amount)}`} />
            ))}
            {data.refunded > 0 && <Row label="Devuelto" value={`- ${formatCurrency(data.refunded)}`} />}
            {data.net != null && <Row label="Neto que recibís" value={formatCurrency(data.net)} strong />}
          </>
        ) : (
          <p className="py-1 text-xs text-muted-foreground">Comisiones visibles para el dueño o el encargado.</p>
        )}
      </div>

      <div className="grid grid-cols-1 gap-x-6 sm:grid-cols-2">
        {data.approved_at && <Row label="Aprobado" value={dt(data.approved_at)} />}
        {data.release_date && (
          <Row label={data.released ? "Acreditado el" : "Se acredita el"} value={d(data.release_date)} />
        )}
        {data.payment_type && <Row label="Tipo" value={paymentTypeLabel(data.payment_type)} />}
        {data.installments != null && data.installments > 0 && (
          <Row
            label="Cuotas"
            value={
              data.installments === 1
                ? "1 pago"
                : `${data.installments}${data.installment_amount ? ` de ${formatCurrency(data.installment_amount)}` : ""}`
            }
          />
        )}
        {data.card && (
          <Row
            label="Tarjeta"
            value={[data.card.brand, data.card.first6 ? `${data.card.first6}...` : null, data.card.last4 ? `**** ${data.card.last4}` : null]
              .filter(Boolean)
              .join(" ")}
          />
        )}
        {data.card?.holder && <Row label="Titular" value={data.card.holder} />}
        {data.authorization && <Row label="Autorización" value={data.authorization} mono />}
        {data.cupon && <Row label="Cupón" value={data.cupon} mono />}
        {data.lote && <Row label="Lote" value={data.lote} mono />}
        {data.comercio && <Row label="N° de comercio" value={data.comercio} mono />}
        {data.terminal && <Row label="Terminal" value={data.terminal} mono />}
        {data.payer?.email && <Row label="Pagador" value={data.payer.email} />}
        {data.payer?.doc && <Row label="Documento" value={data.payer.doc} />}
        {data.external_id && <Row label="Id de pago" value={data.external_id} mono />}
        {data.order_id && <Row label="Id de orden" value={data.order_id} mono />}
        {data.pos_id && <Row label="Caja del procesador" value={data.pos_id} mono />}
        {data.store_ext_id && <Row label="Sucursal del procesador" value={data.store_ext_id} mono />}
      </div>
    </div>
  );
}
