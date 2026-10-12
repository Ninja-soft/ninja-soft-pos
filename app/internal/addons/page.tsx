import { AiConfigCard } from "@/components/internal/AiConfigCard";
import { Sparkles } from "lucide-react";
import { PageHeader } from "@/components/ui/PageHeader";

export default function InternalAddonsPage() {
  return (
    <>
      <PageHeader
        eyebrow="Plataforma"
        title="Complementos (Add-ons)"
        icon={Sparkles}
        description={
          <>
            Complementos opcionales que los negocios contratan sobre su plan. Acá
            configurás el <strong>Asistente IA</strong>: proveedor (Gemini o Claude),
            modelo y la API key (write-only), más la presentación del complemento
            (avatar, texto comercial, precio y prueba) que ven los dueños sin el addon.
          </>
        }
      />

      <div className="mt-8">
        <AiConfigCard />
      </div>
    </>
  );
}
