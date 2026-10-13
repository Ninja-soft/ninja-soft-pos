#!/usr/bin/env node
// =============================================================================
// Smoke test de ARCA en HOMOLOGACIÓN (ADR-072). Nunca toca producción: los
// endpoints están fijos a wsaahomo / wswhomo.
//
// Uso (Node 22.18+ o 23.6+, que ejecutan TypeScript sin compilar):
//   $env:ARCA_CERT_PATH="C:\Users\<vos>\.ninja-arca\homo\ninjapos-homo.crt"
//   $env:ARCA_KEY_PATH="C:\Users\<vos>\.ninja-arca\homo\ninjapos-homo.key"
//   $env:ARCA_CUIT="20378923450"          # CUIT del certificado (representada)
//   node scripts/arca-homo-smoke.mjs
//
// Pasos: WSAA loginCms (o el ticket guardado) → FEDummy →
// FECompUltimoAutorizado (pto vta 1, Factura B) → FECAESolicitar de una
// Factura B a consumidor final por $121 (100 + IVA 21 %) → FECompConsultar
// del número emitido.
//
// El ticket de acceso (TA) se guarda junto a la clave (ta-wsfe.json, fuera
// del repo): ARCA no entrega otro mientras el anterior siga vigente (12 h).
// Si responde coe.alreadyAuthenticated y no hay ticket guardado, hay que
// esperar a que venza. Variables opcionales: ARCA_PTO_VTA (1), ARCA_TA_PATH,
// ARCA_SMOKE_ONLY=dummy (sólo FEDummy, sin certificado).
// No imprime la clave, ni el token, ni el sign.
// =============================================================================
import fs from "node:fs";
import path from "node:path";
import { buildTra, ticketUsable } from "../supabase/functions/_shared/arca/wsaa.ts";
import { parseCertificate, signCms, keyMatchesCert } from "../supabase/functions/_shared/arca/pki.ts";
import { createWsfeClient, loginCms } from "../supabase/functions/_shared/arca/client.ts";
import { DEFAULT_ENDPOINTS } from "../supabase/functions/_shared/arca/config.ts";
import { breakdownFromSale, arDate } from "../supabase/functions/_shared/arca/comprobante.ts";
import { joinMsgs, humanError } from "../supabase/functions/_shared/arca/errors.ts";
import { qrUrl } from "../supabase/functions/_shared/arca/qr.ts";

const EP = DEFAULT_ENDPOINTS.homologacion;
const fetcher = (url, init) => fetch(url, init);
const ws = createWsfeClient({ fetch: fetcher, endpoints: EP, queryTimeoutMs: 20_000, emitTimeoutMs: 40_000 });
const ok = (m) => console.log(`  OK   ${m}`);
const bad = (m) => console.log(`  FAIL ${m}`);

console.log(`ARCA homologación · ${EP.wsfe}`);

const d = await ws.dummy();
if (d.transport || !d.parsed) {
  bad(`FEDummy sin respuesta (${d.error})`);
  process.exit(1);
}
(d.parsed.ok ? ok : bad)(`FEDummy App=${d.parsed.app} Db=${d.parsed.db} Auth=${d.parsed.auth} (${d.ms} ms)`);
if (process.env.ARCA_SMOKE_ONLY === "dummy") process.exit(d.parsed.ok ? 0 : 1);

const certPath = process.env.ARCA_CERT_PATH;
const keyPath = process.env.ARCA_KEY_PATH;
if (!certPath || !keyPath) {
  bad("Faltan ARCA_CERT_PATH y ARCA_KEY_PATH");
  process.exit(1);
}
const certPem = fs.readFileSync(certPath, "utf8");
const keyPem = fs.readFileSync(keyPath, "utf8");
const info = parseCertificate(certPem);
const cuit = (process.env.ARCA_CUIT ?? info.cuit ?? "").replace(/\D/g, "");
ok(`Certificado: CUIT ${info.cuit} · emisor ${info.issuerCn} · vence ${info.notAfter.slice(0, 10)}`);
if (info.issuerCn !== "Computadores Test") bad("El emisor no es el de homologación (Computadores Test)");
if (!keyMatchesCert(certPem, keyPem)) {
  bad("La clave no corresponde al certificado");
  process.exit(1);
}

// --- WSAA ------------------------------------------------------------------------
const taPath = process.env.ARCA_TA_PATH ?? path.join(path.dirname(keyPath), "ta-wsfe.json");
let ta = null;
try {
  ta = JSON.parse(fs.readFileSync(taPath, "utf8"));
} catch {
  ta = null;
}
if (ta && ticketUsable(ta.expirationTime)) {
  ok(`WSAA: ticket guardado, vence ${ta.expirationTime}`);
} else {
  const cms = signCms(buildTra("wsfe"), certPem, keyPem);
  const r = await loginCms(fetcher, EP.wsaa, cms, 30_000);
  if (r.transport || !r.result) {
    bad(`WSAA sin respuesta (${r.error})`);
    process.exit(1);
  }
  if (!r.result.ok) {
    const h = humanError(r.result.code, r.result.message);
    bad(`WSAA ${r.result.code}: ${r.result.message}`);
    console.log(`       ${h.title}. ${h.action}`);
    process.exit(1);
  }
  ta = r.result.ticket;
  fs.writeFileSync(taPath, JSON.stringify(ta), { mode: 0o600 });
  ok(`WSAA: ticket nuevo, vence ${ta.expirationTime} (guardado en ${taPath})`);
}
const auth = { token: ta.token, sign: ta.sign, cuit };

// --- Último autorizado ------------------------------------------------------------
const pv = Number(process.env.ARCA_PTO_VTA ?? 1);
const tipo = 6;
const u = await ws.ultimo(auth, pv, tipo);
if (u.transport || !u.parsed) {
  bad(`FECompUltimoAutorizado sin respuesta (${u.error})`);
  process.exit(1);
}
if (u.parsed.errors.length) {
  bad(`FECompUltimoAutorizado: ${joinMsgs(u.parsed.errors)}`);
  process.exit(1);
}
const nro = (u.parsed.nro ?? 0) + 1;
ok(`FECompUltimoAutorizado pto vta ${pv} Factura B: ${u.parsed.nro} → se pide el ${nro}`);

// --- FECAESolicitar -----------------------------------------------------------------
const fch = arDate(new Date());
const b = breakdownFromSale("B", { total: 121 }, [
  { kind: "iva", tax: "iva", rate_code: "21", rate: 21, base: 100, amount: 21, arca_id: 5 },
]);
const det = {
  ...b,
  Concepto: 1,
  DocTipo: 99,
  DocNro: "0",
  CbteDesde: nro,
  CbteHasta: nro,
  CbteFch: fch,
  MonId: "PES",
  MonCotiz: 1,
  CondicionIVAReceptorId: 5,
};
const s = await ws.solicitar(auth, pv, tipo, det);
if (s.transport || !s.parsed) {
  bad(`FECAESolicitar sin respuesta (${s.error}): consultá con FECompUltimoAutorizado antes de reintentar`);
  process.exit(1);
}
const p = s.parsed;
if (p.resultado === "A" && p.cae) {
  ok(`FECAESolicitar: APROBADO · CAE ${p.cae} · vence ${p.caeVto} (${s.ms} ms)`);
  if (p.observaciones.length) console.log(`       Observaciones: ${joinMsgs(p.observaciones)}`);
  console.log(`       QR: ${qrUrl({ fecha: fch, cuit, ptoVta: pv, tipoCmp: tipo, nroCmp: nro, importe: 121, tipoCodAut: "E", codAut: p.cae })}`);
} else {
  bad(`FECAESolicitar: ${p.resultado ?? "sin resultado"} · ${joinMsgs([...p.errors, ...p.observaciones])}`);
  process.exit(1);
}

// --- FECompConsultar -------------------------------------------------------------------
const c = await ws.consultar(auth, pv, tipo, nro);
if (!c.transport && c.parsed?.found) ok(`FECompConsultar ${nro}: ${c.parsed.resultado} · CAE ${c.parsed.cae} · total ${c.parsed.impTotal}`);
else bad("FECompConsultar no devolvió el comprobante");
console.log("Listo.");
