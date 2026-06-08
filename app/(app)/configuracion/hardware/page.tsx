import { redirect } from "next/navigation";

// Centro de diagnostico de hardware (F10 - H26).
// La UI vive como seccion de Configuracion (HardwareCard). Esta ruta existe para
// que el path documentado /configuracion/hardware funcione como acceso directo:
// redirige a la seccion correspondiente.
export default function HardwareRedirectPage() {
  redirect("/configuracion?seccion=hardware");
}
