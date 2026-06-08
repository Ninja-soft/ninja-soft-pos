import { describe, it, expect } from "vitest";
import {
  detectCapabilities,
  detectEnv,
  type Capability,
} from "@/lib/hardware/capabilities";
import { buildDiagnosticPayload } from "@/lib/hardware/export";
import type { DiagEntry } from "@/lib/hardware/diagnosticsLog";

// Centro de diagnostico de hardware (F10 - H26). Tests de los helpers puros.
// Corren en jsdom: ese entorno NO implementa WebUSB/WebSerial/BroadcastChannel,
// asi que sirve para verificar las ramas "no disponible" honestas y que la
// impresion web (window.print) siempre figura disponible.

describe("detectCapabilities", () => {
  const caps = detectCapabilities();
  const byKey = new Map<string, Capability>(caps.map((c) => [c.key, c]));
  const cap = (key: string): Capability => {
    const c = byKey.get(key);
    if (!c) throw new Error(`falta la capacidad ${key}`);
    return c;
  };

  it("incluye las capacidades de hardware esperadas", () => {
    for (const key of [
      "broadcastChannel",
      "barcodeDetector",
      "webusb",
      "webserial",
      "webbluetooth",
      "webprint",
      "clipboard",
    ]) {
      expect(byKey.has(key), `falta la capacidad ${key}`).toBe(true);
    }
  });

  it("reporta impresion web disponible (window.print existe en jsdom)", () => {
    expect(cap("webprint").status).toBe("ok");
  });

  it("reporta WebUSB/WebSerial como no disponibles en jsdom (honestidad)", () => {
    expect(cap("webusb").status).toBe("unavailable");
    expect(cap("webserial").status).toBe("unavailable");
  });

  it("cada capacidad trae un detalle legible para soporte", () => {
    for (const c of caps) {
      expect(typeof c.detail).toBe("string");
      expect(c.detail.length).toBeGreaterThan(0);
    }
  });
});

describe("detectEnv", () => {
  it("devuelve datos del entorno con pantalla y user agent", () => {
    const env = detectEnv();
    expect(env).not.toBeNull();
    expect(env!.userAgent.length).toBeGreaterThan(0);
    expect(env!.screen).toMatch(/\d+.\d+/);
    expect(typeof env!.secureContext).toBe("boolean");
  });
});

describe("buildDiagnosticPayload", () => {
  const tests: DiagEntry[] = [
    {
      id: "1",
      area: "printer",
      action: "Imprimir ticket de prueba",
      result: "ok",
      detail: "Se abrio el dialogo de impresion.",
      at: Date.now(),
    },
  ];

  const payload = buildDiagnosticPayload({
    context: {
      tenantName: "Kiosco Lucas",
      tenantSlug: "kiosco-lucas",
      registerName: "Caja 1",
      appVersion: "0.1.0",
    },
    environment: detectEnv(),
    capabilities: detectCapabilities(),
    tests,
  });

  it("arma el paquete con contexto, entorno, capacidades y pruebas", () => {
    expect(payload.context.tenantName).toBe("Kiosco Lucas");
    expect(payload.context.registerName).toBe("Caja 1");
    expect(payload.capabilities.length).toBeGreaterThan(0);
    expect(payload.tests).toHaveLength(1);
    expect(() => new Date(payload.generatedAt).toISOString()).not.toThrow();
  });

  it("NO incluye datos sensibles (sin tokens/keys/clientes en el JSON)", () => {
    const serialized = JSON.stringify(payload).toLowerCase();
    expect(serialized).not.toContain("token");
    expect(serialized).not.toContain("api_key");
    expect(serialized).not.toContain("password");
    expect(serialized).not.toContain("secret");
  });
});
