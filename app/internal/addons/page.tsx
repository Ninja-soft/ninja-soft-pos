import { AiConfigCard } from "@/components/internal/AiConfigCard";
import { Sparkles } from "lucide-react";
import { PageHeader } from "@/components/ui/PageHeader";

export default function InternalAddonsPage() {
  return (
    <>
      <PageHeader
        eyebrow="Plataforma"
        title="Complementos"
        icon={Sparkles}
        description={
          <>
            Lo que los negocios contratan aparte de su plan. Acá configurás el
            Asistente IA: proveedor, modelo, API key y cómo se presenta a los dueños
            que todavía no lo tienen.
          </>
        }
      />

      <div className="mt-8">
        <AiConfigCard />
      </div>
    </>
  );
}
