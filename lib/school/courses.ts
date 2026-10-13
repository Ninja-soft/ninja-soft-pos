// Escuela NinjaSoft (F15 · H69 · ADR-086): cursos versionados en
// content/help/courses.json. Este módulo tiene las respuestas: importarlo sólo
// desde el servidor (páginas de /escuela) y mandar al navegador toPublicCourse.
import { z } from "zod";
import raw from "@/content/help/courses.json";
import { courseSchema, type Course } from "@/lib/help/types";

export const COURSES: readonly Course[] = z.array(courseSchema).parse(raw);

export function getCourse(key: string): Course | null {
  return COURSES.find((c) => c.key === key) ?? null;
}
