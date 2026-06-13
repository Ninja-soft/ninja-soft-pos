import { describe, it, expect } from "vitest";
import {
  timeToMin,
  minToTime,
  formatWindow,
  isValidWindow,
  WEEKDAYS,
} from "@/lib/gastro/menuTime";

// F13 · H47 — los menús por horario guardan ventanas como minutos del día. Estos
// helpers convierten entre "HH:MM" (input de la UI) y minutos, y validan que una
// ventana sea coherente antes de guardarla.

describe("timeToMin", () => {
  it("convierte HH:MM a minutos del día", () => {
    expect(timeToMin("00:00")).toBe(0);
    expect(timeToMin("09:00")).toBe(540);
    expect(timeToMin("12:30")).toBe(750);
    expect(timeToMin("24:00")).toBe(1440);
  });
  it("rechaza formatos inválidos", () => {
    expect(timeToMin("")).toBeNull();
    expect(timeToMin("9")).toBeNull();
    expect(timeToMin("25:00")).toBeNull();
    expect(timeToMin("10:60")).toBeNull();
    expect(timeToMin("aa:bb")).toBeNull();
  });
});

describe("minToTime", () => {
  it("convierte minutos a HH:MM con cero a la izquierda", () => {
    expect(minToTime(0)).toBe("00:00");
    expect(minToTime(540)).toBe("09:00");
    expect(minToTime(750)).toBe("12:30");
    expect(minToTime(1440)).toBe("24:00");
  });
  it("acota fuera de rango", () => {
    expect(minToTime(-10)).toBe("00:00");
    expect(minToTime(5000)).toBe("24:00");
  });
  it("es inverso de timeToMin para horas válidas", () => {
    for (const t of ["00:00", "07:15", "13:45", "23:59"]) {
      expect(minToTime(timeToMin(t) as number)).toBe(t);
    }
  });
});

describe("formatWindow", () => {
  it("arma la etiqueta día · desde–hasta", () => {
    expect(formatWindow(1, 540, 720)).toBe("Lun · 09:00–12:00");
    expect(formatWindow(6, 1200, 1440)).toBe("Sáb · 20:00–24:00");
  });
});

describe("isValidWindow", () => {
  it("acepta una ventana coherente", () => {
    expect(isValidWindow(1, 540, 900)).toBe(true);
  });
  it("rechaza fin <= inicio y días/rangos inválidos", () => {
    expect(isValidWindow(1, 900, 900)).toBe(false);
    expect(isValidWindow(1, 900, 540)).toBe(false);
    expect(isValidWindow(7, 540, 900)).toBe(false);
    expect(isValidWindow(1, -1, 900)).toBe(false);
    expect(isValidWindow(1, 540, 1441)).toBe(false);
  });
});

describe("WEEKDAYS", () => {
  it("tiene 7 días empezando en domingo (extract(dow)=0)", () => {
    expect(WEEKDAYS).toHaveLength(7);
    expect(WEEKDAYS[0]).toBe("Domingo");
    expect(WEEKDAYS[6]).toBe("Sábado");
  });
});
