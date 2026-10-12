import { NextResponse, type NextRequest } from "next/server";
import { updateSession } from "@/lib/supabase/middleware";
import { legacyHostRedirect } from "@/lib/site";

export async function middleware(request: NextRequest) {
  // Alias de producción de Vercel → dominio canónico (los previews no).
  const target = legacyHostRedirect(
    request.headers.get("host"),
    request.nextUrl.pathname + request.nextUrl.search,
  );
  if (target) return NextResponse.redirect(target, 308);
  return updateSession(request);
}

export const config = {
  // Excluye estáticos, imágenes, fuentes y favicon, y los prefetch del router
  // (<Link> prefetchea cada ítem del menú al entrar en pantalla: sin esto cada
  // uno costaba un getUser contra Supabase Auth). La navegación real sí pasa
  // por acá, y el layout del panel vuelve a validar la sesión igual.
  matcher: [
    // En el alias de producción pasa TODO (estáticos, /api, prefetch incluidos)
    // para redirigirlo al dominio canónico.
    {
      source: "/:path*",
      has: [{ type: "host", value: "ninja-soft-pos.vercel.app" }],
    },
    {
      source:
        "/((?!_next/static|_next/image|favicon.ico|.*\\.(?:svg|png|jpg|jpeg|gif|webp|ico|woff2?|ttf|otf|txt|xml|webmanifest)$).*)",
      missing: [
        { type: "header", key: "next-router-prefetch" },
        { type: "header", key: "purpose", value: "prefetch" },
      ],
    },
  ],
};
