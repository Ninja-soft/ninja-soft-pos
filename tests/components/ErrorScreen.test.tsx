// Pantalla de los error boundaries (F1.5 · ADR-098).
import { describe, expect, it, vi, beforeEach } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import { ErrorScreen } from "@/components/errors/ErrorScreen";
import { __resetReportedErrors } from "@/lib/errors/clientError";

describe("ErrorScreen", () => {
  beforeEach(() => {
    __resetReportedErrors();
    Object.defineProperty(navigator, "sendBeacon", { value: vi.fn(() => true), configurable: true });
  });

  it("muestra el mensaje humano, el código y reintenta", () => {
    const reset = vi.fn();
    const error = Object.assign(new Error("Cannot read properties of undefined"), { digest: "4242" });
    render(<ErrorScreen error={error} reset={reset} boundary="panel" />);
    expect(screen.getByRole("alert")).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "Algo salió mal en esta pantalla" })).toBeInTheDocument();
    expect(screen.queryByText(/Cannot read/)).toBeNull();
    expect(screen.getByText("4242")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Probar de nuevo" }));
    expect(reset).toHaveBeenCalledOnce();
    expect(navigator.sendBeacon).toHaveBeenCalledOnce();
  });

  it("chunk viejo: ofrece recargar en vez de reintentar", () => {
    const error = Object.assign(new Error("Loading chunk 7 failed."), { name: "ChunkLoadError" });
    render(<ErrorScreen error={error} reset={vi.fn()} boundary="root" />);
    expect(screen.getByRole("heading", { name: /versión nueva/ })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Recargar" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Probar de nuevo" })).toBeNull();
  });
});
