// =============================================================================
// ADR-149: pasar a facturar en real. Estado de la conexión por ambiente (la
// prueba de producción ya no pisa los pasos Autorizar y Probar de
// homologación), guía de producción con el estado real de cada paso, mapeo de
// errores de ARCA y reintentos cortos ante errores pasajeros.
// =============================================================================
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import {
  authStepOk,
  connectionFor,
  currentProdStep,
  envConnected,
  inferArcaCode,
  productionSteps,
  wizardStepsDone,
  type ProductionConfigLike,
} from "@/lib/arca/labels";
import { HUMAN_ERRORS, humanError } from "@/supabase/functions/_shared/arca/errors";
import { isTransientWsaaCode, withRetry } from "@/supabase/functions/_shared/arca/retry";
import { missingPointsOfSale, usedPointsOfSale } from "@/supabase/functions/_shared/arca/wsfe";

const NOW = new Date("2026-10-15T22:00:00Z");

/** El caso real del 15/10/2026 (datos fiscales ficticios). */
function casoReal(): ProductionConfigLike {
  return {
    settings: {
      enabled: true,
      auth_mode: "propio",
      environment: "homologacion",
      caea_enabled: true,
      last_connection_at: "2026-10-15T21:37:55Z",
      last_connection_env: "produccion",
      last_connection_ok: false,
      last_connection_message: "Computador no autorizado a acceder al servicio",
    },
    emitter: { cuit: "20123456786", iva_condition: "monotributo" },
    certificates: [
      { environment: "homologacion", status: "active", not_after: "2028-10-14T20:32:09Z", cuit: "20123456786", subject: "CN=ninjapos20123456786, serialNumber=CUIT 20123456786" },
      { environment: "produccion", status: "active", not_after: "2028-10-14T21:24:05Z", cuit: "20123456786", subject: "CN=ninjapos20123456786true, serialNumber=CUIT 20123456786" },
    ],
    platform: {},
    stores: [{ afip_pos_number: 100 }],
    checklist: {
      ready: false,
      items: [
        { key: "fiscal_data", ok: true },
        { key: "certificado", ok: true },
        { key: "homologacion_ok", ok: true, count: 3, min: 3, required: true },
        { key: "conexion_produccion", ok: false },
        { key: "puntos_de_venta", ok: false, pos: [100], verified: [] },
      ],
    },
    can_owner: true,
  };
}

describe("conexión por ambiente: los pasos 4 y 6 no se pierden", () => {
  it("causa raíz: con sólo last_connection_* la prueba de producción borraba Autorizar y Probar", () => {
    const c = casoReal();
    // Sin checklist (como antes del arreglo) no hay de dónde sacar que homologación anda.
    const before = wizardStepsDone({ ...c, checklist: undefined }, NOW);
    expect(before.autorizar).toBe(false);
    expect(before.prueba).toBe(false);
  });

  it("sin la migración: las facturas de prueba aprobadas prueban la conexión de homologación", () => {
    const done = wizardStepsDone(casoReal(), NOW);
    expect(done.certificado).toBe(true);
    expect(done.autorizar).toBe(true);
    expect(done.prueba).toBe(true);
    expect(done.punto_venta).toBe(true);
  });

  it("con connection_by_env cada ambiente guarda lo suyo", () => {
    const c = casoReal();
    c.checklist.items = c.checklist.items.map((i) => (i.key === "homologacion_ok" ? { ...i, count: 0, ok: false } : i));
    c.settings!.connection_by_env = {
      homologacion: { ok: true, at: "2026-10-15T21:37:13Z", code: null, steps: [] },
      produccion: { ok: false, at: "2026-10-15T21:37:55Z", code: "coe.notAuthorized", steps: [{ key: "certificado", ok: true }, { key: "wsaa", ok: false, code: "coe.notAuthorized" }] },
    };
    const done = wizardStepsDone(c, NOW);
    expect(done.autorizar).toBe(true);
    expect(done.prueba).toBe(true);
    expect(envConnected(c, "produccion")).toBe(false);
    expect(connectionFor(c.settings, "produccion")?.code).toBe("coe.notAuthorized");
  });

  it("una prueba fallida de homologación sin facturas aprobadas deja el paso pendiente", () => {
    const c = casoReal();
    c.checklist.items = c.checklist.items.map((i) => (i.key === "homologacion_ok" ? { ...i, count: 0 } : i));
    c.settings!.connection_by_env = { homologacion: { ok: false, code: "coe.notAuthorized", steps: [{ key: "wsaa", ok: false }] } };
    const done = wizardStepsDone(c, NOW);
    expect(done.autorizar).toBe(false);
    expect(done.prueba).toBe(false);
  });

  it("acceso OK aunque falle un paso posterior (datos viejos sin pasos)", () => {
    expect(authStepOk({ ok: false, at: null, code: "11002", message: null, steps: [], pos: null })).toBe(true);
    expect(authStepOk({ ok: false, at: null, code: "coe.notAuthorized", message: null, steps: [], pos: null })).toBe(false);
    expect(authStepOk(null)).toBe(false);
  });

  it("infiere el código desde el texto de ARCA", () => {
    expect(inferArcaCode("Computador no autorizado a acceder al servicio")).toBe("coe.notAuthorized");
    expect(inferArcaCode("otra cosa")).toBeNull();
  });
});

describe("guía para pasar a facturar en real", () => {
  it("el caso real hoy: falta autorizar wsfe para el alias; lo demás queda después", () => {
    const steps = productionSteps(casoReal(), NOW);
    const by = Object.fromEntries(steps.map((s) => [s.key, s]));
    expect(by.pruebas?.state).toBe("ok");
    expect(by.certificado?.state).toBe("ok");
    expect(by.autorizar?.state).toBe("error");
    expect(by.autorizar?.code).toBe("coe.notAuthorized");
    expect(by.autorizar?.action).toMatch(/Administrador de Relaciones de Clave Fiscal/);
    expect(by.autorizar?.action).toMatch(/Computador Fiscal/);
    expect(by.punto_venta?.state).toBe("locked");
    expect(by.prueba_real?.state).toBe("locked");
    expect(by.activar?.state).toBe("locked");
    expect(currentProdStep(steps)).toBe("autorizar");
  });

  it("sin prueba todavía: autorizar queda en Falta", () => {
    const c = casoReal();
    c.settings = { ...c.settings!, last_connection_env: "homologacion", last_connection_ok: true };
    expect(productionSteps(c, NOW).find((s) => s.key === "autorizar")?.state).toBe("todo");
  });

  it("acceso OK pero el punto de venta 100 no está como Web Services", () => {
    const c = casoReal();
    c.settings!.connection_by_env = {
      produccion: {
        ok: false,
        code: "pv_no_habilitado",
        pos: [2],
        steps: [
          { key: "certificado", ok: true },
          { key: "wsaa", ok: true },
          { key: "dummy", ok: true },
          { key: "ptos_venta", ok: true },
          { key: "pv_sucursales", ok: false, code: "pv_no_habilitado" },
          { key: "ultimo", ok: false, code: "11002" },
        ],
      },
    };
    const steps = productionSteps(c, NOW);
    const pv = steps.find((s) => s.key === "punto_venta")!;
    expect(steps.find((s) => s.key === "autorizar")?.state).toBe("ok");
    expect(pv.state).toBe("error");
    expect(pv.missing).toEqual([100]);
    expect(pv.action).toMatch(/Web Services/);
    expect(steps.find((s) => s.key === "prueba_real")?.state).toBe("error");
  });

  it("todo verificado: se habilita el interruptor", () => {
    const c = casoReal();
    c.settings!.connection_by_env = { produccion: { ok: true, pos: [100], steps: [{ key: "wsaa", ok: true }] } };
    c.checklist = {
      ready: true,
      items: c.checklist.items.map((i) => ({ ...i, ok: true })),
    };
    const steps = productionSteps(c, NOW);
    expect(steps.filter((s) => s.key !== "activar").every((s) => s.state === "ok")).toBe(true);
    expect(steps.find((s) => s.key === "activar")?.state).toBe("todo");
    expect(currentProdStep(steps)).toBe("activar");
  });

  it("certificado de otra CUIT o vencido: error con la acción", () => {
    const c = casoReal();
    c.certificates[1] = { ...c.certificates[1]!, cuit: "30712345671" };
    expect(productionSteps(c, NOW).find((s) => s.key === "certificado")).toMatchObject({ state: "error", code: "cuit_distinta" });
    const d = casoReal();
    d.certificates[1] = { ...d.certificates[1]!, not_after: "2026-10-01T00:00:00Z" };
    d.checklist.items = d.checklist.items.map((i) => (i.key === "certificado" ? { ...i, ok: false } : i));
    const cert = productionSteps(d, NOW).find((s) => s.key === "certificado");
    expect(cert).toMatchObject({ state: "error", code: "cms.cert.expired" });
    expect(productionSteps(d, NOW).find((s) => s.key === "autorizar")?.state).toBe("locked");
  });

  it("sucursal sin número: el paso de punto de venta lo pide aunque lo demás falte", () => {
    const c = casoReal();
    c.stores = [{ afip_pos_number: null }];
    expect(productionSteps(c, NOW).find((s) => s.key === "punto_venta")).toMatchObject({ state: "todo", code: "sin_punto_de_venta" });
  });

  it("ya en producción: el último paso queda listo", () => {
    const c = casoReal();
    c.settings!.environment = "produccion";
    expect(productionSteps(c, NOW).find((s) => s.key === "activar")?.state).toBe("ok");
  });
});

describe("errores de ARCA en lenguaje simple", () => {
  it("cada error típico tiene qué pasó y qué hacer", () => {
    for (const code of [
      "coe.notAuthorized",
      "cms.cert.expired",
      "cms.cert.untrusted",
      "xml.generationTime.invalid",
      "coe.alreadyAuthenticated",
      "11002",
      "10016",
      "10015",
      "600",
      "601",
      "cuit_distinta",
      "pv_no_habilitado",
      "sin_punto_de_venta",
    ]) {
      const h = humanError(code);
      expect(h.title, code).not.toBe("ARCA devolvió un error");
      expect(h.action.length, code).toBeGreaterThan(15);
    }
  });

  it("acepta el prefijo de namespace de WSAA y mayúsculas distintas", () => {
    expect(humanError("ns1:coe.notAuthorized").title).toBe(HUMAN_ERRORS["coe.notAuthorized"]!.title);
    expect(humanError("COE.NOTAUTHORIZED").title).toBe(HUMAN_ERRORS["coe.notAuthorized"]!.title);
  });

  it("coe.notAuthorized explica la relación, el alias y la demora", () => {
    const a = humanError("coe.notAuthorized").action;
    expect(a).toMatch(/Nueva Relación/);
    expect(a).toMatch(/WebServices > Facturación Electrónica/);
    expect(a).toMatch(/otro alias u otra CUIT/);
    expect(a).toMatch(/minutos/);
  });

  it("punto de venta: Comprobantes en línea no sirve", () => {
    expect(humanError("11002").action).toMatch(/Comprobantes en línea no sirve/);
  });

  it("sin em dash en los textos", () => {
    expect(JSON.stringify(HUMAN_ERRORS)).not.toContain("—");
  });
});

describe("reintentos cortos ante errores pasajeros", () => {
  it("reintenta lo transitorio con las esperas dadas y corta al primer resultado bueno", async () => {
    const sleep = vi.fn(async (_ms: number) => undefined);
    let n = 0;
    const r = await withRetry(async () => ++n, (x) => x < 3, [10, 20, 30], sleep);
    expect(r).toEqual({ result: 3, attempts: 3 });
    expect(sleep.mock.calls.map((c) => c[0])).toEqual([10, 20]);
  });

  it("no reintenta un error del negocio", async () => {
    const sleep = vi.fn(async (_ms: number) => undefined);
    const fn = vi.fn(async () => ({ code: "coe.notAuthorized" }));
    const r = await withRetry(fn, (x) => isTransientWsaaCode(x.code), [10, 20], sleep);
    expect(r.attempts).toBe(1);
    expect(sleep).not.toHaveBeenCalled();
  });

  it("se rinde después de la última espera", async () => {
    const sleep = vi.fn(async (_ms: number) => undefined);
    const r = await withRetry(async () => "timeout", () => true, [1, 2], sleep);
    expect(r.attempts).toBe(3);
  });

  it("clasifica los códigos de WSAA", () => {
    expect(isTransientWsaaCode("xml.generationTime.invalid")).toBe(true);
    expect(isTransientWsaaCode("ns1:xml.expirationTime.expired")).toBe(true);
    expect(isTransientWsaaCode("coe.notAuthorized")).toBe(false);
    expect(isTransientWsaaCode(null)).toBe(false);
  });
});

describe("puntos de venta usados contra los que lista ARCA", () => {
  it("une sucursales y cajas sin repetir", () => {
    expect(usedPointsOfSale([100, null, 3], [3, 7, undefined])).toEqual([3, 7, 100]);
  });

  it("los de CAEA no cuentan como Web Services", () => {
    const listed = [
      { nro: 3, emisionTipo: "CAE - RECE" },
      { nro: 100, emisionTipo: "CAEA - RECE" },
    ];
    expect(missingPointsOfSale([3, 100], listed)).toEqual([100]);
  });
});

describe("migración y Edge", () => {
  const sql = readFileSync(join(process.cwd(), "supabase/migrations/20261217100000_arca_conexion_por_ambiente.sql"), "utf8");
  const edge = readFileSync(join(process.cwd(), "supabase/functions/arca_wsfe/index.ts"), "utf8");

  it("la migración suma connection_by_env, la rellena y mantiene la seguridad de la RPC", () => {
    expect(sql).toMatch(/add column if not exists connection_by_env jsonb not null default/);
    expect(sql).toMatch(/from fiscal_document_events/);
    expect(sql).toMatch(/create or replace function arca_record_connection\(p_tenant uuid, p_env text, p jsonb\)/);
    expect(sql).toMatch(/security definer/);
    expect(sql).toMatch(/set search_path = public, pg_temp/);
    expect(sql).toMatch(/revoke all on function arca_record_connection\(uuid, text, jsonb\) from public, anon, authenticated/);
    expect(sql).toMatch(/grant execute on function arca_record_connection\(uuid, text, jsonb\) to service_role/);
    expect(sql).not.toMatch(/\bdelete from\b/i);
  });

  it("la Edge guarda los pasos, los puntos de venta listados y reintenta lo pasajero", () => {
    expect(edge).toMatch(/steps: steps\.map/);
    expect(edge).toMatch(/pos_ok: true/);
    expect(edge).toMatch(/\{ retry: true \}/);
    expect(edge).toMatch(/cuit_distinta/);
    expect(edge).toMatch(/pv_no_habilitado/);
    // Nunca emite desde la prueba.
    const test = edge.slice(edge.indexOf("async function testConnection"), edge.indexOf("// Certificados (negocio y plataforma)"));
    expect(test).not.toMatch(/solicitar\(/);
  });
});
