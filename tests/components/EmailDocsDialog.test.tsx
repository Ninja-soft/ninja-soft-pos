// ADR-163 (H68b, pedido del dueño 16/10): enviar la documentación por email
// con las credenciales. El secreto sólo si está en memoria (recién creado o
// rotado) y con confirmación explícita; "Rotar y enviar" para las viejas.
import { beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";

const toast = vi.fn();
vi.mock("@/components/ui/Toast", () => ({ useToast: () => ({ toast }) }));
const sendAsync = vi.fn();
const rotateAsync = vi.fn();
vi.mock("@/modules/api-publica/hooks", () => ({
  useSendApiDocs: () => ({ mutateAsync: sendAsync, isPending: false }),
  useApiClientMutations: () => ({ rotate: { mutateAsync: rotateAsync } }),
}));

import { EmailDocsDialog, SECRET_WARNING } from "@/components/integrations/api/EmailDocsDialog";
import type { ApiClientView, ApiClientWithSecret } from "@/modules/api-publica/api";

const base = {
  secret_hint: "aaaa",
  scopes: ["products:read" as const],
  rate_limit_per_min: 600,
  created_at: "2026-10-01T00:00:00Z",
  updated_at: "2026-10-01T00:00:00Z",
  rotated_at: null,
  last_used_at: null,
  revoked_at: null,
  revoke_reason: null,
  status: "active" as const,
};
const TEST: ApiClientView = { ...base, id: "c1", name: "Tienda prueba", client_id: `nsc_test_${"a".repeat(24)}`, environment: "test" };
const LIVE: ApiClientView = { ...base, id: "c2", name: "Tienda", client_id: `nsc_${"b".repeat(24)}`, environment: "live" };
const FRESH: ApiClientWithSecret = { ...TEST, client_secret: `nss_test_${"c".repeat(64)}` };

function setEmail(v = "dev@proveedor.example") {
  fireEvent.change(screen.getByLabelText("Email del integrador"), { target: { value: v } });
}

describe("EmailDocsDialog", () => {
  beforeEach(() => {
    toast.mockReset();
    sendAsync.mockReset().mockResolvedValue({ ok: true, with_secret: false });
    rotateAsync.mockReset();
  });

  it("valida el email antes de enviar", () => {
    render(<EmailDocsDialog open onOpenChange={() => {}} />);
    setEmail("no-es-email");
    fireEvent.click(screen.getByRole("button", { name: /^enviar$/i }));
    expect(screen.getByText(/no parece válido/)).toBeInTheDocument();
    expect(sendAsync).not.toHaveBeenCalled();
  });

  it("sin credencial: documentación y adjuntos, sin secreto", async () => {
    const onOpenChange = vi.fn();
    render(<EmailDocsDialog open onOpenChange={onOpenChange} clients={[TEST, LIVE]} />);
    setEmail(" Dev@Proveedor.example ");
    fireEvent.click(screen.getByRole("button", { name: /^enviar$/i }));
    await waitFor(() => expect(onOpenChange).toHaveBeenCalledWith(false));
    expect(sendAsync.mock.calls[0]![0]).toMatchObject({
      email: "Dev@Proveedor.example",
      client: null,
      clientSecret: null,
      ackSecret: false,
      includePostman: true,
      includeHtml: true,
    });
  });

  it("con el secreto recién creado pide confirmación antes de enviar", async () => {
    sendAsync.mockResolvedValue({ ok: true, with_secret: true });
    render(<EmailDocsDialog open onOpenChange={() => {}} clients={[TEST, LIVE]} fresh={FRESH} />);
    setEmail();
    fireEvent.click(screen.getByRole("checkbox", { name: "Incluir el client_secret" }));
    fireEvent.click(screen.getByRole("button", { name: /^enviar$/i }));
    expect(screen.getByText(SECRET_WARNING)).toBeInTheDocument();
    expect(sendAsync).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: /enviar con la clave/i }));
    await waitFor(() => expect(sendAsync).toHaveBeenCalledTimes(1));
    expect(sendAsync.mock.calls[0]![0]).toMatchObject({
      client: { client_id: TEST.client_id, environment: "test" },
      clientSecret: FRESH.client_secret,
      ackSecret: true,
    });
  });

  it("credencial vieja: va sin secreto, o Rotar y enviar con confirmación", async () => {
    const onRotated = vi.fn();
    const rotated: ApiClientWithSecret = { ...LIVE, client_secret: `nss_${"d".repeat(64)}` };
    rotateAsync.mockResolvedValue(rotated);
    sendAsync.mockResolvedValue({ ok: true, with_secret: true });
    render(<EmailDocsDialog open onOpenChange={() => {}} clients={[TEST, LIVE]} onRotated={onRotated} />);
    setEmail();
    fireEvent.click(screen.getByRole("combobox", { name: /credencial/i }));
    fireEvent.click(await screen.findByText(/Tienda · Producción/));
    expect(screen.queryByRole("checkbox", { name: "Incluir el client_secret" })).toBeNull();
    expect(screen.getByText(/no se puede volver a ver/)).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: /rotar y enviar con secreto/i }));
    expect(screen.getByText(SECRET_WARNING)).toBeInTheDocument();
    expect(screen.getByText(/el actual deja de funcionar ya/)).toBeInTheDocument();
    expect(screen.getByText(/Es de producción/)).toBeInTheDocument();
    expect(rotateAsync).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: /^rotar y enviar$/i }));
    await waitFor(() => expect(sendAsync).toHaveBeenCalledTimes(1));
    expect(rotateAsync).toHaveBeenCalledWith("c2");
    expect(onRotated).toHaveBeenCalledWith(rotated);
    expect(sendAsync.mock.calls[0]![0]).toMatchObject({ clientSecret: rotated.client_secret, ackSecret: true });
  });

  it("muestra el error traducido y vuelve al formulario", async () => {
    sendAsync.mockRejectedValue(new Error("too_many_emails"));
    render(<EmailDocsDialog open onOpenChange={() => {}} />);
    setEmail();
    fireEvent.click(screen.getByRole("button", { name: /^enviar$/i }));
    expect(await screen.findByText(/máximo de 20 envíos/)).toBeInTheDocument();
  });
});
