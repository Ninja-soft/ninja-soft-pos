"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { LogoNinjaPos, LogoNinjaSoft } from "@/components/brand/Logo";
import { ValuePanel } from "@/components/auth/ValuePanel";

// Layout de auth (login, signup, recuperar, blanquear, login interno).
// Desktop (lg+): dos columnas, panel de marca fijo a la izquierda y el
// formulario a la derecha. Celular: una columna limpia con el logo arriba.
// Sigue el tema del usuario (ninja-dark por defecto, ver ThemeProvider): el
// fondo es el plano del tema, sin manchas ni degradados.
export default function AuthLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  const pathname = usePathname();
  const isSignup = pathname === "/signup";

  return (
    <div className="min-h-screen bg-background text-foreground lg:grid lg:grid-cols-[minmax(0,5fr)_minmax(0,6fr)]">
      <ValuePanel showTrial={isSignup} />

      <div className="flex min-h-screen flex-col px-4 sm:px-8">
        <main className="flex flex-1 flex-col justify-center py-10 sm:py-14">
          <div className="mx-auto w-full max-w-[420px]">
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

        <footer className="mx-auto flex w-full max-w-[420px] items-center justify-center gap-2 border-t border-border py-6 text-xs text-muted-foreground lg:justify-start">
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
