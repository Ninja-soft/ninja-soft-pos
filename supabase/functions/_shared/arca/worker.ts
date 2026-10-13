// =============================================================================
// Procesamiento de la cola fiscal (ADR-072). Sin dependencias de Supabase ni
// de red: la base (RPC) y ARCA (cliente SOAP) se inyectan, así los tests
// recorren cada caso con fixtures.
//
// Un comprobante:
//   1. Foto de la venta → importes (si no cierran: requiere acción).
//   2. Ticket de acceso (WSAA, cacheado 12 h).
//   3. Recuperación: si quedó un número asignado de un intento incierto, se
//      pregunta a ARCA (FECompUltimoAutorizado + FECompConsultar) si ya tiene
//      CAE antes de volver a mandar (nunca dos facturas por una venta).
//   4. Conciliación de numeración: FECompUltimoAutorizado → número siguiente
//      (se guarda ANTES de mandar).
//   5. FECAESolicitar → aprobado (CAE + QR) | rechazado (observaciones) |
//      reintentar con backoff | requiere acción.
//   Contingencia: si ARCA falla de forma CIERTA antes del CAE (WSAA, último
//   autorizado o error explícito de ARCA, sin un timeout del pedido de CAE en
//   el medio) y el negocio tiene CAEA vigente, se emite al instante con CAEA.
// =============================================================================
import {
  breakdownCloses,
  breakdownFromSale,
  conceptoFor,
  arDate,
  isoToYmd,
  letterOfTipo,
  pickCbteDate,
  scaleBreakdown,
  ymdToIso,
  type Breakdown,
  type TaxLine,
} from "./comprobante.ts";
import { classifyWsfeErrors, joinMsgs, nextAttemptAt } from "./errors.ts";
import { fchHsGen } from "./caea.ts";
import { qrUrl } from "./qr.ts";
import { buildFECAESolicitar, redactXml, type CbteDetalle, type WsfeAuth } from "./wsfe.ts";
import type { WsfeClient } from "./client.ts";
import type { ArcaEnv } from "./config.ts";

// ---------------------------------------------------------------------------
// Foto (arca_snapshot)
// ---------------------------------------------------------------------------
export interface SnapshotDoc {
  id: string;
  tenant_id: string;
  sale_id: string;
  origin: "sale" | "return" | "void";
  environment: ArcaEnv;
  cbte_letter: string | null;
  cbte_tipo: number | null;
  pto_vta: number | null;
  cbte_nro: number | null;
  cbte_fch: string | null;
  imp_total: number | string | null;
  doc_tipo: number | null;
  doc_nro: string | null;
  status: string;
  attempts: number;
  emission_type?: "CAE" | "CAEA";
  inform_attempts?: number;
  cae?: string | null;
  approved_at?: string | null;
}

export interface Receptor {
  iva_condition?: string | null;
  arca_condition_id?: number | null;
  arca_doc_type?: number | null;
  doc_number?: string | null;
  name?: string | null;
}

export interface Snapshot {
  document: SnapshotDoc;
  sale: {
    id: string;
    created_at: string;
    total: number | string;
    net_taxed?: number | string | null;
    iva_total?: number | string | null;
    cbte_letter?: string | null;
    receptor?: Receptor | null;
  };
  tax_lines: TaxLine[];
  has_services: boolean;
  has_goods: boolean;
  return_total: number | string | null;
  credited_total: number | string | null;
  assoc: { cbte_tipo: number; pto_vta: number; cbte_nro: number; cbte_fch: string | null; imp_total: number | string | null } | null;
  emitter: { cuit: string | null; iva_condition: string | null };
  last_fch: string | null;
  settings: {
    max_attempts?: number;
    auth_mode?: string;
    caea_enabled?: boolean;
    caea_pto_vta?: number | null;
    caea_timeout_seconds?: number;
  } | null;
}

export interface Plan {
  concepto: 1 | 2 | 3;
  docTipo: number;
  docNro: string;
  condIva: number;
  breakdown: Breakdown;
  saleYmd: string;
}

/** Importes y receptor del comprobante, o el código de lo que falta. */
export function planDocument(s: Snapshot): { ok: true; plan: Plan } | { ok: false; code: string } {
  const doc = s.document;
  const letter = letterOfTipo(doc.cbte_tipo ?? 0);
  if (!letter || doc.pto_vta == null) return { ok: false, code: "sin_punto_de_venta" };
  if (letter === "E") return { ok: false, code: "exportacion_no_soportada" };
  const full = breakdownFromSale(letter, s.sale, s.tax_lines ?? []);
  let b = full;
  if (doc.origin === "return") {
    b = scaleBreakdown(full, Number(s.return_total ?? doc.imp_total ?? 0));
  } else if (doc.origin === "void") {
    const left = Math.round((Number(s.sale.total) - Number(s.credited_total ?? 0)) * 100) / 100;
    if (left <= 0) return { ok: false, code: "nada_para_acreditar" };
    b = scaleBreakdown(full, left);
  }
  if (b.ImpTotal <= 0) return { ok: false, code: "nada_para_acreditar" };
  if (!breakdownCloses(b)) return { ok: false, code: "importes_no_cierran" };
  const r = s.sale.receptor ?? {};
  const docTipo = Number(r.arca_doc_type ?? 99) || 99;
  const docNro = docTipo === 99 ? "0" : String(r.doc_number ?? "0").replace(/\D/g, "") || "0";
  if ((letter === "A" || letter === "M") && docTipo !== 80) return { ok: false, code: "receptor_sin_cuit" };
  return {
    ok: true,
    plan: {
      concepto: conceptoFor(s.has_goods || !s.has_services, s.has_services),
      docTipo,
      docNro,
      condIva: Number(r.arca_condition_id ?? 5) || 5,
      breakdown: b,
      saleYmd: arDate(s.sale.created_at),
    },
  };
}

export function detalleFor(s: Snapshot, p: Plan, nro: number, fch: string, cuitEmisor: string | null): CbteDetalle {
  const serv = p.concepto !== 1;
  return {
    ...p.breakdown,
    Concepto: p.concepto,
    DocTipo: p.docTipo,
    DocNro: p.docNro,
    CbteDesde: nro,
    CbteHasta: nro,
    CbteFch: fch,
    FchServDesde: serv ? fch : null,
    FchServHasta: serv ? fch : null,
    FchVtoPago: serv ? fch : null,
    MonId: "PES",
    MonCotiz: 1,
    CondicionIVAReceptorId: p.condIva,
    CbtesAsoc: s.assoc
      ? [{
          Tipo: s.assoc.cbte_tipo,
          PtoVta: s.assoc.pto_vta,
          Nro: s.assoc.cbte_nro,
          Cuit: cuitEmisor,
          CbteFch: isoToYmd(s.assoc.cbte_fch),
        }]
      : undefined,
  };
}

// ---------------------------------------------------------------------------
// Dependencias
// ---------------------------------------------------------------------------
export type AuthOutcome =
  | { ok: true; auth: WsfeAuth }
  | { ok: false; kind: "transient" | "action"; code: string; message: string };

export interface CaeaIssued {
  caea: string;
  caea_id: string;
  pto_vta: number;
  cbte_nro: number;
  cbte_fch: string; // AAAA-MM-DD
  fch_vig_hasta: string;
}

export interface WorkerDb {
  snapshot(id: string): Promise<Snapshot | null>;
  markSending(id: string, p: Record<string, unknown>): Promise<void>;
  applyResult(id: string, p: Record<string, unknown>): Promise<void>;
  caeaIssue(id: string, p: Record<string, unknown>): Promise<CaeaIssued | null>;
  setQr(id: string, url: string): Promise<void>;
  informResult(id: string, p: Record<string, unknown>): Promise<void>;
}

export interface WorkerDeps {
  now(): Date;
  db: WorkerDb;
  auth(env: ArcaEnv): Promise<AuthOutcome>;
  wsfe(env: ArcaEnv, opts?: { queryTimeoutMs?: number }): WsfeClient;
  /** CUIT que factura en ese ambiente (para el QR cuando ARCA no responde). */
  cuitFor(env: ArcaEnv, snap: Snapshot): string | null;
}

export type DocOutcome =
  | "aprobado"
  | "recuperado"
  | "caea"
  | "rechazado"
  | "reintentar"
  | "requiere_accion"
  | "missing";

// ---------------------------------------------------------------------------
// Un comprobante
// ---------------------------------------------------------------------------
export async function processDocument(deps: WorkerDeps, id: string, recovering = false): Promise<{ outcome: DocOutcome; detail?: string }> {
  const snap = await deps.db.snapshot(id);
  if (!snap) return { outcome: "missing" };
  const doc = snap.document;
  const env = doc.environment;
  const now = deps.now();
  const set = snap.settings ?? {};
  const pv = doc.pto_vta as number;
  const tipo = doc.cbte_tipo as number;
  const uncertain = recovering || doc.cbte_nro != null;

  const result = async (outcome: "reintentar" | "requiere_accion" | "rechazado", code: string, msg: string, extra: Record<string, unknown> = {}) => {
    await deps.db.applyResult(id, {
      outcome,
      error_code: code,
      error_msg: msg,
      next_attempt_at: outcome === "reintentar" ? nextAttemptAt(doc.attempts, now).toISOString() : undefined,
      ...extra,
    });
    return { outcome, detail: code } as { outcome: DocOutcome; detail: string };
  };

  const planned = planDocument(snap);
  if (!planned.ok) return await result("requiere_accion", planned.code, planned.code, { keep_number: uncertain });
  const plan = planned.plan;

  const approve = async (
    a: { nro: number; fch: string; cae: string; caeVto: string; cuit: string },
    extra: Record<string, unknown>,
    outcome: DocOutcome,
  ) => {
    const url = qrUrl({
      fecha: a.fch,
      cuit: a.cuit,
      ptoVta: pv,
      tipoCmp: tipo,
      nroCmp: a.nro,
      importe: plan.breakdown.ImpTotal,
      tipoDocRec: plan.docTipo,
      nroDocRec: plan.docNro,
      tipoCodAut: "E",
      codAut: a.cae,
    });
    await deps.db.applyResult(id, {
      outcome: "aprobado",
      cbte_nro: a.nro,
      cbte_fch: ymdToIso(a.fch),
      cae: a.cae,
      cae_vto: ymdToIso(a.caeVto),
      qr_url: url,
      ...extra,
    });
    return { outcome };
  };

  // Contingencia: sólo si el CAE seguro no salió.
  const tryCaea = async (code: string, msg: string, cuit: string | null): Promise<boolean> => {
    if (uncertain || !set.caea_enabled) return false;
    const issued = await deps.db.caeaIssue(id, {
      concepto: plan.concepto,
      doc_tipo: plan.docTipo,
      doc_nro: plan.docNro,
      imp_total: plan.breakdown.ImpTotal,
      error_code: code,
      error_msg: msg,
    });
    if (!issued) return false;
    const c = cuit ?? deps.cuitFor(env, snap);
    if (c) {
      await deps.db.setQr(
        id,
        qrUrl({
          fecha: issued.cbte_fch,
          cuit: c,
          ptoVta: issued.pto_vta,
          tipoCmp: tipo,
          nroCmp: issued.cbte_nro,
          importe: plan.breakdown.ImpTotal,
          tipoDocRec: plan.docTipo,
          nroDocRec: plan.docNro,
          tipoCodAut: "A",
          codAut: issued.caea,
        }),
      );
    }
    return true;
  };

  // 2. Acceso
  const a = await deps.auth(env);
  if (!a.ok) {
    if (a.kind === "transient") {
      if (await tryCaea(a.code, a.message, null)) return { outcome: "caea", detail: a.code };
      return await result("reintentar", a.code, a.message, { keep_number: uncertain });
    }
    return await result("requiere_accion", a.code, a.message, { keep_number: uncertain });
  }
  const auth = a.auth;
  const ws = deps.wsfe(env, set.caea_enabled ? { queryTimeoutMs: (set.caea_timeout_seconds ?? 10) * 1000 } : undefined);

  // 3. Recuperación de un intento incierto
  if (doc.cbte_nro != null) {
    const u = await ws.ultimo(auth, pv, tipo);
    if (u.transport || !u.parsed) {
      return await result("reintentar", "sin_respuesta", `ARCA no respondió (${u.error ?? "sin datos"})`, { keep_number: true });
    }
    const uk = classifyWsfeErrors(u.parsed.errors);
    if (uk === "transient") return await result("reintentar", u.parsed.errors[0]?.code ?? "500", joinMsgs(u.parsed.errors), { keep_number: true });
    if (uk === "action") return await result("requiere_accion", u.parsed.errors[0]?.code ?? "600", joinMsgs(u.parsed.errors), { keep_number: true });
    if ((u.parsed.nro ?? 0) >= doc.cbte_nro) {
      const c = await ws.consultar(auth, pv, tipo, doc.cbte_nro);
      if (c.transport || !c.parsed) {
        return await result("reintentar", "sin_respuesta", "ARCA no respondió la consulta del comprobante", { keep_number: true });
      }
      const sameTotal = Math.abs(Number(c.parsed.impTotal ?? -1) - plan.breakdown.ImpTotal) < 0.005;
      const sameDoc = String(c.parsed.docNro ?? "").replace(/\D/g, "") === plan.docNro.replace(/\D/g, "") || plan.docTipo === 99;
      if (c.parsed.found && c.parsed.cae && c.parsed.resultado === "A" && sameTotal && sameDoc) {
        return await approve(
          { nro: doc.cbte_nro, fch: c.parsed.cbteFch ?? isoToYmd(doc.cbte_fch) ?? arDate(now), cae: c.parsed.cae, caeVto: c.parsed.caeVto ?? "", cuit: auth.cuit },
          { action: "FECompConsultar", response_xml: c.responseXml },
          "recuperado",
        );
      }
      // El número lo usó otro comprobante: se pide uno nuevo.
    }
  }

  // 4. Último autorizado
  const u = await ws.ultimo(auth, pv, tipo);
  if (u.transport || !u.parsed) {
    if (!uncertain && (await tryCaea("sin_respuesta", `ARCA no respondió (${u.error ?? "sin datos"})`, auth.cuit))) {
      return { outcome: "caea", detail: "sin_respuesta" };
    }
    return await result("reintentar", "sin_respuesta", `ARCA no respondió (${u.error ?? "sin datos"})`);
  }
  const uk = classifyWsfeErrors(u.parsed.errors);
  if (uk === "transient") {
    const code = u.parsed.errors[0]?.code ?? "500";
    if (await tryCaea(code, joinMsgs(u.parsed.errors), auth.cuit)) return { outcome: "caea", detail: code };
    return await result("reintentar", code, joinMsgs(u.parsed.errors));
  }
  if (uk) return await result("requiere_accion", u.parsed.errors[0]?.code ?? "600", joinMsgs(u.parsed.errors));
  const nro = (u.parsed.nro ?? 0) + 1;
  const fch = pickCbteDate(plan.saleYmd, arDate(now), isoToYmd(snap.last_fch), plan.concepto);
  const det = detalleFor(snap, plan, nro, fch, auth.cuit);

  // 5. Pedido de CAE (número guardado antes)
  const requestPreview = redactXml(buildFECAESolicitar(auth, pv, tipo, det));
  await deps.db.markSending(id, {
    cbte_nro: nro,
    cbte_fch: ymdToIso(fch),
    concepto: plan.concepto,
    doc_tipo: plan.docTipo,
    doc_nro: plan.docNro,
    imp_total: plan.breakdown.ImpTotal,
    request_xml: requestPreview,
  });
  const r = await ws.solicitar(auth, pv, tipo, det);
  const io = { request_xml: r.requestXml, response_xml: r.responseXml, duration_ms: r.ms };
  if (r.transport || !r.parsed) {
    // Incierto: el pedido salió. Se guarda el número y se recupera después.
    return await result("reintentar", "sin_respuesta", `ARCA no respondió el pedido de CAE (${r.error ?? "sin datos"})`, {
      keep_number: true,
      ...io,
    });
  }
  const p = r.parsed;
  const extra = { observations: p.observaciones, events: p.events, ...io };
  if (p.resultado === "A" && p.cae) {
    return await approve({ nro, fch: p.cbteFch ?? fch, cae: p.cae, caeVto: p.caeVto ?? "", cuit: auth.cuit }, extra, "aprobado");
  }
  const kind = classifyWsfeErrors(p.errors);
  if (kind === "numbering") {
    return await result("reintentar", "10016", joinMsgs(p.errors), {
      ...extra,
      next_attempt_at: new Date(now.getTime() + 10_000).toISOString(),
    });
  }
  if (kind === "transient") {
    const code = p.errors[0]?.code ?? "500";
    // ARCA respondió con un error explícito: el CAE no salió (cierto).
    if (await tryCaea(code, joinMsgs(p.errors), auth.cuit)) return { outcome: "caea", detail: code };
    return await result("reintentar", code, joinMsgs(p.errors), extra);
  }
  if (kind === "action") return await result("requiere_accion", p.errors[0]?.code ?? "600", joinMsgs(p.errors), extra);
  if (p.resultado === "R" || kind === "rejected") {
    const list = [...p.errors, ...p.observaciones];
    return await result("rechazado", list[0]?.code ?? "rechazado", joinMsgs(list), extra);
  }
  return await result("reintentar", "respuesta_incompleta", "ARCA respondió sin resultado", { keep_number: true, ...extra });
}

// ---------------------------------------------------------------------------
// Informe de un comprobante emitido con CAEA
// ---------------------------------------------------------------------------
export async function informCaeaDocument(deps: WorkerDeps, id: string): Promise<{ outcome: "informado" | "rechazado" | "reintentar" | "missing" }> {
  const snap = await deps.db.snapshot(id);
  if (!snap || snap.document.emission_type !== "CAEA" || !snap.document.cae || !snap.document.cbte_nro) {
    return { outcome: "missing" };
  }
  const doc = snap.document;
  const nroCaea = doc.cbte_nro as number;
  const caea = doc.cae as string;
  const now = deps.now();
  const retry = async (code: string, msg: string, extra: Record<string, unknown> = {}) => {
    await deps.db.informResult(id, {
      outcome: "reintentar",
      error_code: code,
      error_msg: msg,
      next_attempt_at: nextAttemptAt((doc.inform_attempts ?? 0) + 1, now).toISOString(),
      ...extra,
    });
    return { outcome: "reintentar" as const };
  };
  const planned = planDocument(snap);
  if (!planned.ok) {
    await deps.db.informResult(id, { outcome: "rechazado", error_code: planned.code, error_msg: planned.code });
    return { outcome: "rechazado" };
  }
  const a = await deps.auth(doc.environment);
  if (!a.ok) return await retry(a.code, a.message);
  const fch = isoToYmd(doc.cbte_fch) ?? arDate(now);
  const det: CbteDetalle = {
    ...detalleFor(snap, planned.plan, nroCaea, fch, a.auth.cuit),
    CAEA: caea,
    CbteFchHsGen: fchHsGen(new Date(doc.approved_at ?? now.toISOString())),
  };
  const ws = deps.wsfe(doc.environment);
  const r = await ws.caeaInformar(a.auth, doc.pto_vta as number, doc.cbte_tipo as number, det);
  const io = { request_xml: r.requestXml, response_xml: r.responseXml, duration_ms: r.ms };
  if (r.transport || !r.parsed) return await retry("sin_respuesta", `ARCA no respondió (${r.error ?? "sin datos"})`, io);
  const p = r.parsed;
  if (p.resultado === "A") {
    await deps.db.informResult(id, { outcome: "informado", observations: p.observaciones, ...io });
    return { outcome: "informado" };
  }
  const kind = classifyWsfeErrors(p.errors);
  if (kind === "transient" || kind === "action") return await retry(p.errors[0]?.code ?? "500", joinMsgs(p.errors), io);
  const list = [...p.errors, ...p.observaciones];
  await deps.db.informResult(id, {
    outcome: "rechazado",
    error_code: list[0]?.code ?? "rechazado",
    error_msg: joinMsgs(list),
    observations: p.observaciones,
    ...io,
  });
  return { outcome: "rechazado" };
}

/** Tipos de comprobante que puede emitir un negocio según su condición. */
export function tiposForEmitter(cond: string | null | undefined): number[] {
  return !cond || cond === "responsable_inscripto" ? [1, 3, 6, 8] : [11, 13];
}
