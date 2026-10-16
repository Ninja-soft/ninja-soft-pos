import { redirect } from "next/navigation";

// El alta del negocio vive en /signup: retoma lo que el dueño cargó al
// registrarse (rubro, plan, Asistente IA, código de invitación, datos fiscales)
// y no lo vuelve a pedir. Esta ruta vieja pedía otra vez el nombre del negocio,
// ofrecía sólo 6 rubros (sin "Servicios") y perdía el plan y la IA: queda como
// redirección para links y favoritos viejos.
export default function OnboardingPage() {
  redirect("/signup");
}
