// F16 primer corte (ADR-091): cockpit de comercio unificado, reservas de
// stock con retiro en tienda, riesgo operativo y runbooks de soporte.
// Helpers puros y chequeos estáticos de las migraciones (la lógica SQL la
// cubre tests/integration/rls-comercio-unificado.test.ts).
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { describe, it, expect } from "vitest";
import {
  channelLabel,
  channelShares,
  cockpitAlerts,
  cockpitErrorMessage,
  cockpitHeadline,
  type CommerceCockpit,
} from "@/lib/commerce/cockpit";
import {
  effectiveStatus,
  expiresLabel,
  isOpen,
  normalizeDoc,
  pickupFailureMessage,
  reservationErrorMessage,
  reservedByItem,
  validateReservationDraft,
  type StockReservation,
} from "@/lib/stock/reservations";
import {
  DEFAULT_RISK_SETTINGS,
  RETURN_WEIGHTS,
  VOID_WEIGHTS,
  reasonLabel,
  scoreReturn,
  scoreVoid,
  shouldFlag,
  validateRiskSettings,
} from "@/lib/risk/riskScore";
import { personRisk, rankPeople, riskErrorMessage, riskLevel, type RiskPersonRow } from "@/lib/risk/operationalRisk";
import { RUNBOOKS, RUNBOOK_SECTIONS, runbooksForAlert, searchRunbooks } from "@/lib/internal/runbooks";
import { FEATURE_INFO, featureRequires } from "@/lib/saas/featureInfo";
import { periodFrom } from "@/modules/commerce/cockpit";

const DIR = join(process.cwd(), "supabase", "migrations");
const read = (f: string) => readFileSync(join(DIR, f), "utf8");
const MIGS = {
  features: read("20261109100000_features_comercio_unificado.sql"),
  reservas: read("20261109100100_reservas_stock.sql"),
  riesgo: read("20261109100200_riesgo_operativo.sql"),
  cockpit: read("20261109100300_cockpit_comercio.sql"),
};

const baseCockpit = (): CommerceCockpit => ({
  range: { from: "2026-10-13T03:00:00Z", to: "2026-10-13T20:00:00Z" },
  scope: "all",
  channels: [],
  stores: [],
  orders: {
    delivery_open: 0,
    delivery_late: 0,
    delivery_oldest_at: null,
    reservations_open: 0,
    reservations_ready: 0,
    reservations_expiring: 0,
    reservations_old_unprepared: 0,
    transfers_pending: 0,
    transfers_late: 0,
    transfers_in_transit: 0,
  },
  payments: { rejected: 0, paid_not_completed: 0, waiting: 0, disputes_open: 0 },
  fiscal: { blocked: 0, pending_late: 0 },
  returns: { count: 0, total: 0, review_items: 0 },
  stock: { reserved_units: 0, in_transit_units: 0, negative: 0, out_with_sales: 0, below_min: 0 },
  registers: { open: 0, silent: 0 },
  risk: null,
});

// ── H76: cockpit ────────────────────────────────────────────────────────────
describe("cockpit de comercio unificado (H76)", () => {
  it("participación por canal con etiquetas, mayor primero", () => {
    const s = channelShares([
      { channel: "mostrador", sales: 3, total: 300 },
      { channel: "whatsapp", sales: 1, total: 700 },
    ]);
    expect(s.map((x) => x.label)).toEqual(["WhatsApp", "Mostrador"]);
    expect(s[0]!.share).toBeCloseTo(0.7);
    expect(channelShares([])).toEqual([]);
    expect(channelLabel("retiro")).toBe("Retiro en tienda");
    expect(channelLabel("otro")).toBe("otro");
  });

  it("sin problemas no hay alertas", () => {
    const a = cockpitAlerts(baseCockpit());
    expect(a).toEqual([]);
    expect(cockpitHeadline(a)).toBe("Todo en orden");
  });

  it("criterio H76: pedidos por surtir, pagos fallidos y stock roto se ven como alertas ordenadas", () => {
    const c = baseCockpit();
    c.orders.delivery_late = 2;
    c.payments.rejected = 6;
    c.payments.paid_not_completed = 1;
    c.stock.out_with_sales = 4;
    c.fiscal.blocked = 1;
    c.returns.review_items = 3;
    c.registers.silent = 1;
    c.orders.reservations_old_unprepared = 1;
    c.risk = { flags_pending: 2 };
    const a = cockpitAlerts(c);
    const kinds = a.map((x) => x.kind);
    expect(kinds).toEqual(
      expect.arrayContaining([
        "pedido_demorado",
        "pago_rechazado",
        "pago_sin_conciliar",
        "stock_roto",
        "factura_bloqueada",
        "devolucion_a_revisar",
        "caja_sin_senal",
        "reserva_sin_preparar",
        "riesgo_pendiente",
      ]),
    );
    // Las urgentes primero; dentro del nivel, la de más casos.
    const firstWarning = a.findIndex((x) => x.level !== "danger");
    expect(a.slice(0, firstWarning).every((x) => x.level === "danger")).toBe(true);
    expect(a[0]!.kind).toBe("pago_rechazado");
    expect(a.find((x) => x.kind === "devolucion_a_revisar")!.level).toBe("info");
    expect(cockpitHeadline(a)).toMatch(/urgentes/);
    expect(a.every((x) => x.href.startsWith("/"))).toBe(true);
  });

  it("los cobros rechazados escalan de aviso a urgente según el SLA", () => {
    const c = baseCockpit();
    c.payments.rejected = 2;
    expect(cockpitAlerts(c)[0]).toMatchObject({ kind: "pago_rechazado", level: "warning" });
    c.payments.rejected = 5;
    expect(cockpitAlerts(c)[0]).toMatchObject({ kind: "pago_rechazado", level: "danger" });
  });

  it("los pedidos de delivery sin sucursal no alertan en la vista por sucursal", () => {
    const c = baseCockpit();
    c.scope = "stores";
    c.orders.delivery_late = null;
    c.orders.delivery_open = null;
    expect(cockpitAlerts(c)).toEqual([]);
  });

  it("riesgo sólo aparece con la feature (risk null)", () => {
    const c = baseCockpit();
    expect(cockpitAlerts(c).some((x) => x.kind === "riesgo_pendiente")).toBe(false);
  });

  it("período: hoy lo resuelve el servidor; 7 y 30 días hacia atrás", () => {
    const now = new Date("2026-10-13T12:00:00Z");
    expect(periodFrom("hoy", now)).toBeNull();
    expect(periodFrom("7d", now)).toBe("2026-10-06T12:00:00.000Z");
    expect(periodFrom("30d", now)).toBe("2026-09-13T12:00:00.000Z");
  });

  it("mensajes claros", () => {
    expect(cockpitErrorMessage(new Error("feature_not_in_plan: cockpit_comercio"))).toMatch(/plan/);
    expect(cockpitErrorMessage({ message: "forbidden" })).toMatch(/dueño/);
    expect(cockpitErrorMessage("x")).toMatch(/No se pudo/);
  });
});

// ── H77: reservas y retiro en tienda ────────────────────────────────────────
const res = (p: Partial<StockReservation>): StockReservation => ({
  id: "r",
  number: 1,
  store_id: "s1",
  origin_store_id: null,
  channel: "mostrador",
  customer_id: null,
  customer_name: "Ana",
  customer_phone: null,
  customer_doc: null,
  failed_attempts: 0,
  status: "reservada",
  expires_at: "2026-10-14T12:00:00Z",
  notes: null,
  total_units: 2,
  total_value: 200,
  sale_id: null,
  cancel_reason: null,
  created_at: "2026-10-13T12:00:00Z",
  prepared_at: null,
  delivered_at: null,
  items: [
    {
      id: "i",
      product_id: "p",
      variant_id: null,
      product_name: "Remera",
      variant_label: null,
      sku: null,
      unit: "un",
      qty: 2,
      unit_price: 100,
      sort: 0,
    },
  ],
  ...p,
});

describe("reservas de stock y retiro en tienda (H77)", () => {
  const now = new Date("2026-10-13T18:00:00Z");

  it("valida el borrador antes de llamar al servidor", () => {
    const ok = {
      storeId: "s1",
      customerName: "Ana",
      customerDoc: "30.123.456",
      hours: 48,
      lines: [{ product_id: "p", variant_id: null, qty: 2, available: 5 }],
    };
    expect(validateReservationDraft(ok)).toEqual([]);
    expect(validateReservationDraft({ ...ok, storeId: null })).toContain("Elegí la sucursal donde retira.");
    expect(validateReservationDraft({ ...ok, customerName: " " }).join()).toMatch(/nombre/);
    expect(validateReservationDraft({ ...ok, customerDoc: "12" }).join()).toMatch(/documento/);
    expect(validateReservationDraft({ ...ok, lines: [] }).join()).toMatch(/al menos un producto/);
    expect(
      validateReservationDraft({ ...ok, lines: [...ok.lines, { product_id: "p", variant_id: null, qty: 1 }] }).join(),
    ).toMatch(/repetido/);
    expect(validateReservationDraft({ ...ok, lines: [{ product_id: "p", variant_id: null, qty: 9, available: 5 }] }).join()).toMatch(
      /disponible/,
    );
    expect(validateReservationDraft({ ...ok, hours: 24 * 31 }).join()).toMatch(/30 días/);
  });

  it("normaliza el documento a números", () => {
    expect(normalizeDoc("20-30.123.456-7")).toBe("20301234567");
    expect(normalizeDoc(null)).toBe("");
  });

  it("una reserva vigente con el vencimiento pasado se ve vencida", () => {
    expect(effectiveStatus(res({}), now)).toBe("reservada");
    expect(effectiveStatus(res({ expires_at: "2026-10-13T17:00:00Z" }), now)).toBe("vencida");
    expect(effectiveStatus(res({ status: "entregada", expires_at: "2026-10-13T17:00:00Z" }), now)).toBe("entregada");
    expect(isOpen(res({ status: "preparada" }), now)).toBe(true);
    expect(isOpen(res({ status: "cancelada" }), now)).toBe(false);
  });

  it("texto del vencimiento", () => {
    expect(expiresLabel("2026-10-13T18:30:00Z", now)).toBe("Vence en 30 min");
    expect(expiresLabel("2026-10-14T12:00:00Z", now)).toBe("Vence en 18 h");
    expect(expiresLabel("2026-10-17T18:00:00Z", now)).toBe("Vence en 4 días");
    expect(expiresLabel("2026-10-13T10:00:00Z", now)).toBe("Vencida");
  });

  it("lo reservado vigente se suma por sucursal e ítem", () => {
    const m = reservedByItem(
      [res({}), res({ id: "b", status: "preparada" }), res({ id: "c", status: "cancelada" }), res({ id: "d", expires_at: "2026-10-13T10:00:00Z" })],
      now,
    );
    expect(m.get("s1:p:")).toBe(4);
  });

  it("mensajes claros para los errores del servidor", () => {
    expect(reservationErrorMessage(new Error("insufficient_available_stock: Remera"))).toBe(
      "No hay disponible suficiente de Remera en esa sucursal.",
    );
    expect(reservationErrorMessage("feature_not_in_plan: reservas_stock")).toMatch(/plan/);
    expect(reservationErrorMessage("store_forbidden")).toMatch(/acceso/);
    expect(reservationErrorMessage("sale_wrong_store")).toMatch(/sucursal de la reserva/);
    expect(reservationErrorMessage("sale_items_mismatch")).toMatch(/todos los productos/);
    expect(reservationErrorMessage("override_requires_manager")).toMatch(/encargado/);
    expect(pickupFailureMessage("pickup_code_invalid", 1)).toMatch(/Queda 1 intento/);
    expect(pickupFailureMessage("pickup_code_invalid", 3)).toMatch(/Quedan 3/);
    expect(pickupFailureMessage("pickup_code_locked", 0)).toMatch(/bloqueado/);
  });
});

// ── H82: riesgo operativo ───────────────────────────────────────────────────
describe("riesgo operativo (H82)", () => {
  const s = DEFAULT_RISK_SETTINGS;

  it("criterio H82: una devolución de alto riesgo queda marcada", () => {
    const r = scoreReturn(s, {
      amount: 80000,
      daysSinceSale: 45,
      userReturnsToday: 1,
      cashWithoutCustomer: true,
      sameUserSold: false,
    });
    expect(r.reasons).toEqual(["monto_alto", "fuera_de_plazo", "efectivo_sin_cliente"]);
    expect(r.score).toBe(75);
    expect(shouldFlag(s, r)).toBe(true);
  });

  it("una devolución común no se marca", () => {
    const r = scoreReturn(s, { amount: 3000, daysSinceSale: 2, userReturnsToday: 1, cashWithoutCustomer: false, sameUserSold: false });
    expect(r).toEqual({ score: 0, reasons: [] });
    expect(shouldFlag(s, r)).toBe(false);
  });

  it("anulaciones: repetidas, tarde, con turno cerrado; tope 100", () => {
    const r = scoreVoid(s, { amount: 90000, userVoidsToday: 5, minutesAfterSale: 300, shiftClosed: true, sameUserSold: true });
    expect(r.score).toBe(100);
    expect(r.reasons).toContain("turno_cerrado");
    const low = scoreVoid(s, { amount: 100, userVoidsToday: 1, minutesAfterSale: 3, shiftClosed: false, sameUserSold: true });
    expect(low.score).toBe(15);
    expect(shouldFlag(s, low)).toBe(false);
  });

  it("los pesos del front son los mismos que los de la migración", () => {
    const sql = MIGS.riesgo;
    const fnBody = (name: string) => sql.slice(sql.indexOf(`create or replace function ${name}`), sql.indexOf("$$;", sql.indexOf(`create or replace function ${name}`)));
    const weights = (body: string) =>
      Object.fromEntries(
        [...body.matchAll(/v_score := v_score \+ (\d+); v_reasons := v_reasons \|\| '\["(\w+)"\]'/g)].map((m) => [m[2], Number(m[1])]),
      );
    expect(weights(fnBody("risk_score_return"))).toEqual(RETURN_WEIGHTS);
    expect(weights(fnBody("risk_score_void"))).toEqual(VOID_WEIGHTS);
    // Umbrales por defecto iguales a los de risk_settings_effective.
    for (const [k, v] of Object.entries(DEFAULT_RISK_SETTINGS)) {
      expect(sql, k).toMatch(new RegExp(`'${k}',\\s+coalesce\\(rs\\.${k}, ${v}\\)`));
    }
  });

  it("valida los umbrales con los mismos rangos que la tabla", () => {
    expect(validateRiskSettings(s)).toEqual([]);
    expect(validateRiskSettings({ ...s, flag_score_min: 0 }).join()).toMatch(/puntaje/);
    expect(validateRiskSettings({ ...s, discount_pct_high: 120 }).join()).toMatch(/descuento/);
    expect(validateRiskSettings({ ...s, returns_per_user_day: 2.5 }).join()).toMatch(/decimales/);
  });

  const row = (p: Partial<RiskPersonRow>): RiskPersonRow => ({
    user_id: "u",
    name: "Caja",
    sales_count: 100,
    sales_total: 100000,
    sales_subtotal: 100000,
    discount_total: 0,
    discounted_sales: 0,
    voids_count: 0,
    voids_total: 0,
    returns_count: 0,
    returns_total: 0,
    rejected_payments: 0,
    shifts_closed: 5,
    cash_diff_total: 0,
    cash_diff_shifts: 0,
    flags_pending: 0,
    flags_total: 0,
    ...p,
  });

  it("detecta anulaciones, descuentos, devoluciones, cobros rechazados y caja fuera de patrón", () => {
    const p = personRisk(
      row({ voids_count: 8, discount_total: 25000, returns_count: 6, rejected_payments: 4, cash_diff_shifts: 2, flags_pending: 1 }),
      s,
    );
    expect(p.signals.map((x) => x.kind)).toEqual([
      "anulaciones",
      "descuentos",
      "devoluciones",
      "cobros_rechazados",
      "caja",
      "marcas",
    ]);
    expect(p.score).toBe(100);
    expect(p.level).toBe("alto");
    expect(personRisk(row({}), s)).toMatchObject({ score: 0, level: "bajo", signals: [] });
  });

  it("con pocas ventas, una sola anulación pesa por tasa", () => {
    expect(personRisk(row({ sales_count: 4, voids_count: 1 }), s).signals[0]?.kind).toBe("anulaciones");
    expect(personRisk(row({ sales_count: 100, voids_count: 1 }), s).signals).toEqual([]);
  });

  it("ordena por puntaje y nivel", () => {
    const list = rankPeople([row({ name: "B" }), row({ name: "A", cash_diff_shifts: 1, flags_pending: 1 })], s);
    expect(list.map((x) => x.row.name)).toEqual(["A", "B"]);
    expect(riskLevel(25)).toBe("medio");
    expect(riskLevel(49)).toBe("medio");
    expect(riskLevel(50)).toBe("alto");
    expect(reasonLabel("turno_cerrado")).toMatch(/turno/);
    expect(riskErrorMessage("note_required")).toMatch(/por qué/);
  });
});

// ── H85: runbooks ───────────────────────────────────────────────────────────
function routeExists(href: string): boolean {
  const path = href.split("?")[0]!.replace(/^\//, "");
  if (path.startsWith("internal")) return existsSync(join(process.cwd(), "app", path, "page.tsx"));
  const groups = readdirSync(join(process.cwd(), "app")).filter((d) => d.startsWith("("));
  return groups.some((g) => existsSync(join(process.cwd(), "app", g, path, "page.tsx")));
}

describe("runbooks de soporte (H85)", () => {
  it("cada runbook dice qué revisar, cómo reintentar, cuándo escalar y cómo cerrar", () => {
    const ids = new Set<string>();
    for (const r of RUNBOOKS) {
      expect(ids.has(r.id), r.id).toBe(false);
      ids.add(r.id);
      expect(r.symptoms.length, r.id).toBeGreaterThan(0);
      for (const sec of RUNBOOK_SECTIONS) expect(r[sec.key].length, `${r.id}.${sec.key}`).toBeGreaterThan(0);
    }
  });

  it("todas las pantallas que nombran existen", () => {
    for (const r of RUNBOOKS) {
      for (const sec of RUNBOOK_SECTIONS) {
        for (const st of r[sec.key]) if (st.href) expect(routeExists(st.href), `${r.id}: ${st.href}`).toBe(true);
      }
    }
  });

  it("criterio H85: una caída de pagos tiene runbook que identifica proveedor desde Salud de webhooks", () => {
    const [rb] = runbooksForAlert("pago_rechazado");
    expect(rb?.id).toBe("caida-pagos-proveedor");
    expect(rb?.detect.some((s) => s.href === "/internal/webhooks")).toBe(true);
    expect(rb?.severity).toBe("critica");
  });

  it("las alertas del cockpit que atienden existen", () => {
    const c = baseCockpit();
    c.payments.rejected = 9;
    c.payments.paid_not_completed = 1;
    c.fiscal.blocked = 1;
    c.fiscal.pending_late = 1;
    c.registers.silent = 1;
    c.stock.negative = 1;
    c.stock.out_with_sales = 1;
    const kinds = new Set(cockpitAlerts(c).map((a) => a.kind as string));
    for (const r of RUNBOOKS) for (const k of r.cockpitAlerts ?? []) expect(kinds.has(k), `${r.id}: ${k}`).toBe(true);
  });

  it("búsqueda sin acentos y por área, críticas primero", () => {
    expect(searchRunbooks("senal").map((r) => r.id)).toContain("caja-sin-senal");
    expect(searchRunbooks("", "fiscal").every((r) => r.area === "fiscal")).toBe(true);
    expect(searchRunbooks("")[0]!.severity).toBe("critica");
    expect(searchRunbooks("zzz")).toEqual([]);
  });
});

// ── Plan, seguridad y migraciones ───────────────────────────────────────────
describe("checklist de features y guardas de las migraciones (ADR-091)", () => {
  it("las tres keys tienen copy y plan mínimo", () => {
    expect(FEATURE_INFO.cockpit_comercio?.minPlan).toBe("Business");
    expect(FEATURE_INFO.prevencion_fraude?.minPlan).toBe("Business");
    expect(FEATURE_INFO.reservas_stock?.minPlan).toBe("Pro");
    expect(featureRequires("reservas_stock")).toEqual(["stock"]);
  });

  it("las keys son OPTIONAL y se marcan por plan", () => {
    for (const key of ["cockpit_comercio", "reservas_stock", "prevencion_fraude"]) {
      expect(MIGS.features).toMatch(new RegExp(`\\('${key}',`));
      expect(MIGS.features).toMatch(new RegExp(`jsonb_build_object\\('${key}'`));
    }
    expect(MIGS.features).toMatch(/'cockpit_comercio', \(p\.key in \('business', 'enterprise'\)\)/);
    expect(MIGS.features).toMatch(/'reservas_stock', \(p\.key in \('pro', 'business', 'enterprise'\)\)/);
    expect(MIGS.features).not.toMatch(/, true, \d+\)/);
  });

  it("gating real en el servidor", () => {
    expect(MIGS.reservas).toMatch(/tenant_has_feature_for\(v_tenant, 'reservas_stock'\)/);
    expect(MIGS.riesgo).toMatch(/tenant_has_feature_for\(v_tenant, 'prevencion_fraude'\)/);
    expect(MIGS.riesgo).toMatch(/tenant_has_feature_for\(new\.tenant_id, 'prevencion_fraude'\)/);
    expect(MIGS.cockpit).toMatch(/tenant_has_feature_for\(v_tenant, 'cockpit_comercio'\)/);
  });

  it("policies con (select current_tenant_id()) y (select internal_scope()), nunca is_internal()", () => {
    for (const [name, sql] of Object.entries(MIGS)) {
      const policies = [...sql.matchAll(/create policy[\s\S]*?;/g)].map((m) => m[0]);
      for (const p of policies) {
        expect(p, name).not.toMatch(/is_internal\(\)/);
        expect(p.replace(/\(select current_tenant_id\(\)\)/g, ""), name).not.toMatch(/current_tenant_id\(\)/);
        expect(p.replace(/\(select internal_scope\(\)\)/g, ""), name).not.toMatch(/internal_scope\(\)/);
        // Initplan (guard de rendimiento F4): ninguna llamada pelada.
        expect(p.replace(/\(select [a-z_.]+\(\)\)/g, ""), name).not.toMatch(/[a-z_.]+\(\)/);
      }
    }
  });

  it("sin policies de escritura y con role_write_guard en las tablas nuevas", () => {
    for (const sql of [MIGS.reservas, MIGS.riesgo]) {
      for (const p of sql.match(/create policy[\s\S]*?;/g) ?? []) {
        expect(p).toMatch(/for select/);
      }
    }
    expect(MIGS.reservas).toMatch(/array\['stock_reservations', 'stock_reservation_items'\]/);
    expect(MIGS.reservas).toMatch(/trg_role_write_guard\(%L\)', t, 'operate'/);
    expect(MIGS.riesgo).toMatch(/array\['risk_settings', 'risk_flags'\]/);
    expect(MIGS.riesgo).toMatch(/trg_role_write_guard\(%L\)', t, 'manage'/);
  });

  it("toda escritura audita y nada borra audit_logs", () => {
    for (const action of [
      "stock_reservation_created",
      "stock_reservation_prepared",
      "stock_reservation_delivered",
      "stock_reservation_pickup_failed",
      "stock_reservation_cancelled",
      "stock_reservation_expired",
    ]) {
      expect(MIGS.reservas).toContain(`'${action}'`);
    }
    for (const action of ["risk_flag_raised", "risk_flag_reviewed", "risk_settings_updated"]) {
      expect(MIGS.riesgo).toContain(`'${action}'`);
    }
    for (const sql of Object.values(MIGS)) expect(sql).not.toMatch(/delete from audit_logs|update audit_logs/i);
  });

  it("no recrea create_sale, void_sale ni return_sale (deuda en ADR-091)", () => {
    for (const sql of Object.values(MIGS)) {
      expect(sql).not.toMatch(/create or replace function (public\.)?(create_sale|void_sale|return_sale\w*)\s*\(/);
    }
  });

  it("el código de retiro se guarda sólo como hash y la entrega valida la venta", () => {
    expect(MIGS.reservas).toMatch(/pickup_code_hash\s+text not null/);
    expect(MIGS.reservas).not.toMatch(/pickup_code\s+text/);
    for (const err of ["sale_wrong_store", "sale_already_used", "sale_items_mismatch", "sale_not_completed"]) {
      expect(MIGS.reservas).toContain(err);
    }
  });

  it("la devolución se evalúa al commit (total final) sin hacer fallar la operación", () => {
    expect(MIGS.riesgo).toMatch(/create constraint trigger risk_flag_return\s+after insert on sale_returns\s+deferrable initially deferred/);
    expect((MIGS.riesgo.match(/exception when others then\s+raise warning/g) ?? []).length).toBe(2);
  });
});
