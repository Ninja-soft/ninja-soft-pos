import { describe, expect, it } from "vitest";
import {
  browserName,
  buildHeartbeatInfo,
  deviceSummary,
  DISPLAY_PRESENCE_TTL_MS,
  registerSignal,
} from "@/lib/branches/heartbeat";

const NOW = new Date("2026-11-05T15:00:00Z");
const ago = (min: number) => new Date(NOW.getTime() - min * 60_000).toISOString();

describe("heartbeat de la caja (H99)", () => {
  it("reconoce navegadores comunes", () => {
    expect(
      browserName(
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/129.0.0.0 Safari/537.36",
      ),
    ).toBe("Chrome 129");
    expect(browserName("Mozilla/5.0 ... Chrome/128.0 Safari/537.36 Edg/128.0.1")).toBe("Edge 128");
    expect(browserName("Mozilla/5.0 (X11; Linux) Gecko/20100101 Firefox/131.0")).toBe("Firefox 131");
    expect(browserName("Mozilla/5.0 (iPad) AppleWebKit/605 Version/17.4 Mobile/15E148 Safari/604.1")).toBe("Safari 17");
    expect(browserName(null)).toBeNull();
    expect(browserName("curl/8")).toBeNull();
  });

  it("arma la info con la whitelist del servidor y la pantalla del cliente", () => {
    const now = NOW.getTime();
    const base = { online: true, visible: true, userAgent: "x Chrome/129.0 y", platform: "Windows<script>", now };
    expect(buildHeartbeatInfo({ ...base, displaySeenAt: now - 10_000 })).toEqual({
      online: true,
      visible: true,
      browser: "Chrome 129",
      platform: "Windowsscript",
      display: "ok",
    });
    expect(buildHeartbeatInfo({ ...base, displaySeenAt: now - DISPLAY_PRESENCE_TTL_MS - 1 }).display).toBe("off");
    expect(buildHeartbeatInfo({ ...base, displaySeenAt: null }).display).toBe("none");
  });

  it("estado de la señal según el umbral", () => {
    expect(registerSignal(null, NOW, 5)).toBe("never");
    expect(registerSignal(ago(2), NOW, 5)).toBe("online");
    expect(registerSignal(ago(6), NOW, 5)).toBe("stale");
    // Umbral mínimo de 1 minuto (la señal es por minuto).
    expect(registerSignal(ago(0.5), NOW, 0)).toBe("online");
  });

  it("resumen del equipo", () => {
    expect(deviceSummary({ browser: "Chrome 129", platform: "Windows", display: "ok" }, "1.4.0")).toBe(
      "Chrome 129 · Windows · pantalla conectada · v1.4.0",
    );
    expect(deviceSummary({ display: "off", online: false })).toBe("pantalla desconectada · sin internet");
    expect(deviceSummary(null)).toBe("");
  });
});
