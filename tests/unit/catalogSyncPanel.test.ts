// Pestaña Catálogos del panel interno (rediseño, ADR-113): estado por tienda
// en la corrida, tiempo transcurrido y estimación, y la baldosa del logo.
import { describe, it, expect } from "vitest";
import { estimateEta, parseSyncRun, runIsFull, storeRowState, type SyncRun } from "@/modules/internal/catalogSync";
import { storeInitials, storeTilePadding } from "@/components/catalog/StoreLogo";

const run = (row: Record<string, unknown>): SyncRun =>
  parseSyncRun({ id: "r", trigger: "manual", status: "running", started_at: "2026-10-13T09:00:00Z", stores: {}, ...row });

const stores = {
  A: { label: "A", done: true },
  B: { label: "B", done: true, error: "feed 502" },
  C: { label: "C", done: false },
  D: { label: "D", done: false },
};

describe("storeRowState", () => {
  it("leyendo el feed: todas en curso sin porcentaje", () => {
    const r = run({ stores: { C: { label: "C" } }, feed: { done: false, pages: 3 } });
    expect(storeRowState(r, r.stores[0]!)).toEqual({ state: "running", pct: null });
  });

  it("cerrando tiendas: OK, Error, en curso y pendiente", () => {
    const r = run({ stores, feed: { done: true }, current_store: "C" });
    const by = Object.fromEntries(r.stores.map((s) => [s.key, storeRowState(r, s)]));
    expect(by.A).toEqual({ state: "ok", pct: 100 });
    expect(by.B).toEqual({ state: "error", pct: 100 });
    expect(by.C).toEqual({ state: "running", pct: null });
    expect(by.D).toEqual({ state: "pending", pct: 0 });
  });

  it("pausada o cancelada: nada en curso", () => {
    const paused = run({ stores, feed: { done: true }, current_store: "C", paused_at: "2026-10-13T09:10:00Z" });
    expect(storeRowState(paused, paused.stores.find((s) => s.key === "C")!).state).toBe("pending");
    const cancelled = run({ stores, status: "cancelled", feed: { done: false } });
    expect(storeRowState(cancelled, cancelled.stores.find((s) => s.key === "C")!).state).toBe("pending");
  });
});

describe("estimateEta", () => {
  const prevInc = run({ id: "p1", status: "ok", mode: "incremental", started_at: "2026-10-10T09:00:00Z", finished_at: "2026-10-10T09:30:00Z" });
  const prevFull = run({ id: "p2", status: "ok", mode: "full", force_full: true, started_at: "2026-10-01T09:00:00Z", finished_at: "2026-10-01T15:00:00Z" });
  const now = new Date("2026-10-13T09:20:00Z");

  it("según la última corrida del mismo tipo", () => {
    const cur = run({ feed: { full: false, done: false } });
    expect(estimateEta(cur, [cur, prevFull, prevInc], now)).toEqual({ elapsedMs: 20 * 60_000, etaMs: 10 * 60_000, basis: "incremental" });
    const full = run({ force_full: true, feed: { full: true, done: false } });
    expect(estimateEta(full, [full, prevInc, prevFull], now).etaMs).toBe(5 * 3_600_000 + 40 * 60_000);
  });

  it("sin referencia, pausada o pasada de tiempo", () => {
    const cur = run({ feed: { full: false } });
    expect(estimateEta(cur, [cur, prevFull], now).etaMs).toBeNull();
    const paused = run({ paused_at: "2026-10-13T09:10:00Z", feed: { full: false } });
    expect(estimateEta(paused, [paused, prevInc], now).etaMs).toBeNull();
    expect(estimateEta(cur, [prevInc], new Date("2026-10-13T10:00:00Z")).etaMs).toBe(0);
  });

  it("tipo de corrida sin feed todavía: por force_full", () => {
    expect(runIsFull(run({ force_full: true }))).toBe(true);
    expect(runIsFull(run({ mode: "incremental" }))).toBe(false);
  });
});

describe("StoreLogo", () => {
  it("margen mínimo del ícono, sin baldosa", () => {
    expect(storeTilePadding(16)).toBe(1);
    expect(storeTilePadding(28)).toBe(1);
    expect(storeTilePadding(36)).toBe(1);
  });

  it("iniciales", () => {
    expect(storeInitials("Tienda BNA")).toBe("TB");
    expect(storeInitials("Coto")).toBe("CO");
    expect(storeInitials("")).toBe("?");
  });
});
