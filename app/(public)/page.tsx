import { redirect } from "next/navigation";

// La pestaña principal entra al producto (POS). Sin sesión, el middleware
// redirige a /login. La landing de "Ninja Soft" se hará más adelante.
export default function Home() {
  redirect("/pos");
}
