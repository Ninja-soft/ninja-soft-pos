import { type NextRequest } from "next/server";
import { updateSession } from "@/lib/supabase/middleware";

export async function middleware(request: NextRequest) {
  return updateSession(request);
}

export const config = {
  // Excluye estáticos, imágenes, fuentes y favicon, y los prefetch del router
  // (<Link> prefetchea cada ítem del menú al entrar en pantalla: sin esto cada
  // uno costaba un getUser contra Supabase Auth). La navegación real sí pasa
  // por acá, y el layout del panel vuelve a validar la sesión igual.
  matcher: [
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
