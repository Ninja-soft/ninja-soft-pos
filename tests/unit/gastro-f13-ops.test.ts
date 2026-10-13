import { describe, it, expect } from "vitest";
import {
  KDS_SLA_FALLBACK,
  KdsSlaConfigSchema,
  kdsTone,
  parseKdsSla,
  resolveKdsSla,
} from "@/lib/gastro/kdsSla";
import {
  isOverQuoted,
  normalizeArPhone,
  sortWaitlist,
  suggestTables,
  waitedMinutes,
  waitlistPositions,
  waitlistWhatsappLink,
  type WaitlistEntryLike,
} from "@/lib/gastro/waitlist";
import { splitTips, tipsTotal } from "@/lib/gastro/tips";
import {
  diningErrorMessage,
  isItemSent,
  moveTargets,
  validateVoid,
} from "@/lib/gastro/tableOps";

describe("KDS · SLA por estación", () => {
  it("sin configuración usa 5/10", () => {
    expect(resolveKdsSla({}, "cocina")).toEqual(KDS_SLA_FALLBACK);
    expect(resolveKdsSla(null, null)).toEqual({ warn: 5, late: 10 });
  });

  it("la estación pisa al default y el default pisa al fallback", () => {
    const cfg = { default: { warn: 7, late: 12 }, parrilla: { warn: 15, late: 25 } };
    expect(resolveKdsSla(cfg, "parrilla")).toEqual({ warn: 15, late: 25 });
    expect(resolveKdsSla(cfg, "barra")).toEqual({ warn: 7, late: 12 });
    expect(resolveKdsSla(cfg, null)).toEqual({ warn: 7, late: 12 });
  });

  it("tono por minutos; listo nunca alerta", () => {
    const r = { warn: 3, late: 6 };
    expect(kdsTone(2, r)).toBe("ok");
    expect(kdsTone(3, r)).toBe("warn");
    expect(kdsTone(6, r)).toBe("late");
    expect(kdsTone(60, r, true)).toBe("ok");
  });

  it("parse descarta reglas inválidas (espejo del CHECK SQL)", () => {
    const parsed = parseKdsSla({
      cocina: { warn: 8, late: 15 },
      barra: { warn: 10, late: 5 },
      postres: { warn: 1.5, late: 4 },
      parrilla: "x",
      cafeteria: { warn: 2, late: 300 },
    });
    expect(parsed).toEqual({ cocina: { warn: 8, late: 15 } });
    expect(parseKdsSla(null)).toEqual({});
    expect(parseKdsSla([1, 2])).toEqual({});
  });

  it("el schema rechaza aviso >= demora", () => {
    expect(KdsSlaConfigSchema.safeParse({ default: { warn: 5, late: 5 } }).success).toBe(false);
    expect(KdsSlaConfigSchema.safeParse({ default: { warn: 4, late: 5 } }).success).toBe(true);
  });
});

describe("Lista de espera", () => {
  const base = Date.parse("2026-10-13T21:00:00Z");
  const e = (id: string, mins: number, extra: Partial<WaitlistEntryLike> = {}): WaitlistEntryLike => ({
    id,
    status: "esperando",
    priority: 0,
    created_at: new Date(base + mins * 60_000).toISOString(),
    quoted_minutes: null,
    party_size: 2,
    ...extra,
  });

  it("prioridad primero, después orden de llegada, cerrados al final", () => {
    const list = [e("a", 0), e("b", 5, { priority: 1 }), e("c", 2), e("d", -10, { status: "sentado" })];
    expect(sortWaitlist(list).map((x) => x.id)).toEqual(["b", "a", "c", "d"]);
    const pos = waitlistPositions(list);
    expect(pos.get("b")).toBe(1);
    expect(pos.get("c")).toBe(3);
    expect(pos.has("d")).toBe(false);
  });

  it("minutos esperados y demora contra lo prometido", () => {
    const x = e("a", 0, { quoted_minutes: 20 });
    expect(waitedMinutes(x.created_at, base + 15 * 60_000)).toBe(15);
    expect(isOverQuoted(x, base + 15 * 60_000)).toBe(false);
    expect(isOverQuoted(x, base + 21 * 60_000)).toBe(true);
    expect(isOverQuoted(e("b", 0), base + 999 * 60_000)).toBe(false);
  });

  it("sugiere la mesa libre más chica que alcanza", () => {
    const tables = [
      { id: "1", label: "1", status: "libre", capacity: 6 },
      { id: "2", label: "2", status: "libre", capacity: 4 },
      { id: "3", label: "3", status: "ocupada", capacity: 4 },
      { id: "4", label: "4", status: "libre", capacity: 2 },
    ];
    expect(suggestTables(tables, 3).map((t) => t.id)).toEqual(["2", "1", "4"]);
  });

  it("normaliza teléfonos argentinos para WhatsApp", () => {
    expect(normalizeArPhone("011 15 2345-6789")).toBe("5491123456789");
    expect(normalizeArPhone("11 2345 6789")).toBe("5491123456789");
    expect(normalizeArPhone("+54 9 341 555 1234")).toBe("5493415551234");
    expect(normalizeArPhone("+54 341 555 1234")).toBe("5493415551234");
    expect(normalizeArPhone("123")).toBeNull();
    expect(waitlistWhatsappLink(null, "hola")).toBeNull();
    expect(waitlistWhatsappLink("1123456789", "Hola Ana")).toBe(
      "https://wa.me/5491123456789?text=Hola%20Ana",
    );
  });
});

describe("Reparto de propinas", () => {
  const rows = [
    { waiter: "Ana", tips: 1000, orders: 4 },
    { waiter: "Beto", tips: 500.5, orders: 2 },
    { waiter: "Caro", tips: 0, orders: 1 },
    { waiter: "Sin mesas", tips: 0, orders: 0 },
  ];

  it("por mozo: cada uno lo suyo", () => {
    expect(splitTips(rows, "por_mozo").map((r) => r.share)).toEqual([1000, 500.5, 0]);
  });

  it("pozo común: partes iguales que suman exacto el total", () => {
    const shares = splitTips(rows, "pozo");
    expect(shares).toHaveLength(3);
    const sum = Math.round(shares.reduce((a, r) => a + r.share, 0) * 100) / 100;
    expect(sum).toBe(tipsTotal(rows));
    expect(shares.map((s) => s.share)).toEqual([500.17, 500.17, 500.16]);
  });

  it("sin mozos no reparte", () => {
    expect(splitTips([], "pozo")).toEqual([]);
  });
});

describe("Mover / unir mesas y anulaciones", () => {
  const tables = [
    { id: "a", label: "1", status: "ocupada", current_order_id: "o1", area_id: null },
    { id: "b", label: "10", status: "libre", current_order_id: null, area_id: null },
    { id: "c", label: "2", status: "cuenta_pedida", current_order_id: "o2", area_id: null },
    { id: "d", label: "3", status: "bloqueada", current_order_id: null, area_id: null },
    { id: "e", label: "4", status: "reservada", current_order_id: null, area_id: null },
    { id: "f", label: "5", status: "libre", current_order_id: null, area_id: null },
  ];

  it("destinos: libres para mover, ocupadas para unir; sin origen, bloqueadas ni reservadas", () => {
    const t = moveTargets(tables, "a");
    expect(t.map((x) => [x.table.id, x.mode])).toEqual([
      ["f", "mover"],
      ["b", "mover"],
      ["c", "unir"],
    ]);
  });

  it("ítem enviado = impreso o tocado por cocina", () => {
    expect(isItemSent({ printed_at: null, kds_status: "pendiente" })).toBe(false);
    expect(isItemSent({ printed_at: "2026-10-13T20:00:00Z", kds_status: "pendiente" })).toBe(true);
    expect(isItemSent({ printed_at: null, kds_status: "preparando" })).toBe(true);
    expect(isItemSent({})).toBe(false);
  });

  it("valida la anulación", () => {
    expect(validateVoid(2, 1, "Error de carga")).toEqual({ ok: true });
    expect(validateVoid(2, 3, "Error de carga").ok).toBe(false);
    expect(validateVoid(2, 0, "Error de carga").ok).toBe(false);
    expect(validateVoid(2, 1, " a ").ok).toBe(false);
  });

  it("traduce los códigos de error del servidor", () => {
    expect(diningErrorMessage({ message: "item_sent_use_void" })).toMatch(/motivo/);
    expect(diningErrorMessage(new Error("table_reserved"))).toMatch(/reservada/);
    expect(diningErrorMessage(new Error("otra cosa"))).toBe("otra cosa");
    expect(diningErrorMessage(null)).toBeUndefined();
  });
});
