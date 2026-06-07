"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { WordmarkPos } from "@/components/brand/Logo";
import { cn } from "@/lib/utils/cn";

export default function AuthLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  // data-theme fijo: las pantallas de auth siempre se ven en void (ninja-dark),
  // sin importar el tema que el usuario tenga guardado. El atributo re-aplica
  // los tokens del tema a todo el subtree (ver globals.css).
  //
  // /signup usa un wizard ancho (tarjeta side-by-side con su propio logo en el
  // ValuePanel): le damos un contenedor amplio y ocultamos el wordmark compartido.
  const pathname = usePathname();
  const isWide = pathname === "/signup";

  return (
    <div
      data-theme="ninja-dark"
      className="ninja-dark-bg relative flex min-h-screen items-center justify-center px-4 py-12 text-ninja-softWhite"
    >
      <div className="ninja-grid pointer-events-none absolute inset-0 opacity-20" />
      <div
        className={cn(
          "relative z-10 w-full",
          isWide ? "max-w-4xl" : "max-w-md",
        )}
      >
        {!isWide && (
          <Link href="/" className="mb-8 flex justify-center">
            <WordmarkPos variant="dark" className="h-16 w-auto sm:h-20" priority />
          </Link>
        )}
        {children}
      </div>
    </div>
  );
}
