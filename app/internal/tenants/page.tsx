"use client";

import { useMemo, useState } from "react";
import Link from "next/link";
import { Search, X, Building2, Plus, ChevronRight } from "lucide-react";
import {
  DateRangePicker,
  type DateRange,
} from "@/components/ui/DateRangePicker";
import {
  useFeatureFlagsCatalog,
  useFlagOverrides,
  useInternalTenants,
  useMyStaffLevel,
  useTenantHealth,
} from "@/modules/internal/hooks";
import type { InternalTenant } from "@/modules/internal/api";
import { useBillingProfilesOverview } from "@/modules/fiscalProfile/hooks";
import { Button } from "@/components/ui/Button";
import { CreateTenantModal } from "@/components/internal/CreateTenantModal";
import { formatRelative } from "@/lib/utils/format";
import { NoData } from "@/components/ui/NoData";
import { PageHeader } from "@/components/ui/PageHeader";
import { TableStateRow, TableWrap } from "@/components/ui/Table";
import { EmptyState } from "@/components/ui/EmptyState";
import { SearchField } from "@/components/ui/SearchField";
import { Select } from "@/components/ui/Select";
import { Badge, type BadgeTone } from "@/components/ui/Badge";
import { Skeleton } from "@/components/ui/Skeleton";

const STATUS_LABELS: Record<string, string> = {
  trial: "Trial",
  active: "Activo",
  past_due: "Pago pendiente",
  suspended: "Suspendido",
  cancelled: "Cancelado",
};
const STATUS_TONE: Record<string, BadgeTone> = {
  trial: "info",
  active: "success",
  past_due: "warning",
  suspended: "danger",
  cancelled: "neutral",
};
// Filtro de datos fiscales para la factura de NinjaSoft (F20-3).
const FISCAL_OPTIONS = [
  { value: "", label: "Datos fiscales: todos" },
  { value: "unverified", label: "Sin datos fiscales verificados" },
  { value: "verified", label: "Datos fiscales verificados" },
];

// Filtro extra: negocios dados de baja (baja lógica, ADR-073). Por defecto se
// ocultan del listado.
const DELETED_FILTER = "deleted";

function statusOf(t: InternalTenant): { label: string; tone: BadgeTone } {
  if (t.deletedAt) return { label: "Dado de baja", tone: "neutral" };
  const s = t.subStatus ?? t.status;
  return { label: STATUS_LABELS[s] ?? s, tone: STATUS_TONE[s] ?? "neutral" };
}

function TenantAvatar({ t }: { t: InternalTenant }) {
  return (
    <div className="grid h-9 w-9 shrink-0 place-items-center overflow-hidden rounded-md border border-border bg-muted text-xs font-bold text-muted-foreground">
      {t.logoUrl ? (
        // eslint-disable-next-line @next/next/no-img-element
        <img src={t.logoUrl} alt="" className="h-full w-full object-contain" />
      ) : (
        (t.name[0] ?? "?").toUpperCase()
      )}
    </div>
  );
}

export default function InternalTenantsPage() {
  const { data: tenants, isLoading } = useInternalTenants();
  const { data: health } = useTenantHealth();
  const [search, setSearch] = useState("");
  const [status, setStatus] = useState("");
  const [plan, setPlan] = useState("");
  const [flag, setFlag] = useState("");
  const [fiscal, setFiscal] = useState("");
  // Se pide recién al usar el filtro (calcula el perfil de cada negocio).
  const { data: fiscalMap } = useBillingProfilesOverview(Boolean(fiscal));
  const [range, setRange] = useState<DateRange | undefined>(undefined);
  const { data: flagsCatalog } = useFeatureFlagsCatalog();
  const { data: flagOverrides } = useFlagOverrides(flag || null);
  const { loaded: levelLoaded, level } = useMyStaffLevel();
  const [createOpen, setCreateOpen] = useState(false);

  const plans = useMemo(() => {
    const map = new Map<string, string>();
    for (const t of tenants ?? []) {
      if (t.planKey && t.planName) map.set(t.planKey, t.planName);
    }
    return Array.from(map.entries()).sort((a, b) => a[1].localeCompare(b[1]));
  }, [tenants]);

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase();
    // CUIT/teléfono se comparan solo por dígitos (ignora guiones y espacios).
    const qDigits = q.replace(/\D/g, "");
    return (tenants ?? []).filter((t) => {
      if (status === DELETED_FILTER) {
        if (!t.deletedAt) return false;
      } else {
        if (t.deletedAt) return false;
        if (status && (t.subStatus ?? t.status) !== status) return false;
      }
      if (plan && t.planKey !== plan) return false;
      if (fiscal) {
        if (!fiscalMap) return false; // cargando
        const verified = fiscalMap.get(t.id)?.verified === true;
        if (fiscal === "unverified" ? verified : !verified) return false;
      }
      if (flag) {
        // Flag efectivo del tenant: override si existe, si no el default.
        if (!flagOverrides) return false; // cargando overrides
        const enabled =
          flagOverrides.overrides.get(t.id) ?? flagOverrides.defaultEnabled;
        if (!enabled) return false;
      }
      if (range?.from) {
        const created = new Date(t.created_at);
        if (created < range.from) return false;
        if (range.to) {
          const end = new Date(range.to);
          end.setHours(23, 59, 59, 999);
          if (created > end) return false;
        }
      }
      if (!q) return true;
      const textMatch = [t.name, t.slug, t.ownerName, t.ownerEmail]
        .filter(Boolean)
        .some((v) => (v as string).toLowerCase().includes(q));
      const digitsMatch =
        qDigits.length >= 4 &&
        [t.cuit, t.phone]
          .filter(Boolean)
          .some((v) => (v as string).replace(/\D/g, "").includes(qDigits));
      return textMatch || digitsMatch;
    });
  }, [tenants, search, status, plan, flag, flagOverrides, range, fiscal, fiscalMap]);

  const lastActivity = (id: string) => {
    const h = health?.get(id);
    const ts = [h?.last_login_at, h?.last_sale_at]
      .filter(Boolean)
      .map((d) => new Date(d as string).getTime());
    return ts.length > 0 ? formatRelative(new Date(Math.max(...ts))) : null;
  };

  const statusOptions = [
    { value: "", label: "Todos los estados" },
    ...Object.entries(STATUS_LABELS).map(([value, label]) => ({ value, label })),
    { value: DELETED_FILTER, label: "Dados de baja" },
  ];
  const planOptions = [
    { value: "", label: "Todos los planes" },
    ...plans.map(([value, label]) => ({ value, label })),
  ];
  const flagOptions = [
    { value: "", label: "Todos los flags" },
    ...(flagsCatalog ?? []).map((f) => ({ value: f.key, label: f.key })),
  ];
  const hasFilters = Boolean(range?.from || flag || status || plan || fiscal);

  const empty =
    tenants?.length === 0 ? (
      <EmptyState compact icon={Building2} title="Todavía no hay negocios" />
    ) : (
      <EmptyState
        compact
        icon={Search}
        title="Sin resultados"
        description="Probá con otra búsqueda o limpiá los filtros."
      />
    );

  return (
    <>
      <PageHeader
        eyebrow="Operaciones"
        title="Negocios"
        icon={Building2}
        description={
          <>
            Todos los clientes del SaaS. Entrá a uno para gestionar su plan y
            suscripción.
          </>
        }
        actions={
          levelLoaded && level !== "support" ? (
            <Button size="sm" onClick={() => setCreateOpen(true)}>
              <Plus size={15} /> Nuevo negocio
            </Button>
          ) : null
        }
      />
      <CreateTenantModal open={createOpen} onOpenChange={setCreateOpen} />

      <div className="mt-6 grid gap-2 sm:grid-cols-2 lg:grid-cols-[minmax(0,1.6fr)_repeat(4,minmax(0,1fr))_auto]">
        <SearchField
          value={search}
          onValueChange={setSearch}
          placeholder="Nombre, slug, dueño, email, CUIT o teléfono"
          aria-label="Buscar negocios"
          className="sm:col-span-2 lg:col-span-1"
        />
        <Select aria-label="Estado" value={status} options={statusOptions} onChange={setStatus} />
        <Select aria-label="Plan" value={plan} options={planOptions} onChange={setPlan} />
        <Select
          aria-label="Feature flag activo"
          value={flag}
          options={flagOptions}
          onChange={setFlag}
        />
        <Select aria-label="Datos fiscales" value={fiscal} options={FISCAL_OPTIONS} onChange={setFiscal} />
        <DateRangePicker value={range} onChange={setRange} className="h-11" />
      </div>
      <div className="mt-3 flex min-h-[28px] flex-wrap items-center gap-3 text-xs text-muted-foreground">
        {isLoading ? (
          <Skeleton className="h-3.5 w-24" />
        ) : (
          <span className="tabular-nums">
            {filtered.length} de {tenants?.length ?? 0} negocios
          </span>
        )}
        {hasFilters && (
          <button
            type="button"
            onClick={() => {
              setRange(undefined);
              setFlag("");
              setStatus("");
              setPlan("");
              setFiscal("");
            }}
            className="inline-flex items-center gap-1 rounded-md px-2 py-1 font-medium text-foreground transition hover:bg-muted"
          >
            <X size={13} /> Limpiar filtros
          </button>
        )}
      </div>

      {/* Mobile: lista compacta. */}
      <ul
        className="mt-3 divide-y divide-border overflow-hidden rounded-lg border border-border bg-card md:hidden"
        aria-busy={isLoading || undefined}
      >
        {isLoading &&
          Array.from({ length: 4 }, (_, i) => (
            <li key={i} className="flex items-center gap-3 px-4 py-3" aria-hidden>
              <Skeleton className="h-9 w-9" />
              <div className="flex-1 space-y-1.5">
                <Skeleton className="h-3.5 w-1/2" />
                <Skeleton className="h-3 w-1/3" />
              </div>
            </li>
          ))}
        {!isLoading && filtered.length === 0 && <li>{empty}</li>}
        {filtered.map((t) => {
          const st = statusOf(t);
          return (
            <li key={t.id}>
              <Link
                href={`/internal/tenants/${t.id}`}
                className="flex min-h-[56px] items-center gap-3 px-4 py-3 transition hover:bg-muted/40"
              >
                <TenantAvatar t={t} />
                <div className="min-w-0 flex-1">
                  <p className="truncate font-medium text-foreground">{t.name}</p>
                  <p className="truncate text-xs text-muted-foreground">
                    {t.planName ?? "Sin plan"} · {lastActivity(t.id) ?? "sin actividad"}
                  </p>
                </div>
                <Badge tone={st.tone}>{st.label}</Badge>
                <ChevronRight size={16} className="shrink-0 text-muted-foreground" aria-hidden />
              </Link>
            </li>
          );
        })}
      </ul>

      {/* Desde md: tabla. */}
      <TableWrap className="mt-3 hidden rounded-lg md:block">
        <table className="w-full min-w-[760px] text-sm" aria-busy={isLoading || undefined}>
          <thead className="bg-muted text-left text-xs uppercase tracking-[0.14em] text-muted-foreground">
            <tr>
              <th className="px-4 py-2.5 font-semibold">Negocio</th>
              <th className="px-4 py-2.5 font-semibold">Dueño</th>
              <th className="px-4 py-2.5 font-semibold">Plan</th>
              <th className="px-4 py-2.5 font-semibold">Estado</th>
              <th className="px-4 py-2.5 font-semibold">Últ. actividad</th>
              <th className="px-4 py-2.5 text-right font-semibold">Alta</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-border text-foreground">
            {isLoading &&
              Array.from({ length: 5 }, (_, i) => (
                <tr key={i} aria-hidden>
                  <td className="px-4 py-3">
                    <div className="flex items-center gap-3">
                      <Skeleton className="h-9 w-9" />
                      <div className="space-y-1.5">
                        <Skeleton className="h-3.5 w-28" />
                        <Skeleton className="h-3 w-20" />
                      </div>
                    </div>
                  </td>
                  <td className="px-4 py-3"><Skeleton className="h-3.5 w-36" /></td>
                  <td className="px-4 py-3"><Skeleton className="h-3.5 w-20" /></td>
                  <td className="px-4 py-3"><Skeleton className="h-5 w-16 rounded-full" /></td>
                  <td className="px-4 py-3"><Skeleton className="h-3.5 w-24" /></td>
                  <td className="px-4 py-3"><Skeleton className="ml-auto h-3.5 w-16" /></td>
                </tr>
              ))}
            {!isLoading && filtered.length === 0 && (
              <TableStateRow colSpan={6}>{empty}</TableStateRow>
            )}
            {filtered.map((t) => {
              const st = statusOf(t);
              const act = lastActivity(t.id);
              return (
                <tr key={t.id} className="transition hover:bg-muted/40">
                  <td className="px-4 py-2.5">
                    <div className="flex items-center gap-3">
                      <TenantAvatar t={t} />
                      <div className="min-w-0">
                        <Link
                          href={`/internal/tenants/${t.id}`}
                          className="font-medium text-foreground hover:text-ninja-flameSoft"
                        >
                          {t.name}
                        </Link>
                        <div className="text-xs text-muted-foreground">{t.slug}</div>
                      </div>
                    </div>
                  </td>
                  <td className="max-w-[240px] px-4 py-2.5">
                    <div className="truncate">{t.ownerName ?? <NoData />}</div>
                    <div className="truncate text-xs text-muted-foreground">
                      {t.ownerEmail ?? <NoData />}
                    </div>
                  </td>
                  <td className="px-4 py-2.5">
                    {t.planName ? (
                      <span className="font-medium">{t.planName}</span>
                    ) : (
                      <span className="text-xs text-muted-foreground">Sin plan</span>
                    )}
                  </td>
                  <td className="px-4 py-2.5">
                    <Badge tone={st.tone}>{st.label}</Badge>
                  </td>
                  <td className="whitespace-nowrap px-4 py-2.5 text-muted-foreground">
                    {act ?? <NoData />}
                  </td>
                  <td className="whitespace-nowrap px-4 py-2.5 text-right tabular-nums text-muted-foreground">
                    {new Date(t.created_at).toLocaleDateString("es-AR")}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </TableWrap>
    </>
  );
}
