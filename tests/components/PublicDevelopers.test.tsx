// ADR-163 (H68b): portal público /developers y envío de la documentación por
// email. Probar con las credenciales de ejemplo va a /api/sandbox/v1; las de
// producción se rechazan sin llamar a la red; el email valida antes de enviar.
import { beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";

const toast = vi.fn();
vi.mock("@/components/ui/Toast", () => ({ useToast: () => ({ toast }) }));
vi.mock("next/link", () => ({
  default: ({ href, children, ...rest }: { href: string; children: React.ReactNode }) => (
    <a href={href} {...rest}>
      {children}
    </a>
  ),
}));
const mutate = vi.fn();
vi.mock("@/modules/api-publica/hooks", () => ({ useSendApiDocs: () => ({ mutate, isPending: false }) }));

import { PublicDevelopers } from "@/components/integrations/api/PublicDevelopers";
import { EmailDocsDialog } from "@/components/integrations/api/EmailDocsDialog";
import { DEMO_CLIENT_ID } from "@/lib/api/sandboxConstants";

const DEMO_TOKEN = `nsat_test_${"0".repeat(62)}ff`;

describe("PublicDevelopers", () => {
  beforeEach(() => {
    toast.mockReset();
    mutate.mockReset();
    vi.restoreAllMocks();
    window.history.replaceState(null, "", "/developers");
  });

  it("muestra la referencia sin login y las descargas en HTML y PDF", () => {
    render(<PublicDevelopers />);
    expect(screen.getByRole("heading", { name: "API pública de NinjaSoft POS" })).toBeInTheDocument();
    const nav = screen.getByRole("navigation", { name: "Documentación de la API" });
    fireEvent.click(Array.from(nav.querySelectorAll("button")).find((b) => b.textContent?.includes("Descargas"))!);
    expect(screen.getByRole("link", { name: /descargar html/i })).toHaveAttribute("href", "/api/docs/html?download=1");
    expect(screen.getByRole("link", { name: /guardar como pdf/i })).toHaveAttribute("href", "/api/docs/html?print=1");
    // En la página pública no hay envío por email (sólo el dueño desde el panel).
    expect(screen.queryByRole("button", { name: /enviar por email/i })).toBeNull();
  });

  it("abre la sección del hash", () => {
    window.history.replaceState(null, "", "/developers#stores.list");
    render(<PublicDevelopers />);
    expect(screen.getByRole("heading", { name: "Listar sucursales" })).toBeInTheDocument();
  });

  it("Probar con las credenciales de ejemplo usa /api/sandbox/v1", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockImplementation(async (input) => {
      const url = String(input);
      if (url.endsWith("/oauth/token")) {
        return new Response(
          JSON.stringify({ access_token: DEMO_TOKEN, token_type: "Bearer", expires_in: 3600, scope: "stock:read", environment: "test" }),
          { status: 200, headers: { "content-type": "application/json" } },
        );
      }
      return new Response(JSON.stringify({ data: [] }), { status: 200, headers: { "content-type": "application/json" } });
    });
    window.history.replaceState(null, "", "/developers#stores.list");
    render(<PublicDevelopers />);
    fireEvent.click(screen.getByRole("button", { name: /usar credenciales de ejemplo/i }));
    expect(screen.getByLabelText("client_id de prueba")).toHaveValue(DEMO_CLIENT_ID);
    fireEvent.click(screen.getByRole("button", { name: /^conectar$/i }));
    await screen.findByText("Datos ficticios");
    fireEvent.click(screen.getByRole("button", { name: /enviar/i }));
    await waitFor(() => expect(fetchSpy).toHaveBeenCalledTimes(2));
    expect(String(fetchSpy.mock.calls[0]![0])).toBe("/api/sandbox/v1/oauth/token");
    expect(String(fetchSpy.mock.calls[1]![0])).toBe("/api/sandbox/v1/stores");
    expect(JSON.stringify({ ...window.localStorage })).not.toContain(DEMO_TOKEN);
  });

  it("rechaza credenciales de producción sin llamar a la red", () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch");
    window.history.replaceState(null, "", "/developers#products.list");
    render(<PublicDevelopers />);
    fireEvent.change(screen.getByLabelText("client_id de prueba"), { target: { value: `nsc_${"a".repeat(24)}` } });
    fireEvent.change(screen.getByLabelText("client_secret de prueba"), { target: { value: `nss_${"d".repeat(64)}` } });
    fireEvent.click(screen.getByRole("button", { name: /^conectar$/i }));
    expect(screen.getByText(/sólo acepta credenciales de prueba/)).toBeInTheDocument();
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});

describe("EmailDocsDialog", () => {
  beforeEach(() => {
    mutate.mockReset();
    toast.mockReset();
  });

  it("valida el email antes de enviar", () => {
    render(<EmailDocsDialog open onOpenChange={() => {}} />);
    fireEvent.change(screen.getByLabelText("Email del integrador"), { target: { value: "no-es-email" } });
    fireEvent.click(screen.getByRole("button", { name: /^enviar$/i }));
    expect(screen.getByText(/no parece válido/)).toBeInTheDocument();
    expect(mutate).not.toHaveBeenCalled();
  });

  it("envía email y nota y cierra al confirmar", () => {
    const onOpenChange = vi.fn();
    mutate.mockImplementation((_v: unknown, opts: { onSuccess: () => void }) => opts.onSuccess());
    render(<EmailDocsDialog open onOpenChange={onOpenChange} />);
    fireEvent.change(screen.getByLabelText("Email del integrador"), { target: { value: " Dev@Proveedor.example " } });
    fireEvent.change(screen.getByPlaceholderText(/sincronizar la tienda/), { target: { value: "Para la tienda" } });
    fireEvent.click(screen.getByRole("button", { name: /^enviar$/i }));
    expect(mutate.mock.calls[0]![0]).toEqual({ email: "Dev@Proveedor.example", note: "Para la tienda" });
    expect(onOpenChange).toHaveBeenCalledWith(false);
    expect(toast).toHaveBeenCalledWith(expect.objectContaining({ title: "Documentación enviada" }));
  });
});
