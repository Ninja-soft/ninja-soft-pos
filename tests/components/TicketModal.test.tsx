// ADR-111: la ventana del ticket espera el CAE en ventas fiscales y, con
// "Imprimir ticket al cobrar", imprime sola sin abrir la ventana salvo error.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { ReactNode } from "react";

const toast = vi.fn();
let docs: { data: unknown[]; isSuccess: boolean; isError: boolean };
let profilePaper = "80";

const sale = {
  sale: {
    id: "11111111-1111-1111-1111-111111111111",
    number: 12,
    created_at: "2026-10-13T21:00:00Z",
    subtotal: 1000,
    discount_total: 0,
    total: 1000,
    status: "completed",
    customers: null,
    customer_id: null,
    receipt_emailed_at: null,
    receipt_email_to: null,
  },
  items: [{ id: "i1", product_name: "Alfajor", quantity: 1, unit_price: 1000, subtotal: 1000 }],
  payments: [{ id: "p1", method: "cash", amount: 1000 }],
};

vi.mock("@/components/ui/Toast", () => ({ useToast: () => ({ toast }) }));
vi.mock("next/link", () => ({
  default: ({ href, children, ...rest }: { href: string; children: ReactNode }) => (
    <a href={href} {...rest}>
      {children}
    </a>
  ),
}));
vi.mock("@/lib/supabase/client", () => ({
  createClient: () => ({
    from: () => ({
      select: () => ({
        maybeSingle: async () => ({ data: { auto_email_receipt: false } }),
        eq: () => ({ maybeSingle: async () => ({ data: null }) }),
      }),
    }),
  }),
}));
vi.mock("@/modules/sales/hooks", () => ({
  useSaleDetail: () => ({ data: sale, isLoading: false }),
  useSaleNumberFormat: () => ({ data: undefined }),
}));
vi.mock("@/modules/tickets/hooks", () => ({
  usePrintProfiles: () => ({ data: { sale: { paper: profilePaper, copies: 1, auto: false } }, isFetched: true, isLoading: false }),
  usePrintTarget: () => null,
  useTenantSmtpStatus: () => ({ data: { allowed: false, configured: false } }),
  useTicketBranding: () => ({ data: null }),
}));
vi.mock("@/modules/branches/hooks", () => ({ useBranches: () => ({ data: [] }) }));
vi.mock("@/modules/tax/hooks", () => ({ useSaleTaxLines: () => ({ data: [] }) }));
vi.mock("@/modules/promotions/hooks", () => ({ useSalePromotions: () => ({ data: [] }) }));
vi.mock("@/modules/tenants/hooks", () => ({ useMyTenant: () => ({ data: { role: "cashier" } }) }));
vi.mock("@/modules/arca/hooks", () => ({
  useArcaStatus: () => ({ data: { enabled: true } }),
  useSaleFiscalDocuments: () => docs,
}));
vi.mock("@/modules/arca/api", () => ({ arcaApi: { emitirVenta: vi.fn(async () => ({ ok: true })) } }));
vi.mock("@/components/arca/FiscalStatus", () => ({ FiscalStatus: () => <div>detalle fiscal</div> }));
vi.mock("@/components/sales/SalePayments", () => ({ SalePayments: () => <div>cobros</div> }));
// ADR-119: todo comprobante sale del motor; acá sólo importa qué formato y
// qué modelo se dibuja (vista previa, nodo que se imprime y nodo del email).
vi.mock("@/components/invoices/InvoiceDocument", () => ({
  InvoiceDocument: ({ format, style }: { format: string; style: { ticketModel: string; a4Model: string } }) => (
    <div data-testid="ticket" data-format={format} data-invoice-model={format === "a4" ? style.a4Model : style.ticketModel}>
      TICKET
    </div>
  ),
}));

import { TicketModal } from "@/components/sales/TicketModal";

const fiscalDoc = (d: Record<string, unknown>) => ({
  id: "d1",
  origin: "sale",
  status: "pendiente",
  cbte_tipo: 6,
  pto_vta: 3,
  cbte_nro: null,
  cae: null,
  cae_vto: null,
  qr_url: null,
  environment: "homologacion",
  emission_type: "CAE",
  last_error_code: null,
  last_error_msg: null,
  next_attempt_at: null,
  ...d,
});

function setup(props: Partial<React.ComponentProps<typeof TicketModal>> = {}) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const onOpenChange = vi.fn();
  const ui = (p: Partial<React.ComponentProps<typeof TicketModal>>) => (
    <QueryClientProvider client={qc}>
      <TicketModal open saleId={sale.sale.id} onOpenChange={onOpenChange} {...props} {...p} />
    </QueryClientProvider>
  );
  const r = render(ui({}));
  return { onOpenChange, rerender: (p: Partial<React.ComponentProps<typeof TicketModal>> = {}) => r.rerender(ui(p)) };
}

let print: ReturnType<typeof vi.fn>;
beforeEach(() => {
  print = vi.fn();
  window.print = print as unknown as typeof window.print;
  toast.mockReset();
  docs = { data: [], isSuccess: true, isError: false };
  profilePaper = "80";
});
afterEach(() => {
  vi.clearAllMocks();
});

describe("TicketModal · auto-imprimir sin ventana (silent)", () => {
  it("venta no fiscal: imprime y cierra sin abrir la ventana", async () => {
    const { onOpenChange } = setup({ silent: true, autoPrint: true });
    await waitFor(() => expect(print).toHaveBeenCalledTimes(1));
    await waitFor(() => expect(onOpenChange).toHaveBeenCalledWith(false));
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("venta fiscal: espera el CAE y recién ahí imprime", async () => {
    docs = { data: [fiscalDoc({})], isSuccess: true, isError: false };
    const { onOpenChange, rerender } = setup({ silent: true, autoPrint: true });
    await new Promise((r) => setTimeout(r, 450));
    expect(print).not.toHaveBeenCalled();
    expect(screen.queryByRole("dialog")).toBeNull();

    docs = { data: [fiscalDoc({ status: "aprobado", cae: "75123456789012", cbte_nro: 45, cae_vto: "2026-10-23" })], isSuccess: true, isError: false };
    rerender();
    await waitFor(() => expect(print).toHaveBeenCalledTimes(1));
    await waitFor(() => expect(onOpenChange).toHaveBeenCalledWith(false));
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("ARCA rechaza: no imprime y abre la ventana con el aviso", async () => {
    docs = { data: [fiscalDoc({ status: "rechazado", last_error_code: "10015" })], isSuccess: true, isError: false };
    const { onOpenChange } = setup({ silent: true, autoPrint: true });
    expect(await screen.findByRole("dialog")).toBeInTheDocument();
    expect(screen.getByText("ARCA rechazó la factura")).toBeInTheDocument();
    expect(print).not.toHaveBeenCalled();
    expect(onOpenChange).not.toHaveBeenCalledWith(false);
  });

  it("ARCA no responde: abre la ventana con reintentar e imprimir provisorio", async () => {
    docs = { data: [fiscalDoc({ last_error_code: "wsaa_timeout" })], isSuccess: true, isError: false };
    setup({ silent: true, autoPrint: true });
    expect(await screen.findByText("ARCA no responde", { selector: "p" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /Reintentar ahora/ })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /Imprimir provisorio/ })).toBeInTheDocument();
    expect(print).not.toHaveBeenCalled();
  });
});

describe("TicketModal · ventana visible", () => {
  it("fiscal autorizando: no muestra el comprobante, sí el estado", async () => {
    docs = { data: [fiscalDoc({})], isSuccess: true, isError: false };
    setup({ onNewSale: vi.fn() });
    expect(await screen.findByText("Autorizando en ARCA", { selector: "p" })).toBeInTheDocument();
    expect(screen.queryByTestId("ticket")).toBeNull();
    expect(screen.getByRole("button", { name: /Imprimir ticket/ })).toBeDisabled();
  });

  it("no fiscal: muestra el comprobante y las acciones; Nueva venta cierra", async () => {
    const onNewSale = vi.fn();
    const { onOpenChange } = setup({ onNewSale });
    expect(await screen.findAllByTestId("ticket")).not.toHaveLength(0);
    expect(screen.getByText("Comprobante no fiscal")).toBeInTheDocument();
    expect(screen.getByRole("link", { name: /Ver venta/ })).toHaveAttribute("href", `/ventas?venta=${sale.sale.id}`);
    screen.getAllByRole("button", { name: /Nueva venta/ })[0]!.click();
    expect(onNewSale).toHaveBeenCalled();
    expect(onOpenChange).toHaveBeenCalledWith(false);
  });

  it("ADR-119: todo sale del motor, en ticket por defecto, y se puede cambiar a A4 ahí mismo", async () => {
    setup({});
    const tickets = await screen.findAllByTestId("ticket");
    // Vista previa, nodo que se imprime y nodo del email: modelo Clásico, rollo de 80 mm.
    expect(tickets.length).toBeGreaterThanOrEqual(3);
    expect(tickets.every((t) => t.getAttribute("data-format") === "80" && t.getAttribute("data-invoice-model") === "clasico")).toBe(true);
    screen.getAllByRole("radio", { name: "A4" })[0]!.click();
    await waitFor(() => expect(screen.getByRole("button", { name: /Imprimir A4/ })).toBeInTheDocument());
    const after = screen.getAllByTestId("ticket");
    // La vista previa y la impresión pasan a A4; el email sigue con su formato.
    expect(after.filter((t) => t.getAttribute("data-format") === "a4")).toHaveLength(2);
    expect(after.filter((t) => t.getAttribute("data-format") === "80")).toHaveLength(1);
  });

  it("ADR-119: el perfil en A4 preselecciona A4 y la impresión automática lo usa", async () => {
    profilePaper = "a4";
    setup({ silent: true, autoPrint: true });
    await waitFor(() => expect(print).toHaveBeenCalledTimes(1));
    expect(screen.getAllByTestId("ticket").some((t) => t.getAttribute("data-format") === "a4")).toBe(true);
  });

  it("sin auto-imprimir no imprime solo; Imprimir ticket imprime", async () => {
    setup({});
    const btn = await screen.findByRole("button", { name: /Imprimir ticket/ });
    await waitFor(() => expect(btn).toBeEnabled());
    await new Promise((r) => setTimeout(r, 400));
    expect(print).not.toHaveBeenCalled();
    btn.click();
    expect(print).toHaveBeenCalledTimes(1);
  });
});
