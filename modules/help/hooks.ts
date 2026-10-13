"use client";

// Ayuda contextual y Escuela (F15 · H72, H69 · ADR-086): datos por usuario.
//  * help_article_feedback: voto útil/no útil (RLS: sólo el propio).
//  * school_progress: progreso de cursos; se escribe sólo por RPC
//    (school_mark_lesson, school_submit_quiz) para que nadie se certifique a mano.
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { createClient } from "@/lib/supabase/client";
import { getCurrentUser } from "@/lib/supabase/currentUser";
import { useMyTenant } from "@/modules/tenants/hooks";

type LooseResult = { data: unknown; error: { message: string } | null };
interface LooseQuery extends PromiseLike<LooseResult> {
  select: (cols: string) => LooseQuery;
  eq: (col: string, v: unknown) => LooseQuery;
  upsert: (row: Record<string, unknown>, opts?: { onConflict?: string }) => LooseQuery;
  maybeSingle: () => PromiseLike<LooseResult>;
}
type Loose = {
  from: (t: string) => LooseQuery;
  rpc: (fn: string, args?: Record<string, unknown>) => PromiseLike<LooseResult>;
};
const loose = () => createClient() as unknown as Loose;

// ── Feedback de artículos ─────────────────────────────────────────────────────

export function useArticleVote(articleId: string | null) {
  const { data: tenant } = useMyTenant();
  return useQuery({
    queryKey: ["help-vote", tenant?.tenantId, articleId],
    enabled: Boolean(tenant?.tenantId && articleId),
    queryFn: async (): Promise<boolean | null> => {
      const user = await getCurrentUser();
      if (!user) return null;
      const { data, error } = await loose()
        .from("help_article_feedback")
        .select("helpful")
        .eq("tenant_id", tenant!.tenantId)
        .eq("user_id", user.id)
        .eq("article_id", articleId!)
        .maybeSingle();
      if (error) throw new Error(error.message);
      return (data as { helpful: boolean } | null)?.helpful ?? null;
    },
  });
}

export function useVoteArticle() {
  const qc = useQueryClient();
  const { data: tenant } = useMyTenant();
  return useMutation({
    mutationFn: async (args: { articleId: string; version: number; helpful: boolean; route: string | null }) => {
      const user = await getCurrentUser();
      if (!user || !tenant?.tenantId) throw new Error("no_session");
      const { error } = await loose()
        .from("help_article_feedback")
        .upsert(
          {
            tenant_id: tenant.tenantId,
            user_id: user.id,
            article_id: args.articleId,
            article_version: args.version,
            helpful: args.helpful,
            route: args.route ? args.route.slice(0, 200) : null,
          },
          { onConflict: "tenant_id,user_id,article_id" },
        );
      if (error) throw new Error(error.message);
      return args.helpful;
    },
    onSuccess: (_v, args) => {
      qc.invalidateQueries({ queryKey: ["help-vote", tenant?.tenantId, args.articleId] });
    },
  });
}

// ── Escuela ───────────────────────────────────────────────────────────────────

export interface SchoolProgress {
  course_key: string;
  course_version: number;
  lessons_done: string[];
  quiz_attempts: number;
  best_score_pct: number | null;
  last_score_pct: number | null;
  passed_at: string | null;
  certificate_code: string | null;
}

export interface QuizSubmitResult {
  score: number;
  total: number;
  pct: number;
  passed: boolean;
  pass_pct: number;
  results: { id: string; correct: boolean; explain: string | null }[];
  passed_at: string | null;
  certificate_code: string | null;
}

const PROGRESS_COLS =
  "course_key, course_version, lessons_done, quiz_attempts, best_score_pct, last_score_pct, passed_at, certificate_code";

/** Progreso propio en todos los cursos del negocio activo. */
export function useMySchoolProgress() {
  const { data: tenant } = useMyTenant();
  return useQuery({
    queryKey: ["school-progress", tenant?.tenantId],
    enabled: Boolean(tenant?.tenantId),
    queryFn: async (): Promise<Record<string, SchoolProgress>> => {
      const user = await getCurrentUser();
      if (!user) return {};
      const { data, error } = await loose()
        .from("school_progress")
        .select(PROGRESS_COLS)
        .eq("tenant_id", tenant!.tenantId)
        .eq("user_id", user.id);
      if (error) throw new Error(error.message);
      const rows = (data as SchoolProgress[] | null) ?? [];
      return Object.fromEntries(rows.map((r) => [r.course_key, r]));
    },
  });
}

export function useMarkLesson() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (args: { course: string; lesson: string; done: boolean }) => {
      const { data, error } = await loose().rpc("school_mark_lesson", {
        p_course: args.course,
        p_lesson: args.lesson,
        p_done: args.done,
      });
      if (error) throw new Error(error.message);
      return data as SchoolProgress;
    },
    onSuccess: () => qc.invalidateQueries({ queryKey: ["school-progress"] }),
  });
}

export function useSubmitQuiz() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (args: { course: string; answers: Record<string, number> }) => {
      const { data, error } = await loose().rpc("school_submit_quiz", {
        p_course: args.course,
        p_answers: args.answers,
      });
      if (error) throw new Error(error.message);
      return data as QuizSubmitResult;
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["school-progress"] });
      qc.invalidateQueries({ queryKey: ["onboarding-activation"] });
    },
  });
}

/** Mensaje para el usuario a partir del error de las RPC de la Escuela. */
export function schoolErrorMessage(message: string): string {
  if (/lessons_pending/.test(message)) return "Marcá todas las lecciones como hechas antes de la prueba.";
  if (/feature_not_in_plan/.test(message)) return "La Escuela no está incluida en tu plan.";
  if (/invalid_course|invalid_lesson/.test(message)) return "El curso cambió. Recargá la página.";
  if (/forbidden|no_tenant/.test(message)) return "Tu usuario no puede usar la Escuela en este negocio.";
  return "No se pudo guardar. Probá de nuevo.";
}

// ── Checklist de activación por rubro (H71) ───────────────────────────────────

export function useOnboardingActivation(enabled: boolean) {
  return useQuery({
    queryKey: ["onboarding-activation"],
    enabled,
    staleTime: 30_000,
    queryFn: async (): Promise<Record<string, boolean>> => {
      const { data, error } = await loose().rpc("onboarding_activation_status");
      if (error) throw new Error(error.message);
      const r = (data ?? {}) as Record<string, unknown>;
      return Object.fromEntries(Object.entries(r).map(([k, v]) => [k, v === true]));
    },
  });
}
