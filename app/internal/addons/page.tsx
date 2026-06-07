import { Eyebrow, Display } from "@/components/ui/Typography";
import { AiConfigCard } from "@/components/internal/AiConfigCard";

export default function InternalAddonsPage() {
  return (
    <>
      <Eyebrow>Plataforma</Eyebrow>
      <Display className="mt-3 text-3xl md:text-4xl">Complementos (Add-ons)</Display>
      <p className="mt-2 max-w-2xl text-muted-foreground">
        Complementos opcionales que los negocios contratan sobre su plan. Acá
        configurás el <strong>Asistente IA</strong>: proveedor (Gemini o Claude),
        modelo y la API key (write-only), más la presentación del complemento
        (avatar, texto comercial, precio y prueba) que ven los dueños sin el addon.
      </p>

      <div className="mt-8">
        <AiConfigCard />
      </div>
    </>
  );
}
