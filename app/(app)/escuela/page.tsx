import { COURSES } from "@/lib/school/courses";
import { toPublicCourse } from "@/lib/school/quiz";
import { SchoolHome } from "@/components/school/SchoolHome";

// Escuela NinjaSoft (F15 · H69 · ADR-086). Server component: los cursos se leen
// del contenido versionado y viajan al navegador sin las respuestas.
export default function EscuelaPage() {
  return <SchoolHome courses={COURSES.map(toPublicCourse)} />;
}
