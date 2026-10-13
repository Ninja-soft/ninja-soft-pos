"use client";

import { Card, CardContent } from "@/components/ui/Card";
import { Heading } from "@/components/ui/Typography";
import { useTenant360 } from "@/modules/internal/opsHooks";
import { formatCurrency, formatRelative } from "@/lib/utils/format";
import { describeAuditAction } from "@/lib/internal/auditTimeline";
import { ERROR_SOURCE_LABELS, groupModules } from "@/lib/internal/tenant360";
import {
  HEALTH_LEVEL_DOT,
  HEALTH_LEVEL_LABELS,
  tenantHealthScore,
} from "@/lib/internal/tenantHealth";

function Stat({ label, value, sub }: { label: string; value: string; sub?: string }) {
  return (
    <div className="rounded-md border border-border p-4">
      <div className="text-xs font-medium uppercase tracking-[0.12em] text-muted-foreground">{label}</div>
      <div className="mt-1 text-xl font-semibold text-foreground">{value}</div>
      {sub && <div className="text-sm text-muted-foreground">{sub}</div>}
    </div>
  );
}

// Ficha 360 (ADR-084): estructura, uso, módulos efectivos, salud, últimos
// errores y actividad del negocio, en una sola RPC de agregados.
export function Tenant360Card({
  tenantId,
  status,
  createdAt,
  trialEndsAt,
}: {
  tenantId: string;
  status: string | null;
  createdAt: string | null;
  trialEndsAt: string | null;
}) {
  const { data, isLoading, error } = useTenant360(tenantId);

  if (isLoading) {
    return <p className="mt-3 text-sm text-muted-foreground">Cargando ficha 360…</p>;
  }
  if (error || !data) {
    return (
      <p className="mt-3 text-sm text-muted-foreground">
        No se pudo cargar la ficha 360{error instanceof Error ? ` (${error.message})` : ""}.
      </p>
    );
  }

  const health = tenantHealthScore({
    status,
    createdAt,
    trialEndsAt,
    lastLoginAt: data.members.lastLoginAt,
    lastSaleAt: data.lastSaleAt,
    sales7dCount: data.sales.d7Count,
    activeUsers: data.members.active,
    webhookErrors7d: data.webhookErrors7d,
    fiscalPending: data.fiscalPending,
  });
  const enabledModules = data.modules.filter((m) => m.enabled).length;

  return (
    <div className="mt-3 space-y-4">
      <Card>
        <CardContent
          className={`flex flex-wrap items-center gap-x-6 gap-y-2 border-t-2 p-5 ${
            health.level === "ok" ? "border-success" : health.level === "attention" ? "border-warning" : "border-danger"
          }`}
        >
          <span className="inline-flex items-center gap-2 text-lg font-semibold text-foreground">
            <span aria-hidden className={`h-2.5 w-2.5 rounded-full ${HEALTH_LEVEL_DOT[health.level]}`} />
            {HEALTH_LEVEL_LABELS[health.level]} · {health.score}/100
          </span>
          <span className="text-sm text-muted-foreground">
            {health.reasons.length ? health.reasons.join(" · ") : "Sin señales de riesgo."}
          </span>
          {data.openImpersonations > 0 && (
            <span className="inline-flex items-center gap-1.5 text-sm text-warning">
              <span aria-hidden className="h-2 w-2 rounded-full bg-warning" />
              {data.openImpersonations} acceso como el negocio abierto
            </span>
          )}
        </CardContent>
      </Card>

      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        <Stat
          label="Usuarios"
          value={`${data.members.active} activos`}
          sub={`${data.members.owners} dueño · ${data.members.managers} encargados · ${data.members.cashiers} cajeros${
            data.members.suspended ? ` · ${data.members.suspended} suspendidos` : ""
          }`}
        />
        <Stat label="Sucursales y cajas" value={`${data.stores} / ${data.registers}`} sub={`${data.products} productos activos`} />
        <Stat
          label="Ventas 30 días"
          value={String(data.sales.d30Count)}
          sub={`${formatCurrency(data.sales.d30Total)} · hoy ${data.sales.todayCount}`}
        />
        <Stat
          label="Última actividad"
          value={formatRelative(data.lastSaleAt)}
          sub={`Último ingreso ${formatRelative(data.members.lastLoginAt)}`}
        />
      </div>

      <div className="grid gap-4 lg:grid-cols-2">
        <Card>
          <CardContent className="p-5">
            <Heading as="h3" className="text-base md:text-base">
              Módulos efectivos ({enabledModules} de {data.modules.length})
            </Heading>
            <p className="mt-1 text-xs text-muted-foreground">
              Plan, complementos y overrides combinados, igual que el gating del servidor.
              {data.flagOverrides ? ` ${data.flagOverrides} overrides de flags.` : ""}
            </p>
            <div className="mt-3 max-h-72 space-y-3 overflow-y-auto pr-1">
              {groupModules(data.modules).map((g) => (
                <div key={g.grupo}>
                  <div className="text-xs font-medium uppercase tracking-[0.12em] text-muted-foreground">{g.grupo}</div>
                  <ul className="mt-1 flex flex-wrap gap-1.5">
                    {g.items.map((m) => (
                      <li
                        key={m.key}
                        title={m.key}
                        className={
                          m.enabled
                            ? "rounded-md bg-success/10 px-2 py-0.5 text-xs text-success"
                            : "rounded-md bg-muted px-2 py-0.5 text-xs text-muted-foreground line-through"
                        }
                      >
                        {m.label}
                      </li>
                    ))}
                  </ul>
                </div>
              ))}
            </div>
          </CardContent>
        </Card>

        <Card>
          <CardContent className="p-5">
            <Heading as="h3" className="text-base md:text-base">
              Últimos errores
            </Heading>
            {data.errors.length === 0 ? (
              <p className="mt-2 text-sm text-muted-foreground">Sin errores recientes de cobros, fiscales ni emails.</p>
            ) : (
              <ul className="mt-2 divide-y divide-border">
                {data.errors.slice(0, 8).map((e, i) => (
                  <li key={`${e.source}-${e.at}-${i}`} className="py-2 text-sm">
                    <span className="inline-flex items-center gap-1.5 font-medium text-foreground">
                      <span aria-hidden className="h-2 w-2 rounded-full bg-danger" />
                      {ERROR_SOURCE_LABELS[e.source]} · {e.label}
                    </span>
                    <span className="ml-2 text-xs text-muted-foreground">{formatRelative(e.at)}</span>
                    {e.detail && <p className="mt-0.5 break-words text-xs text-muted-foreground">{e.detail}</p>}
                  </li>
                ))}
              </ul>
            )}

            <Heading as="h3" className="mt-5 text-base md:text-base">
              Actividad reciente
            </Heading>
            {data.activity.length === 0 ? (
              <p className="mt-2 text-sm text-muted-foreground">Sin actividad auditada.</p>
            ) : (
              <ul className="mt-2 space-y-1.5">
                {data.activity.map((a, i) => (
                  <li key={`${a.at}-${i}`} className="text-sm">
                    <span className="text-foreground">{describeAuditAction(a.entityType, a.action).label}</span>
                    <span className="ml-2 text-xs text-muted-foreground">
                      {a.actorEmail ?? "Sistema"} · {formatRelative(a.at)}
                    </span>
                  </li>
                ))}
              </ul>
            )}
          </CardContent>
        </Card>
      </div>
    </div>
  );
}
