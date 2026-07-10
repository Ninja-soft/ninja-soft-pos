"use client";

import { useMemo, useState } from "react";
import Link from "next/link";
import { Search, X } from "lucide-react";
import { Eyebrow, Display } from "@/components/ui/Typography";
import {
  DateRangePicker,
  type DateRange,
} from "@/components/ui/DateRangePicker";
import {
  useFeatureFlagsCatalog,
  useFlagOverrides,
  useInternalTenants,
  useTenantHealth,
} from "@/modules/internal/hooks";
import { formatRelative } from "@/lib/utils/format";

const STATUS_LABELS: Record<string, string> = {
  trial: "Trial",
  active: "Activo",
  past_due: "Pago pendiente",
  suspended: "Suspendido",
  cancelled: "Cancelado",
};

export default function InternalTenantsPage() {
  const { data: tenants, isLoading } = useInternalTenants();
  const { data: health } = useTenantHealth();
  const [search, setSearch] = useState("");
  const [status, setStatus] = useState("");
  const [plan, setPlan] = useState("");
  const [flag, setFlag] = useState("");
  const [range, setRange] = useState<DateRange | undefined>(undefined);
  const { data: flagsCatalog } = useFeatureFlagsCatalog();
  const { data: flagOverrides } = useFlagOverrides(flag || null);

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
      if (status && (t.subStatus ?? t.status) !== status) return false;
      if (plan && t.planKey !== plan) return false;
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
  }, [tenants, search, status, plan, flag, flagOverrides, range]);

  const selectCls =
    "h-10 rounded-lg border border-input bg-background px-3 text-sm text-foreground outline-none focus:border-ninja-flameSoft";

  return (
    <>
      <Eyebrow>Operaciones</Eyebrow>
      <Display className="mt-3 text-3xl md:text-4xl">Negocios</Display>
      <p className="mt-2 text-muted-foreground">
        Todos los clientes del SaaS. Entrá a uno para gestionar su plan y
        suscripción.
      </p>

      <div className="mt-6 flex flex-wrap items-center gap-2">
        <div className="relative min-w-0 flex-1 sm:max-w-xs">
          <Search
            size={15}
            className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-muted-foreground"
          />
          <input
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Nombre, slug, dueño, email, CUIT o teléfono…"
            className="h-10 w-full rounded-lg border border-input bg-background pl-9 pr-3 text-sm text-foreground outline-none focus:border-ninja-flameSoft"
          />
        </div>
        <select
          value={status}
          onChange={(e) => setStatus(e.target.value)}
          className={selectCls}
        >
          <option value="">Todos los estados</option>
          {Object.entries(STATUS_LABELS).map(([k, label]) => (
            <option key={k} value={k} className="bg-popover text-popover-foreground">
              {label}
            </option>
          ))}
        </select>
        <select
          value={plan}
          onChange={(e) => setPlan(e.target.value)}
          className={selectCls}
        >
          <option value="">Todos los planes</option>
          {plans.map(([key, name]) => (
            <option key={key} value={key} className="bg-popover text-popover-foreground">
              {name}
            </option>
          ))}
        </select>
        <select
          value={flag}
          onChange={(e) => setFlag(e.target.value)}
          className={selectCls}
          title="Solo negocios con el feature flag activo (override o default)"
        >
          <option value="">Todos los flags</option>
          {(flagsCatalog ?? []).map((f) => (
            <option key={f.key} value={f.key} className="bg-popover text-popover-foreground">
              {f.key}
            </option>
          ))}
        </select>
        <DateRangePicker value={range} onChange={setRange} className="h-10" />
        {(range?.from || flag) && (
          <button
            onClick={() => {
              setRange(undefined);
              setFlag("");
            }}
            className="inline-flex h-10 items-center gap-1 rounded-lg border border-border px-2.5 text-xs text-muted-foreground transition hover:text-foreground"
            title="Limpiar flag y fechas"
          >
            <X size={13} /> Limpiar
          </button>
        )}
        {!isLoading && (
          <span className="text-xs text-muted-foreground">
            {filtered.length} de {tenants?.length ?? 0}
          </span>
        )}
      </div>

      <div className="mt-4 overflow-x-auto rounded-lg border border-border bg-card">
        <table className="w-full min-w-[840px] text-sm">
          <thead className="bg-muted text-left text-xs uppercase tracking-[0.14em] text-muted-foreground">
            <tr>
              <th className="px-4 py-3">Negocio</th>
              <th className="px-4 py-3">Dueño</th>
              <th className="px-4 py-3">Plan</th>
              <th className="px-4 py-3">Estado</th>
              <th className="px-4 py-3">Últ. actividad</th>
              <th className="px-4 py-3">Alta</th>
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
            {!isLoading && filtered.length === 0 && (
              <tr>
                <td colSpan={6} className="px-4 py-10 text-center text-muted-foreground">
                  {tenants?.length === 0
                    ? "No hay tenants."
                    : "Sin resultados para los filtros elegidos."}
                </td>
              </tr>
            )}
            {filtered.map((t) => (
              <tr key={t.id} className="transition hover:bg-muted/40">
                <td className="px-4 py-3">
                  <div className="flex items-center gap-3">
                    <div className="grid h-9 w-9 shrink-0 place-items-center overflow-hidden rounded-lg border border-border bg-muted text-xs font-bold text-muted-foreground">
                      {t.logoUrl ? (
                        // eslint-disable-next-line @next/next/no-img-element
                        <img src={t.logoUrl} alt="" className="h-full w-full object-contain" />
                      ) : (
                        (t.name[0] ?? "?").toUpperCase()
                      )}
                    </div>
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
                <td className="px-4 py-3">
                  <div>{t.ownerName ?? "—"}</div>
                  <div className="text-xs text-muted-foreground">{t.ownerEmail ?? "—"}</div>
                </td>
                <td className="px-4 py-3 text-muted-foreground">{t.planName ?? "—"}</td>
                <td className="px-4 py-3">
                  <span className="inline-flex rounded-full border border-border bg-muted px-2.5 py-0.5 text-xs font-semibold">
                    {STATUS_LABELS[t.subStatus ?? t.status] ?? t.subStatus ?? t.status}
                  </span>
                </td>
                <td className="whitespace-nowrap px-4 py-3 text-muted-foreground">
                  {(() => {
                    const h = health?.get(t.id);
                    const ts = [h?.last_login_at, h?.last_sale_at]
                      .filter(Boolean)
                      .map((d) => new Date(d as string).getTime());
                    return ts.length > 0
                      ? formatRelative(new Date(Math.max(...ts)))
                      : "—";
                  })()}
                </td>
                <td className="px-4 py-3 text-muted-foreground">
                  {new Date(t.created_at).toLocaleDateString("es-AR")}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </>
  );
}
