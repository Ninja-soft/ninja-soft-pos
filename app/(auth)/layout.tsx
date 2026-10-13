"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { LogoNinjaPos, LogoNinjaSoft } from "@/components/brand/Logo";
import { ValuePanel } from "@/components/auth/ValuePanel";
import { cn } from "@/lib/utils/cn";

// Layout de auth (login, signup, recuperar, blanquear, login interno).
// Desktop (lg+): dos columnas, panel de marca fijo a la izquierda y el
// formulario a la derecha. En signup el panel se angosta (40%) y la columna del
// formulario se ensancha (hasta 720px) para el wizard en grilla; el resto de las
// pantallas mantiene el formulario de 420px. Celular: una columna limpia con el
// logo arriba.
// Sigue el tema del usuario (ninja-dark por defecto, ver ThemeProvider): el
// fondo es el plano del tema, sin manchas ni degradados.
export default function AuthLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  const pathname = usePathname();
  const isSignup = pathname === "/signup";
  const width = isSignup ? "max-w-[420px] sm:max-w-[720px]" : "max-w-[420px]";

  return (
    <div
      className={cn(
        "min-h-screen bg-background text-foreground lg:grid",
        isSignup
          ? "lg:grid-cols-[minmax(0,2fr)_minmax(0,3fr)]"
          : "lg:grid-cols-[minmax(0,5fr)_minmax(0,6fr)]",
      )}
    >
      <ValuePanel />

      <div className={cn("flex min-h-screen flex-col px-4 sm:px-8", isSignup && "xl:px-12")}>
        <main
          className={cn(
            "flex flex-1 flex-col justify-center",
            isSignup ? "py-10 lg:py-8" : "py-10 sm:py-14",
          )}
        >
          <div className={cn("mx-auto w-full", width)}>
            <Link
              href="/"
              aria-label="Ninja POS, ir al inicio"
              className="mb-10 flex w-fit rounded-md outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-4 focus-visible:ring-offset-background lg:hidden"
            >
              <LogoNinjaPos className="h-8 w-auto" priority />
            </Link>
            {children}
          </div>
        </main>

        <footer
          className={cn(
            "mx-auto flex w-full items-center justify-center gap-2 border-t border-border text-xs text-muted-foreground lg:justify-start",
            width,
            isSignup ? "py-5" : "py-6",
          )}
        >
          <span>Un producto de</span>
          <a
            href="https://soft.ninja"
            target="_blank"
            rel="noopener noreferrer"
            aria-label="Ninja Soft (se abre en una pestaña nueva)"
            className="inline-flex rounded-sm opacity-80 outline-none transition hover:opacity-100 focus-visible:opacity-100 focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background"
          >
            <LogoNinjaSoft className="h-4 w-auto" />
          </a>
        </footer>
      </div>
    </div>
  );
}
