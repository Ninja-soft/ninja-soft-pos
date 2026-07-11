---
name: verify
description: Receta de verificación end-to-end de NinjaSoft POS — levantar la app con sesión real (magic link + cookie @supabase/ssr), screenshots por tema con Chrome del sistema, y probes directos a RPCs/Edge Functions de producción.
---

# Verificación de NinjaSoft POS

## Contexto clave

- **La DB de `.env.local` ES la de producción** (proyecto `hrkditzrsavehnhngakb`). No hay staging: verificar = leer prod + escrituras quirúrgicas reversibles (baja lógica).
- `SUPABASE_SERVICE_ROLE_KEY` está en `.env.local`. `SUPABASE_ACCESS_TOKEN` (Management API) suele estar en el ambiente.
- Migraciones: el historial remoto NO coincide con `supabase/migrations/` (se aplican vía Management API `POST /v1/projects/{ref}/database/query`, con aprobación del dueño). **NUNCA `supabase db push`** (aplicaría 200+ archivos).
- Edge Functions: `npx supabase functions deploy <fn> --project-ref hrkditzrsavehnhngakb` (webhooks con `--no-verify-jwt`). El link del CLI necesita `supabase/.temp/project-ref` con el ref.

## Sesión real de un usuario (sin password)

```js
// 1) magic link admin + verify → tokens
const g = await fetch(`${BASE}/auth/v1/admin/generate_link`, {
  method: "POST",
  headers: { apikey: SERVICE, Authorization: `Bearer ${SERVICE}`, "Content-Type": "application/json" },
  body: JSON.stringify({ type: "magiclink", email: "lucasponzoni@gmail.com" }),
});
const { hashed_token } = await g.json();
const v = await fetch(`${BASE}/auth/v1/verify`, {
  method: "POST",
  headers: { apikey: ANON, "Content-Type": "application/json" },
  body: JSON.stringify({ type: "magiclink", token_hash: hashed_token }),
});
const session = await v.json(); // access_token + refresh_token
```

- RPCs/Edge como ese usuario: headers `{ apikey: ANON, Authorization: 'Bearer ' + session.access_token }`.
- Usuario de referencia: `lucasponzoni@gmail.com` = owner de **Punto Express** + staff interno (super_admin). `lucasponzoninovogar@gmail.com` = owner de SushI Point.

## App en el navegador con esa sesión (cookies @supabase/ssr)

La sesión vive en COOKIES (`sb-<ref>-auth-token`), con chunking a 3180 chars:

```js
const json = JSON.stringify({ access_token, refresh_token, expires_in, expires_at, token_type: "bearer", user });
const b64 = "base64-" + Buffer.from(json).toString("base64url");
// si b64.length > 3180 → cookies sb-<ref>-auth-token.0, .1, …
```

Playwright: **no hay browsers de Playwright instalados**; usar Chrome del sistema:

```js
const { chromium } = require("playwright-core"); // npm i playwright-core en el scratchpad
const browser = await chromium.launch({ executablePath: "C:/Program Files/Google/Chrome/Application/chrome.exe", headless: true });
const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 } });
await ctx.addCookies(cookies.map(c => ({ ...c, domain: "localhost", path: "/" })));
```

## Dev server

- `PORT=3005 pnpm dev` (el 8080 suele estar ocupado por el dev del dueño; 3000 es el default de la config). Ready-check: `curl localhost:3005/login` hasta 200.
- **No pipear `pnpm dev | head`** (SIGPIPE lo mata).

## Temas (claro/oscuro)

- El tema del usuario se persiste server-side y PISA `localStorage["ninja-theme"]` al cargar. Para capturar un tema puntual: `document.documentElement.setAttribute("data-theme", "ninja-light" | "ninja-dark" | "ninja-noir" | "ninja-sand")` post-load.
- Emular OS oscuro: `newContext({ colorScheme: "dark" })` — valida el `color-scheme` por tema (selects nativos).

## Flujos útiles ya probados

- Burbuja IA: esperar `button[aria-label="Abrir asistente IA"]` (tarda ~8s en dev).
- Cobros QR/link: crear intent vía Edge (`payway`/`pagos360`/`modo_create_qr`/`mp_point` con `action`), sondear `action: "status"`. Los intents de prueba quedan `pending` y expiran solos (avisar al dueño si ensucian "Cobros QR").
- Checkout propio Payway: página pública `/pagar/{intent}` (whitelist del middleware). `payway_checkout` `info` es público (anon).
- Productos de prueba creados al verificar: **baja lógica** (`deleted_at`), nunca DELETE.

## CI

- Jobs: `quality` (lint+typecheck+tests) y `rls` (suite de aislamiento contra Supabase local en CI; necesita `auto_expose_new_tables = true` en `config.toml` desde CLI 2.106). `rls` corre SOLO en CI (sin Docker local en esta máquina).
- Merge de PRs: squash (`gh pr merge N --squash --delete-branch`) con `quality` + Vercel verdes.
