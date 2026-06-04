"use client";

import { Fragment, useState } from "react";
import { ChevronDown, ChevronRight, Search } from "lucide-react";
import { Eyebrow, Display } from "@/components/ui/Typography";
import {
  useAuditEntityTypes,
  useInternalAudit,
  useInternalTenants,
} from "@/modules/internal/hooks";

function JsonBlock({ label, value }: { label: string; value: unknown }) {
  if (value == null) return null;
  return (
    <div className="min-w-0 flex-1">
      <div className="mb-1 text-[11px] font-semibold uppercase tracking-[0.14em] text-muted-foreground">
        {label}
      </div>
      <pre className="max-h-64 overflow-auto rounded-lg border border-border bg-background p-3 text-xs text-foreground">
        {JSON.stringify(value, null, 2)}
      </pre>
    </div>
  );
}

export default function InternalAuditPage() {
  const [tenantId, setTenantId] = useState("");
  const [entityType, setEntityType] = useState("");
  const [action, setAction] = useState("");
  const [from, setFrom] = useState("");
  const [to, setTo] = useState("");
  const [openId, setOpenId] = useState<string | null>(null);

  const { data: tenants } = useInternalTenants();
  const { data: entityTypes } = useAuditEntityTypes();
  const { data: entries, isLoading, isError, refetch } = useInternalAudit({
    tenantId: tenantId || null,
    entityType: entityType || null,
    action: action || null,
    from: from || null,
    to: to || null,
  });

  const tenantName = (id: string | null) =>
    id ? tenants?.find((t) => t.id === id)?.name ?? id.slice(0, 8) : "Sistema";

  const selectCls =
    "h-10 rounded-lg border border-input bg-background px-3 text-sm text-foreground outline-none focus:border-ninja-flameSoft";

  return (
    <>
      <Eyebrow>Operaciones</Eyebrow>
      <Display className="mt-3 text-3xl md:text-4xl">Auditoría</Display>
      <p className="mt-2 text-muted-foreground">
        Bitácora administrativa y operativa de todos los tenants. Solo lectura
        (append-only). Últimos 200 registros según filtros.
      </p>

      <div className="mt-6 flex flex-wrap items-center gap-2">
        <select
          value={tenantId}
          onChange={(e) => setTenantId(e.target.value)}
          className={selectCls}
        >
          <option value="">Todos los negocios</option>
          {(tenants ?? []).map((t) => (
            <option key={t.id} value={t.id} className="bg-ninja-deepViolet">
              {t.name}
            </option>
          ))}
        </select>
        <select
          value={entityType}
          onChange={(e) => setEntityType(e.target.value)}
          className={selectCls}
        >
          <option value="">Todas las entidades</option>
          {(entityTypes ?? []).map((et) => (
            <option key={et} value={et} className="bg-ninja-deepViolet">
              {et}
            </option>
          ))}
        </select>
        <div className="relative">
          <Search
            size={14}
            className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-muted-foreground"
          />
          <input
            value={action}
            onChange={(e) => setAction(e.target.value)}
            placeholder="Acción…"
            className="h-10 w-40 rounded-lg border border-input bg-background pl-8 pr-3 text-sm text-foreground outline-none focus:border-ninja-flameSoft"
          />
        </div>
        <input
          type="date"
          value={from}
          onChange={(e) => setFrom(e.target.value)}
          className={selectCls}
          aria-label="Desde"
        />
        <span className="text-xs text-muted-foreground">a</span>
        <input
          type="date"
          value={to}
          onChange={(e) => setTo(e.target.value)}
          className={selectCls}
          aria-label="Hasta"
        />
      </div>

      <div className="mt-6 overflow-x-auto rounded-lg border border-border bg-card">
        <table className="w-full min-w-[840px] text-sm">
          <thead className="bg-muted text-left text-xs uppercase tracking-[0.14em] text-muted-foreground">
            <tr>
              <th className="w-8 px-2 py-3" />
              <th className="px-4 py-3">Fecha</th>
              <th className="px-4 py-3">Negocio</th>
              <th className="px-4 py-3">Actor</th>
              <th className="px-4 py-3">Acción</th>
              <th className="px-4 py-3">Entidad</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-border text-foreground">
            {isLoading && (
              <tr>
                <td colSpan={6} className="px-4 py-10 text-center text-muted-foreground">
                  Cargando…
                </td>
              </tr>
            )}
            {isError && (
              <tr>
                <td colSpan={6} className="px-4 py-10 text-center text-red-300">
                  Error al cargar.{" "}
                  <button onClick={() => refetch()} className="underline">
                    Reintentar
                  </button>
                </td>
              </tr>
            )}
            {!isLoading && !isError && entries?.length === 0 && (
              <tr>
                <td colSpan={6} className="px-4 py-10 text-center text-muted-foreground">
                  Sin registros para los filtros elegidos.
                </td>
              </tr>
            )}
            {entries?.map((e) => {
              const open = openId === e.id;
              const hasDetail =
                e.before_data != null || e.after_data != null || e.reason;
              return (
                <Fragment key={e.id}>
                  <tr
                    className={
                      "transition hover:bg-muted/40" +
                      (hasDetail ? " cursor-pointer" : "")
                    }
                    onClick={() => hasDetail && setOpenId(open ? null : e.id)}
                  >
                    <td className="px-2 py-3 text-muted-foreground">
                      {hasDetail &&
                        (open ? <ChevronDown size={14} /> : <ChevronRight size={14} />)}
                    </td>
                    <td className="whitespace-nowrap px-4 py-3 text-muted-foreground">
                      {new Date(e.created_at).toLocaleString("es-AR", {
                        dateStyle: "short",
                        timeStyle: "short",
                      })}
                    </td>
                    <td className="px-4 py-3">{tenantName(e.tenant_id)}</td>
                    <td className="px-4 py-3">
                      <div>{e.actorName ?? e.actorEmail ?? "—"}</div>
                      {e.actorName && e.actorEmail && (
                        <div className="text-xs text-muted-foreground">{e.actorEmail}</div>
                      )}
                    </td>
                    <td className="px-4 py-3">
                      <span className="inline-flex rounded-full border border-border bg-muted px-2.5 py-0.5 font-mono text-xs">
                        {e.action}
                      </span>
                    </td>
                    <td className="px-4 py-3 text-muted-foreground">
                      {e.entity_type}
                      {e.entity_id && (
                        <span className="ml-1 font-mono text-xs">
                          {e.entity_id.slice(0, 8)}
                        </span>
                      )}
                    </td>
                  </tr>
                  {open && (
                    <tr className="bg-muted/20">
                      <td colSpan={6} className="px-4 py-4">
                        {e.reason && (
                          <p className="mb-3 text-sm">
                            <span className="font-semibold">Motivo:</span> {e.reason}
                          </p>
                        )}
                        <div className="flex flex-col gap-3 md:flex-row">
                          <JsonBlock label="Antes" value={e.before_data} />
                          <JsonBlock label="Después" value={e.after_data} />
                        </div>
                      </td>
                    </tr>
                  )}
                </Fragment>
              );
            })}
          </tbody>
        </table>
      </div>
    </>
  );
}
