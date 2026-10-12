#!/usr/bin/env node
// Genera una sesión real del usuario QA para el suite E2E (tests/e2e).
//
// Lee del ambiente (nunca los imprime):
//   SUPABASE_URL (o NEXT_PUBLIC_SUPABASE_URL)
//   SUPABASE_SERVICE_ROLE_KEY
//   SUPABASE_ANON_KEY (o NEXT_PUBLIC_SUPABASE_ANON_KEY; opcional, para el verify)
//   E2E_EMAIL  → email del usuario owner del tenant QA
//
// Hace magic link admin (generate_link) + verify y escribe los tokens en un
// archivo del directorio temporal del SO. Por stdout sólo sale la ruta.
//
//   node --env-file=.env.local scripts/e2e-session.mjs
//   . $env:TEMP\ninjapos-e2e-session.ps1     (PowerShell)
//   source "$TMPDIR/ninjapos-e2e-session.env" (bash)

import { writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

function fail(msg) {
  console.error(`[e2e-session] ${msg}`);
  process.exit(1);
}

const url = (process.env.SUPABASE_URL ?? process.env.NEXT_PUBLIC_SUPABASE_URL ?? "").replace(/\/$/, "");
const service = process.env.SUPABASE_SERVICE_ROLE_KEY ?? "";
const anon = process.env.SUPABASE_ANON_KEY ?? process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ?? service;
const email = process.env.E2E_EMAIL ?? "";

if (!url) fail("falta SUPABASE_URL");
if (!service) fail("falta SUPABASE_SERVICE_ROLE_KEY");
if (!email) fail("falta E2E_EMAIL (owner del tenant QA)");

// Ref del proyecto: subdominio de *.supabase.co. Para Supabase local
// (127.0.0.1:54321) @supabase/ssr usa el primer label del host.
const host = new URL(url).hostname;
const ref = process.env.E2E_SUPABASE_REF ?? host.split(".")[0];

const gen = await fetch(`${url}/auth/v1/admin/generate_link`, {
  method: "POST",
  headers: {
    apikey: service,
    Authorization: `Bearer ${service}`,
    "Content-Type": "application/json",
  },
  body: JSON.stringify({ type: "magiclink", email }),
});
if (!gen.ok) fail(`generate_link falló (HTTP ${gen.status})`);
const { hashed_token: tokenHash } = await gen.json();
if (!tokenHash) fail("generate_link no devolvió hashed_token");

const ver = await fetch(`${url}/auth/v1/verify`, {
  method: "POST",
  headers: { apikey: anon, "Content-Type": "application/json" },
  body: JSON.stringify({ type: "magiclink", token_hash: tokenHash }),
});
if (!ver.ok) fail(`verify falló (HTTP ${ver.status})`);
const session = await ver.json();
if (!session.access_token || !session.refresh_token) fail("verify no devolvió tokens");

const tenant = session.user?.app_metadata?.current_tenant_id ?? "";

const vars = {
  E2E_ACCESS_TOKEN: session.access_token,
  E2E_REFRESH_TOKEN: session.refresh_token,
  E2E_SUPABASE_REF: ref,
  E2E_QA_TENANT_ID: process.env.E2E_QA_TENANT_ID ?? tenant,
};

const sh = Object.entries(vars)
  .map(([k, v]) => `export ${k}='${v}'`)
  .join("\n");
const ps = Object.entries(vars)
  .map(([k, v]) => `$env:${k} = '${v}'`)
  .join("\r\n");

const shPath = path.join(tmpdir(), "ninjapos-e2e-session.env");
const psPath = path.join(tmpdir(), "ninjapos-e2e-session.ps1");
writeFileSync(shPath, sh + "\n", { mode: 0o600 });
writeFileSync(psPath, ps + "\r\n", { mode: 0o600 });

console.log(`[e2e-session] sesión escrita (vence en ${Math.round((session.expires_in ?? 3600) / 60)} min):`);
console.log(`  bash:       ${shPath}`);
console.log(`  PowerShell: ${psPath}`);
if (!tenant) console.log("  aviso: el usuario no tiene current_tenant_id; seteá E2E_QA_TENANT_ID a mano.");
