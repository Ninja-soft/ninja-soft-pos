import { describe, it, expect } from "vitest";
import { render } from "@testing-library/react";
import { Avatar, AVATAR_PRESETS } from "@/components/ui/Avatar";

describe("Avatar", () => {
  it("muestra iniciales cuando no hay avatar", () => {
    const { container } = render(<Avatar name="Juan Pérez" />);
    expect(container.textContent).toBe("JP");
  });

  it("usa una sola palabra para las iniciales", () => {
    const { container } = render(<Avatar name="Cajero" />);
    expect(container.textContent).toBe("CA");
  });

  it("muestra el emoji cuando el avatar es un preset", () => {
    const { container } = render(<Avatar name="Cajero A" avatar="🦊" />);
    expect(container.textContent).toBe("🦊");
  });

  it("expone un set de presets no vacío", () => {
    expect(AVATAR_PRESETS.length).toBeGreaterThan(5);
  });
});
