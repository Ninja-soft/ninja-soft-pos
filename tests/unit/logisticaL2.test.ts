// ADR-161 · F22 · H145 (L2 de ADR-149): flota, hojas de ruta y app del
// repartidor. Lógica pura (configuración, orden por cercanía, exigencias de la
// entrega, vencimientos, errores), cola offline, rol Repartidor y la
// migración (feature, RLS con initplan, sin is_internal(), auditoría).
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  DEFAULT_FAILURE_REASONS,
  DEFAULT_LOGISTICS_SETTINGS,
  capacityUse,
  distanceM,
  expiryState,
  formatDistance,
  isFar,
  isPermanentEventError,
  logisticsErrorMessage,
  logisticsSettings,
  missingForDelivery,
  missingForFailure,
  missingText,
  navigationLinks,
  normalizePlate,
  orderByProximity,
  phoneLinks,
  plateValid,
  reasonKeyFromLabel,
  routeEditable,
  routeMissing,
  routeNextStatuses,
  settingsProblems,
  stopIsFinal,
} from "@/lib/logistics/logic";
import {
  alreadyUploaded,
  applyPending,
  memoryStore,
  pendingLabel,
  routeMediaPath,
  syncQueue,
  type QueuedAction,
  type Transport,
} from "@/lib/logistics/offline";
import {
  CAPABILITY_BY_KEY,
  DRIVER_ROLE_ID,
  ROLE_TEMPLATES,
  SYSTEM_ROLE_BY_KEY,
  resolveCapabilities,
} from "@/lib/permissions/capabilities";
import { FEATURE_INFO } from "@/lib/saas/featureInfo";
import { homePath } from "@/lib/auth/redirect";
import { copyLabels } from "@/components/remitos/RemitoPrintSet";
import { loadSheet } from "@/components/logistics/routes/RouteSheetPrint";
import type { RouteDetail } from "@/modules/logistics/api";

describe("Configuración › Logística", () => {
  it("defaults sensatos (doc 45 §6): remito a pedido, 2 copias, geo y firma, 300 m", () => {
    const s = logisticsSettings(null);
    expect(s).toMatchObject({
      remito_policy: "a_pedido",
      remito_copies: 2,
      remito_model: "a4",
      require_geo: true,
      require_signature: true,
      require_photo: false,
      max_distance_m: 300,
      saved: false,
    });
    expect(s.failure_reasons.map((r) => r.key)).toContain("no_estaba");
    expect(s.failure_reasons.find((r) => r.key === "no_estaba")!.label).toBe("No estaba en el domicilio");
  });

  it("normaliza lo que manda el servidor y descarta basura", () => {
    const s = logisticsSettings({
      remito_policy: "hackear",
      remito_copies: 9,
      remito_model: "ticket80",
      max_distance_m: "5",
      require_photo: "true",
      remito_copy_labels: ["A", "", "C"],
      failure_reasons: [{ key: "Mal Key!", label: "x" }, { key: "cerrado", label: "Cerrado", requires_photo: true }],
      saved: true,
    });
    expect(s.remito_policy).toBe("a_pedido");
    expect(s.remito_copies).toBe(3);
    expect(s.remito_model).toBe("ticket80");
    expect(s.max_distance_m).toBe(50);
    expect(s.require_photo).toBe(true);
    expect(s.remito_copy_labels).toEqual(["A", "Duplicado: vuelve firmado", "C"]);
    expect(s.failure_reasons).toEqual([{ key: "cerrado", label: "Cerrado", requires_photo: true, requires_note: false, active: true }]);
    expect(s.saved).toBe(true);
  });

  it("claves de motivos nuevos sin acentos ni repetidas", () => {
    expect(reasonKeyFromLabel("Portón cerrado", [])).toBe("porton_cerrado");
    expect(reasonKeyFromLabel("Portón cerrado", ["porton_cerrado"])).toBe("porton_cerrado_2");
    expect(reasonKeyFromLabel("!!", [])).toMatch(/^[a-z0-9_]{2,40}$/);
  });

  it("problemas antes de guardar: motivos vacíos, repetidos o ninguno activo", () => {
    expect(settingsProblems(DEFAULT_LOGISTICS_SETTINGS)).toEqual([]);
    const off = { ...DEFAULT_LOGISTICS_SETTINGS, failure_reasons: DEFAULT_FAILURE_REASONS.map((r) => ({ ...r, active: false })) };
    expect(settingsProblems(off)).toContain("Dejá al menos un motivo activo.");
    const dup = { ...DEFAULT_LOGISTICS_SETTINGS, failure_reasons: [DEFAULT_FAILURE_REASONS[0]!, DEFAULT_FAILURE_REASONS[0]!] };
    expect(settingsProblems(dup).join(" ")).toMatch(/repetido/);
    const noLabel = { ...DEFAULT_LOGISTICS_SETTINGS, remito_copy_labels: ["A", " ", "C"] as [string, string, string] };
    expect(settingsProblems(noLabel)).toContain("Cada copia del remito necesita su leyenda.");
  });
});

describe("Hojas y paradas", () => {
  it("estados editables y transiciones (espejo de route_set_status)", () => {
    expect(routeEditable("borrador")).toBe(true);
    expect(routeEditable("cargando")).toBe(true);
    expect(routeEditable("en_curso")).toBe(false);
    expect(routeNextStatuses("borrador")).toEqual(["planificada"]);
    expect(routeNextStatuses("planificada")).toEqual(["borrador", "cargando"]);
    expect(routeNextStatuses("en_curso")).toEqual([]);
    expect(stopIsFinal("entregada")).toBe(true);
    expect(stopIsFinal("en_el_lugar")).toBe(false);
  });

  it("qué le falta a una hoja para salir", () => {
    expect(routeMissing({ vehicle: false, driver: false, stops: 0 })).toHaveLength(3);
    expect(routeMissing({ vehicle: true, driver: true, stops: 2 })).toEqual([]);
  });
});

describe("Distancias y orden por cercanía", () => {
  const origin = { lat: -34.6, lng: -58.4 };
  it("haversine en metros (espejo de _geo_distance_m)", () => {
    expect(distanceM(origin, origin)).toBe(0);
    const d = distanceM({ lat: -34.42, lng: -58.58 }, { lat: -34.4205, lng: -58.5801 })!;
    expect(d).toBeGreaterThan(50);
    expect(d).toBeLessThan(60);
    expect(distanceM(null, origin)).toBeNull();
    expect(formatDistance(350)).toBe("350 m");
    expect(formatDistance(1234)).toBe("1,2 km");
  });

  it("vecino más cercano + 2-opt; las que no tienen ubicación van al final por localidad", () => {
    const pts = [
      { id: "lejos", lat: -34.9, lng: -58.4 },
      { id: "sin1", lat: null, lng: null, locality: "Tigre" },
      { id: "cerca", lat: -34.61, lng: -58.4 },
      { id: "medio", lat: -34.75, lng: -58.4 },
      { id: "sin2", lat: null, lng: null, locality: "Pilar" },
      { id: "sin3", lat: null, lng: null, locality: "Tigre" },
    ];
    const r = orderByProximity(origin, pts, false);
    expect(r.ids.slice(0, 3)).toEqual(["cerca", "medio", "lejos"]);
    expect(r.ids.slice(3)).toEqual(["sin1", "sin3", "sin2"]);
    expect(r.distanceM).toBeGreaterThan(30_000);
  });

  it("2-opt deshace un cruce", () => {
    // Cuatro puntos en un cuadrado: el orden óptimo recorre el borde.
    const sq = [
      { id: "a", lat: 0, lng: 0.01 },
      { id: "b", lat: 0.01, lng: 0.01 },
      { id: "c", lat: 0.01, lng: 0 },
      { id: "d", lat: 0, lng: 0.02 },
    ];
    const r = orderByProximity({ lat: 0, lng: 0 }, sq, true);
    expect(r.ids).toHaveLength(4);
    expect(new Set(r.ids)).toEqual(new Set(["a", "b", "c", "d"]));
    const naive = orderByProximity({ lat: 0, lng: 0 }, sq, true);
    expect(r.distanceM).toBeLessThanOrEqual(naive.distanceM);
  });

  it("links gratis para navegar y llamar", () => {
    expect(navigationLinks({ lat: -34.4, lng: -58.5, address: null }).google).toContain("destination=-34.4,-58.5");
    expect(navigationLinks({ lat: null, lng: null, address: "Mitre 10, Tigre" }).google).toContain("Mitre%2010");
    expect(phoneLinks("011 4555-0000")).toEqual({ tel: "tel:01145550000", whatsapp: "https://wa.me/541145550000" });
    expect(phoneLinks("12")).toBeNull();
  });
});

describe("Exigencias de la entrega (espejo de delivery_event_record)", () => {
  const draft = { lat: -34.4, lng: -58.5, signature: true, photos: 0, remitoPhoto: false, receivedByName: "Ana", receivedByDoc: "" };
  it("con los defaults: geo, firma y nombre", () => {
    expect(missingForDelivery(DEFAULT_LOGISTICS_SETTINGS, draft)).toEqual([]);
    expect(missingForDelivery(DEFAULT_LOGISTICS_SETTINGS, { ...draft, lat: null, signature: false, receivedByName: "" })).toEqual([
      "geo",
      "signature",
      "receiver_name",
    ]);
  });
  it("foto, DNI y remito firmado cuando la configuración los pide", () => {
    const s = { ...DEFAULT_LOGISTICS_SETTINGS, require_photo: true, require_receiver_doc: true, require_remito_photo: true };
    expect(missingForDelivery(s, draft)).toEqual(["photo", "receiver_doc", "remito_photo"]);
    expect(missingForDelivery(s, { ...draft, photos: 1, receivedByDoc: "30.123.456", remitoPhoto: true })).toEqual([]);
    expect(missingText(["la firma", "una foto"])).toBe("Falta la firma y una foto.");
  });
  it("no entregado: motivo, y foto o nota si el motivo lo pide", () => {
    const cerrado = DEFAULT_FAILURE_REASONS.find((r) => r.key === "cerrado")!;
    const otro = DEFAULT_FAILURE_REASONS.find((r) => r.key === "otro")!;
    expect(missingForFailure(null, { photos: 0, note: "" })).toEqual(["reason"]);
    expect(missingForFailure(cerrado, { photos: 0, note: "" })).toEqual(["photo"]);
    expect(missingForFailure(otro, { photos: 0, note: "ok" })).toEqual(["note"]);
    expect(missingForFailure(otro, { photos: 0, note: "se mudó" })).toEqual([]);
  });
  it("lejos de la dirección según la distancia máxima", () => {
    expect(isFar(301, DEFAULT_LOGISTICS_SETTINGS)).toBe(true);
    expect(isFar(120, DEFAULT_LOGISTICS_SETTINGS)).toBe(false);
    expect(isFar(null, DEFAULT_LOGISTICS_SETTINGS)).toBe(false);
  });
});

describe("Flota", () => {
  it("semáforo de vencimientos", () => {
    expect(expiryState("2026-10-01", "2026-10-15")).toBe("vencido");
    expect(expiryState("2026-11-01", "2026-10-15")).toBe("por_vencer");
    expect(expiryState("2027-06-01", "2026-10-15")).toBe("al_dia");
    expect(expiryState(null, "2026-10-15")).toBe("sin_dato");
  });
  it("patentes como las guarda el servidor", () => {
    expect(normalizePlate(" ab  123 cd ")).toBe("AB 123 CD");
    expect(plateValid("AB123CD")).toBe(true);
    expect(plateValid("")).toBe(true);
    expect(plateValid("A1")).toBe(false);
    expect(capacityUse(8, 10)).toBe(80);
    expect(capacityUse(8, null)).toBeNull();
  });
});

describe("Errores del servidor", () => {
  it("mensajes claros y capacidad faltante", () => {
    expect(logisticsErrorMessage(new Error("remito_missing"))).toMatch(/sin remito/);
    expect(logisticsErrorMessage(new Error("signature_required"))).toMatch(/firma/);
    expect(logisticsErrorMessage({ message: "forbidden_capability", details: "capability:logistics.route.manage" })).toMatch(/Armar hojas de ruta/);
    expect(logisticsErrorMessage(new Error("Failed to fetch"))).toMatch(/Sin conexión/);
  });
  it("la cola no reintenta errores de datos pero sí los de red", () => {
    expect(isPermanentEventError(new Error("stop_closed"))).toBe(true);
    expect(isPermanentEventError(new Error("signature_required"))).toBe(true);
    expect(isPermanentEventError(new Error("Failed to fetch"))).toBe(false);
    expect(isPermanentEventError(new Error("algo raro del servidor"))).toBe(false);
  });
});

function action(id: string, createdAt: string, extra: Partial<QueuedAction> = {}): QueuedAction {
  return {
    id,
    kind: "event",
    routeId: "r1",
    stopId: "s1",
    eventType: "entregado",
    payload: { id },
    media: [],
    createdAt,
    attempts: 0,
    lastError: null,
    failed: false,
    ...extra,
  };
}

describe("Cola offline", () => {
  it("manda en orden, sube las fotos antes y borra lo enviado", async () => {
    const store = memoryStore([
      action("b", "2026-10-15T10:01:00Z", { media: [{ path: "t/routes/r1/b-foto1.webp", blob: new Blob(["x"]), contentType: "image/webp", uploaded: false }] }),
      action("a", "2026-10-15T10:00:00Z", { kind: "start", stopId: null, eventType: undefined }),
    ]);
    const calls: string[] = [];
    const t: Transport = {
      upload: async (p) => void calls.push(`up:${p}`),
      send: async (a) => void calls.push(`send:${a.id}`),
    };
    const r = await syncQueue(store, t, isPermanentEventError);
    expect(calls).toEqual(["send:a", "up:t/routes/r1/b-foto1.webp", "send:b"]);
    expect(r).toEqual({ sent: 2, failed: 0, pending: 0, offline: false });
    expect(store.items.size).toBe(0);
  });

  it("sin red corta y conserva el orden; la foto ya subida no se vuelve a subir", async () => {
    const store = memoryStore([
      action("a", "2026-10-15T10:00:00Z", { media: [{ path: "p1", blob: new Blob(["x"]), contentType: "image/webp", uploaded: false }] }),
      action("b", "2026-10-15T10:01:00Z"),
    ]);
    let uploads = 0;
    let fail = true;
    const t: Transport = {
      upload: async () => void uploads++,
      send: async () => {
        if (fail) throw new Error("Failed to fetch");
      },
    };
    const r1 = await syncQueue(store, t, isPermanentEventError);
    expect(r1).toMatchObject({ sent: 0, pending: 2, offline: true });
    expect(store.items.get("a")!.media[0]!.uploaded).toBe(true);
    expect(store.items.get("a")!.attempts).toBe(1);
    fail = false;
    const r2 = await syncQueue(store, t, isPermanentEventError);
    expect(r2).toMatchObject({ sent: 2, pending: 0 });
    expect(uploads).toBe(1);
  });

  it("un error de datos marca la acción y sigue con las demás", async () => {
    const store = memoryStore([action("a", "2026-10-15T10:00:00Z"), action("b", "2026-10-15T10:01:00Z")]);
    const t: Transport = {
      upload: async () => undefined,
      send: async (a) => {
        if (a.id === "a") throw new Error("signature_required");
      },
    };
    const r = await syncQueue(store, t, isPermanentEventError);
    expect(r).toMatchObject({ sent: 1, failed: 1, pending: 0 });
    expect(store.items.get("a")!.failed).toBe(true);
    expect(store.items.get("a")!.lastError).toBe("signature_required");
  });

  it("archivo que ya estaba subido cuenta como subido", () => {
    expect(alreadyUploaded({ message: "The resource already exists", statusCode: "409" })).toBe(true);
    expect(alreadyUploaded(new Error("Failed to fetch"))).toBe(false);
  });

  it("lo pendiente se ve en la hoja (optimista) y los fallidos no", () => {
    const detail = {
      route: { id: "r1", status: "planificada" as const },
      stops: [
        { id: "s1", status: "pendiente" as const },
        { id: "s2", status: "pendiente" as const },
      ],
    };
    const q = [
      action("start", "2026-10-15T10:00:00Z", { kind: "start", stopId: null }),
      action("e1", "2026-10-15T10:05:00Z", { stopId: "s1", eventType: "entregado" }),
      action("e2", "2026-10-15T10:06:00Z", { stopId: "s2", eventType: "no_entregado", failed: true }),
    ];
    const out = applyPending(detail, q);
    expect(out.route.status).toBe("en_curso");
    expect(out.stops.map((s) => s.status)).toEqual(["entregada", "en_camino"]);
    expect(detail.stops[0]!.status).toBe("pendiente");
    expect(pendingLabel(0)).toBe("Todo enviado");
    expect(pendingLabel(3)).toBe("3 acciones sin enviar");
    expect(routeMediaPath("t", "r", "e", "firma", "png")).toBe("t/routes/r/e-firma.png");
  });
});

describe("Rol Repartidor y capacidades logistics.*", () => {
  it("el Repartidor sólo reparte: no vende, no abre caja, no ve clientes ni ventas", () => {
    const d = SYSTEM_ROLE_BY_KEY.get("driver")!;
    expect(d.id).toBe(DRIVER_ROLE_ID);
    expect(d.base).toBe("cashier");
    const eff = resolveCapabilities({ base: d.base, roleCapabilities: d.capabilities }).effective;
    expect([...eff]).toEqual(["logistics.deliver"]);
    for (const k of ["sales.create", "sales.view", "cash.open", "customers.view", "logistics.view"]) expect(eff.has(k)).toBe(false);
  });

  it("defaults por rol (doc 45 §12)", () => {
    const has = (role: string, cap: string) =>
      resolveCapabilities({ base: SYSTEM_ROLE_BY_KEY.get(role)!.base, roleCapabilities: SYSTEM_ROLE_BY_KEY.get(role)!.capabilities }).effective.has(cap);
    expect(has("manager", "logistics.route.manage")).toBe(true);
    expect(has("manager", "logistics.fleet.manage")).toBe(true);
    expect(has("manager", "logistics.settings")).toBe(false);
    expect(has("cashier", "logistics.prepare")).toBe(true);
    expect(has("cashier", "logistics.route.manage")).toBe(false);
    expect(has("seller", "logistics.view")).toBe(true);
    expect(CAPABILITY_BY_KEY.get("logistics.cot.manage")!.minBase).toBe("owner");
    const exp = ROLE_TEMPLATES.find((t) => t.key === "expeditor")!;
    expect(exp.capabilities).toEqual(expect.arrayContaining(["logistics.route.manage", "logistics.prepare", "stock.view"]));
  });

  it("su inicio es la app de reparto", () => {
    expect(homePath({ isInternal: false, hasTenant: true, isDriver: true })).toBe("/reparto");
    expect(homePath({ isInternal: false, hasTenant: true })).toBe("/dashboard");
  });
});

describe("Remitos con copias y hoja de ruta", () => {
  it("leyendas de las copias", () => {
    expect(copyLabels({ copies: 2, labels: ["Original: cliente", "Duplicado: vuelve firmado", "x"] })).toEqual(["Original: cliente", "Duplicado: vuelve firmado"]);
    expect(copyLabels({ copies: 3, labels: [] })).toEqual(["Original", "Duplicado", "Triplicado"]);
    expect(copyLabels({ copies: 9, labels: [] })).toHaveLength(3);
  });

  it("planilla de carga: total por producto de todas las paradas", () => {
    const detail = {
      stops: [
        { dispatches: [{ outcome: "pendiente", items: [{ name: "Mesa", qty: 2, unit: "un", sku: "M1" }] }] },
        {
          dispatches: [
            { outcome: "pendiente", items: [{ name: "Mesa", qty: 1, unit: "un", sku: "M1" }, { name: "Silla", qty: 4, unit: "un", sku: null }] },
            { outcome: "quitado", items: [{ name: "Silla", qty: 99, unit: "un", sku: null }] },
          ],
        },
      ],
    } as unknown as RouteDetail;
    expect(loadSheet(detail)).toEqual([
      { name: "Mesa", unit: "un", qty: 3 },
      { name: "Silla", unit: "un", qty: 4 },
    ]);
  });
});

describe("Feature reparto_propio (CLAUDE.md §6)", () => {
  it("copy en featureInfo, plan Pro y depende de la expedición", () => {
    expect(FEATURE_INFO.reparto_propio?.minPlan).toBe("Pro");
    expect(FEATURE_INFO.reparto_propio?.requires).toEqual(["pedidos_despacho"]);
    expect(FEATURE_INFO.reparto_propio?.desc).not.toMatch(/—/);
  });
});

describe("Migración 20261230100000_logistica_l2_flota", () => {
  const sql = readFileSync(join(process.cwd(), "supabase", "migrations", "20261230100000_logistica_l2_flota.sql"), "utf8");

  it("feature OPTIONAL en Pro, Business y Enterprise (no en Start)", () => {
    expect(sql).toMatch(/\('reparto_propio', 'Reparto propio',[\s\S]*?'envios', false, 305\)/);
    expect(sql).toContain("jsonb_build_object('reparto_propio', p.key <> 'start')");
  });

  it("tablas con tenant, RLS con initplan y sin is_internal() suelto", () => {
    for (const t of ["vehicles", "vehicle_photos", "driver_profiles", "logistics_origins", "delivery_routes", "route_stops", "route_stop_dispatches", "delivery_events", "logistics_settings"]) {
      expect(sql).toContain(`alter table ${t} enable row level security;`);
    }
    const code = sql.replace(/--.*$/gm, "");
    expect(code).not.toMatch(/or is_internal\(\)/i);
    expect(sql).not.toMatch(/tenant_id = current_tenant_id\(\)\s*\)/);
    expect(sql).toContain("tenant_id = (select current_tenant_id())");
    expect(sql).toContain("(select has_capability('logistics.view'))");
  });

  it("eventos append-only e idempotentes por el id del teléfono", () => {
    expect(sql).toMatch(/create table if not exists delivery_events \(\s*id\s+uuid primary key,/);
    expect(sql).toContain("revoke all on delivery_routes, route_stops, route_stop_dispatches, delivery_events from anon, authenticated;");
    expect(sql).toContain("'duplicate', true");
  });

  it("el Repartidor queda sin sucursales y sin datos de clientes ni ventas", () => {
    expect(sql).toContain("if is_driver_member() then\n    return '{}';");
    expect(sql).toMatch(/'customers', 'customer_addresses'/);
    expect(sql).toContain("as restrictive for select to authenticated using (not (select is_driver_member()))");
    expect(sql).toContain("v.key = 'driver' and not tenant_has_feature_for(p_tenant, 'reparto_propio')");
  });

  it("bucket privado con carpeta por negocio y auditoría en las acciones", () => {
    expect(sql).toMatch(/values \('logistics-media', 'logistics-media', false/);
    for (const a of ["vehicle_created", "route_created", "route_started", "route_stop_delivered", "route_stop_failed", "route_closed", "logistics_settings_saved"]) {
      expect(sql).toContain(`'${a}'`);
    }
    expect(sql).not.toMatch(/create or replace function public\.(create_sale|pos_sale_create_fulfilled|remito_issue)\(/);
  });

  it("textos sin raya", () => {
    expect(sql).not.toContain("—");
  });
});
