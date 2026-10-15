"use client";

import { useState } from "react";
import { CloudOff, RotateCcw, Send } from "lucide-react";
import { Badge } from "@/components/ui/Badge";
import { Button } from "@/components/ui/Button";
import { Modal } from "@/components/ui/Modal";
import { Segmented } from "@/components/ui/Segmented";
import { SpinnerBlock } from "@/components/ui/Spinner";
import { useToast } from "@/components/ui/Toast";
import { formatCurrency } from "@/lib/utils/format";
import { humanError } from "@/supabase/functions/_shared/arca/errors";
import { CBTE_LABEL } from "@/supabase/functions/_shared/arca/comprobante";
import {
  ENV_SHORT,
  ORIGIN_LABEL,
  arcaErrorMessage,
  formatFiscalDate,
  formatFiscalNumber,
} from "@/lib/arca/labels";
import type { ArcaConfig, DocFilter, FiscalDocument } from "@/modules/arca/api";
import { useArcaMutations, useFiscalDocuments, useFiscalEvents } from "@/modules/arca/hooks";
import { Dot, FiscalStatusBadge, fmtDateTime } from "./shared";

// Monitor de la facturación electrónica (ADR-072): cola, errores con su
// explicación, última conexión, reproceso, contingencia CAEA.

function Stat({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="bg-card p-4">
      <p className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">{label}</p>
      <div className="mt-1 flex flex-wrap items-center gap-2 text-sm">{children}</div>
    </div>
  );
}

export function docLabel(d: Pick<FiscalDocument, "cbte_tipo" | "pto_vta" | "cbte_nro">): string {
  const t = d.cbte_tipo != null ? CBTE_LABEL[d.cbte_tipo] ?? `Tipo ${d.cbte_tipo}` : "Comprobante";
  return d.cbte_nro != null ? `${t} ${formatFiscalNumber(d.pto_vta, d.cbte_nro)}` : t;
}

export function ArcaMonitor({ config, canWrite }: { config: ArcaConfig; canWrite: boolean }) {
  const { toast } = useToast();
  const m = useArcaMutations();
  const [filter, setFilter] = useState<DocFilter>("errores");
  const [detail, setDetail] = useState<FiscalDocument | null>(null);
  const docs = useFiscalDocuments(filter);
  const events = useFiscalEvents();
  const s = config.settings;
  const c = config.counts;
  const pending = (c.pendiente ?? 0) + (c.enviando ?? 0);
  const errors = (c.rechazado ?? 0) + (c.requiere_accion ?? 0);

  const processNow = async () => {
    try {
      const r = await m.emitir.mutateAsync(undefined);
      toast({ title: `Cola procesada: ${r.processed?.length ?? 0} comprobantes`, variant: "success" });
    } catch (e) {
      toast({ title: "No se pudo procesar", description: arcaErrorMessage(e), variant: "error" });
    }
  };
  const retry = async (d: FiscalDocument) => {
    try {
      const r = await m.retry.mutateAsync(d.id);
      toast({
        title: r.status === "pendiente" ? "Vuelve a la cola" : "Todavía falta algo",
        description: r.blocker ? humanError(r.blocker).action : undefined,
        variant: r.status === "pendiente" ? "success" : "error",
      });
      setDetail(null);
    } catch (e) {
      toast({ title: "No se pudo reprocesar", description: arcaErrorMessage(e), variant: "error" });
    }
  };

  const recentErrors = (events.data ?? []).filter((e) => !["ok", "aprobado", "informado", "contingencia"].includes(e.outcome)).slice(0, 8);

  return (
    <div className="space-y-5">
      <div className="grid gap-px overflow-hidden rounded-md border border-border bg-border sm:grid-cols-2 lg:grid-cols-4">
        <Stat label="En cola">
          <span className="text-lg font-semibold">{pending}</span>
          <span className="text-muted-foreground">pendientes</span>
        </Stat>
        <Stat label="Para revisar">
          <span className="text-lg font-semibold">{errors}</span>
          {config.dead_letter > 0 && <Badge tone="danger">{config.dead_letter} sin reintentos</Badge>}
        </Stat>
        <Stat label="Última conexión">
          {s?.last_connection_at ? (
            <>
              <Dot tone={s.last_connection_ok ? "success" : "danger"} />
              <span>{fmtDateTime(s.last_connection_at)}</span>
              {s.last_connection_env && <span className="text-muted-foreground">({ENV_SHORT[s.last_connection_env]})</span>}
            </>
          ) : (
            <span className="text-muted-foreground">Todavía no hubo</span>
          )}
        </Stat>
        <div className="flex items-center bg-card p-4">
          <Button className="w-full" onClick={processNow} loading={m.emitir.isPending} disabled={!canWrite || !s?.enabled}>
            <Send size={16} /> Procesar ahora
          </Button>
        </div>
      </div>
      {s?.last_connection_ok === false && s.last_connection_message && (
        <p className="text-sm text-muted-foreground">Último mensaje de ARCA: {s.last_connection_message}</p>
      )}

      {/* Contingencia */}
      {(s?.caea_enabled || config.caea.length > 0) && (
        <div className="rounded-md border border-border bg-card p-4">
          <p className="flex items-center gap-2 font-semibold">
            <CloudOff size={16} className="text-muted-foreground" aria-hidden /> Contingencia (CAEA)
            {s?.contingency_since && <Badge tone="warning">Facturando en contingencia desde {fmtDateTime(s.contingency_since)}</Badge>}
          </p>
          {config.caea.length === 0 ? (
            <p className="mt-2 text-sm text-muted-foreground">
              Sin CAEA todavía. {s?.caea_last_message ?? "NinjaSoft lo pide solo antes de cada quincena."}
            </p>
          ) : (
            <ul className="mt-2 divide-y divide-border text-sm">
              {config.caea.map((x) => (
                <li key={x.id} className="flex flex-col gap-1 py-2 sm:flex-row sm:items-center sm:justify-between">
                  <span>
                    <span className="font-mono">{x.caea}</span>{" "}
                    <span className="text-muted-foreground">
                      {formatFiscalDate(x.fch_vig_desde)} al {formatFiscalDate(x.fch_vig_hasta)} ({ENV_SHORT[x.environment]})
                    </span>
                  </span>
                  <span className="flex flex-wrap gap-1.5">
                    <Badge tone="neutral">{x.used} usadas</Badge>
                    {x.to_inform > 0 && <Badge tone="warning">{x.to_inform} por informar hasta {formatFiscalDate(x.fch_tope_inf)}</Badge>}
                    {x.rejected > 0 && <Badge tone="danger">{x.rejected} rechazadas</Badge>}
                    {x.sin_movimiento_at && <Badge tone="success">Sin movimiento informado</Badge>}
                    {x.sin_movimiento_error && <Badge tone="danger">Sin movimiento: error</Badge>}
                  </span>
                </li>
              ))}
            </ul>
          )}
        </div>
      )}

      {/* Comprobantes */}
      <div className="space-y-3">
        <Segmented scrollOnMobile
          value={filter}
          onChange={setFilter}
          aria-label="Filtro"
          options={[
            { value: "errores", label: `Para revisar${errors ? ` (${errors})` : ""}` },
            { value: "pendientes", label: `En cola${pending ? ` (${pending})` : ""}` },
            { value: "aprobados", label: "Aprobados" },
            { value: "contingencia", label: "Con CAEA" },
            { value: "todos", label: "Todos" },
          ]}
        />
        {docs.isLoading ? (
          <SpinnerBlock className="py-10" />
        ) : (docs.data ?? []).length === 0 ? (
          <p className="rounded-md bg-muted p-4 text-sm text-muted-foreground">Nada por acá.</p>
        ) : (
          <ul className="divide-y divide-border rounded-md border border-border bg-card">
            {(docs.data ?? []).map((d) => {
              const h = d.last_error_code ? humanError(d.last_error_code, d.last_error_msg) : null;
              return (
                <li key={d.id}>
                  <button
                    type="button"
                    onClick={() => setDetail(d)}
                    className="flex w-full flex-col gap-1 px-3 py-2.5 text-left text-sm transition hover:bg-muted/50 sm:flex-row sm:items-center sm:justify-between"
                  >
                    <span className="min-w-0">
                      <span className="font-medium">{docLabel(d)}</span>{" "}
                      <span className="text-muted-foreground">
                        · {ORIGIN_LABEL[d.origin]} · {fmtDateTime(d.created_at)} · {ENV_SHORT[d.environment]}
                      </span>
                      {h && d.status !== "aprobado" && (
                        <span className="block truncate text-muted-foreground">
                          {d.last_error_code}: {h.title}
                        </span>
                      )}
                    </span>
                    <span className="flex shrink-0 items-center gap-2">
                      {d.imp_total != null && <span>{formatCurrency(Number(d.imp_total))}</span>}
                      {d.emission_type === "CAEA" && <Badge tone="info">CAEA</Badge>}
                      <FiscalStatusBadge status={d.status} />
                    </span>
                  </button>
                </li>
              );
            })}
          </ul>
        )}
      </div>

      {/* Errores recientes */}
      {recentErrors.length > 0 && (
        <div className="rounded-md border border-border bg-card">
          <p className="border-b border-border px-3 py-2 text-xs font-semibold uppercase tracking-wide text-muted-foreground">
            Errores recientes de ARCA
          </p>
          <ul className="divide-y divide-border text-sm">
            {recentErrors.map((e) => {
              const h = humanError(e.error_code, e.error_msg);
              return (
                <li key={e.id} className="px-3 py-2">
                  <p className="flex flex-wrap items-center gap-2">
                    <Dot tone="danger" />
                    <span className="font-medium">{h.title}</span>
                    {e.error_code && <span className="font-mono text-xs text-muted-foreground">{e.error_code}</span>}
                    <span className="text-xs text-muted-foreground">
                      {e.action} · {fmtDateTime(e.created_at)}
                    </span>
                  </p>
                  <p className="text-muted-foreground">{h.action}</p>
                </li>
              );
            })}
          </ul>
        </div>
      )}

      <Modal
        open={detail != null}
        onOpenChange={(o) => !o && setDetail(null)}
        title={detail ? docLabel(detail) : "Comprobante"}
        footer={
          detail && (detail.status === "rechazado" || detail.status === "requiere_accion") && canWrite ? (
            <Button onClick={() => retry(detail)} loading={m.retry.isPending} className="w-full sm:w-auto">
              <RotateCcw size={16} /> Reprocesar
            </Button>
          ) : undefined
        }
      >
        {detail && <DocDetail d={detail} />}
      </Modal>
    </div>
  );
}
ArcaMonitor.displayName = "ArcaMonitor";

function DocDetail({ d }: { d: FiscalDocument }) {
  const h = d.last_error_code ? humanError(d.last_error_code, d.last_error_msg) : null;
  return (
    <div className="space-y-3 text-sm">
      <div className="flex flex-wrap items-center gap-2">
        <FiscalStatusBadge status={d.status} />
        <Badge tone="neutral">{ENV_SHORT[d.environment]}</Badge>
        {d.emission_type === "CAEA" && <Badge tone="info">CAEA</Badge>}
        {d.inform_status && <Badge tone={d.inform_status === "informado" ? "success" : d.inform_status === "rechazado" ? "danger" : "warning"}>Informe: {d.inform_status}</Badge>}
      </div>
      <dl className="grid gap-2 sm:grid-cols-2">
        <div>
          <dt className="text-xs text-muted-foreground">{d.emission_type === "CAEA" ? "CAEA" : "CAE"}</dt>
          <dd className="font-mono">{d.cae ?? "Sin autorizar"}</dd>
        </div>
        <div>
          <dt className="text-xs text-muted-foreground">Vencimiento</dt>
          <dd>{formatFiscalDate(d.cae_vto) || "Sin dato"}</dd>
        </div>
        <div>
          <dt className="text-xs text-muted-foreground">Intentos</dt>
          <dd>{d.attempts}</dd>
        </div>
        <div>
          <dt className="text-xs text-muted-foreground">Próximo intento</dt>
          <dd>{d.status === "pendiente" ? fmtDateTime(d.next_attempt_at) : "Sin programar"}</dd>
        </div>
      </dl>
      {h && d.status !== "aprobado" && (
        <div className="rounded-md bg-muted p-3">
          <p className="font-semibold text-foreground">{h.title}</p>
          <p className="text-muted-foreground">{h.action}</p>
          {d.last_error_msg && <p className="mt-1 text-xs text-muted-foreground">ARCA: {d.last_error_msg}</p>}
        </div>
      )}
      {(d.observations ?? []).length > 0 && (
        <div>
          <p className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">Observaciones de ARCA</p>
          <ul className="mt-1 space-y-1">
            {(d.observations ?? []).map((o, i) => (
              <li key={i}>
                <span className="font-mono text-xs">{o.code}</span> {o.msg}
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}
