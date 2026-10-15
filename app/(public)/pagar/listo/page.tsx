// Pantalla de regreso después de pagar con un link (Ualá Bis y otros que
// redirigen al navegador del cliente). Es neutra: la venta la confirma el
// servidor consultando al proveedor, nunca este redirect.
import { CheckCircle2, XCircle } from "lucide-react";

export const metadata = { title: "Pago · NinjaPos" };

export default function PagoListoPage({ searchParams }: { searchParams: { estado?: string } }) {
  const ok = searchParams.estado !== "error";
  return (
    <main className="grid min-h-dvh place-items-center bg-background px-4 text-foreground">
      <div className="max-w-sm text-center">
        {ok ? (
          <CheckCircle2 size={48} className="mx-auto text-success" aria-hidden />
        ) : (
          <XCircle size={48} className="mx-auto text-danger" aria-hidden />
        )}
        <h1 className="mt-4 text-xl font-bold">{ok ? "¡Listo!" : "El pago no se completó"}</h1>
        <p className="mt-2 text-sm text-muted-foreground">
          {ok
            ? "Si el pago se aprobó, la venta se registra sola en el mostrador. Podés cerrar esta pantalla."
            : "No se cobró nada. Podés volver a intentarlo desde el mismo link o pedirle otro al comercio."}
        </p>
      </div>
    </main>
  );
}
