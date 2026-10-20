// @vitest-environment node
// Alertas programadas (F24 · H162, ADR-176): el catálogo de la UI es espejo
// del de la base, los helpers de umbrales y la próxima corrida en hora de
// Argentina (espejo de alert_next_run).
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  ALERT_CATALOG,
  ALERT_KINDS,
  alertErrorMessage,
  alertTitle,
  defaultParams,
  nextRunAt,
  scheduleLabel,
  validateParams,
  type AlertKind,
} from "@/lib/alerts/catalog";
import { FEATURE_INFO } from "@/lib/saas/featureInfo";

const SQL = readFileSync("supabase/migrations/20270114100000_h162_alertas.sql", "utf8");

type SqlKind = {
  label: string;
  severity: string;
  url: string;
  frequency: string;
  hour: number;
  weekdays: number[];
  noun: [string, string];
  params: Record<string, { default: number; min: number; max: number }>;
};

function sqlCatalog(): Record<string, SqlKind> {
  const m = SQL.match(/\$catalog\$([\s\S]*?)\$catalog\$/);
  if (!m) throw new Error("alert_catalog() sin el JSON entre $catalog$");
  return JSON.parse(m[1] ?? "{}") as Record<string, SqlKind>;
}

describe("catálogo TS ↔ SQL", () => {
  const sql = sqlCatalog();

  it("mismos tipos", () => {
    expect(Object.keys(sql).sort()).toEqual([...ALERT_KINDS].sort());
    expect(ALERT_KINDS).toHaveLength(16);
  });

  it("mismos textos, severidad, destino, frecuencia y umbrales", () => {
    for (const kind of ALERT_KINDS) {
      const ts = ALERT_CATALOG[kind];
      const db = sql[kind]!;
      expect({ kind, label: db.label, severity: db.severity, url: db.url, frequency: db.frequency, hour: db.hour, weekdays: db.weekdays, noun: db.noun }).toEqual({
        kind,
        label: ts.label,
        severity: ts.severity,
        url: ts.url,
        frequency: ts.frequency,
        hour: ts.hour,
        weekdays: ts.weekdays,
        noun: ts.noun,
      });
      const tsParams = Object.fromEntries(
        Object.entries(ts.params).map(([k, d]) => [k, { default: d.default, min: d.min, max: d.max }]),
      );
      expect({ kind, params: db.params }).toEqual({ kind, params: tsParams });
    }
  });

  it("el evaluador implementa cada tipo del catálogo", () => {
    for (const kind of ALERT_KINDS) {
      expect(SQL).toMatch(new RegExp(`p_kind = '${kind}'`));
    }
  });

  it("los valores por defecto están dentro del rango", () => {
    for (const kind of ALERT_KINDS) {
      for (const d of Object.values(ALERT_CATALOG[kind].params)) {
        expect(d.default).toBeGreaterThanOrEqual(d.min);
        expect(d.default).toBeLessThanOrEqual(d.max);
      }
    }
  });
});

describe("feature alertas_programadas (CLAUDE.md §6)", () => {
  it("key OPTIONAL en reportes, Pro+ y gating en el servidor", () => {
    expect(SQL).toMatch(/'alertas_programadas', 'Alertas programadas',[\s\S]*?'reportes', false/);
    expect(SQL).toMatch(/jsonb_build_object\('alertas_programadas', p\.key in \('pro', 'business', 'enterprise'\)\)/);
    expect(SQL).toMatch(/not \(coalesce\(p\.limits -> 'modules', '\{\}'::jsonb\) \? 'alertas_programadas'\)/);
    // RPC de la UI (alert_assert) y runner.
    expect(SQL).toMatch(/tenant_has_feature_for\(v_tenant, 'alertas_programadas'\)/);
    expect(SQL).toMatch(/tenant_has_feature_for\(r\.tenant_id, 'alertas_programadas'\)/);
  });

  it("copy en featureInfo", () => {
    expect(FEATURE_INFO.alertas_programadas?.minPlan).toBe("Pro");
    expect(FEATURE_INFO.alertas_programadas?.desc).toMatch(/alertas/i);
  });

  it("RLS sin is_internal() suelto y con initplan", () => {
    const policies = SQL.match(/create policy[\s\S]*?;/g) ?? [];
    expect(policies).toHaveLength(3);
    for (const p of policies) {
      expect(p).not.toMatch(/is_internal\(\)/);
      expect(p).toMatch(/tenant_id = \(select current_tenant_id\(\)\)/);
      expect(p.replace(/\(select [a-z_]+\((?:'[^']*')?\)\)/g, "")).not.toMatch(/[a-z_]+\(/);
    }
  });
});

describe("umbrales", () => {
  it("valores por defecto", () => {
    expect(defaultParams("ajustes_grandes")).toEqual({ hours: 24, qty: 50, value: 100_000 });
    expect(defaultParams("stock_bajo")).toEqual({});
  });

  it("valida rango, tipo y claves", () => {
    expect(validateParams("descuentos_altos", { hours: 24, pct: 20 })).toEqual({});
    expect(Object.keys(validateParams("descuentos_altos", { pct: 0 }))).toEqual(["pct"]);
    expect(Object.keys(validateParams("descuentos_altos", { pct: 101 }))).toEqual(["pct"]);
    expect(Object.keys(validateParams("descuentos_altos", { pct: "20" }))).toEqual(["pct"]);
    expect(Object.keys(validateParams("stock_bajo", { x: 1 }))).toEqual(["x"]);
  });

  it("título de la notificación", () => {
    expect(alertTitle("stock_bajo", 5)).toBe("Stock bajo el mínimo: 5 productos");
    expect(alertTitle("caja_sin_cerrar", 1)).toBe("Cajas sin cerrar: 1 caja");
  });

  it("mensajes de error en castellano", () => {
    expect(alertErrorMessage({ message: "feature_not_in_plan: alertas_programadas" })).toMatch(/plan/);
    expect(alertErrorMessage(new Error("audience_required"))).toMatch(/a quién/);
    expect(alertErrorMessage("x")).toMatch(/No se pudo/);
  });
});

describe("próxima corrida (hora de Argentina, UTC-3)", () => {
  // 2026-10-20 (martes) 10:30 en Argentina = 13:30 UTC.
  const from = new Date("2026-10-20T13:30:00Z");

  it("cada hora: la próxima en punto", () => {
    expect(nextRunAt("hourly", 8, [], from).toISOString()).toBe("2026-10-20T14:00:00.000Z");
  });

  it("diaria: hoy si la hora no pasó, si no mañana", () => {
    expect(nextRunAt("daily", 18, [], from).toISOString()).toBe("2026-10-20T21:00:00.000Z");
    expect(nextRunAt("daily", 8, [], from).toISOString()).toBe("2026-10-21T11:00:00.000Z");
    // Justo a la hora: la próxima es la de mañana.
    expect(nextRunAt("daily", 10, [], new Date("2026-10-20T13:00:00Z")).toISOString()).toBe("2026-10-21T13:00:00.000Z");
  });

  it("diaria cerca de medianoche usa el día de Argentina", () => {
    // 2026-10-20 23:30 AR = 2026-10-21 02:30 UTC; a las 8 AR del 21.
    expect(nextRunAt("daily", 8, [], new Date("2026-10-21T02:30:00Z")).toISOString()).toBe("2026-10-21T11:00:00.000Z");
  });

  it("semanal: el próximo día permitido", () => {
    // Lunes (1): el próximo es el 26/10.
    expect(nextRunAt("weekly", 8, [1], from).toISOString()).toBe("2026-10-26T11:00:00.000Z");
    // Martes (2) a las 18: hoy.
    expect(nextRunAt("weekly", 18, [2], from).toISOString()).toBe("2026-10-20T21:00:00.000Z");
    // Martes a las 8 (ya pasó): el martes siguiente.
    expect(nextRunAt("weekly", 8, [2], from).toISOString()).toBe("2026-10-27T11:00:00.000Z");
  });

  it("texto del horario", () => {
    expect(scheduleLabel("hourly", 8, [])).toBe("Cada hora");
    expect(scheduleLabel("daily", 8, [])).toBe("Todos los días a las 8");
    expect(scheduleLabel("weekly", 9, [4, 1])).toBe("Lun y Jue a las 9");
  });

  it("el SQL usa la zona de Argentina y los días 0 a 6", () => {
    expect(SQL).toMatch(/create or replace function alert_next_run/);
    expect(SQL).toMatch(/'America\/Argentina\/Buenos_Aires'/);
    expect(SQL).toMatch(/weekdays <@ array\[0, 1, 2, 3, 4, 5, 6\]::smallint\[\]/);
  });
});

// Tipos: cada kind tiene grupo y descripción para la UI.
it("cada tipo tiene grupo y descripción", () => {
  for (const k of ALERT_KINDS as AlertKind[]) {
    expect(ALERT_CATALOG[k].description.length).toBeGreaterThan(10);
    expect(ALERT_CATALOG[k].group).toBeTruthy();
  }
});
