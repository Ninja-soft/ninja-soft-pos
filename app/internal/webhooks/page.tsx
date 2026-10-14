import type { SupabaseClient } from "@supabase/supabase-js";
import { Activity, AlertTriangle, CheckCircle2, Webhook } from "lucide-react";
import { createClient } from "@/lib/supabase/server";
import { PageHeader, SectionHeader } from "@/components/ui/PageHeader";
import { Callout } from "@/components/ui/Callout";
import { TableStateRow, TableWrap } from "@/components/ui/Table";
import { Badge, type BadgeTone } from "@/components/ui/Badge";
import { NoData } from "@/components/ui/NoData";
import { EmptyState } from "@/components/ui/EmptyState";
import { cn } from "@/lib/utils/cn";
import {
  WEBHOOK_PROVIDERS,
  buildWebhookHealth,
  type WebhookHealthLevel,
} from "@/lib/internal/webhookHealth";

// Salud de webhooks (ADR-070): últimas 24 h por proveedor, desde
// webhook_events (RLS: staff interno con internal_scope()).
export const dynamic = "force-dynamic";

const LEVEL: Record<WebhookHealthLevel, { label: string; tone: BadgeTone; dot: string; top: string }> = {
  error: { label: "Con errores", tone: "danger", dot: "bg-danger", top: "border-t-danger" },
  warn: { label: "Errores aislados", tone: "warning", dot: "bg-warning", top: "border-t-warning" },
  ok: { label: "Sin errores", tone: "success", dot: "bg-success", top: "border-t-success" },
  idle: { label: "Sin eventos", tone: "neutral", dot: "bg-muted-foreground/50", top: "border-t-border" },
};

const fmt = new Intl.DateTimeFormat("es-AR", {
  timeZone: "America/Argentina/Buenos_Aires",
  day: "2-digit",
  month: "2-digit",
  hour: "2-digit",
  minute: "2-digit",
});
const when = (iso: string | null) => (iso ? fmt.format(new Date(iso)) : null);

const PROVIDER_LABEL = new Map<string, string>(WEBHOOK_PROVIDERS.map((p) => [p.key, p.label]));

type RecentError = {
  id: string;
  provider: string;
  function_name: string;
  http_status: number | null;
  error: string | null;
  payload_ref: string | null;
  created_at: string;
  tenants: { name: string | null } | null;
};

export default async function InternalWebhooksPage() {
  // webhook_events y webhook_health no están en types/database.ts.
  const supabase = createClient({ scope: "internal" }) as unknown as SupabaseClient;
  const since = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();

  const [health, recent] = await Promise.all([
    supabase.rpc("webhook_health", { p_hours: 24 }),
    supabase
      .from("webhook_events")
      .select("id, provider, function_name, http_status, error, payload_ref, created_at, tenants(name)")
      .eq("status", "error")
      .gte("created_at", since)
      .order("created_at", { ascending: false })
      .limit(20),
  ]);

  const rows = buildWebhookHealth(health.data);
  const errors = (recent.data ?? []) as unknown as RecentError[];
  const loadError = health.error ?? recent.error;
  const totals = rows.reduce(
    (acc, r) => ({ total: acc.total + r.total, errors: acc.errors + r.errors }),
    { total: 0, errors: 0 },
  );

  return (
    <>
      <PageHeader
        eyebrow="Operaciones"
        title="Salud de webhooks"
        icon={Webhook}
        description={
          <>
            Avisos de los procesadores de cobro en las últimas 24 horas: cuántos se
            procesaron, cuántos fallaron y el último error. Se guardan 30 días.
          </>
        }
      />

      {loadError ? (
        <Callout tone="danger" icon={AlertTriangle} title="No se pudo leer el registro de webhooks" className="mt-6">
          {loadError.message}
        </Callout>
      ) : null}

      <SectionHeader
        className="mt-8"
        title="Por proveedor"
        icon={Activity}
        description={
          <>
            <span className="tabular-nums">{totals.total}</span> avisos recibidos,{" "}
            <span className={cn("tabular-nums", totals.errors > 0 && "font-semibold text-danger")}>
              {totals.errors}
            </span>{" "}
            con error.
          </>
        }
      />

      <div className="mt-4 grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
        {rows.map((r) => {
          const lv = LEVEL[r.level];
          return (
            <section
              key={r.provider}
              className={cn("rounded-lg rounded-t-none border border-border border-t-2 bg-card p-4", lv.top)}
            >
              <div className="flex items-start justify-between gap-2">
                <div className="min-w-0">
                  <h2 className="truncate text-sm font-semibold text-foreground">{r.label}</h2>
                  <p className="truncate font-mono text-[11px] text-muted-foreground">{r.functionName}</p>
                </div>
                <Badge tone={lv.tone}>
                  <span className={cn("size-1.5 rounded-full", lv.dot)} aria-hidden />
                  {lv.label}
                </Badge>
              </div>

              <dl className="mt-3 grid grid-cols-3 gap-2 text-center">
                <div className="rounded-md bg-muted/50 px-2 py-1.5">
                  <dt className="text-[11px] text-muted-foreground">Procesados</dt>
                  <dd className="text-base font-semibold tabular-nums text-foreground">{r.ok}</dd>
                </div>
                <div className="rounded-md bg-muted/50 px-2 py-1.5">
                  <dt className="text-[11px] text-muted-foreground">Con error</dt>
                  <dd className={cn("text-base font-semibold tabular-nums", r.errors > 0 ? "text-danger" : "text-foreground")}>
                    {r.errors}
                  </dd>
                </div>
                <div className="rounded-md bg-muted/50 px-2 py-1.5">
                  <dt className="text-[11px] text-muted-foreground">Ignorados</dt>
                  <dd className="text-base font-semibold tabular-nums text-foreground">{r.ignored}</dd>
                </div>
              </dl>

              <div className="mt-3 space-y-1 text-xs text-muted-foreground">
                <p>
                  Último aviso: {when(r.lastEventAt) ?? <NoData />}
                  {r.avgDurationMs != null && r.total > 0 ? ` · ${r.avgDurationMs} ms promedio` : null}
                </p>
                {r.lastError ? (
                  <p className="break-words">
                    <span className="font-medium text-foreground">Último error ({when(r.lastErrorAt)}):</span>{" "}
                    {r.lastError}
                  </p>
                ) : null}
              </div>
            </section>
          );
        })}
      </div>

      <SectionHeader
        className="mt-10"
        title="Errores recientes"
        icon={AlertTriangle}
        description="Los últimos 20 avisos que fallaron en las últimas 24 horas."
      />
      <TableWrap className="mt-4">
        <table className="w-full text-left text-sm">
          <thead className="bg-muted/60 text-xs uppercase tracking-wide text-muted-foreground">
            <tr>
              <th className="px-4 py-3 font-semibold">Proveedor</th>
              <th className="hidden px-4 py-3 font-semibold md:table-cell">Negocio</th>
              <th className="px-4 py-3 font-semibold">HTTP</th>
              <th className="hidden px-4 py-3 font-semibold lg:table-cell">Referencia</th>
              <th className="px-4 py-3 font-semibold">Error</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-border">
            {errors.length === 0 && (
              <TableStateRow colSpan={5}>
                <EmptyState compact icon={CheckCircle2} title="Sin errores en las últimas 24 horas" />
              </TableStateRow>
            )}
            {errors.map((e) => (
              <tr key={e.id} className="align-top">
                <td className="px-4 py-3">
                  <div className="whitespace-nowrap font-medium text-foreground">
                    {PROVIDER_LABEL.get(e.provider) ?? e.provider}
                  </div>
                  <div className="text-xs tabular-nums text-muted-foreground">{when(e.created_at)}</div>
                </td>
                <td className="hidden px-4 py-3 md:table-cell">{e.tenants?.name ?? <NoData />}</td>
                <td className="px-4 py-3 tabular-nums">
                  {e.http_status != null ? <Badge tone="danger">{e.http_status}</Badge> : <NoData />}
                </td>
                <td
                  className="hidden max-w-[160px] truncate px-4 py-3 font-mono text-xs lg:table-cell"
                  title={e.payload_ref ?? undefined}
                >
                  {e.payload_ref ?? <NoData />}
                </td>
                <td className="max-w-[22rem] break-words px-4 py-3 text-xs text-muted-foreground">
                  {e.error ?? <NoData />}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </TableWrap>
    </>
  );
}
