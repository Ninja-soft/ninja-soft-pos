// Escuela NinjaSoft (F15 · H69 · ADR-086): puntaje de la prueba corta.
// Espejo puro de school_submit_quiz (migración 20261108100100_escuela): la base
// es la que puntúa y certifica; esto sirve para testear las reglas y para la UI.
import type { Course, PublicCourse, QuizQuestion } from "@/lib/help/types";

export type QuizAnswers = Record<string, number>;

export interface QuizResult {
  score: number;
  total: number;
  pct: number;
  passed: boolean;
  results: { id: string; correct: boolean }[];
}

/**
 * Una respuesta vale si es el índice correcto. Lo que falta o no es un entero
 * cuenta como incorrecta. El porcentaje redondea al entero (igual que round()
 * de Postgres para numeric: 0,5 hacia arriba) y aprueba con pct >= passPct.
 */
export function scoreQuiz(
  quiz: readonly Pick<QuizQuestion, "id" | "answer">[],
  answers: QuizAnswers,
  passPct: number,
): QuizResult {
  const results = quiz.map((q) => {
    const a = answers[q.id];
    return { id: q.id, correct: Number.isInteger(a) && a === q.answer };
  });
  const score = results.filter((r) => r.correct).length;
  const total = quiz.length;
  const pct = total === 0 ? 0 : Math.round((score * 100) / total);
  return { score, total, pct, passed: total > 0 && pct >= passPct, results };
}

/** Todas las preguntas tienen una opción elegida dentro de rango. */
export function quizComplete(quiz: readonly Pick<QuizQuestion, "id" | "options">[], answers: QuizAnswers): boolean {
  return quiz.every((q) => {
    const a = answers[q.id];
    return Number.isInteger(a) && a! >= 0 && a! < q.options.length;
  });
}

/** Lecciones que faltan marcar para habilitar la prueba. */
export function pendingLessons(course: Pick<Course, "lessons">, done: readonly string[]): string[] {
  const set = new Set(done);
  return course.lessons.filter((l) => !set.has(l));
}

/** Curso sin respuestas ni explicaciones: lo único que se manda al navegador. */
export function toPublicCourse(course: Course): PublicCourse {
  return {
    ...course,
    quiz: course.quiz.map(({ id, question, options }) => ({ id, question, options })),
  };
}

/** Cursos recomendados primero para el rol actual. */
export function sortCoursesForRole<T extends Pick<Course, "roles">>(courses: readonly T[], role: string | null): T[] {
  if (!role) return [...courses];
  return courses
    .map((c, i) => ({ c, i, r: (c.roles as string[]).includes(role) ? 0 : 1 }))
    .sort((a, b) => a.r - b.r || a.i - b.i)
    .map((x) => x.c);
}
