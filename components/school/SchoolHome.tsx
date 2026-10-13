"use client";

import Link from "next/link";
import type { Route } from "next";
import { useQuery } from "@tanstack/react-query";
import { Award, ChevronRight, Clock, GraduationCap } from "lucide-react";
import { PageContainer, PageHeader } from "@/components/ui/PageHeader";
import { Badge } from "@/components/ui/Badge";
import { SpinnerBlock } from "@/components/ui/Spinner";
import { createClient } from "@/lib/supabase/client";
import { sortCoursesForRole } from "@/lib/school/quiz";
import type { PublicCourse } from "@/lib/help/types";
import { useMyTenant } from "@/modules/tenants/hooks";
import { useMySchoolProgress, type SchoolProgress } from "@/modules/help/hooks";

// Escuela NinjaSoft (F15 · H69 · ADR-086): cursos recomendados para el rol,
// progreso propio y, para dueño y encargado, los certificados del equipo.
export function SchoolHome({ courses }: { courses: PublicCourse[] }) {
  const { data: tenant } = useMyTenant();
  const { data: progress, isLoading } = useMySchoolProgress();
  const role = tenant?.role ?? null;
  const sorted = sortCoursesForRole(courses, role);

  return (
    <PageContainer size="lg">
      <PageHeader
        eyebrow="Escuela NinjaSoft"
        title="Aprendé a usar el sistema"
        icon={GraduationCap}
        description="Cursos cortos por rol: leés las lecciones, marcás el checklist y hacés una prueba de pocas preguntas."
      />
      {isLoading ? (
        <SpinnerBlock />
      ) : (
        <ul className="mt-6 grid gap-3 sm:grid-cols-2">
          {sorted.map((c) => (
            <CourseCard
              key={c.key}
              course={c}
              progress={progress?.[c.key] ?? null}
              recommended={Boolean(role && (c.roles as string[]).includes(role))}
            />
          ))}
        </ul>
      )}
      {tenant?.canManage && <TeamProgress tenantId={tenant.tenantId} courses={courses} />}
    </PageContainer>
  );
}

function CourseCard({
  course,
  progress,
  recommended,
}: {
  course: PublicCourse;
  progress: SchoolProgress | null;
  recommended: boolean;
}) {
  const done = progress ? course.lessons.filter((l) => progress.lessons_done.includes(l)).length : 0;
  const pct = Math.round((done / course.lessons.length) * 100);
  const passed = Boolean(progress?.passed_at);
  return (
    <li>
      <Link
        href={`/escuela/${course.key}` as Route}
        className="flex h-full flex-col gap-3 rounded-lg border border-border bg-card p-4 transition hover:bg-muted/50"
      >
        <div className="flex items-start gap-2">
          <h2 className="min-w-0 flex-1 font-display text-base font-bold leading-tight text-foreground">
            {course.title}
          </h2>
          {passed ? (
            <Badge tone="success">Aprobado</Badge>
          ) : recommended ? (
            <Badge tone="brand">Para tu rol</Badge>
          ) : null}
        </div>
        <p className="text-sm text-muted-foreground">{course.summary}</p>
        <div className="mt-auto flex items-center gap-3 text-xs text-muted-foreground">
          <span className="inline-flex items-center gap-1">
            <Clock size={13} /> {course.minutes} min
          </span>
          <span>{course.lessons.length} lecciones</span>
          {course.certificate && (
            <span className="inline-flex items-center gap-1">
              <Award size={13} /> Certificado
            </span>
          )}
          <ChevronRight size={15} className="ml-auto" />
        </div>
        <div className="flex items-center gap-2">
          <div className="h-1.5 flex-1 overflow-hidden rounded-full bg-muted">
            <div className="h-full rounded-full bg-[var(--pos-solid)]" style={{ width: `${passed ? 100 : pct}%` }} />
          </div>
          <span className="w-9 text-right font-display text-xs font-bold tabular-nums text-foreground">
            {passed ? 100 : pct}%
          </span>
        </div>
      </Link>
    </li>
  );
}

interface TeamRow {
  user_id: string;
  course_key: string;
  passed_at: string | null;
  lessons_done: string[];
  best_score_pct: number | null;
}

// Dueño y encargado ven el avance de su equipo (RLS de school_progress).
function TeamProgress({ tenantId, courses }: { tenantId: string; courses: PublicCourse[] }) {
  const { data, isLoading } = useQuery({
    queryKey: ["school-team", tenantId],
    queryFn: async () => {
      const db = createClient() as unknown as {
        from: (t: string) => {
          select: (c: string) => { eq: (k: string, v: string) => PromiseLike<{ data: unknown; error: { message: string } | null }> };
        };
      };
      const [prog, members] = await Promise.all([
        db.from("school_progress").select("user_id, course_key, passed_at, lessons_done, best_score_pct").eq("tenant_id", tenantId),
        db.from("tenant_users").select("user_id, display_name, role").eq("tenant_id", tenantId),
      ]);
      if (prog.error) throw new Error(prog.error.message);
      const names = new Map(
        ((members.data as { user_id: string; display_name: string | null }[] | null) ?? []).map((m) => [
          m.user_id,
          m.display_name,
        ]),
      );
      return ((prog.data as TeamRow[] | null) ?? []).map((r) => ({ ...r, name: names.get(r.user_id) ?? "Sin nombre" }));
    },
  });
  const titles = new Map(courses.map((c) => [c.key, c]));

  return (
    <section className="mt-8 space-y-3">
      <h2 className="font-display text-base font-bold">Tu equipo</h2>
      {isLoading ? (
        <SpinnerBlock />
      ) : !data || data.length === 0 ? (
        <p className="text-sm text-muted-foreground">Nadie de tu equipo empezó un curso todavía.</p>
      ) : (
        <ul className="divide-y divide-border rounded-lg border border-border bg-card">
          {data.map((r) => {
            const c = titles.get(r.course_key);
            const total = c?.lessons.length ?? 0;
            return (
              <li key={`${r.user_id}-${r.course_key}`} className="flex flex-wrap items-center gap-x-3 gap-y-1 px-4 py-3 text-sm">
                <span className="min-w-0 flex-1 font-medium text-foreground">{r.name}</span>
                <span className="text-muted-foreground">{c?.title ?? r.course_key}</span>
                {r.passed_at ? (
                  <Badge tone="success">Aprobado {r.best_score_pct ?? ""}%</Badge>
                ) : (
                  <Badge tone="neutral">
                    {r.lessons_done.length}/{total} lecciones
                  </Badge>
                )}
              </li>
            );
          })}
        </ul>
      )}
    </section>
  );
}
