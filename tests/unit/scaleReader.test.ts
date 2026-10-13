import { afterEach, describe, expect, it, vi } from "vitest";
import {
  FrameSplitter,
  SCALE_PROTOCOLS,
  decodeCommand,
  parseFrame,
  protocolDefaults,
  regexProblem,
  visibleFrame,
  type ScaleProtocolConfig,
} from "@/lib/hardware/scale/protocols";
import { StableDetector, formatKg, netWeight, weightUsable } from "@/lib/hardware/scale/stable";
import { ScaleReader, ScaleSimulatorTransport } from "@/lib/hardware/devices";
import type { ByteTransport } from "@/lib/payments/terminal/framing";

// Lectura de balanza (F10 · H24, ADR-063): tramas, protocolos, peso estable,
// tara y el lector completo contra un transporte de prueba y el simulador.

const enc = (s: string) => new Uint8Array([...s].map((c) => c.charCodeAt(0)));

describe("tramas", () => {
  it("corta en CR, LF y ETX; STX arranca trama; ignora vacías", () => {
    const sp = new FrameSplitter();
    expect(sp.push(enc("ST,GS,+0.350kg\r\n"))).toEqual(["ST,GS,+0.350kg"]);
    expect(sp.push(enc("basura\x02 00350"))).toEqual([]);
    expect(sp.push(enc("\x03"))).toEqual([" 00350"]);
    // Trama partida en dos chunks.
    expect(sp.push(enc("  1.2"))).toEqual([]);
    expect(sp.push(enc("50 kg\r"))).toEqual(["  1.250 kg"]);
  });

  it("comandos con escapes", () => {
    expect([...decodeCommand("\\x05")]).toEqual([5]);
    expect([...decodeCommand("P\\r\\n")]).toEqual([80, 13, 10]);
    expect([...decodeCommand("W")]).toEqual([87]);
    expect(visibleFrame("\x02 1\x03\r")).toBe("<STX> 1<ETX><CR>");
  });
});

describe("protocolos", () => {
  const cfg = (p: keyof typeof SCALE_PROTOCOLS, patch: Partial<ScaleProtocolConfig> = {}) => ({
    ...protocolDefaults(p),
    ...patch,
  });

  it("genérico con marca de estabilidad", () => {
    expect(parseFrame("ST,GS,+0000.352kg", cfg("generic"))).toEqual({ weightKg: 0.352, stableFlag: true });
    expect(parseFrame("US,GS,+0001.200kg", cfg("generic"))).toEqual({ weightKg: 1.2, stableFlag: false });
    expect(parseFrame("   2,5 kg", cfg("generic"))).toEqual({ weightKg: 2.5, stableFlag: null });
  });

  it("Systel: gramos a pedido", () => {
    expect(parseFrame(" 00350", cfg("systel"))).toEqual({ weightKg: 0.35, stableFlag: null });
    expect(parseFrame("012345", cfg("systel"))).toEqual({ weightKg: 12.345, stableFlag: null });
  });

  it("Kretz y Moretti: kg con 3 decimales", () => {
    expect(parseFrame("  0.750 kg", cfg("kretz"))).toEqual({ weightKg: 0.75, stableFlag: null });
    expect(parseFrame("P   1,005", cfg("moretti"))).toEqual({ weightKg: 1.005, stableFlag: null });
  });

  it("negativo, sobrecarga, sin número y expresión inválida", () => {
    expect(parseFrame("-  0.020 kg", cfg("kretz"))).toEqual({ weightKg: -0.02, stableFlag: null });
    expect(parseFrame("ST,GS,-0000.010kg", cfg("generic"))).toEqual({ weightKg: -0.01, stableFlag: true });
    expect(parseFrame("OL", cfg("generic"))).toEqual({ error: "overload" });
    expect(parseFrame("hola", cfg("kretz"))).toEqual({ error: "no_match" });
    expect(parseFrame("1.000", cfg("generic", { regex: "([" }))).toEqual({ error: "bad_regex" });
  });

  it("expresión propia del dueño", () => {
    const c = cfg("generic", { regex: "NET\\s+(\\d+)", unit: "g" });
    expect(parseFrame("GROSS 500 NET 480", c)).toEqual({ weightKg: 0.48, stableFlag: null });
    expect(regexProblem("NET\\s+(\\d+)")).toBeNull();
    expect(regexProblem("NET\\s+\\d+")).toMatch(/grupo/);
    expect(regexProblem("(")).toMatch(/no es válida/);
    expect(regexProblem("")).toBeNull();
  });

  it("los presets de marca están marcados sin validar", () => {
    expect(SCALE_PROTOCOLS.systel.verified).toBe(false);
    expect(SCALE_PROTOCOLS.kretz.verified).toBe(false);
    expect(SCALE_PROTOCOLS.moretti.verified).toBe(false);
  });
});

describe("peso estable y tara", () => {
  it("manda la marca de la balanza cuando la informa", () => {
    const d = new StableDetector();
    expect(d.push({ weightKg: 0.3, at: 0, stableFlag: true })).toBe(true);
    expect(d.push({ weightKg: 0.3, at: 10, stableFlag: false })).toBe(false);
  });

  it("sin marca: N lecturas dentro de la tolerancia durante el tiempo mínimo", () => {
    const d = new StableDetector({ toleranceKg: 0.002, minSamples: 3, minStableMs: 400 });
    expect(d.push({ weightKg: 0.3, at: 0, stableFlag: null })).toBe(false);
    expect(d.push({ weightKg: 0.35, at: 200, stableFlag: null })).toBe(false);
    expect(d.push({ weightKg: 0.351, at: 400, stableFlag: null })).toBe(false);
    expect(d.push({ weightKg: 0.35, at: 600, stableFlag: null })).toBe(true);
    // Se mueve: deja de estar estable.
    expect(d.push({ weightKg: 0.4, at: 700, stableFlag: null })).toBe(false);
  });

  it("neto, usable y formato", () => {
    expect(netWeight(1.25, 0.05)).toBe(1.2);
    expect(netWeight(0.3, -1)).toBe(0.3);
    expect(weightUsable(0.35, true)).toBe(true);
    expect(weightUsable(0.35, false)).toBe(false);
    expect(weightUsable(0.001, true)).toBe(false);
    expect(formatKg(1.2)).toBe("1,200 kg");
  });
});

class FakeTransport implements ByteTransport {
  readonly kind = "memory" as const;
  isOpen = false;
  written: Uint8Array[] = [];
  private cb: ((c: Uint8Array) => void) | null = null;
  async open() {
    this.isOpen = true;
  }
  async close() {
    this.isOpen = false;
  }
  async write(d: Uint8Array) {
    this.written.push(d);
  }
  onData(cb: (c: Uint8Array) => void) {
    this.cb = cb;
    return () => {
      this.cb = null;
    };
  }
  emit(s: string) {
    this.cb?.(enc(s));
  }
}

describe("ScaleReader", () => {
  afterEach(() => vi.useRealTimers());

  it("pide el peso en modo poll, lee, estabiliza y aplica la tara", async () => {
    vi.useFakeTimers();
    let now = 0;
    const t = new FakeTransport();
    const r = new ScaleReader(t, { ...protocolDefaults("systel"), pollMs: 200 }, undefined, () => now);
    const seen: number[] = [];
    r.onReading((x) => seen.push(x.netKg));
    await r.start();
    expect([...t.written[0]!]).toEqual([5]);
    vi.advanceTimersByTime(200);
    expect(t.written.length).toBe(2);
    for (let i = 0; i < 4; i++) {
      now += 200;
      t.emit("\x02 00500\x03");
    }
    expect(r.reading).toMatchObject({ grossKg: 0.5, netKg: 0.5, stable: true });
    // Tara con el envase apoyado: el neto queda en cero.
    expect(r.tareNow()).toBe(0.5);
    now += 200;
    t.emit("\x02 00500\x03");
    expect(r.reading).toMatchObject({ netKg: 0, tareKg: 0.5 });
    now += 200;
    t.emit("\x02 01250\x03");
    expect(r.reading?.netKg).toBe(0.75);
    expect(seen.length).toBe(6);
    await r.stop();
    expect(t.isOpen).toBe(false);
  });

  it("avisa sobrecarga", async () => {
    const t = new FakeTransport();
    const r = new ScaleReader(t, protocolDefaults("generic"));
    const errs: string[] = [];
    r.onError((e) => errs.push(e));
    await r.start();
    t.emit("OL\r\n");
    expect(errs).toEqual(["overload"]);
    await r.stop();
  });

  it("con el simulador: en movimiento y después estable en el peso apoyado", async () => {
    vi.useFakeTimers();
    const sim = new ScaleSimulatorTransport(null, 3);
    const r = new ScaleReader(sim, { ...protocolDefaults("generic"), mode: "poll", pollCommand: "P", pollMs: 100 });
    await r.start();
    sim.place(0.42);
    for (let i = 0; i < 6; i++) await vi.advanceTimersByTimeAsync(100);
    expect(r.reading).toMatchObject({ grossKg: 0.42, stable: true });
    await r.stop();
  });
});
