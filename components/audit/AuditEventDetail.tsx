"use client";

import { useMemo } from "react";
import { ArrowRight, Code2 } from "lucide-react";
import { Badge } from "@/components/ui/Badge";
import { Disclosure } from "@/components/ui/Disclosure";
import {
  collectAuditRefs,
  formatDateTimeAR,
  presentAuditEvent,
  type AuditEventLike,
  type PresentedAudit,
  type RefKind,
} from "@/lib/audit/present";
import { useAuditNames } from "@/modules/audit/names";
import { capitalizeName } from "@/lib/utils/format";
import { cn } from "@/lib/utils/cn";

// Detalle legible de un evento de auditoría (TX-AUD, ADR-160). Lo usan el
// visor del dueño (Seguridad › Auditoría, en un modal) y el timeline del panel
// interno (expandido en línea). La lógica vive en lib/audit/present.ts.

export interface AuditDetailEvent extends AuditEventLike {
  id: string;
  created_at: string;
  reason?: string | null;
  actorName?: string | null;
  storeName?: string | null;
}

export type KnownNames = Partial<Record<RefKind, Record<string, string>>>;

const EYEBROW = "text-[11px] font-semibold uppercase tracking-[0.12em] text-muted-foreground";
const TONE_DOT: Record<PresentedAudit["tone"], string> = {
  danger: "bg-danger",
  warning: "bg-warning",
  info: "bg-info",
  neutral: "bg-muted-foreground/50",
};

/** Presenta el evento con los ids resueltos (consulta en lote, con la RLS del usuario). */
export function useAuditPresentation(event: AuditDetailEvent | null, known?: KnownNames) {
  const refs = useMemo(() => (event ? collectAuditRefs([event]) : {}), [event]);
  const { names, isLoading } = useAuditNames(refs, known);
  const presented = event ? presentAuditEvent(event, names) : null;
  return { presented, resolving: isLoading };
}

/** Título + quién, cuándo y dónde. */
export function AuditEventHeader({ event, presented }: { event: AuditDetailEvent; presented: PresentedAudit }) {
  const who = event.actorName ? capitalizeName(event.actorName) : "Sistema";
  return (
    <div className="min-w-0 space-y-2">
      <div className="flex items-start gap-2">
        <span aria-hidden className={cn("mt-2 h-2 w-2 shrink-0 rounded-full", TONE_DOT[presented.tone])} />
        <h2 className="min-w-0 break-words font-display text-lg font-semibold leading-snug text-foreground">
          {presented.title}
        </h2>
      </div>
      <dl className="grid grid-cols-1 gap-x-4 gap-y-1 text-sm sm:grid-cols-3">
        <MetaItem label="Quién" value={who} />
        <MetaItem label="Cuándo" value={formatDateTimeAR(event.created_at)} />
        <MetaItem label="Dónde" value={event.storeName || "Todo el negocio"} />
      </dl>
    </div>
  );
}

function MetaItem({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex min-w-0 items-baseline gap-1.5 sm:block">
      <dt className="text-xs text-muted-foreground">{label}</dt>
      <dd className="min-w-0 truncate text-foreground">{value}</dd>
    </div>
  );
}

/** Motivo, cambios por sección y datos técnicos plegados. */
export function AuditEventBody({
  event,
  presented,
  resolving = false,
}: {
  event: AuditDetailEvent;
  presented: PresentedAudit;
  resolving?: boolean;
}) {
  const showBefore = presented.mode === "changes";
  return (
    <div className="space-y-4">
      <div className="flex flex-wrap gap-2">
        <Badge tone="neutral">{presented.entityLabel}</Badge>
        {presented.mode === "changes" && presented.fieldCount > 0 && (
          <Badge tone="neutral">
            {presented.fieldCount} {presented.fieldCount === 1 ? "cambio" : "cambios"}
          </Badge>
        )}
      </div>

      {event.reason && (
        <p className="rounded-md bg-muted px-3 py-2 text-sm text-foreground">
          <span className="text-muted-foreground">Motivo: </span>
          {event.reason}
        </p>
      )}

      {presented.mode === "none" ? (
        <p className="text-sm text-muted-foreground">Este evento no guarda datos adicionales.</p>
      ) : presented.fieldCount === 0 ? (
        <p className="text-sm text-muted-foreground">
          {showBefore ? "No hubo cambios en datos visibles. El detalle completo está en los datos técnicos." : "Sin datos para mostrar."}
        </p>
      ) : (
        <div className="space-y-4" aria-busy={resolving || undefined}>
          <p className={EYEBROW}>{presented.listTitle}</p>
          {presented.sections.map((s) => (
            <section key={s.key} aria-label={s.title}>
              <h3 className="mb-1.5 text-sm font-semibold text-foreground">{s.title}</h3>
              <dl className="divide-y divide-border rounded-md border border-border text-sm">
                {s.fields.map((f) => (
                  <div key={f.key} className="grid gap-1 px-3 py-2 sm:grid-cols-[minmax(0,180px)_1fr] sm:gap-3">
                    <dt className="text-muted-foreground">{f.label}</dt>
                    <dd className="min-w-0 break-words">
                      {showBefore ? (
                        <span className="flex flex-wrap items-center gap-x-2 gap-y-0.5">
                          <Value value={f.before} muted />
                          <ArrowRight size={14} aria-label="pasó a" className="shrink-0 text-muted-foreground" />
                          <Value value={f.after} />
                        </span>
                      ) : (
                        <Value value={f.after} />
                      )}
                    </dd>
                  </div>
                ))}
              </dl>
            </section>
          ))}
        </div>
      )}

      <Disclosure title="Ver datos técnicos" icon={<Code2 size={15} />}>
        <div className="space-y-3">
          <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-1 font-mono text-xs">
            <dt>entity_type</dt>
            <dd className="break-all text-foreground">{event.entity_type}</dd>
            <dt>action</dt>
            <dd className="break-all text-foreground">{event.action}</dd>
            {event.entity_id && (
              <>
                <dt>entity_id</dt>
                <dd className="break-all text-foreground">{event.entity_id}</dd>
              </>
            )}
            <dt>id</dt>
            <dd className="break-all text-foreground">{event.id}</dd>
          </dl>
          <JsonBlock label="Antes (before_data)" value={event.before_data} />
          <JsonBlock label="Después (after_data)" value={event.after_data} />
        </div>
      </Disclosure>
    </div>
  );
}

function Value({ value, muted = false }: { value: string | null; muted?: boolean }) {
  if (value === null) return <span className="italic text-muted-foreground">Sin dato</span>;
  return <span className={cn(muted ? "text-muted-foreground line-through" : "font-medium text-foreground")}>{value}</span>;
}

function JsonBlock({ label, value }: { label: string; value: unknown }) {
  if (value === null || value === undefined) return null;
  return (
    <div>
      <p className="mb-1 text-xs font-medium text-muted-foreground">{label}</p>
      <pre className="slim-scrollbar max-h-64 overflow-auto rounded-md bg-background p-2 font-mono text-[11px] leading-relaxed text-foreground">
        {JSON.stringify(value, null, 2)}
      </pre>
    </div>
  );
}
