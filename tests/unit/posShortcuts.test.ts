import { describe, expect, it } from "vitest";
import {
  POS_SHORTCUTS,
  isTypingTarget,
  matchPosShortcut,
} from "@/lib/pos/shortcuts";

describe("atajos del POS", () => {
  it("teclas de función funcionan aunque el foco esté en la búsqueda", () => {
    const input = { tagName: "INPUT", type: "search" };
    expect(matchPosShortcut({ key: "F2" }, input)).toBe("search");
    expect(matchPosShortcut({ key: "F4" }, input)).toBe("customer");
    expect(matchPosShortcut({ key: "F8" }, input)).toBe("pending");
    expect(matchPosShortcut({ key: "F9" }, input)).toBe("checkout");
    expect(matchPosShortcut({ key: "F12" }, null)).toBe("checkout");
  });

  it("no toma teclas del navegador ni combinaciones", () => {
    for (const key of ["F1", "F3", "F5", "F6", "F7", "F10", "F11"])
      expect(matchPosShortcut({ key })).toBeNull();
    expect(matchPosShortcut({ key: "F2", ctrlKey: true })).toBeNull();
    expect(matchPosShortcut({ key: "F9", altKey: true })).toBeNull();
    expect(matchPosShortcut({ key: "F9", metaKey: true })).toBeNull();
    expect(matchPosShortcut({ key: "F9", repeat: true })).toBeNull();
  });

  it("no choca con el lector de códigos (dígitos y Enter)", () => {
    for (const key of ["0", "7", "Enter", "a"])
      expect(matchPosShortcut({ key })).toBeNull();
  });

  it('"?" abre la ayuda sólo fuera de campos de texto', () => {
    expect(matchPosShortcut({ key: "?" }, { tagName: "BODY" })).toBe("help");
    expect(matchPosShortcut({ key: "?" }, { tagName: "BUTTON" })).toBe("help");
    expect(matchPosShortcut({ key: "?" }, { tagName: "INPUT" })).toBeNull();
    expect(matchPosShortcut({ key: "?" }, { tagName: "TEXTAREA" })).toBeNull();
    expect(
      matchPosShortcut(
        { key: "?" },
        { tagName: "DIV", isContentEditable: true },
      ),
    ).toBeNull();
  });

  it("isTypingTarget distingue inputs de texto de checkboxes", () => {
    expect(isTypingTarget({ tagName: "INPUT", type: "checkbox" })).toBe(false);
    expect(isTypingTarget({ tagName: "INPUT", type: "number" })).toBe(true);
    expect(isTypingTarget({ tagName: "SELECT" })).toBe(true);
    expect(isTypingTarget(null)).toBe(false);
  });

  it("la ayuda documenta cada acción que el POS atiende", () => {
    const keys = POS_SHORTCUTS.flatMap((s) =>
      s.keys.map((k) => [k, s.action] as const),
    );
    for (const [key, action] of keys) {
      expect(matchPosShortcut({ key }, { tagName: "BODY" })).toBe(action);
    }
  });
});
