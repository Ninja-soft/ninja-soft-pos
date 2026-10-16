// ADR-164 · F22 · H146 (L3): planificación entre camiones (heurística local),
// seguimiento (cuándo guardar, lote, desvío, ETA) y el núcleo de la Edge
// routing (OpenRouteService).
import { describe, expect, it } from "vitest";
import {
  DEFAULT_PLAN_OPTIONS,
  formatDuration,
  groupStops,
  moveStop,
  planProblems,
  planRoutes,
  planToConfirm,
  routeMetrics,
  shiftStop,
  truckColor,
  type PlanDispatch,
  type PlanStop,
  type PlanVehicle,
} from "@/lib/logistics/planning";
import {
  DEFAULT_TRACKING,
  ageLabel,
  bufferAck,
  bufferAdd,
  distanceToPathM,
  freshness,
  isPermanentPushError,
  liveEta,
  nextDeviation,
  routePath,
  shouldRecord,
  skippedStops,
  toQueued,
  trackingSettings,
  type Fix,
  type QueuedPosition,
} from "@/lib/logistics/tracking";
import {
  buildDirectionsBody,
  buildOptimizationBody,
  decodePolyline,
  encodePolyline,
  optimizeInputFromBody,
  orsProfile,
  parseDirections,
  parseOptimization,
  simplifyPath,
} from "@/supabase/functions/_shared/routing/core";
import { distanceM } from "@/lib/logistics/logic";

const ORIGIN = { lat: -34.6, lng: -58.45 };

/** Paradas al azar (con semilla) alrededor del origen, en 4 localidades. */
function randomStops(n: number, seed = 7): PlanStop[] {
  let x = seed;
  const rnd = () => {
    x = (x * 16807) % 2147483647;
    return x / 2147483647;
  };
  const locs = ["Palermo", "Caballito", "Flores", "Belgrano"];
  return Array.from({ length: n }, (_, i) => ({
    key: `s${i}`,
    dispatchIds: [`d${i}`],
    lat: ORIGIN.lat + (rnd() - 0.5) * 0.12,
    lng: ORIGIN.lng + (rnd() - 0.5) * 0.12,
    locality: locs[i % 4]!,
    packages: 1 + Math.floor(rnd() * 3),
    label: `Cliente ${i}`,
    address: `Calle ${i}`,
  }));
}

const truck = (id: string, cap: number | null, max: number | null = null): PlanVehicle => ({ id, name: id, capacityPackages: cap, maxStops: max });

describe("groupStops", () => {
  it("junta las entregas del mismo cliente y dirección en una parada", () => {
    const d = (id: string, customerId: string | null, addressKey: string, packages = 1): PlanDispatch => ({
      id,
      customerId,
      addressKey,
      lat: -34.6,
      lng: -58.4,
      locality: "Palermo",
      packages,
      label: id,
      address: addressKey,
    });
    const out = groupStops([d("a", "c1", "x"), d("b", "c1", "x", 3), d("c", "c1", "y"), d("e", "c2", "x")]);
    expect(out).toHaveLength(3);
    expect(out[0]).toMatchObject({ dispatchIds: ["a", "b"], packages: 4 });
  });
});

describe("planRoutes (heurística local)", () => {
  it("40 entregas en 3 camiones en menos de 2 s, sin perder ninguna", () => {
    const stops = randomStops(40);
    const res = planRoutes(ORIGIN, stops, [truck("A", 40), truck("B", 40), truck("C", 40)]);
    expect(res.ms).toBeLessThan(2000);
    expect(res.unassigned).toEqual([]);
    const all = res.routes.flatMap((r) => r.stopIds).sort();
    expect(all).toEqual(stops.map((s) => s.key).sort());
    expect(res.routes).toHaveLength(3);
    for (const r of res.routes) {
      expect(r.packages).toBeLessThanOrEqual(40);
      expect(r.distanceM).toBeGreaterThan(0);
      expect(r.durationS).toBeGreaterThan(0);
      // La llegada estimada crece con el orden.
      const offs = r.stopIds.map((k) => r.offsets[k]!);
      expect([...offs].sort((a, b) => a - b)).toEqual(offs);
      // Recorrido: origen, paradas y vuelta.
      expect(r.path[0]).toEqual([ORIGIN.lat, ORIGIN.lng]);
      expect(r.path.at(-1)).toEqual([ORIGIN.lat, ORIGIN.lng]);
    }
  });

  it("respeta la capacidad en bultos y el tope de paradas; lo que no entra queda sin asignar", () => {
    const stops = randomStops(12).map((s) => ({ ...s, packages: 2 }));
    const res = planRoutes(ORIGIN, stops, [truck("A", 6), truck("B", 10, 3)]);
    const a = res.routes.find((r) => r.vehicleId === "A")!;
    const b = res.routes.find((r) => r.vehicleId === "B")!;
    expect(a.packages).toBeLessThanOrEqual(6);
    expect(b.stopIds.length).toBeLessThanOrEqual(3);
    expect(res.unassigned.length).toBe(12 - a.stopIds.length - b.stopIds.length);
    expect(res.unassigned.every((u) => u.reason === "capacidad")).toBe(true);
  });

  it("reparte según la capacidad de cada camión (el grande lleva más)", () => {
    const stops = randomStops(30).map((s) => ({ ...s, packages: 1 }));
    const res = planRoutes(ORIGIN, stops, [truck("chico", 10), truck("grande", 30)]);
    const chico = res.routes.find((r) => r.vehicleId === "chico")!;
    const grande = res.routes.find((r) => r.vehicleId === "grande")!;
    expect(grande.packages).toBeGreaterThan(chico.packages);
    expect(chico.packages).toBeLessThanOrEqual(10);
  });

  it("mantiene juntas las localidades cuando entran", () => {
    // Dos barrios bien separados, dos camiones con lugar de sobra.
    const near = (lat: number, lng: number, loc: string, i: number): PlanStop => ({
      key: `${loc}${i}`,
      dispatchIds: [`${loc}${i}`],
      lat: lat + i * 0.001,
      lng: lng + i * 0.001,
      locality: loc,
      packages: 1,
      label: loc,
      address: loc,
    });
    const stops = [...[0, 1, 2, 3].map((i) => near(-34.55, -58.45, "Norte", i)), ...[0, 1, 2, 3].map((i) => near(-34.65, -58.45, "Sur", i))];
    const res = planRoutes(ORIGIN, stops, [truck("A", 4), truck("B", 4)]);
    for (const r of res.routes) {
      const locs = new Set(r.stopIds.map((k) => stops.find((s) => s.key === k)!.locality));
      expect(locs.size).toBe(1);
    }
  });

  it("sin camiones todo queda sin asignar; las paradas sin ubicación van al final", () => {
    const stops = randomStops(3);
    expect(planRoutes(ORIGIN, stops, []).unassigned.map((u) => u.reason)).toEqual(["sin_camion", "sin_camion", "sin_camion"]);
    const withNoGeo = [...stops, { ...stops[0]!, key: "x", lat: null, lng: null, locality: "Tigre" }];
    const res = planRoutes(ORIGIN, withNoGeo, [truck("A", null)]);
    expect(res.routes[0]!.stopIds.at(-1)).toBe("x");
  });

  it("mover, subir y sacar paradas rehace los números", () => {
    const stops = randomStops(6);
    const opts = DEFAULT_PLAN_OPTIONS;
    let plan = planRoutes(ORIGIN, stops, [truck("A", null), truck("B", null)], opts);
    const a = plan.routes.find((r) => r.vehicleId === "A")!;
    const key = a.stopIds[0]!;
    plan = moveStop(plan, key, "B", stops, ORIGIN, opts);
    expect(plan.routes.find((r) => r.vehicleId === "B")!.stopIds).toContain(key);
    expect(plan.routes.find((r) => r.vehicleId === "A")?.stopIds ?? []).not.toContain(key);
    const b = plan.routes.find((r) => r.vehicleId === "B")!;
    const first = b.stopIds[0]!;
    plan = shiftStop(plan, "B", first, 1, stops, ORIGIN, opts);
    expect(plan.routes.find((r) => r.vehicleId === "B")!.stopIds[1]).toBe(first);
    plan = moveStop(plan, first, null, stops, ORIGIN, opts);
    expect(plan.unassigned).toContainEqual({ key: first, reason: "sin_camion" });
  });

  it("arma lo que se manda a route_plan_confirm (entregas en orden, llegada por entrega) y avisa problemas", () => {
    const stops: PlanStop[] = [
      { key: "k1", dispatchIds: ["d1", "d2"], lat: -34.59, lng: -58.45, locality: "A", packages: 2, label: "Ana", address: "x" },
      { key: "k2", dispatchIds: ["d3"], lat: -34.58, lng: -58.45, locality: "A", packages: 9, label: "Beto", address: "y" },
    ];
    const plan = planRoutes(ORIGIN, stops, [truck("A", null)]);
    const out = planToConfirm(plan, stops, { A: "u1" });
    expect(out[0]).toMatchObject({ vehicle_id: "A", driver_user_id: "u1", dispatch_ids: ["d1", "d2", "d3"] });
    expect(out[0]!.offsets.d1).toBe(out[0]!.offsets.d2);
    expect(planProblems(plan, [truck("A", 5, 1)], {})).toEqual([
      "A: elegí el repartidor (si no, la hoja queda en borrador).",
      "A: lleva 11 bultos y le entran 5.",
      "A: 2 paradas y su tope es 1.",
    ]);
  });

  it("km por calle: línea recta por el factor urbano, sin ubicación suma un tramo promedio", () => {
    const s: PlanStop = { key: "a", dispatchIds: ["a"], lat: -34.59, lng: -58.45, locality: null, packages: 1, label: "", address: "" };
    const straight = distanceM(ORIGIN, { lat: -34.59, lng: -58.45 })!;
    const m = routeMetrics(ORIGIN, [s], { ...DEFAULT_PLAN_OPTIONS, returnToOrigin: false });
    expect(m.distanceM).toBe(Math.round(straight * 1.35));
    const noGeo = routeMetrics(ORIGIN, [{ ...s, lat: null, lng: null }], { ...DEFAULT_PLAN_OPTIONS, returnToOrigin: false });
    expect(noGeo.distanceM).toBe(2000);
  });

  it("textos y colores", () => {
    expect(formatDuration(45 * 60)).toBe("45 min");
    expect(formatDuration(80 * 60)).toBe("1 h 20 min");
    expect(formatDuration(120 * 60)).toBe("2 h");
    expect(truckColor(0)).toBe(truckColor(8));
  });
});

describe("seguimiento", () => {
  const fix = (at: number, lat = -34.6, lng = -58.45, accuracy: number | null = 10): Fix => ({ lat, lng, accuracy, speed: null, heading: null, at });

  it("configuración con defaults y rangos", () => {
    expect(trackingSettings(null)).toEqual(DEFAULT_TRACKING);
    expect(trackingSettings({ interval_s: 5, deviation_m: "800", enabled: false, saved: true })).toMatchObject({ interval_s: 10, deviation_m: 800, enabled: false, saved: true });
  });

  it("guarda cada interval_s si se movió; quieto, cada 2 minutos; mala precisión, nunca", () => {
    const cfg = { interval_s: 30, min_move_m: 50 };
    expect(shouldRecord(null, fix(0), cfg)).toBe(true);
    expect(shouldRecord(null, fix(0, -34.6, -58.45, 900), cfg)).toBe(false);
    expect(shouldRecord(fix(0), fix(20_000, -34.61), cfg)).toBe(false);
    expect(shouldRecord(fix(0), fix(31_000, -34.601), cfg)).toBe(true);
    expect(shouldRecord(fix(0), fix(60_000), cfg)).toBe(false);
    expect(shouldRecord(fix(0), fix(121_000), cfg)).toBe(true);
  });

  it("lote: tope de posiciones sin señal y se saca lo enviado", () => {
    let buf: QueuedPosition[] = [];
    for (let i = 0; i < 5; i++) buf = bufferAdd(buf, toQueued(fix(i * 1000), `p${i}`, { level: 0.5, charging: false }, "dev"), 3);
    expect(buf.map((p) => p.id)).toEqual(["p2", "p3", "p4"]);
    expect(buf[0]).toMatchObject({ bat: 50, chg: false, dev: "dev", acc: 10 });
    expect(bufferAck(buf, buf.slice(0, 2)).map((p) => p.id)).toEqual(["p4"]);
    expect(isPermanentPushError(new Error("route_not_started"))).toBe(true);
    expect(isPermanentPushError(new Error("Failed to fetch"))).toBe(false);
  });

  it("distancia al recorrido (espejo de _path_distance_m: 1102 m en el dry-run)", () => {
    expect(distanceToPathM({ lat: -34.415, lng: -58.568 }, [[-34.4, -58.58], [-34.43, -58.58]])).toBe(1102);
    expect(distanceToPathM({ lat: -34.41, lng: -58.58 }, [[-34.4, -58.58], [-34.43, -58.58]])).toBe(0);
    expect(distanceToPathM({ lat: 0, lng: 0 }, [])).toBeNull();
  });

  it("recorrido sin plan: origen, paradas en orden y vuelta", () => {
    const p = routePath(null, ORIGIN, [{ seq: 2, lat: -34.5, lng: -58.4 }, { seq: 1, lat: -34.55, lng: -58.42 }, { seq: 3, lat: null, lng: null }], true);
    expect(p).toEqual([[ORIGIN.lat, ORIGIN.lng], [-34.55, -58.42], [-34.5, -58.4], [ORIGIN.lat, ORIGIN.lng]]);
    expect(routePath([[1, 1], [2, 2]], ORIGIN, [], true)).toEqual([[1, 1], [2, 2]]);
  });

  it("desvío: 600 m por 5 minutos abre el aviso; volver a la ruta lo cierra; mala precisión no cuenta", () => {
    const cfg = { deviation_m: 600, deviation_minutes: 5 };
    let st = { since: null as number | null, alert: false };
    let r = nextDeviation(st, 700, 0, 10, cfg);
    expect(r).toMatchObject({ since: 0, alert: false, opened: false });
    st = r;
    r = nextDeviation(st, 900, 4 * 60_000, 10, cfg);
    expect(r.opened).toBe(false);
    r = nextDeviation(r, 900, 5 * 60_000, 10, cfg);
    expect(r).toMatchObject({ alert: true, opened: true });
    const again = nextDeviation(r, 950, 6 * 60_000, 10, cfg);
    expect(again.opened).toBe(false);
    expect(nextDeviation(again, 900, 7 * 60_000, 400, cfg)).toMatchObject({ alert: true, opened: false, closed: false });
    expect(nextDeviation(again, 100, 8 * 60_000, 10, cfg)).toMatchObject({ since: null, alert: false, closed: true });
    // Un pico corto no avisa.
    expect(nextDeviation({ since: null, alert: false }, 50, 0, 10, cfg)).toMatchObject({ since: null, alert: false });
  });

  it("llegada estimada desde la última posición, en orden y con los minutos de cada parada", () => {
    const now = Date.UTC(2026, 9, 16, 15, 0, 0);
    const eta = liveEta(now, ORIGIN, [{ id: "b", seq: 2, lat: -34.62, lng: -58.45 }, { id: "a", seq: 1, lat: -34.61, lng: -58.45 }], { avg_speed_kmh: 30, service_minutes: 5 });
    expect(eta.a).toBeGreaterThan(now);
    expect(eta.b! - eta.a!).toBeGreaterThan(5 * 60_000);
  });

  it("antigüedad, frescura y paradas salteadas", () => {
    expect(ageLabel(40_000)).toBe("hace 40 s");
    expect(ageLabel(3 * 60_000)).toBe("hace 3 min");
    expect(freshness(30_000)).toBe("vivo");
    expect(freshness(3 * 60_000)).toBe("demorado");
    expect(freshness(10 * 60_000)).toBe("sin_senal");
    expect(skippedStops([{ seq: 1, status: "entregada" }, { seq: 2, status: "en_camino" }, { seq: 3, status: "entregada" }, { seq: 4, status: "en_camino" }])).toEqual([2]);
    expect(skippedStops([{ seq: 1, status: "entregada" }, { seq: 2, status: "en_camino" }])).toEqual([]);
  });
});

describe("Edge routing (OpenRouteService)", () => {
  it("polyline: ida y vuelta, y texto roto no cuelga", () => {
    const pts: [number, number][] = [[-34.6, -58.45], [-34.61, -58.46], [-34.615, -58.4]];
    expect(decodePolyline(encodePolyline(pts))).toEqual(pts);
    // Ejemplo de la documentación de Google.
    expect(decodePolyline("_p~iF~ps|U_ulLnnqC_mqNvxq`@")).toEqual([[38.5, -120.2], [40.7, -120.95], [43.252, -126.453]]);
    expect(() => decodePolyline("_p~iF~")).not.toThrow();
  });

  it("simplifica el recorrido sin perder la forma", () => {
    const line: [number, number][] = Array.from({ length: 100 }, (_, i) => [-34.6 + i * 0.0001, -58.45]);
    const s = simplifyPath(line, 5);
    expect(s).toHaveLength(2);
    expect(simplifyPath([...line, [-34.59, -58.4]], 5).length).toBe(3);
  });

  it("pedido de optimización con ids enteros, capacidad, tope de paradas y vuelta", () => {
    const { body, jobIds, vehicleIds } = buildOptimizationBody({
      origin: ORIGIN,
      stops: [{ id: "s1", lat: -34.61, lng: -58.46, packages: 2.4 }],
      vehicles: [{ id: "v1", kind: "camion", capacityPackages: 20, maxStops: 10 }, { id: "v2", kind: "moto", capacityPackages: null, maxStops: null }],
      serviceS: 300,
      returnToOrigin: true,
    });
    expect(jobIds).toEqual(["s1"]);
    expect(vehicleIds).toEqual(["v1", "v2"]);
    expect(body).toMatchObject({
      jobs: [{ id: 1, location: [-58.46, -34.61], amount: [2], service: 300 }],
      vehicles: [
        { id: 1, profile: "driving-hgv", start: [-58.45, -34.6], end: [-58.45, -34.6], capacity: [20], max_tasks: 10 },
        { id: 2, profile: "driving-car", capacity: [100000] },
      ],
      options: { g: true },
    });
    expect(orsProfile("bici")).toBe("cycling-regular");
  });

  it("respuesta de VROOM a hojas con nuestros ids, llegada por parada y lo que no entró", () => {
    const geometry = encodePolyline([[-34.6, -58.45], [-34.61, -58.46], [-34.6, -58.45]]);
    const out = parseOptimization(
      {
        routes: [
          {
            vehicle: 2,
            distance: 5300,
            duration: 900,
            service: 600,
            geometry,
            steps: [{ type: "start" }, { type: "job", id: 2, arrival: 400 }, { type: "job", job: 1, arrival: 800 }, { type: "end" }],
          },
        ],
        unassigned: [{ id: 3 }],
      },
      ["a", "b", "c"],
      ["v1", "v2"],
    );
    expect(out).toEqual({
      routes: [{ vehicleId: "v2", stopIds: ["b", "a"], distanceM: 5300, durationS: 1500, offsets: { b: 400, a: 800 }, path: expect.any(Array) }],
      unassigned: ["c"],
    });
    expect(out!.routes[0]!.path.length).toBeGreaterThanOrEqual(2);
    expect(parseOptimization({ error: "x" }, [], [])).toBeNull();
  });

  it("trazado por calles: GeoJSON de ORS a recorrido, km, minutos y tramos", () => {
    expect(buildDirectionsBody([[-34.6, -58.45], [-34.61, -58.46]])).toMatchObject({ coordinates: [[-58.45, -34.6], [-58.46, -34.61]] });
    const out = parseDirections({
      features: [
        {
          geometry: { coordinates: [[-58.45, -34.6], [-58.455, -34.605], [-58.46, -34.61]] },
          properties: { summary: { distance: 1500.4, duration: 300.2 }, segments: [{ distance: 1500.4, duration: 300.2 }] },
        },
      ],
    });
    expect(out).toMatchObject({ distanceM: 1500, durationS: 300, legs: [{ distanceM: 1500, durationS: 300 }] });
    expect(out!.path[0]).toEqual([-34.6, -58.45]);
    expect(parseDirections({})).toBeNull();
  });

  it("valida lo que manda el panel antes de gastar cupo", () => {
    const ok = optimizeInputFromBody({ origin: ORIGIN, stops: [{ id: "a", lat: -34.6, lng: -58.4 }], vehicles: [{ id: "v" }] });
    expect(ok).toMatchObject({ serviceS: 300, returnToOrigin: true, stops: [{ packages: 1 }] });
    expect(optimizeInputFromBody({ origin: { lat: 0, lng: 0 }, stops: [], vehicles: [] })).toBeNull();
    expect(optimizeInputFromBody({ origin: ORIGIN, stops: [{ id: "a", lat: 200, lng: 0 }], vehicles: [{ id: "v" }] })).toBeNull();
    expect(
      optimizeInputFromBody({ origin: ORIGIN, stops: Array.from({ length: 151 }, (_, i) => ({ id: `${i}`, lat: -34.6, lng: -58.4 })), vehicles: [{ id: "v" }] }),
    ).toBeNull();
  });
});
