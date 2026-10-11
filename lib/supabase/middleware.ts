import { createServerClient, type CookieOptions } from "@supabase/ssr";
import { NextResponse, type NextRequest } from "next/server";
import type { Database } from "@/types/database";
import { IDLE_COOKIE, isIdleExpired } from "@/lib/auth/idle";
import { homePath } from "@/lib/auth/redirect";

type CookieToSet = { name: string; value: string; options: CookieOptions };

const PUBLIC_PATHS = [
  "/",
  "/login",
  "/login-internal",
  "/signup",
  "/recover",
  "/reset-password",
  "/auth/callback",
];

// Refresca la sesión y aplica redirecciones de auth. Ver docs/05-security.md §3.
export async function updateSession(request: NextRequest) {
  let response = NextResponse.next({ request });

  const supabase = createServerClient<Database>(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
    {
      cookies: {
        getAll() {
          return request.cookies.getAll();
        },
        setAll(cookiesToSet: CookieToSet[]) {
          cookiesToSet.forEach(({ name, value }) =>
            request.cookies.set(name, value),
          );
          response = NextResponse.next({ request });
          cookiesToSet.forEach(({ name, value, options }) =>
            response.cookies.set(name, value, options),
          );
        },
      },
    },
  );

  const {
    data: { user },
  } = await supabase.auth.getUser();

  const { pathname } = request.nextUrl;
  // Catálogo público por slug (/c/<slug>) y checkout de cobro del cliente
  // (/pagar/<intent>, H17b): accesibles sin sesión — los abre el CLIENTE
  // final desde su celular.
  const isPublic =
    PUBLIC_PATHS.includes(pathname) ||
    pathname.startsWith("/c/") ||
    pathname.startsWith("/pagar/");

  // Inactividad (8 h): la marca vive en una cookie que escribe el
  // InactivityGuard. Se corta acá, antes de renderizar, para que una sesión
  // vencida nunca muestre el panel ni por un instante.
  const idle = request.cookies.get(IDLE_COOKIE)?.value;
  if (!user && idle) {
    // Sin sesión, una marca vieja no debe cortar el próximo login.
    response.cookies.delete(IDLE_COOKIE);
  }
  if (user && isIdleExpired(idle, Date.now())) {
    await supabase.auth.signOut();
    const target = isPublic
      ? response
      : (() => {
          const url = request.nextUrl.clone();
          url.pathname = pathname.startsWith("/internal") ? "/login-internal" : "/login";
          url.search = "?reason=inactivity";
          const r = NextResponse.redirect(url);
          // signOut limpió las cookies de sesión en `response`: copiarlas.
          response.cookies.getAll().forEach((c) => r.cookies.set(c));
          return r;
        })();
    target.cookies.delete(IDLE_COOKIE);
    return target;
  }

  // Sin sesión en ruta protegida → login.
  if (!user && !isPublic) {
    const url = request.nextUrl.clone();
    // Rutas del panel interno van al login dedicado.
    url.pathname = pathname.startsWith("/internal") ? "/login-internal" : "/login";
    return NextResponse.redirect(url);
  }

  // Con sesión en /login-internal → si es interno va al panel, si no al dashboard.
  if (user && pathname === "/login-internal") {
    const meta = user.app_metadata as { is_internal?: boolean } | null;
    const url = request.nextUrl.clone();
    url.pathname = meta?.is_internal ? "/internal/tenants" : "/dashboard";
    return NextResponse.redirect(url);
  }

  // Con sesión en páginas de auth regulares → dashboard.
  // Excepción: un usuario autenticado SIN tenant (típico del alta vía Google SSO)
  // se queda en /signup para completar el paso "Tu negocio". Detectamos "sin
  // tenant" por ausencia de current_tenant_id en app_metadata (lo setea
  // create_tenant). Así el wizard puede continuar el flujo de SSO.
  if (user && pathname === "/login") {
    const meta = user.app_metadata as { is_internal?: boolean; current_tenant_id?: string } | null;
    const url = request.nextUrl.clone();
    url.search = "";
    // Sólo staff sin negocio va directo al interno; el resto al panel, cuyo
    // layout verifica la membresía real (current_tenant_id puede faltar en
    // usuarios invitados).
    url.pathname =
      meta?.is_internal === true && !meta?.current_tenant_id
        ? homePath({ isInternal: true, hasTenant: false })
        : "/dashboard";
    return NextResponse.redirect(url);
  }
  if (user && pathname === "/signup") {
    const meta = user.app_metadata as { current_tenant_id?: string } | null;
    if (meta?.current_tenant_id) {
      const url = request.nextUrl.clone();
      url.pathname = "/dashboard";
      return NextResponse.redirect(url);
    }
  }

  return response;
}
