"use client";

import { useMemo, useState } from "react";
import Link from "next/link";
import { Search } from "lucide-react";
import { Eyebrow, Display } from "@/components/ui/Typography";
import { useInternalTenants, useTenantHealth } from "@/modules/internal/hooks";
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

  const plans = useMemo(() => {
    const map = new Map<string, string>();
    for (const t of tenants ?? []) {
      if (t.planKey && t.planName) map.set(t.planKey, t.planName);
    }
    return Array.from(map.entries()).sort((a, b) => a[1].localeCompare(b[1]));
  }, [tenants]);

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase();
    return (tenants ?? []).filter((t) => {
      if (status && (t.subStatus ?? t.status) !== status) return false;
      if (plan && t.planKey !== plan) return false;
      if (!q) return true;
      return [t.name, t.slug, t.ownerName, t.ownerEmail]
        .filter(Boolean)
        .some((v) => (v as string).toLowerCase().includes(q));
    });
  }, [tenants, search, status, plan]);

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
            placeholder="Buscar por nombre, slug o dueño…"
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
            <option key={k} value={k} className="bg-ninja-deepViolet">
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
            <option key={key} value={key} className="bg-ninja-deepViolet">
              {name}
            </option>
          ))}
        </select>
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
