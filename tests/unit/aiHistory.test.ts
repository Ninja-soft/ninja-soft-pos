import { describe, expect, it } from "vitest";
import { conversationDateLabel } from "@/components/ai/AssistantChat";

describe("historial IA · etiqueta de fecha", () => {
  // 2026-10-11 15:00 hora Argentina (UTC-3).
  const now = new Date("2026-10-11T18:00:00Z");

  it("hoy y ayer según el día civil argentino", () => {
    expect(conversationDateLabel("2026-10-11T12:30:00Z", now)).toMatch(/^Hoy 09:30/);
    // 02:00 UTC del 11 = 23:00 AR del 10 → ayer.
    expect(conversationDateLabel("2026-10-11T02:00:00Z", now)).toMatch(/^Ayer 23:00/);
  });

  it("días anteriores con día de semana y fecha corta", () => {
    const label = conversationDateLabel("2026-10-06T15:00:00Z", now);
    expect(label).toMatch(/6\/10/);
    expect(label).not.toMatch(/Hoy|Ayer/);
  });

  it("fecha inválida devuelve vacío", () => {
    expect(conversationDateLabel("nope", now)).toBe("");
  });
});
