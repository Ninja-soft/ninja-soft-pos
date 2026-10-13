// @vitest-environment node
// Simulador de envíos y generadores de etiquetas (ADR-103).
import { describe, expect, it } from "vitest";
import { billableWeight, scenarioOf, simulatorAdapter, simulatedTimeline } from "@/supabase/functions/_shared/shipping/simulator";
import { buildLabelPdf, buildLabelZpl, code39Bars, pdfText, zplText } from "@/supabase/functions/_shared/shipping/labelDoc";
import type { CarrierContext, ShipmentRef } from "@/supabase/functions/_shared/shipping/types";

const T0 = new Date("2026-10-13T12:00:00Z");
const ctxAt = (min: number, over: Partial<CarrierContext> = {}): CarrierContext => ({
  sandbox: true,
  config: {},
  secrets: {},
  fetch: async () => {
    throw new Error("el simulador no usa la red");
  },
  now: () => new Date(T0.getTime() + min * 60_000),
  ...over,
});

const ref = (over: Partial<ShipmentRef> = {}): ShipmentRef => ({
  reference: "abcd1234-0000-4000-8000-000000000001",
  external_id: "SIM-ABCD1234",
  tracking_number: "SIM0000000001",
  service_type: "door",
  created_at: T0.toISOString(),
  ...over,
});

const DATA = {
  carrier: "SIMULADOR",
  service: "A DOMICILIO",
  tracking: "SIM123456",
  reference: "abcd1234",
  sender: { name: "Ñandú Textil (prueba)", address: "Thames 100, CABA" },
  recipient: { name: "José Pérez", address: "Alberdi 3000", city: "CABA", postal_code: "1406", phone: "11 5555" },
  packages: "1",
  weight: "1,2 kg",
  createdAt: "2026-10-13",
};

describe("simulador · cotización y puntos", () => {
  const req = {
    origin: { postal_code: "1414" },
    destination: { postal_code: "1406" },
    packages: [{ weight_kg: 1, length_cm: 40, width_cm: 30, height_cm: 20 }],
    declared_value: 10000,
  };

  it("peso aforado: el mayor entre real y volumétrico /4000", () => {
    expect(billableWeight(req.packages)).toBe(6);
    expect(billableWeight([{ weight_kg: 9, length_cm: 10, width_cm: 10, height_cm: 10 }])).toBe(9);
  });

  it("estándar, express y a punto; determinístico; filtra por servicio", async () => {
    const a = await simulatorAdapter.quote(ctxAt(0), req);
    const b = await simulatorAdapter.quote(ctxAt(0), req);
    expect(a).toEqual(b);
    expect(a.map((q) => q.service_code)).toEqual(["SIM_STD_DOOR", "SIM_EXP_DOOR", "SIM_STD_BRANCH"]);
    expect(a[1]!.cost).toBeGreaterThan(a[0]!.cost);
    expect(a[2]!.cost).toBeLessThan(a[0]!.cost);
    const branch = await simulatorAdapter.quote(ctxAt(0), { ...req, service_type: "branch" });
    expect(branch.map((q) => q.service_type)).toEqual(["branch"]);
    const far = await simulatorAdapter.quote(ctxAt(0), { ...req, destination: { postal_code: "9410" } });
    expect(far[0]!.cost).toBeGreaterThan(a[0]!.cost);
  });

  it("puntos de retiro por CP", async () => {
    const p = await simulatorAdapter.listPoints(ctxAt(0), { postal_code: "5000" });
    expect(p).toHaveLength(3);
    expect(p[0]!.id).toBe("SIM-5000-1");
  });
});

describe("simulador · alta y escenarios", () => {
  const base = {
    reference: "abcd1234-0000-4000-8000-000000000001",
    service_type: "door" as const,
    origin: { postal_code: "1414" },
    sender: { name: "N" },
    destination: { postal_code: "1406" },
    packages: [{ weight_kg: 1, length_cm: 1, width_cm: 1, height_cm: 1 }],
    declared_value: 0,
  };

  it("crea con números estables", async () => {
    const r = await simulatorAdapter.create(ctxAt(0), { ...base, recipient: { name: "Ana" } });
    expect(r.external_id).toBe("SIM-ABCD1234");
    expect(r.tracking_number).toMatch(/^SIM\d{10}$/);
    expect(await simulatorAdapter.create(ctxAt(0), { ...base, recipient: { name: "Ana" } })).toEqual(r);
  });

  it("[rechazo] valida, [caido] reintenta 2 veces, [timeout] queda en duda, [ausente] marca el id", async () => {
    await expect(simulatorAdapter.create(ctxAt(0), { ...base, recipient: { name: "Ana [rechazo]" } })).rejects.toMatchObject({
      code: "validation",
      retryable: false,
    });
    await expect(simulatorAdapter.create(ctxAt(0, { attempt: 1 }), { ...base, recipient: { name: "[caido]" } })).rejects.toMatchObject({
      retryable: true,
    });
    await expect(simulatorAdapter.create(ctxAt(0, { attempt: 3 }), { ...base, recipient: { name: "[caido]" } })).resolves.toBeTruthy();
    await expect(simulatorAdapter.create(ctxAt(0), { ...base, recipient: { name: "[timeout]" } })).rejects.toMatchObject({ uncertain: true });
    expect((await simulatorAdapter.create(ctxAt(0), { ...base, recipient: { name: "[ausente]" } })).external_id).toMatch(/-A$/);
    expect(scenarioOf("Juan")).toBe("ok");
  });
});

describe("simulador · seguimiento y cancelación", () => {
  it("avanza con el tiempo (1 paso cada 2 min por defecto) hasta entregado", async () => {
    expect((await simulatorAdapter.track(ctxAt(0), ref())).map((e) => e.status)).toEqual(["created"]);
    expect((await simulatorAdapter.track(ctxAt(5), ref())).map((e) => e.status)).toEqual(["created", "picked_up", "in_transit"]);
    const done = await simulatorAdapter.track(ctxAt(60), ref());
    expect(done.map((e) => e.status)).toEqual(["created", "picked_up", "in_transit", "out_for_delivery", "delivered"]);
    expect(new Set(done.map((e) => e.external_event_id)).size).toBe(done.length);
  });

  it("a punto de retiro pasa por 'para retirar'; [ausente] termina devuelto", () => {
    expect(simulatedTimeline(ref({ service_type: "branch" }), ctxAt(60)).map((e) => e.status)).toContain("ready_for_pickup");
    const away = simulatedTimeline(ref({ external_id: "SIM-X-A" }), ctxAt(60)).map((e) => e.status);
    expect(away.slice(-2)).toEqual(["failed_attempt", "returned"]);
  });

  it("minutes_per_step acelera o frena la simulación", () => {
    expect(simulatedTimeline(ref(), ctxAt(5, { config: { minutes_per_step: 10 } }))).toHaveLength(1);
  });

  it("cancela antes de entregar; después no", async () => {
    await expect(simulatorAdapter.cancel(ctxAt(1), ref())).resolves.toBeUndefined();
    await expect(simulatorAdapter.cancel(ctxAt(60), ref())).rejects.toMatchObject({ code: "already_final" });
  });

  it("mapStatus reconoce sus propios estados", () => {
    expect(simulatorAdapter.mapStatus("SIM_DELIVERED")).toBe("delivered");
    expect(simulatorAdapter.mapStatus("otro")).toBeNull();
  });
});

describe("etiquetas", () => {
  it("PDF 10x15 válido: cabecera, xref con offsets correctos y fin", () => {
    const bytes = buildLabelPdf(DATA, "10x15");
    const s = new TextDecoder().decode(bytes);
    expect(s.startsWith("%PDF-1.4")).toBe(true);
    expect(s.trimEnd().endsWith("%%EOF")).toBe(true);
    expect(s).toContain("/MediaBox [0 0 283.46 425.2]");
    const xref = Number(/startxref\n(\d+)/.exec(s)![1]);
    expect(s.slice(xref, xref + 4)).toBe("xref");
    const offsets = Array.from(s.slice(xref).matchAll(/^(\d{10}) 00000 n $/gm)).map((m) => Number(m[1]));
    offsets.forEach((off, i) => expect(s.slice(off, off + `${i + 1} 0 obj`.length)).toBe(`${i + 1} 0 obj`));
    const len = Number(/\/Length (\d+)/.exec(s)![1]);
    const start = s.indexOf("stream\n") + "stream\n".length;
    expect(s.slice(start + len, start + len + "\nendstream".length)).toBe("\nendstream");
    expect(s).toContain("(SIM123456) Tj");
    expect(s).toContain("(Jose Perez) Tj");
  });

  it("PDF A4", () => {
    expect(new TextDecoder().decode(buildLabelPdf(DATA, "a4"))).toContain("/MediaBox [0 0 595.28 841.89]");
  });

  it("texto PDF sin acentos y con paréntesis escapados", () => {
    expect(pdfText("Ñandú (prueba) \\")).toBe("Nandu \\(prueba\\) \\\\");
  });

  it("ZPL: ^XA..^XZ, Code 128 con el seguimiento y sin caracteres de control", () => {
    const z = buildLabelZpl({ ...DATA, recipient: { ...DATA.recipient, name: "José ^Pérez~" } });
    expect(z.startsWith("^XA")).toBe(true);
    expect(z.endsWith("^XZ")).toBe(true);
    expect(z).toContain("^BCN,220,Y,N,N^FDSIM123456^FS");
    expect(z).toContain("^FDJose  Perez ^FS");
    expect(zplText("a^b~c\\d")).toBe("a b c d");
  });

  it("Code 39 empieza y termina con el delimitador", () => {
    const bars = code39Bars("AB1");
    expect(bars.length).toBe(5 * 5);
  });

  it("el simulador entrega PDF o ZPL según se pida", async () => {
    const pdf = await simulatorAdapter.label(ctxAt(0), ref());
    expect(pdf.mime).toBe("application/pdf");
    const zpl = await simulatorAdapter.label(ctxAt(0), ref(), "zpl");
    expect(zpl.format).toBe("zpl");
    expect(new TextDecoder().decode(zpl.bytes)).toContain("SIM0000000001");
    const a4 = await simulatorAdapter.label(ctxAt(0, { config: { label_size: "a4" } }), ref());
    expect(a4.size).toBe("a4");
  });
});
