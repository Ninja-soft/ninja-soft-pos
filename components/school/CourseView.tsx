"use client";

import { useState } from "react";
import Link from "next/link";
import type { Route } from "next";
import { ArrowLeft, Award, Check, ChevronDown, CircleCheck, CircleX, ListChecks } from "lucide-react";
import { PageContainer, PageHeader } from "@/components/ui/PageHeader";
import { Button } from "@/components/ui/Button";
import { Badge } from "@/components/ui/Badge";
import { Callout } from "@/components/ui/Callout";
import { useToast } from "@/components/ui/Toast";
import { cn } from "@/lib/utils/cn";
import { normalizeRole } from "@/lib/permissions/roles";
import { pendingLessons, quizComplete, type QuizAnswers } from "@/lib/school/quiz";
import type { HelpArticle, PublicCourse } from "@/lib/help/types";
import { useMyTenant } from "@/modules/tenants/hooks";
import {
  schoolErrorMessage,
  useMarkLesson,
  useMySchoolProgress,
  useSubmitQuiz,
  type QuizSubmitResult,
} from "@/modules/help/hooks";
import { HelpArticleView } from "@/components/help/HelpArticleView";

// Curso de la Escuela (F15 · H69 · ADR-086): lecciones (artículos de ayuda)
// con "Marcar como hecha", checklist de práctica y prueba corta. La base
// valida y puntúa; el navegador nunca recibe las respuestas.
export function CourseView({ course, lessons }: { course: PublicCourse; lessons: HelpArticle[] }) {
  const { toast } = useToast();
  const { data: tenant } = useMyTenant();
  const role = normalizeRole(tenant?.role);
  const { data: progressMap } = useMySchoolProgress();
  const progress = progressMap?.[course.key] ?? null;
  const done = progress?.lessons_done ?? [];
  const pending = pendingLessons(course, done);
  const mark = useMarkLesson();
  const submit = useSubmitQuiz();
  const [openLesson, setOpenLesson] = useState<string | null>(pending[0] ?? null);
  const [checks, setChecks] = useState<Record<number, boolean>>({});
  const [answers, setAnswers] = useState<QuizAnswers>({});
  const [result, setResult] = useState<QuizSubmitResult | null>(null);

  const passed = Boolean(progress?.passed_at);

  const toggleLesson = (id: string, value: boolean) =>
    mark.mutate(
      { course: course.key, lesson: id, done: value },
      {
        onSuccess: () => {
          if (value) {
            const next = course.lessons.find((l) => l !== id && !done.includes(l));
            setOpenLesson(next ?? null);
          }
        },
        onError: (e) => toast({ title: schoolErrorMessage((e as Error).message), variant: "error" }),
      },
    );

  const send = () =>
    submit.mutate(
      { course: course.key, answers },
      {
        onSuccess: (r) => {
          setResult(r);
          toast({
            title: r.passed ? "¡Aprobaste!" : "Todavía no",
            description: `${r.score} de ${r.total} correctas (${r.pct}%).`,
            variant: r.passed ? "success" : "info",
          });
        },
        onError: (e) => toast({ title: schoolErrorMessage((e as Error).message), variant: "error" }),
      },
    );

  return (
    <PageContainer size="md">
      <Link
        href={"/escuela" as Route}
        className="mb-3 inline-flex items-center gap-1 text-sm text-muted-foreground hover:text-foreground"
      >
        <ArrowLeft size={15} /> Escuela
      </Link>
      <PageHeader
        eyebrow="Curso"
        title={course.title}
        description={course.summary}
        actions={
          passed && course.certificate ? (
            <Link href={`/escuela/${course.key}/certificado` as Route}>
              <Button size="sm">
                <Award size={15} /> Ver certificado
              </Button>
            </Link>
          ) : undefined
        }
      />

      {/* 1. Lecciones */}
      <section className="mt-6 space-y-2">
        <h2 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
          Lecciones · {course.lessons.length - pending.length} de {course.lessons.length}
        </h2>
        <ul className="divide-y divide-border rounded-lg border border-border bg-card">
          {lessons.map((a, i) => {
            const isDone = done.includes(a.id);
            const isOpen = openLesson === a.id;
            return (
              <li key={a.id}>
                <button
                  type="button"
                  onClick={() => setOpenLesson(isOpen ? null : a.id)}
                  aria-expanded={isOpen}
                  className="flex w-full items-center gap-3 px-4 py-3 text-left"
                >
                  <span
                    className={cn(
                      "flex h-7 w-7 shrink-0 items-center justify-center rounded-full border text-xs font-bold tabular-nums",
                      isDone ? "border-transparent bg-ninja-flame/10 text-ninja-flameSoft" : "border-border text-muted-foreground",
                    )}
                  >
                    {isDone ? <Check size={14} strokeWidth={3} /> : i + 1}
                  </span>
                  <span className="min-w-0 flex-1">
                    <span className="block text-sm font-medium text-foreground">{a.title}</span>
                    <span className="block text-xs text-muted-foreground">{a.summary}</span>
                  </span>
                  <ChevronDown size={16} className={cn("shrink-0 text-muted-foreground transition", isOpen && "rotate-180")} />
                </button>
                {isOpen && (
                  <div className="space-y-4 px-4 pb-4">
                    <HelpArticleView article={a} role={role} compact />
                    <Button
                      size="sm"
                      variant={isDone ? "secondary" : "primary"}
                      loading={mark.isPending}
                      onClick={() => toggleLesson(a.id, !isDone)}
                    >
                      {isDone ? "Marcar como pendiente" : "Marcar como hecha"}
                    </Button>
                  </div>
                )}
              </li>
            );
          })}
        </ul>
      </section>

      {/* 2. Checklist de práctica (local: guía para practicar en el sistema) */}
      <section className="mt-6 space-y-2">
        <h2 className="flex items-center gap-1.5 text-xs font-semibold uppercase tracking-wide text-muted-foreground">
          <ListChecks size={14} /> Practicá en el sistema
        </h2>
        <ul className="space-y-1.5 rounded-lg border border-border bg-card p-3">
          {course.checklist.map((item, i) => (
            <li key={i}>
              <label className="flex cursor-pointer items-start gap-3 rounded-md px-1 py-1.5 text-sm">
                <input
                  type="checkbox"
                  className="mt-0.5 h-4 w-4 accent-[var(--pos-solid)]"
                  checked={Boolean(checks[i])}
                  onChange={(e) => setChecks((s) => ({ ...s, [i]: e.target.checked }))}
                />
                <span className={cn(checks[i] ? "text-muted-foreground line-through" : "text-foreground")}>{item}</span>
              </label>
            </li>
          ))}
        </ul>
      </section>

      {/* 3. Prueba */}
      <section className="mt-6 space-y-3">
        <h2 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
          Prueba corta · aprobás con {course.passPct}%
        </h2>
        {pending.length > 0 ? (
          <Callout tone="neutral" title="Terminá las lecciones">
            Marcá las {pending.length} lecciones que faltan como hechas para habilitar la prueba.
          </Callout>
        ) : (
          <>
            {passed && !result && (
              <Callout tone="success" title="Ya aprobaste este curso">
                Mejor puntaje: {progress?.best_score_pct ?? 0}%. Podés volver a hacer la prueba para repasar.
              </Callout>
            )}
            <ol className="space-y-4">
              {course.quiz.map((q, qi) => {
                const r = result?.results.find((x) => x.id === q.id);
                return (
                  <li key={q.id} className="rounded-lg border border-border bg-card p-4">
                    <p className="text-sm font-medium text-foreground">
                      {qi + 1}. {q.question}
                    </p>
                    <div className="mt-3 space-y-1.5" role="radiogroup" aria-label={q.question}>
                      {q.options.map((opt, oi) => (
                        <label
                          key={oi}
                          className={cn(
                            "flex cursor-pointer items-start gap-3 rounded-md border px-3 py-2 text-sm transition",
                            answers[q.id] === oi ? "border-[var(--pos-solid)]" : "border-border hover:bg-muted/50",
                          )}
                        >
                          <input
                            type="radio"
                            name={q.id}
                            className="mt-0.5 accent-[var(--pos-solid)]"
                            checked={answers[q.id] === oi}
                            onChange={() => {
                              setAnswers((s) => ({ ...s, [q.id]: oi }));
                              setResult(null);
                            }}
                          />
                          <span className="text-foreground">{opt}</span>
                        </label>
                      ))}
                    </div>
                    {r && (
                      <p
                        className={cn(
                          "mt-3 flex items-start gap-1.5 text-sm",
                          r.correct ? "text-success" : "text-danger",
                        )}
                      >
                        {r.correct ? <CircleCheck size={15} className="mt-0.5 shrink-0" /> : <CircleX size={15} className="mt-0.5 shrink-0" />}
                        <span>
                          {r.correct ? "Correcta." : "Incorrecta."}{" "}
                          <span className="text-muted-foreground">{r.explain}</span>
                        </span>
                      </p>
                    )}
                  </li>
                );
              })}
            </ol>
            <div className="flex flex-wrap items-center gap-3">
              <Button onClick={send} loading={submit.isPending} disabled={!quizComplete(course.quiz, answers)}>
                Enviar respuestas
              </Button>
              {result && (
                <Badge tone={result.passed ? "success" : "warning"}>
                  {result.score}/{result.total} · {result.pct}%
                </Badge>
              )}
              {result?.passed && course.certificate && (
                <Link href={`/escuela/${course.key}/certificado` as Route} className="text-sm font-medium text-ninja-flameSoft underline-offset-4 hover:underline">
                  Ver certificado
                </Link>
              )}
            </div>
          </>
        )}
      </section>
    </PageContainer>
  );
}
