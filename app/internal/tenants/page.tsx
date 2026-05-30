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

      <div className="mt-6 overflow-hidden rounded-ninjaLg border border-white/10 bg-white/[0.04]">
        <table className="w-full text-sm">
          <thead className="bg-white/[0.06] text-left text-xs uppercase tracking-[0.14em] text-white/45">
            <tr>
              <th className="px-4 py-3">Negocio</th>
              <th className="px-4 py-3">Plan</th>
              <th className="px-4 py-3">Estado</th>
              <th className="px-4 py-3">Alta</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-white/10 text-white/80">
            {isLoading && (
              <tr>
                <td colSpan={4} className="px-4 py-10 text-center text-white/50">
                  Cargando…
                </td>
              </tr>
            )}
            {!isLoading && tenants?.length === 0 && (
              <tr>
                <td colSpan={4} className="px-4 py-10 text-center text-white/50">
                  No hay tenants.
                </td>
              </tr>
            )}
            {tenants?.map((t) => (
              <tr key={t.id} className="transition hover:bg-white/[0.03]">
                <td className="px-4 py-3">
                  <Link
                    href={`/internal/tenants/${t.id}`}
                    className="font-medium text-white hover:text-ninja-flameSoft"
                  >
                    {t.name}
                  </Link>
                  <div className="text-xs text-white/40">{t.slug}</div>
                </td>
                <td className="px-4 py-3 text-white/60">{t.planName ?? "—"}</td>
                <td className="px-4 py-3">
                  <span className="inline-flex rounded-ninjaFull border border-white/10 bg-white/[0.06] px-2.5 py-0.5 text-xs font-semibold">
                    {STATUS_LABELS[t.status] ?? t.status}
                  </span>
                </td>
                <td className="px-4 py-3 text-white/60">
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
