// @vitest-environment node
// Estados normalizados de envíos (ADR-103): regla de avance, dedupe, fechas y
// el espejo con la base (_shipping_status_rank y el CHECK de shipments).
import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  STATUS_RANK,
  SHIPMENT_STATUSES,
  applyTrackingEvents,
  argentinaIso,
  dedupeEvents,
  isFinal,
} from "@/supabase/functions/_shared/shipping/status";
import { STATUS_GROUPS, STATUS_LABEL, STATUS_TONE } from "@/lib/shipping/status";
import type { TrackingEvent } from "@/supabase/functions/_shared/shipping/types";

const ev = (status: TrackingEvent["status"], at: string, extra: Partial<TrackingEvent> = {}): TrackingEvent => ({
  status,
  carrier_status: status ?? "info",
  occurred_at: at,
  ...extra,
});

const MIG = path.join(process.cwd(), "supabase", "migrations");
const sql = (f: string) => fs.readFileSync(path.join(MIG, f), "utf8");

describe("applyTrackingEvents", () => {
  it("manda el evento más reciente con estado", () => {
    expect(
      applyTrackingEvents("label_ready", [
        ev("picked_up", "2026-10-13T10:00:00Z"),
        ev("in_transit", "2026-10-13T12:00:00Z"),
        ev(null, "2026-10-13T13:00:00Z"),
      ]),
    ).toBe("in_transit");
  });

  it("empate de hora: gana el de más avance", () => {
    expect(applyTrackingEvents("created", [ev("in_transit", "2026-10-13T10:00:00Z"), ev("delivered", "2026-10-13T10:00:00Z")])).toBe(
      "delivered",
    );
  });

  it("'created' no pisa la etiqueta lista, pero sí un pendiente", () => {
    expect(applyTrackingEvents("label_ready", [ev("created", "2026-10-13T10:00:00Z")])).toBe("label_ready");
    expect(applyTrackingEvents("pending", [ev("created", "2026-10-13T10:00:00Z")])).toBe("created");
  });

  it("un envío final no cambia", () => {
    for (const s of ["delivered", "returned", "cancelled"] as const) {
      expect(applyTrackingEvents(s, [ev("in_transit", "2030-01-01T00:00:00Z")])).toBe(s);
      expect(isFinal(s)).toBe(true);
    }
  });

  it("sin eventos con estado no cambia", () => {
    expect(applyTrackingEvents("in_transit", [ev(null, "2026-10-13T10:00:00Z")])).toBe("in_transit");
  });
});

describe("dedupe y fechas", () => {
  it("dedupe por id externo o por estado + fecha al segundo", () => {
    const a = ev("picked_up", "2026-10-13T10:00:00.000Z", { external_event_id: "e1" });
    const b = ev("picked_up", "2026-10-13T11:00:00.000Z", { external_event_id: "e1" });
    const c = ev("in_transit", "2026-10-13T12:00:00.100Z");
    const d = ev("in_transit", "2026-10-13T12:00:00.900Z");
    expect(dedupeEvents([a, b, c, d])).toEqual([a, c]);
  });

  it("fecha del carrier sin zona = hora de Argentina", () => {
    expect(argentinaIso("2026-07-24T16:28:37")).toBe("2026-07-24T19:28:37.000Z");
    expect(argentinaIso("2026-10-13T08:17:19-03:00")).toBe("2026-10-13T11:17:19.000Z");
    expect(argentinaIso("2026-10-13T11:17:19Z")).toBe("2026-10-13T11:17:19.000Z");
    expect(argentinaIso("cualquiera")).toBeNull();
    expect(argentinaIso("")).toBeNull();
  });
});

describe("espejo con la base", () => {
  it("el CHECK de shipments.status tiene exactamente los estados normalizados", () => {
    const s = sql("20261110300100_envios_nucleo.sql");
    const block = s.slice(s.indexOf("status              text not null default 'draft'"), s.indexOf("status_detail"));
    const found = Array.from(block.matchAll(/'([a-z_]+)'/g)).map((m) => m[1]).filter((x) => x !== "draft" || true);
    expect(new Set(found)).toEqual(new Set(SHIPMENT_STATUSES));
  });

  it("_shipping_status_rank coincide con STATUS_RANK", () => {
    const s = sql("20261110300200_envios_rpc.sql");
    const fn = s.slice(s.indexOf("create or replace function _shipping_status_rank"), s.indexOf("else 0 end;"));
    const pairs = Array.from(fn.matchAll(/when '([a-z_]+)' then (\d+)/g)).map((m) => [m[1]!, Number(m[2])] as const);
    expect(Object.fromEntries(pairs)).toEqual(STATUS_RANK);
  });

  it("cada estado tiene etiqueta y tono en la UI, y los grupos del filtro los cubren", () => {
    for (const s of SHIPMENT_STATUSES) {
      expect(STATUS_LABEL[s], s).toBeTruthy();
      expect(STATUS_TONE[s], s).toBeTruthy();
    }
    const grouped = STATUS_GROUPS.flatMap((g) => g.statuses);
    expect(new Set(grouped)).toEqual(new Set(SHIPMENT_STATUSES));
  });
});
