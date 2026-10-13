import { describe, expect, it } from "vitest";
import {
  DEFAULT_DRAWER_POLICY,
  drawerDecision,
  drawerDeniedMessage,
  escposDrawerPulse,
  parseDrawerPolicy,
  type DrawerPolicy,
} from "@/lib/hardware/drawer";
import {
  DEFAULT_DRAWER_DEVICE,
  drawerDeviceProblem,
  emptyRegisterHardware,
  pairingProblem,
  parseDrawerDevice,
  parseRegisterHardware,
  parseScaleDevice,
  parseStoreHardware,
  scaleDeviceProblem,
  serializeDrawerDevice,
  serializeScaleDevice,
} from "@/lib/hardware/config";
import { DrawerSimulatorTransport, kickDrawer } from "@/lib/hardware/devices";
import { ALWAYS_PIN, DEFAULT_POLICY, PIN_ACTIONS, normalizeSettings, pinRequired } from "@/lib/security/pinPolicy";

// Cajón de dinero (ADR-063): pulso ESC/POS, política por sucursal (espejo de
// cash_drawer_open) y configuración por caja.

describe("pulso ESC/POS", () => {
  it("ESC p m t1 t2 con pin y tiempos en unidades de 2 ms", () => {
    expect([...escposDrawerPulse(2, 120, 240)]).toEqual([0x1b, 0x70, 0, 60, 120]);
    expect([...escposDrawerPulse(5, 100, 100)]).toEqual([0x1b, 0x70, 1, 50, 50]);
    // Recorta a 1..255.
    expect([...escposDrawerPulse(2, 0, 9999)]).toEqual([0x1b, 0x70, 0, 1, 255]);
  });

  it("kickDrawer abre, manda el pulso y cierra", async () => {
    const t = new DrawerSimulatorTransport();
    await kickDrawer({ ...DEFAULT_DRAWER_DEVICE, transport: "simulator", pin: 5, onMs: 200, offMs: 200 }, t);
    expect(t.received.map((b) => [...b])).toEqual([[0x1b, 0x70, 1, 100, 100]]);
    expect(t.isOpen).toBe(false);
  });
});

describe("política del cajón", () => {
  const ctx = { hasDrawer: true, hasShift: true, isSupervisor: false, isManager: false };
  const pol = (noSale: DrawerPolicy["noSale"], openOnCash = true): DrawerPolicy => ({ noSale, openOnCash });

  it("lee la política efectiva con defaults (abre al cobrar, sin venta con PIN)", () => {
    expect(parseDrawerPolicy(null)).toEqual(DEFAULT_DRAWER_POLICY);
    expect(parseDrawerPolicy({ drawer_open_on_cash: false, drawer_no_sale: "deny" })).toEqual(pol("deny", false));
    expect(parseDrawerPolicy({ drawer_no_sale: "cualquiera" }).noSale).toBe("pin");
  });

  it("al cobrar: sólo con efectivo, turno y política prendida", () => {
    expect(drawerDecision("sale", pol("pin"), { ...ctx, hadCash: true })).toEqual({ action: "open" });
    expect(drawerDecision("sale", pol("pin"), { ...ctx, hadCash: false }).action).toBe("skip");
    expect(drawerDecision("sale", pol("pin", false), { ...ctx, hadCash: true }).action).toBe("skip");
    expect(drawerDecision("sale", pol("allow"), { ...ctx, hadCash: true, hasDrawer: false }).action).toBe("skip");
  });

  it("sin venta: permitido, con PIN (salvo supervisor) o prohibido", () => {
    expect(drawerDecision("no_sale", pol("allow"), ctx)).toEqual({ action: "open" });
    expect(drawerDecision("no_sale", pol("pin"), ctx)).toEqual({ action: "ask_pin" });
    expect(drawerDecision("no_sale", pol("pin"), { ...ctx, isSupervisor: true })).toEqual({ action: "open" });
    expect(drawerDecision("no_sale", pol("deny"), { ...ctx, isSupervisor: true })).toEqual({
      action: "deny",
      reason: "policy_deny",
    });
    expect(drawerDecision("no_sale", pol("allow"), { ...ctx, hasShift: false })).toEqual({
      action: "deny",
      reason: "no_shift",
    });
    expect(drawerDecision("no_sale", pol("allow"), { ...ctx, hasDrawer: false })).toEqual({
      action: "deny",
      reason: "no_drawer",
    });
  });

  it("prueba: sólo dueño o encargado, aunque la política prohíba", () => {
    expect(drawerDecision("test", pol("deny"), { ...ctx, isManager: true })).toEqual({ action: "open" });
    expect(drawerDecision("test", pol("allow"), ctx)).toEqual({ action: "deny", reason: "forbidden" });
  });

  it("mensajes de rechazo del servidor", () => {
    expect(drawerDeniedMessage("policy_deny")).toMatch(/sin una venta/);
    expect(drawerDeniedMessage("already_opened")).toMatch(/ya se abrió/);
    expect(drawerDeniedMessage("otro")).toBe("No se pudo abrir el cajón.");
  });

  it("'abrir_cajon' es acción de PIN que siempre se pide al consultarla", () => {
    expect(PIN_ACTIONS).toContain("abrir_cajon");
    expect(ALWAYS_PIN).toContain("abrir_cajon");
    expect(pinRequired(DEFAULT_POLICY, "abrir_cajon", null)).toBe(true);
    // Aunque la fila guardada la tenga apagada.
    const s = normalizeSettings({ pin_policy: { ...DEFAULT_POLICY, abrir_cajon: { enabled: false, threshold: 0 } } });
    expect(s.pin_policy.abrir_cajon.enabled).toBe(true);
  });
});

describe("configuración por caja y por sucursal", () => {
  it("cajón: ida y vuelta, sin cajón y saneo", () => {
    const d = {
      ...DEFAULT_DRAWER_DEVICE,
      printerId: "8f0c7d4e-1b2a-4c3d-9e8f-001122334455",
      transport: "bridge" as const,
      pin: 5 as const,
      bridge: { kind: "tcp" as const, host: "192.168.0.50", port: 9100 },
    };
    expect(parseDrawerDevice(serializeDrawerDevice(d))).toEqual(d);
    expect(serializeDrawerDevice({ ...d, hasDrawer: false }).transport).toBe("none");
    expect(parseDrawerDevice({ pin: 9, on_ms: 99999, printer_id: "x", transport: "laser" })).toEqual(DEFAULT_DRAWER_DEVICE);
    expect(drawerDeviceProblem(DEFAULT_DRAWER_DEVICE)).toMatch(/cómo se conecta/);
    expect(drawerDeviceProblem({ ...d, bridge: null })).toMatch(/puente/);
    expect(drawerDeviceProblem({ ...d, hasDrawer: false, transport: "none" })).toBeNull();
  });

  it("balanza: ida y vuelta y problemas", () => {
    const s = parseScaleDevice({
      enabled: true,
      model: "Systel Cuora",
      transport: "webserial",
      protocol: "systel",
      baud: 4800,
    });
    expect(s.protocol).toMatchObject({ protocol: "systel", mode: "poll", pollCommand: "\\x05", unit: "g" });
    expect(s.serial.baudRate).toBe(4800);
    expect(parseScaleDevice(serializeScaleDevice(s))).toEqual(s);
    expect(scaleDeviceProblem(s)).toBeNull();
    expect(scaleDeviceProblem({ ...s, transport: "bridge", bridge: null })).toMatch(/puente/);
    expect(scaleDeviceProblem({ ...s, protocol: { ...s.protocol, pollCommand: "" } })).toMatch(/comando/);
  });

  it("fila de register_hardware y caja sin fila", () => {
    const hw = parseRegisterHardware({
      cash_register_id: "r1",
      store_id: "s1",
      scale: { enabled: false },
      drawer: { has_drawer: false },
      updated_at: "2026-10-26T10:00:00Z",
    });
    expect(hw.drawer.hasDrawer).toBe(false);
    expect(hw.scale.enabled).toBe(false);
    expect(emptyRegisterHardware("r2", "s1")).toMatchObject({ registerId: "r2", drawer: { hasDrawer: true, transport: "none" } });
  });

  it("reglas de la sucursal desde la configuración efectiva", () => {
    expect(parseStoreHardware({ scale_enabled: true, drawer_no_sale: "allow" })).toMatchObject({
      scaleEnabled: true,
      drawer: { openOnCash: true, noSale: "allow" },
    });
  });

  it("qué falta en esta PC", () => {
    expect(pairingProblem("simulator", null, null)).toBeNull();
    expect(pairingProblem("bridge", null, null)).toMatch(/puente/);
    expect(pairingProblem("bridge", null, { url: "ws://127.0.0.1:47800", token: "x" })).toBeNull();
    expect(pairingProblem("webserial", null, null)).toMatch(/Emparejar/);
  });
});
