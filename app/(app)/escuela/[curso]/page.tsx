import { notFound } from "next/navigation";
import { getCourse } from "@/lib/school/courses";
import { toPublicCourse } from "@/lib/school/quiz";
import { getArticle } from "@/lib/help/content";
import type { HelpArticle } from "@/lib/help/types";
import { CourseView } from "@/components/school/CourseView";

// Curso de la Escuela (F15 · H69 · ADR-086): lecciones = artículos de ayuda.
export default function CursoPage({ params }: { params: { curso: string } }) {
  const course = getCourse(params.curso);
  if (!course) notFound();
  const lessons = course.lessons.map(getArticle).filter((a): a is HelpArticle => a !== null);
  return <CourseView course={toPublicCourse(course)} lessons={lessons} />;
}
