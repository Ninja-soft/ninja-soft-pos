// ADR-169: ficha del cliente 360 completa. Cuenta Debe / Haber con saldo
// corrido y PDF, adjuntos (validación antes de subir, ver y quitar) y los
// cambios de la ficha en la línea de tiempo con antes y después.
import { beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";

const toast = vi.fn();
vi.mock("@/components/ui/Toast", () => ({ useToast: () => ({ toast }) }));
vi.mock("next/link", () => ({
  default: ({ href, children, ...p }: { href: string; children: React.ReactNode }) => (
    <a href={href} {...p}>
      {children}
    </a>
  ),
}));

const statement = {
  customer: { id: "c1", name: "Ana Pérez", email: "ana@test.local" },
  from: "2026-09-01",
  to: "2026-10-19",
  balance: 1500,
  overdue: 500,
  opening_balance: 0,
  movements: [
    { id: "m1", kind: "charge", delta: 2000, reason: "Venta #12", note: null, created_at: "2026-10-01T12:00:00Z", due_date: "2026-10-10", receipt_no: null, method: null, voided_at: null, running: 2000 },
    { id: "m2", kind: "payment", delta: -500, reason: null, note: null, created_at: "2026-10-05T12:00:00Z", due_date: null, receipt_no: 7, method: "cash", voided_at: null, running: 1500 },
  ],
};
const sendStatement = vi.fn().mockResolvedValue(undefined);
vi.mock("@/modules/customers/hooks", () => ({
  useAccountStatement: () => ({ data: statement, isLoading: false, isError: false }),
  useAccountMutations: () => ({ sendStatement: { mutateAsync: sendStatement, isPending: false } }),
}));
const downloadCustomerStatement = vi.fn().mockResolvedValue(undefined);
vi.mock("@/components/account/statementExport", async (orig) => {
  const real = await orig<typeof import("@/components/account/statementExport")>();
  return { ...real, downloadCustomerStatement: (...a: unknown[]) => downloadCustomerStatement(...a) };
});

const upload = vi.fn();
const remove = vi.fn();
const attachments = [
  { id: "a1", storage_path: "t/c1/u-contrato.pdf", file_name: "contrato.pdf", mime_type: "application/pdf", size_bytes: 2048, note: "Firmado", created_by: "u", created_at: "2026-10-18T12:00:00Z" },
];
vi.mock("@/modules/customers/c360", () => ({
  useCustomerAttachments: () => ({ data: attachments, isLoading: false, isError: false }),
  useCustomerAttachmentMutations: () => ({
    upload: { mutate: upload, isPending: false },
    remove: { mutate: remove, isPending: false },
  }),
  attachmentUrl: vi.fn().mockResolvedValue("https://signed.example/x"),
}));
vi.mock("@/modules/tenants/hooks", () => ({ useMyTenant: () => ({ data: { tenantId: "t", canManage: true } }) }));

import { C360Account } from "@/components/customers/c360/C360Account";
import { C360Attachments } from "@/components/customers/c360/C360Attachments";

beforeEach(() => {
  vi.clearAllMocks();
});

describe("Cuenta Debe / Haber", () => {
  it("muestra los movimientos con Debe, Haber y saldo corrido, y baja el PDF", async () => {
    render(<C360Account customerId="c1" />);
    expect(screen.getByText("Cuenta Debe / Haber")).toBeInTheDocument();
    expect(screen.getByText("Venta #12")).toBeInTheDocument();
    expect(screen.getByText(/Cobro recibo #7/i)).toBeInTheDocument();
    expect(screen.getByText(/vencido/)).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: /Estado de cuenta PDF/ }));
    await waitFor(() => expect(downloadCustomerStatement).toHaveBeenCalledWith(statement));
    fireEvent.click(screen.getByRole("button", { name: /Enviar por email/ }));
    await waitFor(() => expect(sendStatement).toHaveBeenCalledWith({ customerId: "c1" }));
    expect(screen.getByRole("link", { name: /Ver la cuenta completa/ })).toHaveAttribute("href", "/clientes/cuentas/c1");
  });
});

describe("Adjuntos", () => {
  it("lista los archivos y rechaza un tipo no permitido antes de subir", () => {
    render(<C360Attachments customerId="c1" />);
    expect(screen.getByText("contrato.pdf")).toBeInTheDocument();
    expect(screen.getByText(/PDF · 2 KB/)).toBeInTheDocument();
    const input = document.querySelector('input[type="file"]') as HTMLInputElement;
    fireEvent.change(input, { target: { files: [new File(["x"], "virus.exe", { type: "application/x-msdownload" })] } });
    expect(toast).toHaveBeenCalledWith(expect.objectContaining({ title: "No se puede adjuntar" }));
    expect(screen.getByRole("button", { name: /Adjuntar/ })).toBeDisabled();
  });

  it("sube un PDF válido con su nota y pide confirmación para quitar", () => {
    render(<C360Attachments customerId="c1" />);
    const input = document.querySelector('input[type="file"]') as HTMLInputElement;
    const file = new File(["%PDF"], "dni.pdf", { type: "application/pdf" });
    fireEvent.change(input, { target: { files: [file] } });
    fireEvent.change(screen.getByLabelText("Nota del adjunto"), { target: { value: "Frente y dorso" } });
    fireEvent.click(screen.getByRole("button", { name: /Adjuntar/ }));
    expect(upload).toHaveBeenCalledWith({ tenantId: "t", file, note: "Frente y dorso" }, expect.anything());

    fireEvent.click(screen.getByRole("button", { name: "Quitar contrato.pdf" }));
    fireEvent.click(screen.getByRole("button", { name: "Quitar" }));
    expect(remove).toHaveBeenCalledWith("a1", expect.anything());
  });
});
