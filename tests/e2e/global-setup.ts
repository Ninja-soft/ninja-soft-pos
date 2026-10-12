import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import {
  ACCESS_TOKEN,
  AUTH_STATE_PATH,
  BASE_URL,
  HAS_SESSION,
  QA_TENANT_ID,
  REFRESH_TOKEN,
  RUN_PREFIX,
  SUPABASE_REF,
} from "./support/env";
import { buildSessionCookies, decodeJwt } from "./support/session";

// Escribe el storageState con las cookies de sesión del usuario QA.
// Sin tokens deja un estado vacío (modo smoke).
export default async function globalSetup() {
  mkdirSync(path.dirname(AUTH_STATE_PATH), { recursive: true });

  if (!HAS_SESSION) {
    writeFileSync(AUTH_STATE_PATH, JSON.stringify({ cookies: [], origins: [] }));
    console.log(`[e2e] modo smoke (sin sesión). run=${RUN_PREFIX}`);
    return;
  }

  const claims = decodeJwt(ACCESS_TOKEN);
  const secondsLeft = claims.exp - Math.floor(Date.now() / 1000);
  // Un access token vencido se refresca con el refresh token (las cookies
  // rotadas se persisten entre tests, ver support/fixtures.ts).
  if (secondsLeft < 5 * 60) {
    console.log("[e2e] aviso: el access token vence pronto; se usará el refresh token.");
  }

  // Guardarraíl: los flujos crean y anulan datos. Sólo contra el tenant QA.
  const tenant = (claims.app_metadata as { current_tenant_id?: string } | undefined)
    ?.current_tenant_id;
  if (!QA_TENANT_ID) {
    throw new Error("[e2e] falta E2E_QA_TENANT_ID (id del tenant QA dedicado)");
  }
  if (tenant !== QA_TENANT_ID) {
    throw new Error("[e2e] la sesión no pertenece al tenant QA (E2E_QA_TENANT_ID): abortado");
  }

  const host = new URL(BASE_URL).hostname;
  const secure = BASE_URL.startsWith("https://");
  const cookies = buildSessionCookies(SUPABASE_REF, ACCESS_TOKEN, REFRESH_TOKEN).map((c) => ({
    ...c,
    domain: host,
    path: "/",
    expires: claims.exp + 7 * 24 * 3600,
    httpOnly: false,
    secure,
    sameSite: "Lax" as const,
  }));

  writeFileSync(AUTH_STATE_PATH, JSON.stringify({ cookies, origins: [] }));
  console.log(`[e2e] sesión inyectada (${cookies.length} cookie/s). run=${RUN_PREFIX}`);
}
