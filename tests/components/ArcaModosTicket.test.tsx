// ADR-155: modo Prueba / Real con la verificación de puntos de venta, respaldo
// CAEA, factura o sólo ticket por defecto y el interruptor de la hoja de cobro.
import { beforeEach, describe, expect, it, vi } from "vitest";
import { act, fireEvent, render, renderHook, screen, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { ArcaConfig } from "@/modules/arca/api";

const toast = vi.fn();
vi.mock("@/components/ui/Toast", () => ({ useToast: () => ({ toast }) }));

const testConexion = vi.fn();
const saveSettings = vi.fn();
const setEnvironment = vi.fn();
const setStorePos = vi.fn();
const setRegisterPos = vi.fn();
const setTicketMode = vi.fn();
const mut = (fn: ReturnType<typeof vi.fn>) => ({ mutateAsync: fn, mutate: fn, isPending: false });
let status: { enabled: boolean; ticket_mode?: string } | undefined = { enabled: true, ticket_mode: "factura" };

vi.mock("@/modules/arca/hooks", () => ({
  useArcaMutations: () => ({
    testConexion: mut(testConexion),
    saveSettings: mut(saveSettings),
    setEnvironment: mut(setEnvironment),
    setStorePos: mut(setStorePos),
    setRegisterPos: mut(setRegisterPos),
    setTicketMode: mut(setTicketMode),
  }),
  useArcaStatus: () => ({ data: status }),
}));

const ticketOnlySet = vi.fn();
const ticketOnlyClear = vi.fn();
vi.mock("@/modules/arca/api", () => ({
  arcaApi: {
    ticketOnlySet: (...a: unknown[]) => ticketOnlySet(...a),
    ticketOnlyClear: (...a: unknown[]) => ticketOnlyClear(...a),
  },
}));

let customer: { document_type: string | null; document_number: string | null } | null = null;
vi.mock("@/modules/tax/hooks", () => ({ useTaxSettings: () => ({ data: { cf_id_threshold: 10_000_000 } }) }));
vi.mock("@/modules/customers/checkoutFiscal", () => ({ useCheckoutCustomerFiscal: () => ({ data: customer }) }));

import { ArcaModeCard } from "@/components/arca/ModeSwitch";
import { TicketModeCard } from "@/components/arca/TicketModeCard";
import { CheckoutFiscalMode } from "@/components/pos/checkout/CheckoutFiscalMode";
import { useFiscalChoice } from "@/components/pos/checkout/useFiscalChoice";

function config(env: "homologacion" | "produccion" = "homologacion"): ArcaConfig {
  return {
    settings: {
      tenant_id: "t",
      enabled: true,
      auth_mode: "propio",
      environment: env,
      start_at: null,
      max_attempts: 10,
      homo_min_approved: 3,
      last_connection_at: null,
      last_connection_env: null,
      last_connection_ok: null,
      last_connection_message: null,
      prod_test_ok_at: null,
      prod_pos_verified: null,
      prod_pos_verified_at: null,
      last_worker_at: null,
      caea_enabled: false,
      caea_pto_vta: null,
      caea_timeout_seconds: 10,
      caea_next_check_at: null,
      caea_last_message: null,
      contingency_since: null,
      ticket_mode: "factura",
    },
    feature: true,
    can_owner: true,
    platform: {},
    emitter: { cuit: "20123456786", iva_condition: "monotributo" },
    certificates: [],
    checklist: {
      mode: "propio",
      ready: false,
      items: [
        { key: "fiscal_data", ok: true },
        { key: "certificado", ok: true },
        { key: "homologacion_ok", ok: true, count: 3, min: 3, required: true },
        { key: "conexion_produccion", ok: false },
        { key: "puntos_de_venta", ok: false, pos: [1], verified: [] },
      ],
    },
    stores: [{ id: "s1", name: "Sucursal principal", afip_pos_number: 1, is_default: true, registers: [] }],
    counts: {},
    caea: [],
    dead_letter: 0,
  };
}

function wrap(ui: React.ReactElement) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  return render(<QueryClientProvider client={qc}>{ui}</QueryClientProvider>);
}

const okSteps = [
  { key: "certificado", ok: true, message: "Certificado listo" },
  { key: "wsaa", ok: true, message: "ok" },
  { key: "dummy", ok: true, message: "ok" },
  { key: "ptos_venta", ok: true, message: "Puntos de venta: 100" },
];

beforeEach(() => {
  for (const f of [toast, testConexion, saveSettings, setEnvironment, setStorePos, setRegisterPos, setTicketMode, ticketOnlySet, ticketOnlyClear])
    f.mockReset();
  status = { enabled: true, ticket_mode: "factura" };
  customer = null;
});

describe("Modo de facturación (Prueba / Real)", () => {
  it("al tocar Real verifica los puntos de venta, propone el de ARCA y, al aceptar, actualiza la sucursal y vuelve a verificar", async () => {
    testConexion
      .mockResolvedValueOnce({
        ok: false,
        steps: [...okSteps, { key: "pv_sucursales", ok: false, code: "pv_no_habilitado", message: "ARCA no tiene como Web Services: 1" }],
        pos: [{ nro: 100, emisionTipo: "Factura Electronica - Monotributo - Web Services" }],
      })
      .mockResolvedValueOnce({
        ok: true,
        steps: [...okSteps, { key: "pv_sucursales", ok: true, message: "ok" }, { key: "ultimo", ok: true, message: "ok" }],
        pos: [{ nro: 100, emisionTipo: "Factura Electronica - Monotributo - Web Services" }],
      });
    setStorePos.mockResolvedValue(undefined);
    setEnvironment.mockResolvedValue({ ok: true });
    wrap(<ArcaModeCard config={config()} canWrite />);
    fireEvent.click(screen.getByRole("radio", { name: /Real/ }));
    await waitFor(() => expect(testConexion).toHaveBeenCalledWith("produccion"));
    expect(await screen.findByText("Hay que actualizar el punto de venta")).toBeTruthy();
    const accept = screen.getByRole("button", { name: /Aceptar y facturar en real/ }) as HTMLButtonElement;
    expect(accept.disabled).toBe(true);
    fireEvent.click(screen.getByRole("button", { name: "Aceptar y actualizar" }));
    await waitFor(() => expect(setStorePos).toHaveBeenCalledWith({ id: "s1", n: 100 }));
    await waitFor(() => expect(testConexion).toHaveBeenCalledTimes(2));
    expect(await screen.findByText("Todo listo en ARCA")).toBeTruthy();
    const ready = screen.getByRole("button", { name: /Aceptar y facturar en real/ }) as HTMLButtonElement;
    await waitFor(() => expect(ready.disabled).toBe(false));
    fireEvent.click(ready);
    await waitFor(() => expect(setEnvironment).toHaveBeenCalledWith({ env: "produccion" }));
  });

  it("si falta el certificado real no prueba: manda a la guía", async () => {
    const c = config();
    c.checklist.items = c.checklist.items.map((i) => (i.key === "certificado" ? { ...i, ok: false } : i));
    const onGoStep = vi.fn();
    wrap(<ArcaModeCard config={c} canWrite onGoStep={onGoStep} />);
    fireEvent.click(screen.getByRole("radio", { name: /Real/ }));
    expect(await screen.findByText("Antes falta")).toBeTruthy();
    expect(testConexion).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "Abrir la guía paso a paso" }));
    expect(onGoStep).toHaveBeenCalledWith("produccion");
  });

  it("vuelve a Prueba con un toque y la advertencia de que no valen", async () => {
    setEnvironment.mockResolvedValue({ ok: true });
    wrap(<ArcaModeCard config={config("produccion")} canWrite />);
    expect(screen.getByText("Facturando en real")).toBeTruthy();
    fireEvent.click(screen.getByRole("radio", { name: /Prueba/ }));
    expect(screen.getAllByText(/no tienen validez fiscal/).length).toBeGreaterThan(0);
    fireEvent.click(screen.getByRole("button", { name: "Sí, volver a prueba" }));
    await waitFor(() => expect(setEnvironment).toHaveBeenCalledWith({ env: "homologacion" }));
  });

  it("la contingencia CAEA se explica aparte y sin punto de venta lleva al paso del asistente", () => {
    const onGoStep = vi.fn();
    wrap(<ArcaModeCard config={config()} canWrite onGoStep={onGoStep} />);
    expect(screen.getByText(/No es el modo prueba/)).toBeTruthy();
    fireEvent.click(screen.getByRole("switch"));
    expect(onGoStep).toHaveBeenCalledWith("contingencia");
    expect(saveSettings).not.toHaveBeenCalled();
  });
});

describe("Factura o sólo ticket por defecto", () => {
  it("guarda el modo elegido", async () => {
    setTicketMode.mockResolvedValue({ ok: true });
    wrap(<TicketModeCard config={config()} canWrite />);
    expect(screen.getByRole("radio", { name: /Siempre factura/ }).getAttribute("aria-checked")).toBe("true");
    fireEvent.click(screen.getByRole("radio", { name: /Sólo ticket por defecto/ }));
    await waitFor(() => expect(setTicketMode).toHaveBeenCalledWith("ticket"));
  });

  it("sin la migración no se muestra", () => {
    const c = config();
    delete c.settings!.ticket_mode;
    const { container } = wrap(<TicketModeCard config={c} canWrite />);
    expect(container.textContent).toBe("");
  });
});

describe("Interruptor de la hoja de cobro", () => {
  it("alterna con un toque y con Shift + F9, y avisa si corresponde factura A", () => {
    const onChange = vi.fn();
    const { rerender } = render(
      <CheckoutFiscalMode open value="factura" onChange={onChange} customerId="c1" letter="A" total={1000} />,
    );
    fireEvent.click(screen.getByRole("radio", { name: /Sólo ticket/ }));
    expect(onChange).toHaveBeenLastCalledWith("ticket");
    fireEvent.keyDown(window, { key: "F9", shiftKey: true });
    expect(onChange).toHaveBeenLastCalledWith("ticket");
    rerender(<CheckoutFiscalMode open value="ticket" onChange={onChange} customerId="c1" letter="A" total={1000} />);
    expect(screen.getByText(/corresponde Factura A/)).toBeTruthy();
    fireEvent.keyDown(window, { key: "F9", shiftKey: true });
    expect(onChange).toHaveBeenLastCalledWith("factura");
  });

  it("en Preguntar pide elegir; sin conexión queda en factura", () => {
    const { rerender } = render(<CheckoutFiscalMode open value={null} onChange={vi.fn()} customerId={null} letter="B" total={1} />);
    expect(screen.getByText(/Elegí Factura o Sólo ticket para cobrar/)).toBeTruthy();
    rerender(<CheckoutFiscalMode open value="factura" onChange={vi.fn()} customerId={null} letter="B" total={1} offline />);
    expect(screen.getByText(/Sin conexión/)).toBeTruthy();
    expect((screen.getByRole("radio", { name: /Sólo ticket/ }) as HTMLButtonElement).disabled).toBe(true);
  });
});

describe("useFiscalChoice", () => {
  const args = (onConfirm = vi.fn(), over: Partial<{ open: boolean; offline: boolean; customerId: string | null }> = {}) => ({
    open: true,
    offline: false,
    customerId: "c1",
    onConfirm,
    ...over,
  });

  it("con Factura cobra directo, sin llamar al servidor", () => {
    const onConfirm = vi.fn();
    const { result } = renderHook(() => useFiscalChoice(args(onConfirm)));
    expect(result.current.visible).toBe(true);
    expect(result.current.choice).toBe("factura");
    result.current.onConfirm([], [], 0, null);
    expect(onConfirm).toHaveBeenCalledTimes(1);
    expect(ticketOnlySet).not.toHaveBeenCalled();
  });

  it("con Sólo ticket registra la elección ANTES de crear la venta", async () => {
    status = { enabled: true, ticket_mode: "ticket" };
    const order: string[] = [];
    ticketOnlySet.mockImplementation(async () => {
      order.push("set");
      return { ok: true };
    });
    const onConfirm = vi.fn(() => order.push("sale"));
    const { result } = renderHook(() => useFiscalChoice(args(onConfirm)));
    expect(result.current.ticketOnly).toBe(true);
    act(() => result.current.onConfirm([], [], 0, null));
    await waitFor(() => expect(onConfirm).toHaveBeenCalledTimes(1));
    expect(ticketOnlySet).toHaveBeenCalledWith("c1");
    expect(order).toEqual(["set", "sale"]);
  });

  it("si no se puede registrar, la venta sale igual (con factura) y avisa", async () => {
    status = { enabled: true, ticket_mode: "ticket" };
    ticketOnlySet.mockRejectedValue(new Error("not_enabled"));
    const onConfirm = vi.fn();
    const { result } = renderHook(() => useFiscalChoice(args(onConfirm)));
    act(() => result.current.onConfirm([], [], 0, null));
    await waitFor(() => expect(onConfirm).toHaveBeenCalledTimes(1));
    expect(toast).toHaveBeenCalledWith(expect.objectContaining({ title: "La venta sale con factura" }));
  });

  it("Preguntar bloquea el cobro hasta elegir; sin la migración no aparece", () => {
    status = { enabled: true, ticket_mode: "preguntar" };
    const { result, rerender } = renderHook(() => useFiscalChoice(args()));
    expect(result.current.choice).toBeNull();
    expect(result.current.commitBlocker).toBe("Elegí Factura o Sólo ticket");
    act(() => result.current.setChoice("ticket"));
    expect(result.current.commitBlocker).toBeNull();
    status = { enabled: true };
    rerender();
    expect(result.current.visible).toBe(false);
    expect(result.current.commitBlocker).toBeNull();
    status = { enabled: false, ticket_mode: "ticket" };
    rerender();
    expect(result.current.visible).toBe(false);
  });
});
