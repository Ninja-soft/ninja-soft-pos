import Link from "next/link";
import { Building2, CreditCard, Mail, ShieldCheck } from "lucide-react";
import { createClient } from "@/lib/supabase/server";
import { Eyebrow, Display, Heading } from "@/components/ui/Typography";
import { Card, CardContent } from "@/components/ui/Card";

const STATUS_LABELS: Record<string, string> = {
  trial: "Prueba",
  active: "Activa",
  past_due: "Pago pendiente",
  suspended: "Suspendida",
  cancelled: "Cancelada",
};

export default async function InternalHomePage() {
  const supabase = createClient();

  const { data: tenants } = await supabase
    .from("tenants")
    .select("name, slug, status, created_at")
    .is("deleted_at", null)
    .order("created_at", { ascending: false });
  const { count: staffCount } = await supabase
    .from("users")
    .select("id", { count: "exact", head: true })
    .not("internal_level", "is", null);

  const list = tenants ?? [];
  const by = (s: string) => list.filter((t) => t.status === s).length;
  const metrics = [
    { label: "Negocios", value: list.length },
    { label: "En prueba", value: by("trial") },
    { label: "Activas", value: by("active") },
    { label: "Suspendidas", value: by("suspended") },
  ];

  return (
    <>
      <Eyebrow>Panel interno</Eyebrow>
      <Display className="mt-3 text-3xl md:text-4xl">NinjaSoft</Display>
      <p className="mt-2 text-muted-foreground">
        Operá el SaaS: negocios, suscripciones, staff y comunicaciones.
      </p>

      <div className="mt-6 grid grid-cols-2 gap-4 sm:grid-cols-4">
        {metrics.map((m) => (
          <Card key={m.label}>
            <CardContent className="p-5">
              <p className="text-sm text-muted-foreground">{m.label}</p>
              <p className="mt-1 font-display text-3xl font-black">{m.value}</p>
            </CardContent>
          </Card>
        ))}
      </div>

      <div className="mt-6 flex flex-wrap gap-3">
        <Link
          href="/internal/tenants"
          className="flex items-center gap-2 rounded-lg border border-border bg-card px-4 py-2.5 text-sm font-medium transition hover:border-ninja-flameSoft/50 hover:bg-muted"
        >
          <Building2 size={16} /> Negocios
        </Link>
        <Link
          href="/internal/staff"
          className="flex items-center gap-2 rounded-lg border border-border bg-card px-4 py-2.5 text-sm font-medium transition hover:border-ninja-flameSoft/50 hover:bg-muted"
        >
          <ShieldCheck size={16} /> Staff ({staffCount ?? 0})
        </Link>
        <Link
          href="/internal/emails"
          className="flex items-center gap-2 rounded-lg border border-border bg-card px-4 py-2.5 text-sm font-medium transition hover:border-ninja-flameSoft/50 hover:bg-muted"
        >
          <Mail size={16} /> Emails
        </Link>
      </div>

      <Heading as="h2" className="mt-8 flex items-center gap-2 text-base">
        <CreditCard size={18} /> Últimos negocios
      </Heading>
      <Card className="mt-3">
        <CardContent className="overflow-x-auto p-0">
          <table className="w-full min-w-[480px] text-sm">
            <thead className="bg-muted text-left text-xs uppercase tracking-[0.14em] text-muted-foreground">
              <tr>
                <th className="px-4 py-3">Negocio</th>
                <th className="px-4 py-3">Estado</th>
                <th className="px-4 py-3">Alta</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-border">
              {list.slice(0, 8).map((t) => (
                <tr key={t.slug}>
                  <td className="px-4 py-3">
                    <Link
                      href={`/internal/tenants`}
                      className="font-medium hover:text-ninja-flameSoft"
                    >
                      {t.name}
                    </Link>
                    <div className="text-xs text-muted-foreground">{t.slug}</div>
                  </td>
                  <td className="px-4 py-3 text-muted-foreground">
                    {STATUS_LABELS[t.status] ?? t.status}
                  </td>
                  <td className="px-4 py-3 text-muted-foreground">
                    {new Date(t.created_at).toLocaleDateString("es-AR")}
                  </td>
                </tr>
              ))}
              {list.length === 0 && (
                <tr>
                  <td colSpan={3} className="px-4 py-6 text-muted-foreground">
                    Todavía no hay negocios.
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </CardContent>
      </Card>
    </>
  );
}
