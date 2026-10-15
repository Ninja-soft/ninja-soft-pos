import { describe, it, expect } from "vitest";
import { fireEvent, render } from "@testing-library/react";
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

  it("muestra un icono (svg) cuando el avatar es un preset", () => {
    const { container } = render(<Avatar name="Cajero A" avatar="cat" />);
    expect(container.querySelector("svg")).toBeTruthy();
    expect(container.textContent).toBe("");
  });

  it("cae a iniciales si el token de avatar no existe", () => {
    const { container } = render(<Avatar name="Cajero A" avatar="zzz" />);
    expect(container.querySelector("svg")).toBeNull();
    expect(container.textContent).toBe("CA");
  });

  it("una foto que no carga cae a las iniciales (nunca imagen rota)", () => {
    const { container } = render(<Avatar name="Pablo Scalise" avatar="https://x.test/no-existe.webp" />);
    const img = container.querySelector("img");
    expect(img).toBeTruthy();
    fireEvent.error(img!);
    expect(container.querySelector("img")).toBeNull();
    expect(container.textContent).toBe("PS");
  });

  it("con un email arma las iniciales de la parte antes del @", () => {
    const { container } = render(<Avatar name="pablo.scalise@gmail.com" />);
    expect(container.textContent).toBe("PS");
  });

  it("expone un set de presets no vacío", () => {
    expect(AVATAR_PRESETS.length).toBeGreaterThan(5);
  });
});
