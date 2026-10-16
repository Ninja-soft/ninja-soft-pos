import type { Metadata } from "next";
import { PublicDevelopers } from "@/components/integrations/api/PublicDevelopers";

// Portal público de desarrolladores de la API (ADR-163, H68b). Sin login: la
// documentación sale de lib/api/spec.ts y el sandbox usa /api/sandbox/v1
// (dataset ficticio o credencial de prueba propia).
export const metadata: Metadata = {
  title: "Desarrolladores · API de NinjaSoft POS",
  description:
    "Referencia de la API pública de NinjaSoft POS, colección de Postman, OpenAPI y sandbox para probar sin cuenta con datos ficticios.",
};

export default function DevelopersPage() {
  return <PublicDevelopers />;
}
