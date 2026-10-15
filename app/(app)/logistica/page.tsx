import { redirect } from "next/navigation";

// Logística (ADR-149 · L0): el ítem del menú entra por Expedición; desde ahí
// la barra de Logística lleva a Remitos y Envíos.
export default function LogisticaPage() {
  redirect("/expedicion");
}
