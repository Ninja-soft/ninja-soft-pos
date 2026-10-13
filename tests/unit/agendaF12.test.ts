import { describe, expect, it } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { agendaErrorMessage, findConflicts, isActiveStatus, rangesOverlap, type SlotLike } from "@/modules/agenda/overlap";
import {
  entryFitsSlot,
  slotOfHour,
  sortWaitlist,
  validateWaitlistInput,
  waitlistPhone,
  waitlistWho,
} from "@/modules/agenda/waitlist";
import {
  activationMilestones,
  activationScore,
  formatMinutes,
  isActivated,
  parseActivation,
} from "@/lib/saas/activation";
import { FEATURE_INFO, featureRequires } from "@/lib/saas/featureInfo";

const root = join(__dirname, "..", "..");
const read = (f: string) => readFileSync(join(root, f), "utf8");
const MIGS = readdirSync(join(root, "supabase/migrations"))
  .filter((f) => f.startsWith("202611061"))
  .map((f) => `supabase/migrations/${f}`);

const slot = (over: Partial<SlotLike>): SlotLike => ({
  id: "x",
  starts_at: "2026-11-06T13:00:00.000Z",
  duration_min: 30,
  status: "reservado",
  professional_id: null,
  resource_id: null,
  ...over,
});

describe("choques de horario de la agenda", () => {
  it("rangos semiabiertos: terminar 10:30 no choca con empezar 10:30", () => {
    expect(rangesOverlap("2026-11-06T10:00:00Z", 30, "2026-11-06T10:30:00Z", 30)).toBe(false);
    expect(rangesOverlap("2026-11-06T10:00:00Z", 31, "2026-11-06T10:30:00Z", 30)).toBe(true);
    expect(rangesOverlap("2026-11-06T10:00:00Z", 90, "2026-11-06T10:30:00Z", 15)).toBe(true);
    expect(rangesOverlap("nada", 30, "2026-11-06T10:30:00Z", 30)).toBe(false);
  });

  it("sólo los estados activos ocupan lugar", () => {
    expect(isActiveStatus("reservado")).toBe(true);
    expect(isActiveStatus("en_curso")).toBe(true);
    expect(isActiveStatus("cancelado")).toBe(false);
    expect(isActiveStatus("no_show")).toBe(false);
    expect(isActiveStatus("realizado")).toBe(false);
  });

  it("detecta choque por recurso y por profesional, ignorando el propio turno y los cancelados", () => {
    const existing = [
      slot({ id: "a", professional_id: "p1", resource_id: "r1" }),
      slot({ id: "b", professional_id: "p2", resource_id: "r1", status: "cancelado" }),
      slot({ id: "c", professional_id: "p1", resource_id: "r2", starts_at: "2026-11-06T15:00:00.000Z" }),
    ];
    const c = findConflicts(existing, slot({ id: "new", professional_id: "p1", resource_id: "r1", starts_at: "2026-11-06T13:15:00.000Z" }));
    expect(c.resource.map((x) => x.id)).toEqual(["a"]);
    expect(c.professional.map((x) => x.id)).toEqual(["a"]);
    // Editar el mismo turno no choca consigo mismo.
    expect(findConflicts(existing, slot({ id: "a", professional_id: "p1", resource_id: "r1" })).resource).toEqual([]);
    // Un candidato cancelado no choca.
    expect(findConflicts(existing, slot({ id: "n", resource_id: "r1", status: "cancelado" })).resource).toEqual([]);
    // Sin recurso no hay choque de recurso.
    expect(findConflicts(existing, slot({ id: "n", professional_id: "p9" }))).toEqual({ professional: [], resource: [] });
  });

  it("traduce los errores del servidor", () => {
    expect(agendaErrorMessage("resource_busy")).toMatch(/ocupado/);
    expect(agendaErrorMessage("feature_not_in_plan: agenda_recursos")).toMatch(/recursos/);
    expect(agendaErrorMessage("feature_not_in_plan: lista_espera")).toMatch(/lista de espera/);
    expect(agendaErrorMessage("feature_not_in_plan: agenda")).toMatch(/no incluye la agenda/);
    expect(agendaErrorMessage("new row violates row-level security policy")).toMatch(/rol/);
    expect(agendaErrorMessage(null)).toMatch(/No se pudo/);
  });
});

describe("lista de espera", () => {
  it("franjas: mañana hasta las 13, tarde hasta las 19, noche después", () => {
    expect(slotOfHour(9)).toBe("manana");
    expect(slotOfHour(12)).toBe("manana");
    expect(slotOfHour(13)).toBe("tarde");
    expect(slotOfHour(18)).toBe("tarde");
    expect(slotOfHour(19)).toBe("noche");
  });

  it("una entrada encaja en un hueco según fecha, franja y profesional", () => {
    const e = { status: "esperando" as const, preferred_date: "2026-11-06", preferred_slot: "tarde" as const, professional_id: "p1" };
    expect(entryFitsSlot(e, new Date(2026, 10, 6, 16, 0), "p1")).toBe(true);
    expect(entryFitsSlot(e, new Date(2026, 10, 6, 16, 0), null)).toBe(true);
    expect(entryFitsSlot(e, new Date(2026, 10, 6, 10, 0), "p1")).toBe(false);
    expect(entryFitsSlot(e, new Date(2026, 10, 7, 16, 0), "p1")).toBe(false);
    expect(entryFitsSlot(e, new Date(2026, 10, 6, 16, 0), "p2")).toBe(false);
    expect(entryFitsSlot({ ...e, status: "agendado" }, new Date(2026, 10, 6, 16, 0), "p1")).toBe(false);
    expect(
      entryFitsSlot({ status: "esperando", preferred_date: null, preferred_slot: "cualquiera", professional_id: null }, new Date(), "p3"),
    ).toBe(true);
  });

  it("orden: primero con fecha (la más cercana), después por orden de llegada", () => {
    const list = [
      { id: "1", preferred_date: null, created_at: "2026-11-01T10:00:00Z" },
      { id: "2", preferred_date: "2026-11-09", created_at: "2026-11-02T10:00:00Z" },
      { id: "3", preferred_date: "2026-11-07", created_at: "2026-11-03T10:00:00Z" },
      { id: "4", preferred_date: null, created_at: "2026-10-30T10:00:00Z" },
      { id: "5", preferred_date: "2026-11-07", created_at: "2026-11-01T09:00:00Z" },
    ];
    expect(sortWaitlist(list).map((x) => x.id)).toEqual(["5", "3", "2", "4", "1"]);
    expect(list[0]?.id).toBe("1");
  });

  it("valida quién y qué servicio, y muestra nombre y teléfono", () => {
    expect(validateWaitlistInput({ customer_id: null, customer_name: " ", service_name: "Corte", service_product_id: null })).toMatch(/cliente/);
    expect(validateWaitlistInput({ customer_id: "c", customer_name: null, service_name: null, service_product_id: null })).toMatch(/servicio/);
    expect(validateWaitlistInput({ customer_id: null, customer_name: "Ana", service_name: null, service_product_id: "p" })).toBeNull();
    expect(waitlistWho({ customer_name: null, customers: { name: "Ana", phone: "11" } })).toBe("Ana");
    expect(waitlistWho({ customer_name: "Paula", customers: null })).toBe("Paula");
    expect(waitlistPhone({ phone: null, customers: { name: "Ana", phone: "11" } })).toBe("11");
  });
});

describe("métricas de activación", () => {
  const base = {
    tenant_created_at: "2026-11-01T10:00:00Z",
    first_sale_at: "2026-11-01T10:08:00Z",
    minutes_to_first_sale: 8,
    sales_count: "12",
    first_appointment_at: null,
    appointments_count: 0,
    first_recurring_customer_at: "2026-11-03T10:00:00Z",
    first_pack_sold_at: null,
    favorites_count: 6,
    favorite_lines_share_30d: "0.4167",
  };

  it("parsea la respuesta de la RPC y rechaza basura", () => {
    const a = parseActivation(base)!;
    expect(a.sales_count).toBe(12);
    expect(a.favorite_lines_share_30d).toBeCloseTo(0.4167);
    expect(parseActivation(null)).toBeNull();
    expect(parseActivation({ sales_count: 1 })).toBeNull();
  });

  it("formatea duraciones", () => {
    expect(formatMinutes(8)).toBe("8 min");
    expect(formatMinutes(60)).toBe("1 h");
    expect(formatMinutes(185)).toBe("3 h 5 min");
    expect(formatMinutes(60 * 24 * 2 + 60 * 4)).toBe("2 d 4 h");
    expect(formatMinutes(60 * 24)).toBe("1 d");
    expect(formatMinutes(null)).toBeNull();
    expect(formatMinutes(-1)).toBeNull();
  });

  it("hitos, puntaje y activación", () => {
    const a = parseActivation(base)!;
    const ms = activationMilestones(a);
    expect(ms.map((m) => m.key)).toEqual(["first_sale", "first_appointment", "first_recurring_customer", "first_pack", "favorites"]);
    expect(ms[0]?.detail).toBe("A 8 min del alta · 12 ventas");
    expect(ms.filter((m) => m.done).map((m) => m.key)).toEqual(["first_sale", "first_recurring_customer", "favorites"]);
    expect(ms[4]?.detail).toBe("6 favoritos · 42% de las líneas (30 días)");
    expect(activationScore(a)).toBe(60);
    expect(isActivated(a)).toBe(true);
    expect(isActivated({ ...a, first_recurring_customer_at: null })).toBe(false);
    expect(isActivated({ ...a, first_sale_at: null })).toBe(false);
  });
});

describe("features de F12 (CLAUDE.md §6)", () => {
  it("recursos es Pro y la lista de espera es BASE, las dos dependen de la agenda", () => {
    expect(FEATURE_INFO.agenda_recursos?.minPlan).toBe("Pro");
    expect(featureRequires("agenda_recursos")).toEqual(["agenda"]);
    expect(FEATURE_INFO.lista_espera?.minPlan).toBe("Start");
    expect(featureRequires("lista_espera")).toEqual(["agenda"]);
    const sql = read("supabase/migrations/20261106100000_features_agenda_f12.sql");
    expect(sql).toMatch(/'agenda_recursos'[\s\S]*'ventas', false/);
    expect(sql).toMatch(/'lista_espera'[\s\S]*'ventas', true/);
    expect(sql).toMatch(/'agenda_recursos', \(p\.key in \('pro', 'business', 'enterprise'\)\)/);
  });
});

describe("migraciones de ADR-082", () => {
  it("son cuatro, desde 20261106100000", () => {
    expect(MIGS.length).toBe(4);
  });

  it("RLS con internal_scope(), nunca is_internal() en policies", () => {
    for (const f of MIGS) {
      const sql = read(f);
      expect(sql, f).not.toMatch(/or\s+\(?\s*(select\s+)?is_internal\(\)/i);
      for (const m of sql.matchAll(/create policy [\s\S]*?;/g)) {
        expect(m[0], f).not.toMatch(/is_internal\(\)/);
      }
    }
  });

  it("no toca create_sale", () => {
    for (const f of MIGS) expect(read(f), f).not.toMatch(/function (public\.)?create_sale\(/);
  });

  it("gating y roles en el servidor", () => {
    const r = read("supabase/migrations/20261106100100_agenda_recursos.sql");
    expect(r).toMatch(/create policy agenda_resources_insert[\s\S]*in \('owner', 'manager'\)[\s\S]*'agenda_recursos'/);
    expect(r).toMatch(/feature_not_in_plan: agenda_recursos/);
    expect(r).toMatch(/raise exception 'resource_busy'/);
    expect(r).toMatch(/pg_advisory_xact_lock/);
    const w = read("supabase/migrations/20261106100200_agenda_lista_espera.sql");
    expect(w).toMatch(/create policy agenda_waitlist_insert[\s\S]*in \('owner', 'manager', 'cashier'\)[\s\S]*'lista_espera'/);
    expect(w).toMatch(/feature_not_in_plan: lista_espera/);
    expect(w).toMatch(/'waitlist_scheduled'/);
    expect(w).not.toMatch(/create policy agenda_waitlist_delete/);
    const d = read("supabase/migrations/20261106100300_activacion_demo_agenda.sql");
    expect(d).toMatch(/if not internal_scope\(\) then/);
    expect(d).toMatch(/'agenda_demo_seeded'/);
    expect(d).toMatch(/'agenda_demo_cleared'/);
    expect(d).toMatch(/a\.sale_id is null/);
  });

  it("sin rayas largas en los textos nuevos", () => {
    const EM_DASH = String.fromCharCode(0x2014);
    for (const f of [
      ...MIGS,
      "modules/agenda/overlap.ts",
      "modules/agenda/waitlist.ts",
      "lib/saas/activation.ts",
      "components/agenda/ResourcesManager.tsx",
      "components/agenda/WaitlistPanel.tsx",
      "components/internal/ActivationCard.tsx",
    ]) {
      expect(read(f).includes(EM_DASH), f).toBe(false);
    }
  });
});
