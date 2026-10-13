import { NextResponse, type NextRequest } from "next/server";
import { updateSession } from "@/lib/supabase/middleware";
import { legacyHostRedirect } from "@/lib/site";
import { webhookTarget } from "@/lib/hooks";

export async function middleware(request: NextRequest) {
  // Webhooks con dominio propio → proxy a la Edge Function (sin sesión).
  const hook = webhookTarget(
    request.headers.get("host"),
    request.nextUrl.pathname,
    request.nextUrl.search,
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
  );
  if (hook === "not_found") return new NextResponse("Not found", { status: 404 });
  if (hook) return NextResponse.rewrite(hook);

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
  // /sw.js (service worker del POS, H65) tampoco: es estático y sin sesión, y
  // el navegador lo revisa en cada navegación.
  matcher: [
    // En el alias de producción pasa TODO (estáticos, /api, prefetch incluidos)
    // para redirigirlo al dominio canónico.
    {
      source: "/:path*",
      has: [{ type: "host", value: "ninja-soft-pos.vercel.app" }],
    },
    // Host de webhooks: pasa todo (POST de proveedores sin headers de browser).
    {
      source: "/:path*",
      has: [{ type: "host", value: "hooks.soft.ninja" }],
    },
    {
      source:
        "/((?!_next/static|_next/image|favicon.ico|sw\\.js$|.*\\.(?:svg|png|jpg|jpeg|gif|webp|ico|woff2?|ttf|otf|txt|xml|webmanifest)$).*)",
      missing: [
        { type: "header", key: "next-router-prefetch" },
        { type: "header", key: "purpose", value: "prefetch" },
      ],
    },
  ],
};
