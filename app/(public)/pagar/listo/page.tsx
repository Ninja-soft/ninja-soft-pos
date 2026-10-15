// Pantalla de regreso después de pagar con un link (Ualá Bis y otros que
// redirigen al navegador del cliente). Es neutra: la venta la confirma el
// servidor consultando al proveedor, nunca este redirect. Muestra el nombre y
// el logo del negocio (vienen en la URL, son públicos) y el pie de NinjaPos.
import { CheckCircle2, XCircle } from "lucide-react";
import { LogoNinjaPos } from "@/components/brand/Logo";

export const metadata = { title: "Pago · NinjaPos" };

const safeLogo = (v?: string) => (v && /^https:\/\//.test(v) && v.length < 600 ? v : null);

export default function PagoListoPage({ searchParams }: { searchParams: { estado?: string; n?: string; l?: string } }) {
  const ok = searchParams.estado !== "error";
  const shop = (searchParams.n ?? "").slice(0, 80);
  const logo = safeLogo(searchParams.l);
  return (
    <div className="flex min-h-dvh flex-col bg-background text-foreground">
      <main className="grid flex-1 place-items-center px-4 py-10">
        <div className="w-full max-w-sm text-center">
          {(logo || shop) && (
            <div className="mb-8 flex flex-col items-center gap-3">
              {logo && (
                // eslint-disable-next-line @next/next/no-img-element
                <img src={logo} alt={shop || "Logo del comercio"} className="h-16 w-16 rounded-lg object-contain" />
              )}
              {shop && <p className="text-base font-semibold">{shop}</p>}
            </div>
          )}
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
      <footer className="flex flex-col items-center gap-2 border-t border-border px-4 py-5 text-xs text-muted-foreground">
        <LogoNinjaPos className="h-6" />
        <a href="https://soft.ninja" target="_blank" rel="noopener noreferrer" className="hover:text-foreground hover:underline">
          Un software de Ninja Soft
        </a>
      </footer>
    </div>
  );
}
