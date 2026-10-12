import path from "node:path";

// Configuración del suite E2E leída del ambiente. Nada de esto se imprime.

export const BASE_URL = process.env.BASE_URL ?? "http://localhost:3005";

export const ACCESS_TOKEN = process.env.E2E_ACCESS_TOKEN ?? "";
export const REFRESH_TOKEN = process.env.E2E_REFRESH_TOKEN ?? "";
export const SUPABASE_REF = process.env.E2E_SUPABASE_REF ?? "";
export const QA_TENANT_ID = process.env.E2E_QA_TENANT_ID ?? "";

/** Hay sesión inyectable → corren los specs autenticados. Si no, modo smoke. */
export const HAS_SESSION = Boolean(ACCESS_TOKEN && REFRESH_TOKEN && SUPABASE_REF);

export const SMOKE_SKIP_REASON =
  "Modo smoke: faltan E2E_ACCESS_TOKEN / E2E_REFRESH_TOKEN / E2E_SUPABASE_REF";

/** Permite gastar cuota del asistente IA (mandar mensajes). */
export const AI_ENABLED = process.env.E2E_AI === "1";

/** Id único de la corrida (lo fija playwright.config.ts). */
export const RUN_ID = process.env.E2E_RUN_ID ?? String(Date.now());

/** Prefijo para todo dato creado por el suite: permite limpiarlo después. */
export const RUN_PREFIX = `E2E-${RUN_ID}`;

export const AUTH_STATE_PATH = path.resolve("test-results/.e2e-auth/state.json");
export const SCREENSHOT_DIR = path.resolve("test-results/screenshots");
