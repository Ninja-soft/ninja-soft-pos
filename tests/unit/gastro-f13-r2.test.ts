import { describe, it, expect } from "vitest";
import fs from "node:fs";
import path from "node:path";
import {
  dinerLabel,
  dinerLines,
  dinerSummary,
  equalShareLines,
  linesTotal,
  nextEqualPart,
  parsePartLabel,
  partLabel,
  roundQty,
} from "@/lib/gastro/splitBill";
import {
  courseColumns,
  groupByCourse,
  heldOnlyOrders,
  nextHeldCourse,
  orderColumns,
} from "@/lib/gastro/kdsGroups";
import { waitlistReadyMessage } from "@/lib/gastro/waitlist";
import { diningErrorMessage } from "@/lib/gastro/tableOps";

// ADR-097: segunda ronda de F13 (cuenta por comensal, KDS por curso con
// prioridad, anulación de delivery y aviso automático a la lista de espera).

const items = [
  { id: "a", qty: 3, unit_price: 1000, diner: null },
  { id: "b", qty: 1, unit_price: 500, diner: 2 },
  { id: "c", qty: 2, unit_price: 750, diner: 1 },
  { id: "d", qty: 1, unit_price: 300, diner: 2 },
];

describe("Cuenta por comensal", () => {
  it("suma cada comensal y deja aparte lo compartido", () => {
    const s = dinerSummary(items);
    expect(s.diners.map((d) => [d.diner, d.total])).toEqual([
      [1, 1500],
      [2, 800],
    ]);
    expect(s.shared.total).toBe(3000);
    expect(s.shared.items.map((i) => i.id)).toEqual(["a"]);
  });

  it("las líneas de un comensal van enteras", () => {
    expect(dinerLines(items, 2)).toEqual([
      { item_id: "b", qty: null },
      { item_id: "d", qty: null },
    ]);
    expect(dinerLabel(3)).toBe("Comensal 3");
  });
});

describe("Partes iguales", () => {
  it("cada parte lleva la fracción de cada línea y la última se lleva el resto", () => {
    const lines = equalShareLines([{ id: "m", qty: 1, unit_price: 1000, diner: null }], 3);
    expect(lines).toEqual([{ item_id: "m", qty: 0.333 }]);
    expect(linesTotal([{ id: "m", qty: 1, unit_price: 1000, diner: null }], lines)).toBe(333);
    // Quedan 0,667 en 2 partes: 0,334 (redondeo) y el resto en la última.
    const second = equalShareLines([{ id: "m", qty: 0.667, unit_price: 1000, diner: null }], 2);
    expect(second[0]!.qty).toBe(roundQty(0.667 / 2));
    const last = equalShareLines([{ id: "m", qty: 0.333, unit_price: 1000, diner: null }], 1);
    expect(last).toEqual([{ item_id: "m", qty: null }]);
  });

  it("las tres partes cuadran con el total de la cuenta", () => {
    let qty = 1;
    let paid = 0;
    for (let remaining = 3; remaining >= 1; remaining--) {
      const it = { id: "m", qty, unit_price: 1000, diner: null };
      const [line] = equalShareLines([it], remaining);
      const take = line!.qty ?? qty;
      paid += linesTotal([it], [line!]);
      qty = roundQty(qty - take);
    }
    expect(qty).toBe(0);
    expect(paid).toBe(1000);
  });

  it("etiquetas de parte y continuidad del reparto", () => {
    expect(partLabel(2, 3)).toBe("Parte 2 de 3");
    expect(parsePartLabel("Parte 2 de 3")).toEqual({ part: 2, parts: 3 });
    expect(parsePartLabel("Comensal 2")).toBeNull();
    expect(parsePartLabel("Parte 4 de 3")).toBeNull();
    expect(nextEqualPart([], 4)).toEqual({ part: 1, parts: 4, remaining: 4 });
    expect(nextEqualPart([], 1)).toEqual({ part: 1, parts: 2, remaining: 2 });
    expect(
      nextEqualPart(
        [
          { split_label: "Parte 1 de 3", status: "cobrada" },
          { split_label: "Comensal 2", status: "cobrada" },
          { split_label: "Parte 2 de 3", status: "cancelada" },
        ],
        2,
      ),
    ).toEqual({ part: 2, parts: 3, remaining: 2 });
  });
});

describe("KDS por pedido y por curso", () => {
  const kds = [
    { order_id: "o1", course: 2, priority: "normal", created_at: "2026-10-13T20:00:00Z" },
    { order_id: "o1", course: 1, priority: "normal", created_at: "2026-10-13T20:01:00Z" },
    { order_id: "o2", course: 1, priority: "urgente", created_at: "2026-10-13T20:02:00Z" },
  ];

  it("urgentes primero y después por orden de llegada", () => {
    expect(orderColumns(kds).map((c) => [c.orderId, c.urgent])).toEqual([
      ["o2", true],
      ["o1", false],
    ]);
  });

  it("agrupa por curso ascendente", () => {
    expect(groupByCourse(kds).map((g) => g.course)).toEqual([1, 2]);
    const cols = courseColumns(kds);
    expect(cols[0]!.items.map((i) => i.order_id)).toEqual(["o2", "o1"]);
  });

  it("próximo curso en espera y pedidos que sólo esperan", () => {
    const held = [
      { order_id: "o1", course: 3, held: 2, priority: "normal", first_at: "2026-10-13T20:00:00Z" },
      { order_id: "o1", course: 2, held: 1, priority: "normal", first_at: "2026-10-13T20:00:00Z" },
      { order_id: "o3", course: 2, held: 4, priority: "normal", first_at: "2026-10-13T19:00:00Z" },
      { order_id: "o4", course: 1, held: 1, priority: "urgente", first_at: "2026-10-13T21:00:00Z" },
    ];
    expect(nextHeldCourse(held, "o1")!.course).toBe(2);
    expect(nextHeldCourse(held, "o9")).toBeNull();
    expect(heldOnlyOrders(held, new Set(["o1"])).map((h) => h.order_id)).toEqual(["o4", "o3"]);
  });
});

describe("Aviso a la lista de espera", () => {
  it("el mensaje del cliente coincide con el del servidor", () => {
    expect(waitlistReadyMessage("Ana", "Resto", "3")).toBe(
      "Hola Ana, tu mesa en Resto ya está lista (mesa 3). Te esperamos.",
    );
    expect(waitlistReadyMessage(" Beto ")).toBe("Hola Beto, tu mesa ya está lista. Te esperamos.");
  });
});

describe("Mensajes de error nuevos", () => {
  it("traduce los códigos de cuenta separada y aviso", () => {
    expect(diningErrorMessage(new Error("order_has_open_splits"))).toMatch(/cuentas separadas/);
    expect(diningErrorMessage(new Error("split_use_unsplit"))).toMatch(/deshace/);
    expect(diningErrorMessage(new Error("notice_closed"))).toMatch(/aviso/);
  });
});

describe("Migraciones de la ronda 2 (estático)", () => {
  const dir = path.join(process.cwd(), "supabase", "migrations");
  const files = fs.readdirSync(dir).filter((f) => f.startsWith("20261109600"));
  const sql = files.map((f) => fs.readFileSync(path.join(dir, f), "utf8")).join("\n");

  it("son cuatro y no recrean create_sale", () => {
    expect(files).toHaveLength(4);
    expect(sql).not.toMatch(/function\s+(public\.)?create_sale\s*\(/i);
  });

  it("policies con (select current_tenant_id()) y sin is_internal()", () => {
    const policies = sql.match(/create policy[\s\S]*?;/gi) ?? [];
    expect(policies.length).toBeGreaterThan(0);
    for (const p of policies) {
      expect(p).toMatch(/\(select current_tenant_id\(\)\)/);
      expect(p).not.toMatch(/is_internal\(\)/);
    }
  });

  it("tablas nuevas con role_write_guard y sin DEFAULT current_tenant_id()", () => {
    for (const t of ["delivery_order_voids", "dining_waitlist_notices"]) {
      expect(sql).toMatch(new RegExp(`create table if not exists ${t}`));
      expect(sql).toMatch(new RegExp(`create trigger role_write_guard[^;]*on ${t}`));
    }
    expect(sql).not.toMatch(/default current_tenant_id\(\)/i);
  });

  it("las RPCs SECURITY DEFINER fijan search_path", () => {
    const fns = sql.match(/create or replace function[\s\S]*?\$\$;/gi) ?? [];
    for (const f of fns) {
      if (/security definer/i.test(f)) expect(f).toMatch(/set search_path/i);
    }
  });
});
