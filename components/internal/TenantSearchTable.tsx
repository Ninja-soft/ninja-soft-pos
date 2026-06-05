"use client";

import { useState } from "react";
import Link from "next/link";
import { Search } from "lucide-react";

const STATUS_LABELS: Record<string, string> = {
  trial: "Prueba",
  active: "Activa",
  past_due: "Pago pendiente",
  suspended: "Suspendida",
  cancelled: "Cancelada",
};
const STATUS_COLOR: Record<string, string> = {
  trial: "text-yellow-400",
  active: "text-emerald-400",
  past_due: "text-orange-400",
  suspended: "text-red-400",
  cancelled: "text-muted-foreground",
};

interface TenantRow {
  id: string;
  name: string;
  slug: string;
  status: string;
  created_at: string;
  plan_name: string | null;
}

export function TenantSearchTable({ tenants }: { tenants: TenantRow[] }) {
  const [q, setQ] = useState("");
  const filtered = q.trim()
    ? tenants.filter(
        (t) =>
          t.name.toLowerCase().includes(q.toLowerCase()) ||
          t.slug.toLowerCase().includes(q.toLowerCase()),
      )
    : tenants.slice(0, 12);

  return (
    <div className="space-y-3">
      <div className="relative">
        <Search
          size={15}
          className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-muted-foreground"
        />
        <input
          value={q}
          onChange={(e) => setQ(e.target.value)}
          placeholder="Buscar por nombre o slug…"
          className="h-10 w-full rounded-lg border border-input bg-background pl-9 pr-4 text-sm text-foreground outline-none transition focus:border-ninja-flameSoft focus:ring-4 focus:ring-ninja-flameSoft/15"
        />
      </div>

      <div className="overflow-x-auto rounded-lg border border-border bg-card">
        <table className="w-full min-w-[520px] text-sm">
          <thead className="bg-muted text-left text-xs uppercase tracking-[0.14em] text-muted-foreground">
            <tr>
              <th className="px-4 py-3">Negocio</th>
              <th className="px-4 py-3">Plan</th>
              <th className="px-4 py-3">Estado</th>
              <th className="px-4 py-3">Alta</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-border">
            {filtered.map((t) => (
              <tr key={t.id} className="transition hover:bg-muted/40">
                <td className="px-4 py-3">
                  <Link
                    href={`/internal/tenants/${t.id}`}
                    className="font-medium hover:text-ninja-flameSoft"
                  >
                    {t.name}
                  </Link>
                  <div className="text-xs text-muted-foreground">{t.slug}</div>
                </td>
                <td className="px-4 py-3 text-muted-foreground">
                  {t.plan_name ?? "—"}
                </td>
                <td className={`px-4 py-3 font-medium ${STATUS_COLOR[t.status] ?? "text-foreground"}`}>
                  {STATUS_LABELS[t.status] ?? t.status}
                </td>
                <td className="px-4 py-3 text-muted-foreground">
                  {new Date(t.created_at).toLocaleDateString("es-AR")}
                </td>
              </tr>
            ))}
            {filtered.length === 0 && (
              <tr>
                <td colSpan={4} className="px-4 py-6 text-center text-muted-foreground">
                  Sin resultados para &ldquo;{q}&rdquo;.
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
      {!q && tenants.length > 12 && (
        <p className="text-right text-xs text-muted-foreground">
          Mostrando 12 de {tenants.length}.{" "}
          <Link href="/internal/tenants" className="text-ninja-flameSoft hover:underline">
            Ver todos
          </Link>
        </p>
      )}
    </div>
  );
}
