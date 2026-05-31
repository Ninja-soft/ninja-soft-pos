import { redirect } from "next/navigation";

// Acceso directo al panel interno: usa el mismo login y, al entrar, va a /internal.
// La layout de /internal valida is_internal (si no, manda al POS).
export default function LoginInternalPage() {
  redirect("/login?next=/internal/tenants");
}
