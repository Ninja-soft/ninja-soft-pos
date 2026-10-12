import { redirect } from "next/navigation";

// Compras (F18 · H101): entra por las órdenes de compra.
export default function ComprasPage() {
  redirect("/compras/ordenes");
}
