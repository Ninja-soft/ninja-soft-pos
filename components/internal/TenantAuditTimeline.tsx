"use client";

import { useMemo, useState } from "react";
import { format } from "date-fns";
import { ChevronDown, ChevronRight, ScrollText, X } from "lucide-react";
import { Card } from "@/components/ui/Card";
import { Button } from "@/components/ui/Button";
import { Segmented } from "@/components/ui/Segmented";
import { SkeletonLines } from "@/components/ui/Skeleton";
import { SearchField } from "@/components/ui/SearchField";
import { EmptyState } from "@/components/ui/EmptyState";
import { Callout } from "@/components/ui/Callout";
import { DateRangePicker, type DateRange } from "@/components/ui/DateRangePicker";
import { useInternalAudit } from "@/modules/internal/hooks";
import {
  AUDIT_CATEGORY_LABELS,
  auditChanges,
  describeAuditAction,
  filterAuditEntries,
  groupAuditByDay,
  type AuditCategory,
} from "@/lib/internal/auditTimeline";

const PAGE = 50;
const CATEGORIES = Object.keys(AUDIT_CATEGORY_LABELS) as (AuditCategory | "all")[];
const CATEGORY_DOT: Record<AuditCategory, string> = {
  lifecycle: "bg-ninja-flame",
  plan: "bg-success",
  access: "bg-warning",
  config: "bg-muted-foreground",
  operation: "bg-border",
};

function dayLabel(day: string): string {
  const [y, m, d] = day.split("-").map(Number);
  return new Date(y!, (m ?? 1) - 1, d).toLocaleDateString("es-AR", {
    weekday: "long",
    day: "numeric",
    month: "long",
    year: "numeric",
  });
}

// Timeline de auditoría del negocio (audit_logs), legible y filtrable
// (ADR-073). Las fechas filtran en el servidor; categoría y texto en memoria
// sobre lo traído. "Ver más" amplía el lote.
export function TenantAuditTimeline({ tenantId }: { tenantId: string }) {
  const [category, setCategory] = useState<AuditCategory | "all">("all");
  const [query, setQuery] = useState("");
  const [range, setRange] = useState<DateRange | undefined>(undefined);
  const [limit, setLimit] = useState(PAGE);
  const [openId, setOpenId] = useState<string | null>(null);

  const { data, isLoading, isError, refetch } = useInternalAudit({
    tenantId,
    limit,
    from: range?.from ? format(range.from, "yyyy-MM-dd") : null,
    to: range?.to
      ? format(range.to, "yyyy-MM-dd")
      : range?.from
        ? format(range.from, "yyyy-MM-dd")
        : null,
  });

  const filtered = useMemo(
    () => filterAuditEntries(data ?? [], { category, query }),
    [data, category, query],
  );
  const groups = useMemo(() => groupAuditByDay(filtered), [filtered]);
  const mayHaveMore = (data?.length ?? 0) >= limit;

  return (
    <Card className="mt-3">
      <div className="space-y-3 border-b border-border p-3">
        <Segmented
          value={category}
          onChange={setCategory}
          size="sm"
          aria-label="Categoría"
          options={CATEGORIES.map((c) => ({ value: c, label: AUDIT_CATEGORY_LABELS[c] }))}
        />
        <div className="flex flex-wrap items-center gap-2">
          <SearchField
            value={query}
            onValueChange={setQuery}
            placeholder="Buscar acción, motivo o autor"
            aria-label="Buscar en la auditoría"
            className="min-w-0 basis-full sm:max-w-xs sm:flex-1 sm:basis-auto"
          />
          <DateRangePicker
            value={range}
            onChange={(r) => {
              setRange(r);
              setLimit(PAGE);
            }}
            className="h-11"
          />
          {(range?.from || query || category !== "all") && (
            <button
              onClick={() => {
                setRange(undefined);
                setQuery("");
                setCategory("all");
                setLimit(PAGE);
              }}
              type="button"
              className="inline-flex h-11 items-center gap-1 rounded-lg px-3 text-xs font-medium text-foreground transition hover:bg-muted"
            >
              <X size={13} /> Limpiar
            </button>
          )}
          {data && (
            <span className="text-xs tabular-nums text-muted-foreground">
              {filtered.length} de {data.length} registros
            </span>
          )}
        </div>
      </div>

      {isLoading ? (
        <div className="p-4" aria-busy>
          <SkeletonLines lines={6} />
        </div>
      ) : isError ? (
        <div className="p-4">
          <Callout
            tone="danger"
            title="No se pudo cargar la auditoría"
            actions={
              <Button variant="secondary" size="sm" onClick={() => refetch()}>
                Reintentar
              </Button>
            }
          />
        </div>
      ) : groups.length === 0 ? (
        <EmptyState compact icon={ScrollText} title="Sin registros con estos filtros" />
      ) : (
        <div>
          {groups.map((g) => (
            <section key={g.day}>
              <h3 className="bg-muted/40 px-4 py-1.5 text-xs font-semibold capitalize text-muted-foreground">
                {dayLabel(g.day)}
              </h3>
              <ul className="divide-y divide-border">
                {g.items.map((e) => {
                  const d = describeAuditAction(e.entity_type, e.action);
                  const changes = auditChanges(e.before_data, e.after_data);
                  const open = openId === e.id;
                  const expandable = changes.length > 0 || e.before_data != null || e.after_data != null;
                  return (
                    <li key={e.id}>
                      <button
                        type="button"
                        disabled={!expandable}
                        onClick={() => setOpenId(open ? null : e.id)}
                        aria-expanded={open}
                        className="flex w-full items-start gap-3 px-4 py-2.5 text-left transition hover:bg-muted/30 disabled:cursor-default disabled:hover:bg-transparent"
                      >
                        <span aria-hidden className={`mt-1.5 h-2 w-2 shrink-0 rounded-full ${CATEGORY_DOT[d.category]}`} />
                        <span className="min-w-0 flex-1">
                          <span className="block break-words text-sm font-medium text-foreground">{d.label}</span>
                          {e.reason && (
                            <span className="mt-0.5 block break-words text-sm text-muted-foreground">Motivo: {e.reason}</span>
                          )}
                          {!open && changes.length > 0 && (
                            <span className="mt-0.5 block truncate text-xs text-muted-foreground">
                              {changes
                                .slice(0, 3)
                                .map((c) => (c.before ? `${c.key}: ${c.before} a ${c.after}` : `${c.key}: ${c.after}`))
                                .join(" · ")}
                            </span>
                          )}
                          <span className="mt-0.5 block text-xs text-muted-foreground">
                            {e.actorName ?? e.actorEmail ?? "Sistema"} ·{" "}
                            {new Date(e.created_at).toLocaleTimeString("es-AR", { hour: "2-digit", minute: "2-digit" })}
                          </span>
                        </span>
                        {expandable &&
                          (open ? (
                            <ChevronDown size={15} className="mt-1 shrink-0 text-muted-foreground" />
                          ) : (
                            <ChevronRight size={15} className="mt-1 shrink-0 text-muted-foreground" />
                          ))}
                      </button>
                      {open && (
                        <div className="px-4 pb-3 pl-9">
                          {changes.length > 0 ? (
                            <div className="slim-scrollbar overflow-x-auto"><table className="w-full min-w-[320px] text-xs">
                              <thead className="text-left text-muted-foreground">
                                <tr>
                                  <th className="py-1 pr-3 font-medium">Campo</th>
                                  <th className="py-1 pr-3 font-medium">Antes</th>
                                  <th className="py-1 font-medium">Después</th>
                                </tr>
                              </thead>
                              <tbody className="text-foreground">
                                {changes.map((c) => (
                                  <tr key={c.key} className="align-top">
                                    <td className="py-1 pr-3 font-mono">{c.key}</td>
                                    <td className="break-all py-1 pr-3 text-muted-foreground">{c.before}</td>
                                    <td className="break-all py-1">{c.after}</td>
                                  </tr>
                                ))}
                              </tbody>
                            </table></div>
                          ) : (
                            <p className="text-xs text-muted-foreground">Sin cambios de datos registrados.</p>
                          )}
                          <p className="mt-2 font-mono text-[11px] text-muted-foreground">
                            {e.entity_type} · {e.action}
                          </p>
                        </div>
                      )}
                    </li>
                  );
                })}
              </ul>
            </section>
          ))}
          {mayHaveMore && (
            <div className="border-t border-border p-3 text-center">
              <Button variant="secondary" size="sm" onClick={() => setLimit((l) => l + PAGE)}>
                Ver más
              </Button>
            </div>
          )}
        </div>
      )}
    </Card>
  );
}
