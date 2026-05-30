"use client";

import Link from "next/link";
import { Eyebrow, Display } from "@/components/ui/Typography";
import { useInternalTenants } from "@/modules/internal/hooks";

const STATUS_LABELS: Record<string, string> = {
  trial: "Trial",
  active: "Activo",
  past_due: "Pago pendiente",
  suspended: "Suspendido",
  cancelled: "Cancelado",
};

export default function InternalTenantsPage() {
  const { data: tenants, isLoading } = useInternalTenants();

  return (
    <>
      <Eyebrow>Operaciones</Eyebrow>
      <Display className="mt-3 text-3xl md:text-4xl">Tenants</Display>

      <div className="mt-6 overflow-hidden rounded-ninjaLg border border-border bg-card">
        <table className="w-full text-sm">
          <thead className="bg-muted text-left text-xs uppercase tracking-[0.14em] text-muted-foreground">
            <tr>
              <th className="px-4 py-3">Negocio</th>
              <th className="px-4 py-3">Plan</th>
              <th className="px-4 py-3">Estado</th>
              <th className="px-4 py-3">Alta</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-border text-foreground">
            {isLoading && (
              <tr>
                <td colSpan={4} className="px-4 py-10 text-center text-muted-foreground">
                  Cargando…
                </td>
              </tr>
            )}
            {!isLoading && tenants?.length === 0 && (
              <tr>
                <td colSpan={4} className="px-4 py-10 text-center text-muted-foreground">
                  No hay tenants.
                </td>
              </tr>
            )}
            {tenants?.map((t) => (
              <tr key={t.id} className="transition hover:bg-muted/40">
                <td className="px-4 py-3">
                  <Link
                    href={`/internal/tenants/${t.id}`}
                    className="font-medium text-foreground hover:text-ninja-flameSoft"
                  >
                    {t.name}
                  </Link>
                  <div className="text-xs text-muted-foreground">{t.slug}</div>
                </td>
                <td className="px-4 py-3 text-muted-foreground">{t.planName ?? "—"}</td>
                <td className="px-4 py-3">
                  <span className="inline-flex rounded-ninjaFull border border-border bg-muted px-2.5 py-0.5 text-xs font-semibold">
                    {STATUS_LABELS[t.status] ?? t.status}
                  </span>
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
