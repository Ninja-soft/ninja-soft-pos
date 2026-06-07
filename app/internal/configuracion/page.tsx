import { Eyebrow, Display } from "@/components/ui/Typography";
import { AiConfigCard } from "@/components/internal/AiConfigCard";

export default function InternalConfiguracionPage() {
  return (
    <>
      <Eyebrow>Plataforma</Eyebrow>
      <Display className="mt-3 text-3xl md:text-4xl">Configuración</Display>
      <p className="mt-2 max-w-2xl text-muted-foreground">
        Ajustes globales de NinjaSoft. Acá configurás el Asistente IA: proveedor,
        modelo y la API key (write-only), más la presentación del complemento
        (avatar, texto comercial, precio y prueba) que ven los dueños sin el
        addon.
      </p>

      <div className="mt-8">
        <AiConfigCard />
      </div>
    </>
  );
}
