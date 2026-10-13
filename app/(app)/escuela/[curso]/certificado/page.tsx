import { notFound } from "next/navigation";
import { getCourse } from "@/lib/school/courses";
import { CertificateView } from "@/components/school/CertificateView";

// Certificado de un curso aprobado (F15 · H69 · ADR-086).
export default function CertificadoPage({ params }: { params: { curso: string } }) {
  const course = getCourse(params.curso);
  if (!course || !course.certificate) notFound();
  return <CertificateView courseKey={course.key} title={course.title} certificate={course.certificate} />;
}
