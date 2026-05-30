import { redirect } from "next/navigation";

// El panel interno entra directo al listado de negocios.
export default function InternalIndexPage() {
  redirect("/internal/tenants");
}
