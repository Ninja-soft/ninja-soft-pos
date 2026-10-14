"use client";

import { Fragment, useState } from "react";
import { AlertTriangle, ChevronDown, ScrollText, X } from "lucide-react";
import { format } from "date-fns";
import {
  DateRangePicker,
  type DateRange,
} from "@/components/ui/DateRangePicker";
import {
  useAuditEntityTypes,
  useInternalAudit,
  useInternalTenants,
} from "@/modules/internal/hooks";
import { cn } from "@/lib/utils/cn";
import { NoData } from "@/components/ui/NoData";
import { Badge } from "@/components/ui/Badge";
import { Button } from "@/components/ui/Button";
import { Disclosure } from "@/components/ui/Disclosure";
import { EmptyState } from "@/components/ui/EmptyState";
import { PageHeader } from "@/components/ui/PageHeader";
import { SearchField } from "@/components/ui/SearchField";
import { TableStateRow, TableWrap } from "@/components/ui/Table";

const selectCls =
  "h-11 w-full rounded-lg border border-input bg-background px-3 text-sm text-foreground outline-none transition focus:border-ninja-flameSoft";

// Campos técnicos que cambian en casi todo UPDATE y no aportan a la lectura.
const NOISE = new Set(["updated_at"]);
const VALUE_MAX = 140;

function asRecord(v: unknown): Record<string, unknown> | null {
  return v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : null;
}

function show(v: unknown): string {
  if (v === undefined) return "";
  const s = typeof v === "string" ? v : JSON.stringify(v);
  return s ?? "";
}

/** Campos que cambiaron (UPDATE) o que se crearon / borraron (INSERT / DELETE). */
function changedFields(before: unknown, after: unknown) {
  const b = asRecord(before);
  const a = asRecord(after);
  if (!b && !a) return [];
  const keys = Array.from(new Set([...Object.keys(b ?? {}), ...Object.keys(a ?? {})]));
  return keys
    .filter((k) => !NOISE.has(k))
    .filter((k) => !b || !a || JSON.stringify(b[k]) !== JSON.stringify(a[k]))
    .filter((k) => (b?.[k] ?? null) !== null || (a?.[k] ?? null) !== null)
    .map((k) => ({ key: k, before: b ? b[k] : undefined, after: a ? a[k] : undefined }));
}

function Value({ v }: { v: unknown }) {
  if (v === undefined || v === null || v === "") return <NoData />;
  const s = show(v);
  const cut = s.length > VALUE_MAX;
  return (
    <span title={cut ? s : undefined} className="break-all font-mono text-xs text-foreground">
      {cut ? `${s.slice(0, VALUE_MAX)}…` : s}
    </span>
  );
}

function JsonBlock({ label, value }: { label: string; value: unknown }) {
  if (value == null) return null;
  return (
    <div className="min-w-0 flex-1">
      <div className="mb-1 text-[11px] font-semibold uppercase tracking-[0.14em] text-muted-foreground">
        {label}
      </div>
      <pre className="slim-scrollbar max-h-64 overflow-auto rounded-lg bg-background p-3 text-xs text-foreground">
        {JSON.stringify(value, null, 2)}
      </pre>
    </div>
  );
}

function EntryDetail({
  before,
  after,
  reason,
}: {
  before: unknown;
  after: unknown;
  reason: string | null;
}) {
  const fields = changedFields(before, after);
  const both = before != null && after != null;
  return (
    <div className="space-y-3">
      {reason && (
        <p className="text-sm">
          <span className="font-semibold text-foreground">Motivo:</span>{" "}
          <span className="text-muted-foreground">{reason}</span>
        </p>
      )}
      {fields.length > 0 && (
        <div className="overflow-hidden rounded-lg border border-border bg-card">
          <div className="grid grid-cols-[minmax(7rem,12rem)_1fr] gap-x-4 bg-muted/60 px-3 py-2 text-[11px] font-semibold uppercase tracking-[0.12em] text-muted-foreground">
            <span>Campo</span>
            <span>{both ? "Antes → Después" : before != null ? "Valor borrado" : "Valor"}</span>
          </div>
          <ul className="divide-y divide-border">
            {fields.slice(0, 40).map((f) => (
              <li
                key={f.key}
                className="grid grid-cols-[minmax(7rem,12rem)_1fr] gap-x-4 px-3 py-2"
              >
                <span className="truncate font-mono text-xs text-muted-foreground" title={f.key}>
                  {f.key}
                </span>
                <span className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1">
                  {both ? (
                    <>
                      <span className="text-muted-foreground line-through decoration-muted-foreground/50">
                        <Value v={f.before} />
                      </span>
                      <span aria-hidden className="text-muted-foreground">
                        →
                      </span>
                      <Value v={f.after} />
                    </>
                  ) : (
                    <Value v={f.after ?? f.before} />
                  )}
                </span>
              </li>
            ))}
          </ul>
          {fields.length > 40 && (
            <p className="border-t border-border px-3 py-2 text-xs text-muted-foreground">
              Y {fields.length - 40} campos más en el JSON completo.
            </p>
          )}
        </div>
      )}
      {(before != null || after != null) && (
        <Disclosure title="Ver JSON completo">
          <div className="flex flex-col gap-3 md:flex-row">
            <JsonBlock label="Antes" value={before} />
            <JsonBlock label="Después" value={after} />
          </div>
        </Disclosure>
      )}
    </div>
  );
}

export default function InternalAuditPage() {
  const [tenantId, setTenantId] = useState("");
  const [entityType, setEntityType] = useState("");
  const [action, setAction] = useState("");
  const [range, setRange] = useState<DateRange | undefined>(undefined);
  const [openId, setOpenId] = useState<string | null>(null);

  const { data: tenants } = useInternalTenants();
  const { data: entityTypes } = useAuditEntityTypes();
  const { data: entries, isLoading, isError, refetch } = useInternalAudit({
    tenantId: tenantId || null,
    entityType: entityType || null,
    action: action || null,
    from: range?.from ? format(range.from, "yyyy-MM-dd") : null,
    to: range?.to
      ? format(range.to, "yyyy-MM-dd")
      : range?.from
        ? format(range.from, "yyyy-MM-dd")
        : null,
  });

  const tenantName = (id: string | null) =>
    id ? tenants?.find((t) => t.id === id)?.name ?? id.slice(0, 8) : "Sistema";

  const filtered = Boolean(tenantId || entityType || action || range?.from);

  return (
    <>
      <PageHeader
        eyebrow="Operaciones"
        title="Auditoría"
        icon={ScrollText}
        description={
          <>
            Bitácora administrativa y operativa de todos los negocios. Es de solo
            lectura y no se puede editar. Muestra los últimos 200 registros según
            los filtros.
          </>
        }
      />

      <div className="mt-6 grid gap-2 sm:grid-cols-2 lg:grid-cols-[1fr_1fr_1fr_auto]">
        <select
          aria-label="Negocio"
          value={tenantId}
          onChange={(e) => setTenantId(e.target.value)}
          className={selectCls}
        >
          <option value="" className="bg-popover text-popover-foreground">
            Todos los negocios
          </option>
          {(tenants ?? []).map((t) => (
            <option key={t.id} value={t.id} className="bg-popover text-popover-foreground">
              {t.name}
            </option>
          ))}
        </select>
        <select
          aria-label="Entidad"
          value={entityType}
          onChange={(e) => setEntityType(e.target.value)}
          className={selectCls}
        >
          <option value="" className="bg-popover text-popover-foreground">
            Todas las entidades
          </option>
          {(entityTypes ?? []).map((et) => (
            <option key={et} value={et} className="bg-popover text-popover-foreground">
              {et}
            </option>
          ))}
        </select>
        <SearchField
          value={action}
          onValueChange={setAction}
          placeholder="Buscar acción"
          aria-label="Buscar acción"
        />
        <div className="flex gap-2">
          <DateRangePicker value={range} onChange={setRange} className="h-11 flex-1" />
          {range?.from && (
            <button
              type="button"
              onClick={() => setRange(undefined)}
              className="inline-flex h-11 shrink-0 items-center gap-1.5 rounded-lg border border-border px-3 text-sm text-muted-foreground transition hover:bg-muted hover:text-foreground"
              aria-label="Quitar filtro de fechas"
            >
              <X size={14} /> Fechas
            </button>
          )}
        </div>
      </div>

      {entries && entries.length > 0 && (
        <p className="mt-3 text-xs text-muted-foreground">
          {entries.length === 200 ? "Últimos 200 registros" : `${entries.length} registros`}
        </p>
      )}

      <TableWrap className="mt-3">
        <table className="w-full min-w-[600px] text-sm">
          <thead className="bg-muted/60 text-left text-xs uppercase tracking-wide text-muted-foreground">
            <tr>
              <th className="w-8 px-2 py-3">
                <span className="sr-only">Detalle</span>
              </th>
              <th className="px-4 py-3">Fecha</th>
              <th className="px-4 py-3">Negocio</th>
              <th className="hidden px-4 py-3 md:table-cell">Actor</th>
              <th className="px-4 py-3">Acción</th>
              <th className="hidden px-4 py-3 lg:table-cell">Entidad</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-border text-foreground">
            {isLoading && <TableStateRow colSpan={6} loading />}
            {isError && (
              <TableStateRow colSpan={6}>
                <EmptyState
                  compact
                  icon={AlertTriangle}
                  title="No pudimos cargar la auditoría"
                  action={
                    <Button size="sm" variant="secondary" onClick={() => refetch()}>
                      Reintentar
                    </Button>
                  }
                />
              </TableStateRow>
            )}
            {!isLoading && !isError && entries?.length === 0 && (
              <TableStateRow colSpan={6}>
                <EmptyState
                  compact
                  icon={ScrollText}
                  title={filtered ? "Sin registros para estos filtros" : "Todavía no hay registros"}
                  description={
                    filtered ? "Probá con otro negocio, entidad o rango de fechas." : undefined
                  }
                />
              </TableStateRow>
            )}
            {entries?.map((e) => {
              const open = openId === e.id;
              const hasDetail =
                e.before_data != null || e.after_data != null || Boolean(e.reason);
              return (
                <Fragment key={e.id}>
                  <tr
                    className={cn(
                      "transition hover:bg-muted/40",
                      hasDetail && "cursor-pointer",
                      open && "bg-muted/40",
                    )}
                    onClick={() => hasDetail && setOpenId(open ? null : e.id)}
                  >
                    <td className="px-2 py-3 text-muted-foreground">
                      {hasDetail && (
                        <button
                          type="button"
                          aria-expanded={open}
                          aria-label={open ? "Ocultar detalle" : "Ver detalle"}
                          onClick={(ev) => {
                            ev.stopPropagation();
                            setOpenId(open ? null : e.id);
                          }}
                          className="grid h-7 w-7 place-items-center rounded-md transition hover:bg-muted hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                        >
                          <ChevronDown
                            size={15}
                            className={cn("transition-transform", !open && "-rotate-90")}
                          />
                        </button>
                      )}
                    </td>
                    <td className="whitespace-nowrap px-4 py-3 tabular-nums text-muted-foreground">
                      {new Date(e.created_at).toLocaleString("es-AR", {
                        dateStyle: "short",
                        timeStyle: "short",
                      })}
                    </td>
                    <td className="max-w-[12rem] truncate px-4 py-3">{tenantName(e.tenant_id)}</td>
                    <td className="hidden px-4 py-3 md:table-cell">
                      <div className="max-w-[14rem] truncate">
                        {e.actorName ?? e.actorEmail ?? <NoData />}
                      </div>
                      {e.actorName && e.actorEmail && (
                        <div className="max-w-[14rem] truncate text-xs text-muted-foreground">
                          {e.actorEmail}
                        </div>
                      )}
                    </td>
                    <td className="px-4 py-3">
                      <Badge tone="neutral" className="font-mono font-medium">
                        {e.action}
                      </Badge>
                      <div className="mt-1 text-xs text-muted-foreground lg:hidden">
                        {e.entity_type}
                      </div>
                    </td>
                    <td className="hidden px-4 py-3 text-muted-foreground lg:table-cell">
                      {e.entity_type}
                      {e.entity_id && (
                        <span className="ml-1 font-mono text-xs">{e.entity_id.slice(0, 8)}</span>
                      )}
                    </td>
                  </tr>
                  {open && (
                    <tr className="bg-muted/20">
                      <td colSpan={6} className="px-4 py-4">
                        <EntryDetail
                          before={e.before_data}
                          after={e.after_data}
                          reason={e.reason}
                        />
                      </td>
                    </tr>
                  )}
                </Fragment>
              );
            })}
          </tbody>
        </table>
      </TableWrap>
    </>
  );
}
