"use client";

import Link from "next/link";
import type { Route } from "next";
import { useQuery } from "@tanstack/react-query";
import { ArrowLeft, Award, Printer } from "lucide-react";
import { PageContainer } from "@/components/ui/PageHeader";
import { Button } from "@/components/ui/Button";
import { SpinnerBlock } from "@/components/ui/Spinner";
import { EmptyState } from "@/components/ui/EmptyState";
import { createClient } from "@/lib/supabase/client";
import { getCurrentUser } from "@/lib/supabase/currentUser";
import { useMyTenant } from "@/modules/tenants/hooks";
import { useMySchoolProgress } from "@/modules/help/hooks";

// Certificado simple de la Escuela (F15 · H69 · ADR-086): nombre, curso, fecha
// y código. Imprimible. Sólo existe si la base registró el aprobado.
export function CertificateView({ courseKey, title, certificate }: { courseKey: string; title: string; certificate: string }) {
  const { data: tenant } = useMyTenant();
  const { data: progress, isLoading } = useMySchoolProgress();
  const row = progress?.[courseKey];

  const { data: name } = useQuery({
    queryKey: ["my-display-name", tenant?.tenantId],
    enabled: Boolean(tenant?.tenantId),
    queryFn: async () => {
      const user = await getCurrentUser();
      if (!user) return null;
      const { data } = await createClient()
        .from("tenant_users")
        .select("display_name")
        .eq("tenant_id", tenant!.tenantId)
        .eq("user_id", user.id)
        .maybeSingle();
      return (data as { display_name: string | null } | null)?.display_name || user.email || null;
    },
  });

  if (isLoading) return <SpinnerBlock />;

  return (
    <PageContainer size="md">
      <Link
        href={`/escuela/${courseKey}` as Route}
        className="mb-3 inline-flex items-center gap-1 text-sm text-muted-foreground hover:text-foreground print:hidden"
      >
        <ArrowLeft size={15} /> {title}
      </Link>
      {!row?.passed_at ? (
        <EmptyState
          icon={Award}
          title="Todavía no tenés este certificado"
          description="Completá las lecciones y aprobá la prueba del curso."
        />
      ) : (
        <>
          <div className="rounded-lg border border-border border-t-2 border-t-[var(--pos-solid)] bg-card px-6 py-10 text-center">
            <p className="text-xs font-semibold uppercase tracking-[0.2em] text-muted-foreground">Escuela NinjaSoft</p>
            <Award size={36} className="mx-auto mt-5 text-ninja-flameSoft" aria-hidden />
            <p className="mt-4 text-sm text-muted-foreground">Certificamos que</p>
            <p className="mt-1 font-display text-2xl font-bold text-foreground">{name ?? ""}</p>
            <p className="mt-3 text-sm text-muted-foreground">aprobó el curso</p>
            <p className="mt-1 font-display text-xl font-bold text-foreground">{certificate}</p>
            {tenant?.name && <p className="mt-3 text-sm text-muted-foreground">en {tenant.name}</p>}
            <p className="mt-6 text-sm text-foreground">
              {new Date(row.passed_at).toLocaleDateString("es-AR", { day: "numeric", month: "long", year: "numeric" })}
              {row.best_score_pct != null && ` · ${row.best_score_pct}%`}
            </p>
            <p className="mt-1 font-mono text-xs text-muted-foreground">Código {row.certificate_code}</p>
          </div>
          <div className="mt-4 flex justify-end print:hidden">
            <Button variant="secondary" onClick={() => window.print()}>
              <Printer size={15} /> Imprimir
            </Button>
          </div>
        </>
      )}
    </PageContainer>
  );
}
