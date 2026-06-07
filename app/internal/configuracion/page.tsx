import { redirect } from "next/navigation";

// El Asistente IA se movió a Complementos (Add-ons). Mantenemos la URL vieja
// viva redirigiendo, por si quedó algún enlace/marcador apuntando acá.
export default function InternalConfiguracionPage() {
  redirect("/internal/addons");
}
