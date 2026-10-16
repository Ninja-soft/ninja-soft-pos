// ADR-159 (H68b): portal de la API. Navegación, referencia generada del spec,
// Probar que sólo acepta credenciales de prueba y token pedido al sandbox.
import { beforeEach, describe, expect, it, vi } from "vitest";
import { useState } from "react";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";

const toast = vi.fn();
vi.mock("@/components/ui/Toast", () => ({ useToast: () => ({ toast }) }));

import { ApiPortal } from "@/components/integrations/api/ApiPortal";
import { SandboxProvider } from "@/components/integrations/api/TryIt";

const TEST_ID = `nsc_test_${"b".repeat(24)}`;
const TEST_SECRET = `nss_test_${"c".repeat(64)}`;
const TEST_TOKEN = `nsat_test_${"e".repeat(64)}`;

function Harness({ start = "intro" }: { start?: string }) {
  const [active, setActive] = useState(start);
  return (
    <SandboxProvider>
      <ApiPortal active={active} onNavigate={setActive} credentials={<p>Credenciales del dueño</p>} onPostman={() => {}} />
    </SandboxProvider>
  );
}

describe("ApiPortal", () => {
  beforeEach(() => {
    toast.mockReset();
    vi.restoreAllMocks();
  });

  it("muestra la introducción y navega a un endpoint desde la barra lateral", () => {
    render(<Harness />);
    expect(screen.getByRole("heading", { name: "API pública v1" })).toBeInTheDocument();
    const nav = screen.getByRole("navigation", { name: "Documentación de la API" });
    fireEvent.click(Array.from(nav.querySelectorAll("button")).find((b) => b.textContent?.includes("Crear y editar productos en lote"))!);
    expect(screen.getByRole("heading", { name: "Crear y editar productos en lote" })).toBeInTheDocument();
    expect(screen.getByText("/api/v1/products/batch")).toBeInTheDocument();
    expect(screen.getByText("barcode_in_use")).toBeInTheDocument();
    expect(screen.getAllByRole("button", { name: /copiar/i }).length).toBeGreaterThan(0);
  });

  it("la sección de credenciales es la que pasa el contenedor", () => {
    render(<Harness start="credentials" />);
    expect(screen.getByText("Credenciales del dueño")).toBeInTheDocument();
  });

  it("Probar rechaza una credencial de producción sin llamar a la API", () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch");
    render(<Harness start="products.list" />);
    fireEvent.change(screen.getByLabelText("client_id de prueba"), { target: { value: `nsc_${"a".repeat(24)}` } });
    fireEvent.change(screen.getByLabelText("client_secret de prueba"), { target: { value: `nss_${"d".repeat(64)}` } });
    fireEvent.click(screen.getByRole("button", { name: /conectar/i }));
    expect(screen.getByText(/sólo acepta credenciales de prueba/)).toBeInTheDocument();
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("Probar pide el token al sandbox y envía el pedido con Bearer", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockImplementation(async (input) => {
      const url = String(input);
      if (url.endsWith("/oauth/token")) {
        return new Response(
          JSON.stringify({ access_token: TEST_TOKEN, token_type: "Bearer", expires_in: 3600, scope: "stock:read", environment: "test" }),
          { status: 200, headers: { "content-type": "application/json" } },
        );
      }
      return new Response(JSON.stringify({ data: [] }), {
        status: 200,
        headers: { "content-type": "application/json", "x-ninja-environment": "test" },
      });
    });
    render(<Harness start="stores.list" />);
    fireEvent.change(screen.getByLabelText("client_id de prueba"), { target: { value: TEST_ID } });
    fireEvent.change(screen.getByLabelText("client_secret de prueba"), { target: { value: TEST_SECRET } });
    fireEvent.click(screen.getByRole("button", { name: /conectar/i }));
    await screen.findByText("Conectado al sandbox");
    fireEvent.click(screen.getByRole("button", { name: /enviar/i }));
    await waitFor(() => expect(fetchSpy).toHaveBeenCalledTimes(2));
    const [url, init] = fetchSpy.mock.calls[1]!;
    expect(String(url)).toBe("/api/v1/stores");
    expect((init!.headers as Record<string, string>).Authorization).toBe(`Bearer ${TEST_TOKEN}`);
    expect(await screen.findByText("x-ninja-environment:", { exact: false })).toBeInTheDocument();
    // El token no se guarda en el navegador.
    expect(JSON.stringify({ ...window.localStorage })).not.toContain(TEST_TOKEN);
  });
});
