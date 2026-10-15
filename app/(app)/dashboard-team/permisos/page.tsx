import Link from "next/link";
import { ArrowLeft, ShieldCheck } from "lucide-react";
import { PageContainer, PageHeader } from "@/components/ui/PageHeader";
import { buttonVariants } from "@/components/ui/Button";
import { PermissionsEditor } from "@/components/permissions/PermissionsEditor";

export const metadata = { title: "Roles y permisos" };

// Editor de roles y permisos del negocio (ADR-138). La base valida todo; la
// página la ve cualquier miembro (cada uno ve lo suyo), edita el dueño y
// asigna quien gestiona el equipo.
export default function PermisosPage() {
  return (
    <PageContainer>
      <PageHeader
        eyebrow="Panel del dueño"
        title="Roles y permisos"
        icon={ShieldCheck}
        description="Qué puede hacer cada persona del equipo: elegí un rol, armá los tuyos por módulo o capacidad por capacidad y mirá de dónde sale cada permiso."
        actions={
          <Link href={"/dashboard-team#equipo" as never} className={buttonVariants({ variant: "secondary", size: "sm" })}>
            <ArrowLeft size={16} /> Volver al equipo
          </Link>
        }
      />
      <div className="mt-8">
        <PermissionsEditor />
      </div>
    </PageContainer>
  );
}
