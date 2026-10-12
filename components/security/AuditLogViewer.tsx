"use client";

import { useMemo, useState } from "react";
import { Download, FileSearch, Lock } from "lucide-react";
import { Badge } from "@/components/ui/Badge";
import { Button } from "@/components/ui/Button";
import { EmptyState } from "@/components/ui/EmptyState";
import { Modal } from "@/components/ui/Modal";
import { SearchField } from "@/components/ui/SearchField";
import { TableStateRow, TableWrap } from "@/components/ui/Table";
import { useToast } from "@/components/ui/Toast";
import { BranchDot } from "@/components/branches/BranchSwitcher";
import { useFeatureGate } from "@/components/saas/GatedAction";
import { EYEBROW, FLAT_PANEL } from "@/components/security/styles";
import { useBranches } from "@/modules/branches/hooks";
import { useStaffPeople } from "@/modules/staff/hooks";
import { securityApi, type AuditRow } from "@/modules/security/api";
import { useAuditFacets, useAuditSearch } from "@/modules/security/hooks";
import { auditActionLabel, auditDiff, auditEntityLabel, auditTone, auditValue } from "@/lib/security/auditLabels";
import { exportXlsx } from "@/lib/utils/xlsx";
import { capitalizeName } from "@/lib/utils/format";
import { cn } from "@/lib/utils/cn";

const PAGE = 50;
const SELECT = "h-11 w-full rounded-lg border border-border bg-background px-3 text-sm";

function isoStart(d: string) {
  return d ? new Date(`${d}T00:00:00-03:00`).toISOString() : null;
}
function isoEnd(d: string) {
  if (!d) return null;
  const x = new Date(`${d}T00:00:00-03:00`);
  x.setDate(x.getDate() + 1);
  return x.toISOString();
}

// Visor de auditoría del negocio (F17 · H117): filtros por usuario, sucursal,
// acción, entidad y fechas, detalle con diff y export XLSX. Feature OPTIONAL
// `auditoria` (el registro es siempre BASE; esto es el visor).
export function AuditLogViewer() {
  const gate = useFeatureGate("auditoria", "Auditoría");
  const { toast } = useToast();
  const { data: branches = [] } = useBranches();
  const { data: people = [] } = useStaffPeople(!gate.locked);
  const { data: facets } = useAuditFacets(!gate.locked);
  const [from, setFrom] = useState("");
  const [to, setTo] = useState("");
  const [actor, setActor] = useState("");
  const [store, setStore] = useState("");
  const [action, setAction] = useState("");
  const [entity, setEntity] = useState("");
  const [q, setQ] = useState("");
  const [page, setPage] = useState(0);
  const [open, setOpen] = useState<AuditRow | null>(null);
  const [exporting, setExporting] = useState(false);

  const filters = useMemo(
    () => ({
      from: isoStart(from),
      to: isoEnd(to),
      actor: actor || null,
      store: store || null,
      action: action || null,
      entity: entity || null,
      q: q.trim() || null,
      limit: PAGE,
      offset: page * PAGE,
    }),
    [from, to, actor, store, action, entity, q, page],
  );
  const { data, isFetching, error } = useAuditSearch(filters, !gate.locked);
  const rows = data?.rows ?? [];
  const total = data?.total ?? 0;
  const storeName = (id: string | null) => branches.find((b) => b.id === id) ?? null;
  const users = people.filter((p) => p.user_id);

  function resetPage<T>(set: (v: T) => void) {
    return (v: T) => {
      set(v);
      setPage(0);
    };
  }

  async function exportAll() {
    setExporting(true);
    try {
      const all = await securityApi.auditSearch({ ...filters, limit: 500, offset: 0 });
      await exportXlsx(`auditoria-${new Date().toISOString().slice(0, 10)}`, [
        {
          name: "Auditoría",
          title: "Registro de auditoría",
          columns: [
            { header: "Fecha", key: "date", type: "date", width: 20 },
            { header: "Usuario", key: "actor", width: 24 },
            { header: "Acción", key: "action", width: 34 },
            { header: "Entidad", key: "entity", width: 20 },
            { header: "Sucursal", key: "store", width: 18 },
            { header: "Motivo", key: "reason", width: 30 },
            { header: "Datos", key: "data", width: 60 },
          ],
          rows: all.rows.map((r) => ({
            date: new Date(r.created_at),
            actor: r.actor_name ?? "Sistema",
            action: auditActionLabel(r.action),
            entity: auditEntityLabel(r.entity_type),
            store: storeName(r.store_id)?.name ?? "",
            reason: r.reason ?? "",
            data: r.after_data ? JSON.stringify(r.after_data) : "",
          })),
        },
      ]);
      if (all.total > 500) toast({ title: "Se exportaron los 500 más recientes", description: "Acotá las fechas para el resto.", variant: "info" });
    } catch {
      toast({ title: "No se pudo exportar", variant: "error" });
    } finally {
      setExporting(false);
    }
  }

  if (gate.locked) {
    return (
      <div className={FLAT_PANEL}>
        <EmptyState
          icon={Lock}
          title="El visor de auditoría está en planes superiores"
          description="El registro se guarda igual en todos los planes; con Auditoría lo podés filtrar, ver el detalle y exportarlo."
          action={
            <Button size="sm" variant="secondary" onClick={() => gate.run(() => undefined)}>
              Ver planes
            </Button>
          }
        />
        {gate.modal}
      </div>
    );
  }

  return (
    <div className="space-y-4">
      <div className={cn(FLAT_PANEL, "grid gap-3 p-4 sm:grid-cols-2 lg:grid-cols-3")}>
        <label className="block">
          <span className="mb-1.5 block text-xs font-medium text-muted-foreground">Desde</span>
          <input type="date" value={from} onChange={(e) => resetPage(setFrom)(e.target.value)} className={SELECT} />
        </label>
        <label className="block">
          <span className="mb-1.5 block text-xs font-medium text-muted-foreground">Hasta</span>
          <input type="date" value={to} onChange={(e) => resetPage(setTo)(e.target.value)} className={SELECT} />
        </label>
        <label className="block">
          <span className="mb-1.5 block text-xs font-medium text-muted-foreground">Usuario</span>
          <select value={actor} onChange={(e) => resetPage(setActor)(e.target.value)} className={SELECT}>
            <option value="">Todos</option>
            {users.map((u) => (
              <option key={u.user_id!} value={u.user_id!}>
                {capitalizeName(u.name)}
              </option>
            ))}
          </select>
        </label>
        {branches.filter((b) => !b.deleted_at).length > 1 && (
          <label className="block">
            <span className="mb-1.5 block text-xs font-medium text-muted-foreground">Sucursal</span>
            <select value={store} onChange={(e) => resetPage(setStore)(e.target.value)} className={SELECT}>
              <option value="">Todas</option>
              {branches.map((b) => (
                <option key={b.id} value={b.id}>
                  {b.name}
                </option>
              ))}
            </select>
          </label>
        )}
        <label className="block">
          <span className="mb-1.5 block text-xs font-medium text-muted-foreground">Acción</span>
          <select value={action} onChange={(e) => resetPage(setAction)(e.target.value)} className={SELECT}>
            <option value="">Todas</option>
            {(facets?.actions ?? []).sort((a, b) => auditActionLabel(a).localeCompare(auditActionLabel(b))).map((a) => (
              <option key={a} value={a}>
                {auditActionLabel(a)}
              </option>
            ))}
          </select>
        </label>
        <label className="block">
          <span className="mb-1.5 block text-xs font-medium text-muted-foreground">Sobre</span>
          <select value={entity} onChange={(e) => resetPage(setEntity)(e.target.value)} className={SELECT}>
            <option value="">Todo</option>
            {(facets?.entities ?? []).map((a) => (
              <option key={a} value={a}>
                {auditEntityLabel(a)}
              </option>
            ))}
          </select>
        </label>
        <div className="flex items-end gap-2 sm:col-span-2 lg:col-span-3">
          <SearchField value={q} onValueChange={resetPage(setQ)} placeholder="Buscar en motivo o datos" loading={isFetching} />
          <Button variant="secondary" onClick={exportAll} loading={exporting} disabled={total === 0}>
            <Download size={16} /> XLSX
          </Button>
        </div>
      </div>

      <TableWrap>
        <table className="w-full min-w-[720px] text-sm">
          <thead className="bg-muted text-left text-xs uppercase tracking-[0.12em] text-muted-foreground">
            <tr>
              <th className="px-4 py-3">Cuándo</th>
              <th className="px-4 py-3">Quién</th>
              <th className="px-4 py-3">Qué</th>
              <th className="px-4 py-3">Sobre</th>
              <th className="px-4 py-3">Sucursal</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-border">
            {error ? (
              <TableStateRow colSpan={5}>
                <span className="text-sm text-muted-foreground">No pudimos cargar la auditoría.</span>
              </TableStateRow>
            ) : !data ? (
              <TableStateRow colSpan={5} loading />
            ) : rows.length === 0 ? (
              <TableStateRow colSpan={5}>
                <EmptyState compact icon={FileSearch} title="Nada con esos filtros" />
              </TableStateRow>
            ) : (
              rows.map((r) => {
                const b = storeName(r.store_id);
                return (
                  <tr key={r.id} className="cursor-pointer hover:bg-muted/50" onClick={() => setOpen(r)}>
                    <td className="whitespace-nowrap px-4 py-2.5 tabular-nums text-muted-foreground">
                      {new Date(r.created_at).toLocaleString("es-AR", { day: "2-digit", month: "2-digit", hour: "2-digit", minute: "2-digit" })}
                    </td>
                    <td className="px-4 py-2.5">{r.actor_name ? capitalizeName(r.actor_name) : "Sistema"}</td>
                    <td className="px-4 py-2.5">
                      <span className="inline-flex items-center gap-2">
                        <span
                          aria-hidden
                          className={cn(
                            "h-1.5 w-1.5 shrink-0 rounded-full",
                            {
                              danger: "bg-danger",
                              warning: "bg-warning",
                              info: "bg-info",
                              neutral: "bg-muted-foreground/50",
                            }[auditTone(r.action)],
                          )}
                        />
                        {auditActionLabel(r.action)}
                      </span>
                      {r.reason && <span className="block truncate text-xs text-muted-foreground">{r.reason}</span>}
                    </td>
                    <td className="px-4 py-2.5 text-muted-foreground">{auditEntityLabel(r.entity_type)}</td>
                    <td className="px-4 py-2.5">
                      {b ? (
                        <span className="inline-flex items-center gap-1.5">
                          <BranchDot branch={b} /> {b.short_name || b.name}
                        </span>
                      ) : (
                        <span className="text-muted-foreground">Negocio</span>
                      )}
                    </td>
                  </tr>
                );
              })
            )}
          </tbody>
        </table>
      </TableWrap>

      {total > PAGE && (
        <div className="flex items-center justify-between text-sm text-muted-foreground">
          <span>
            {page * PAGE + 1} a {Math.min(total, (page + 1) * PAGE)} de {total.toLocaleString("es-AR")}
          </span>
          <div className="flex gap-2">
            <Button size="sm" variant="secondary" disabled={page === 0} onClick={() => setPage((p) => p - 1)}>
              Anteriores
            </Button>
            <Button size="sm" variant="secondary" disabled={(page + 1) * PAGE >= total} onClick={() => setPage((p) => p + 1)}>
              Siguientes
            </Button>
          </div>
        </div>
      )}

      <AuditDetail row={open} onClose={() => setOpen(null)} storeLabel={(id) => storeName(id)?.name ?? null} />
    </div>
  );
}
AuditLogViewer.displayName = "AuditLogViewer";

function AuditDetail({
  row,
  onClose,
  storeLabel,
}: {
  row: AuditRow | null;
  onClose: () => void;
  storeLabel: (id: string | null) => string | null;
}) {
  const diff = row ? auditDiff(row.before_data, row.after_data) : [];
  const hasBefore = Boolean(row?.before_data);
  return (
    <Modal
      open={Boolean(row)}
      onOpenChange={(o) => !o && onClose()}
      title={row ? auditActionLabel(row.action) : "Detalle"}
      description={
        row
          ? `${new Date(row.created_at).toLocaleString("es-AR")} · ${row.actor_name ? capitalizeName(row.actor_name) : "Sistema"}${
              storeLabel(row.store_id) ? ` · ${storeLabel(row.store_id)}` : ""
            }`
          : undefined
      }
    >
      {row && (
        <div className="space-y-4">
          <div className="flex flex-wrap gap-2">
            <Badge tone="neutral">{auditEntityLabel(row.entity_type)}</Badge>
            {row.entity_id && <Badge tone="neutral">ID {row.entity_id.slice(0, 8)}</Badge>}
          </div>
          {row.reason && (
            <div className="rounded-md bg-muted px-3 py-2 text-sm">
              <span className="text-muted-foreground">Motivo: </span>
              {row.reason}
            </div>
          )}
          {diff.length === 0 ? (
            <p className="text-sm text-muted-foreground">Sin datos adicionales.</p>
          ) : (
            <div>
              <p className={EYEBROW}>{hasBefore ? "Cambios" : "Datos"}</p>
              <dl className="mt-2 divide-y divide-border rounded-md border border-border text-sm">
                {diff.map((d) => (
                  <div key={d.key} className={cn("grid gap-1 px-3 py-2 sm:grid-cols-[160px_1fr]", d.changed && hasBefore && "bg-warning/5")}>
                    <dt className="font-mono text-xs text-muted-foreground">{d.key}</dt>
                    <dd className="min-w-0 break-words">
                      {hasBefore && d.changed ? (
                        <>
                          <span className="text-muted-foreground line-through">{auditValue(d.before)}</span>
                          <span className="mx-1.5 text-muted-foreground">a</span>
                          <span className="font-medium">{auditValue(d.after)}</span>
                        </>
                      ) : (
                        auditValue(d.after ?? d.before)
                      )}
                    </dd>
                  </div>
                ))}
              </dl>
            </div>
          )}
        </div>
      )}
    </Modal>
  );
}
