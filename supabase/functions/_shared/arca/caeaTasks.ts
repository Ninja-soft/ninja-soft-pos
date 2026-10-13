// =============================================================================
// Tareas periódicas de la contingencia CAEA (ADR-072): pedir el CAEA de la
// quincena (o consultarlo si ya se había pedido), sincronizar la numeración
// del punto de venta CAEA, informar los comprobantes emitidos en contingencia
// y declarar "sin movimiento" las quincenas sin uso. Base y ARCA inyectados.
// =============================================================================
import type { ArcaEnv } from "./config.ts";
import { ymdToIso } from "./comprobante.ts";
import { joinMsgs } from "./errors.ts";
import { informCaeaDocument, tiposForEmitter, type WorkerDeps } from "./worker.ts";

export interface CaeaTasks {
  environment: ArcaEnv;
  pto_vta: number;
  request: { periodo: number; orden: number }[];
  inform: string[];
  sin_movimiento: { id: string; caea: string; environment: ArcaEnv }[];
}

export interface CaeaDb {
  tasks(): Promise<CaeaTasks | null>;
  store(env: ArcaEnv, p: Record<string, unknown>): Promise<void>;
  seriesSync(env: ArcaEnv, pv: number, tipo: number, last: number): Promise<void>;
  sinMovimiento(caeaId: string, ok: boolean, message: string | null): Promise<void>;
  checked(next: Date, message: string): Promise<void>;
}

export interface CaeaRun {
  obtained: number;
  informed: number;
  rejected: number;
  sinMovimiento: number;
  errors: string[];
}

export async function runCaeaTasks(deps: WorkerDeps, db: CaeaDb, emitterCond: string | null): Promise<CaeaRun> {
  const out: CaeaRun = { obtained: 0, informed: 0, rejected: 0, sinMovimiento: 0, errors: [] };
  const t = await db.tasks();
  if (!t || (!t.request.length && !t.inform.length && !t.sin_movimiento.length && !t.pto_vta)) return out;
  const env = t.environment;
  const now = deps.now();
  const a = await deps.auth(env);
  if (!a.ok) {
    out.errors.push(a.message || a.code);
    await db.checked(new Date(now.getTime() + 10 * 60_000), `Sin acceso a ARCA: ${a.message || a.code}`);
    return out;
  }
  const ws = deps.wsfe(env);

  for (const q of t.request) {
    let r = await ws.caeaSolicitar(a.auth, q.periodo, q.orden);
    if (!r.transport && r.parsed && !r.parsed.caea) {
      // Ya pedido (o fuera de plazo): se consulta el otorgado.
      const c = await ws.caeaConsultar(a.auth, q.periodo, q.orden);
      if (!c.transport && c.parsed?.caea) r = c;
    }
    const g = r.parsed;
    if (r.transport || !g) {
      out.errors.push(`CAEA ${q.periodo}/${q.orden}: ARCA no respondió`);
      continue;
    }
    if (!g.caea) {
      out.errors.push(`CAEA ${q.periodo}/${q.orden}: ${joinMsgs([...g.errors, ...g.observaciones]) || "sin CAEA"}`);
      continue;
    }
    await db.store(env, {
      periodo: g.periodo ?? q.periodo,
      orden: g.orden ?? q.orden,
      caea: g.caea,
      fch_vig_desde: ymdToIso(g.fchVigDesde),
      fch_vig_hasta: ymdToIso(g.fchVigHasta),
      fch_tope_inf: ymdToIso(g.fchTopeInf),
      fch_proceso: g.fchProceso && /^\d{14}$/.test(g.fchProceso)
        ? `${ymdToIso(g.fchProceso.slice(0, 8))}T${g.fchProceso.slice(8, 10)}:${g.fchProceso.slice(10, 12)}:${g.fchProceso.slice(12, 14)}-03:00`
        : null,
    });
    out.obtained++;
  }

  // Numeración del punto de venta CAEA (para seguir con ARCA caído).
  if (t.pto_vta) {
    for (const tipo of tiposForEmitter(emitterCond)) {
      const u = await ws.ultimo(a.auth, t.pto_vta, tipo);
      if (!u.transport && u.parsed && u.parsed.errors.length === 0 && u.parsed.nro != null) {
        await db.seriesSync(env, t.pto_vta, tipo, u.parsed.nro);
      }
    }
  }

  for (const id of t.inform) {
    const r = await informCaeaDocument(deps, id);
    if (r.outcome === "informado") out.informed++;
    if (r.outcome === "rechazado") out.rejected++;
  }

  for (const c of t.sin_movimiento) {
    const r = await ws.caeaSinMovimiento(a.auth, t.pto_vta, c.caea);
    const ok = !r.transport && !!r.parsed && (r.parsed.resultado === "A" || r.parsed.errors.length === 0);
    await db.sinMovimiento(c.id, ok, ok ? null : r.parsed ? joinMsgs(r.parsed.errors) : "ARCA no respondió");
    if (ok) out.sinMovimiento++;
    else out.errors.push(`Sin movimiento ${c.caea}: no se pudo informar`);
  }

  const msg = out.errors.length
    ? out.errors.join(" · ")
    : `CAEA al día (${out.obtained} pedidos, ${out.informed} informados)`;
  await db.checked(new Date(now.getTime() + (out.errors.length ? 15 : 360) * 60_000), msg);
  return out;
}
