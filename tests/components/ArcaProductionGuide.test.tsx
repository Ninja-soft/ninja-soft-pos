// ADR-153: guía para pasar a facturar en real y pasos del asistente que
// guardan su estado. Caso real (datos ficticios): un negocio con el certificado de
// producción cargado y la relación de wsfe sin hacer (coe.notAuthorized).
import { beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { ArcaConfig } from "@/modules/arca/api";

const toast = vi.fn();
vi.mock("@/components/ui/Toast", () => ({ useToast: () => ({ toast }) }));

const testConexion = vi.fn();
const saveSettings = vi.fn();
const setEnvironment = vi.fn();
const setStorePos = vi.fn();
const mut = (fn: ReturnType<typeof vi.fn>) => ({ mutateAsync: fn, mutate: fn, isPending: false });

vi.mock("@/modules/arca/hooks", () => ({
  useArcaMutations: () => ({
    testConexion: mut(testConexion),
    saveSettings: mut(saveSettings),
    setEnvironment: mut(setEnvironment),
    setStorePos: mut(setStorePos),
    setRegisterPos: mut(vi.fn()),
    generarCsr: mut(vi.fn()),
    subirCertificado: mut(vi.fn()),
    deleteCertificate: mut(vi.fn()),
  }),
}));

const puntosDeVenta = vi.fn();
vi.mock("@/modules/arca/api", () => ({ arcaApi: { puntosDeVenta: (...a: unknown[]) => puntosDeVenta(...a) } }));

import { ProductionGuide } from "@/components/arca/ProductionGuide";
import { ArcaWizard } from "@/components/arca/ArcaWizard";

function config(): ArcaConfig {
  return {
    settings: {
      tenant_id: "t",
      enabled: true,
      auth_mode: "propio",
      environment: "homologacion",
      start_at: null,
      max_attempts: 10,
      homo_min_approved: 3,
      last_connection_at: "2026-10-15T21:37:55Z",
      last_connection_env: "produccion",
      last_connection_ok: false,
      last_connection_message: "Computador no autorizado a acceder al servicio",
      connection_by_env: {
        homologacion: { ok: true, at: "2026-10-15T21:37:13Z", code: null, steps: [] },
        produccion: {
          ok: false,
          at: "2026-10-15T21:37:55Z",
          code: "coe.notAuthorized",
          message: "Computador no autorizado a acceder al servicio",
          steps: [
            { key: "certificado", ok: true },
            { key: "wsaa", ok: false, code: "coe.notAuthorized" },
          ],
        },
      },
      prod_test_ok_at: null,
      prod_pos_verified: null,
      prod_pos_verified_at: null,
      last_worker_at: null,
      caea_enabled: true,
      caea_pto_vta: 101,
      caea_timeout_seconds: 10,
      caea_next_check_at: null,
      caea_last_message: null,
      contingency_since: null,
    },
    feature: true,
    can_owner: true,
    platform: {},
    emitter: { cuit: "20123456786", iva_condition: "monotributo" },
    certificates: [
      {
        id: "c1",
        environment: "homologacion",
        status: "active",
        cuit: "20123456786",
        subject: "CN=ninjapos20123456786, serialNumber=CUIT 20123456786",
        issuer: "CN=Computadores Test, O=AFIP, C=AR",
        serial: "1",
        not_before: null,
        not_after: "2028-10-14T20:32:09Z",
        fingerprint_sha256: null,
        created_at: "2026-10-15T20:39:24Z",
        csr_pem: null,
      },
      {
        id: "c2",
        environment: "produccion",
        status: "active",
        cuit: "20123456786",
        subject: "CN=ninjapos20123456786true, serialNumber=CUIT 20123456786",
        issuer: "CN=Computadores, O=AFIP, C=AR",
        serial: "2",
        not_before: null,
        not_after: "2028-10-14T21:24:05Z",
        fingerprint_sha256: null,
        created_at: "2026-10-15T21:29:36Z",
        csr_pem: null,
      },
    ],
    checklist: {
      mode: "propio",
      ready: false,
      items: [
        { key: "fiscal_data", ok: true },
        { key: "certificado", ok: true },
        { key: "homologacion_ok", ok: true, count: 3, min: 3, required: true },
        { key: "conexion_produccion", ok: false },
        { key: "puntos_de_venta", ok: false, pos: [100], verified: [] },
      ],
    },
    stores: [{ id: "s1", name: "Sucursal principal", afip_pos_number: 100, is_default: true, registers: [] }],
    counts: { aprobado: 3 },
    caea: [],
    dead_letter: 0,
  };
}

function wrap(ui: React.ReactElement) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  return render(<QueryClientProvider client={qc}>{ui}</QueryClientProvider>);
}

beforeEach(() => {
  toast.mockReset();
  testConexion.mockReset();
  saveSettings.mockReset();
  setEnvironment.mockReset();
  setStorePos.mockReset();
  puntosDeVenta.mockReset();
});

describe("ProductionGuide", () => {
  it("abre en Autorizar con el error explicado, el alias y la CUIT exactos", () => {
    wrap(<ProductionGuide config={config()} canWrite />);
    const auth = screen.getByTestId("prod-step-autorizar");
    expect(auth.getAttribute("data-state")).toBe("error");
    expect(within(auth).getByText("Con error")).toBeTruthy();
    expect(within(auth).getByText("El certificado no está autorizado para facturar")).toBeTruthy();
    expect(within(auth).getAllByText("ninjapos20123456786true").length).toBeGreaterThan(0);
    expect(within(auth).getAllByText("20123456786").length).toBeGreaterThan(0);
    expect(within(auth).getByRole("button", { name: /Copiar Computador Fiscal/ })).toBeTruthy();
    expect(screen.getByTestId("prod-step-pruebas").getAttribute("data-state")).toBe("ok");
    expect(screen.getByTestId("prod-step-certificado").getAttribute("data-state")).toBe("ok");
    expect(screen.getByTestId("prod-step-punto_venta").getAttribute("data-state")).toBe("locked");
    expect(screen.getByTestId("prod-step-activar").getAttribute("data-state")).toBe("locked");
  });

  it("Ya lo hice: verificar prueba en producción y muestra el resultado en el paso", async () => {
    testConexion.mockResolvedValue({
      ok: false,
      cuit: "20123456786",
      steps: [
        { key: "certificado", ok: true, message: "Certificado listo" },
        { key: "wsaa", ok: false, code: "coe.notAuthorized", message: "Computador no autorizado a acceder al servicio" },
      ],
    });
    wrap(<ProductionGuide config={config()} canWrite />);
    fireEvent.click(screen.getByRole("button", { name: /Ya lo hice: verificar/ }));
    await waitFor(() => expect(testConexion).toHaveBeenCalledWith("produccion"));
    await waitFor(() => expect(screen.getByText("Código ARCA: coe.notAuthorized")).toBeTruthy());
  });

  it("si la verificación falla por red, el error queda en el paso (no sólo en un toast)", async () => {
    testConexion.mockRejectedValue(new Error("Failed to fetch"));
    wrap(<ProductionGuide config={config()} canWrite />);
    fireEvent.click(screen.getByRole("button", { name: /Ya lo hice: verificar/ }));
    await waitFor(() => expect(screen.getByText("No se pudo verificar")).toBeTruthy());
    expect(screen.getByText(/No hay conexión con NinjaSoft/)).toBeTruthy();
  });

  it("el botón Facturar en real está deshabilitado mientras falte algo", () => {
    wrap(<ProductionGuide config={config()} canWrite />);
    fireEvent.click(screen.getByText("Facturar en real", { selector: "span" }));
    const btn = within(screen.getByTestId("prod-step-activar")).getByRole("button", { name: "Facturar en real" });
    expect((btn as HTMLButtonElement).disabled).toBe(true);
    expect(within(screen.getByTestId("prod-step-activar")).getByText("Autorizar el servicio en ARCA")).toBeTruthy();
  });

  it("con todo verificado se habilita y pide confirmación", () => {
    const c = config();
    c.settings!.connection_by_env = { produccion: { ok: true, at: "2026-10-15T22:00:00Z", pos: [100], steps: [{ key: "wsaa", ok: true }] } };
    c.checklist = { ...c.checklist, ready: true, items: c.checklist.items.map((i) => ({ ...i, ok: true })) };
    wrap(<ProductionGuide config={c} canWrite />);
    const act = screen.getByTestId("prod-step-activar");
    expect(act.getAttribute("data-state")).toBe("todo");
    const btn = within(act).getByRole("button", { name: "Facturar en real" }) as HTMLButtonElement;
    expect(btn.disabled).toBe(false);
    fireEvent.click(btn);
    expect(screen.getAllByText("¿Pasar a facturar en real?").length).toBeGreaterThan(0);
  });
});

describe("ArcaWizard: los pasos 4 y 6 muestran lo guardado", () => {
  it("Autorizar figura hecho aunque la última prueba haya sido la de producción", () => {
    wrap(<ArcaWizard config={config()} canWrite initialStep="autorizar" />);
    expect(screen.getByTestId("saved-connection-homologacion").textContent).toMatch(/Verificado/);
  });

  it("Probar y activar: el interruptor sigue activo y el error de guardar se muestra en el paso", async () => {
    saveSettings.mockRejectedValue(new Error("certificate_missing"));
    wrap(<ArcaWizard config={config()} canWrite initialStep="prueba" />);
    expect(screen.getByTestId("saved-connection-homologacion").textContent).toMatch(/Verificado/);
    fireEvent.click(screen.getByRole("switch"));
    await waitFor(() => expect(screen.getByText("No se pudo cambiar")).toBeTruthy());
    expect(screen.getByText(/Falta el certificado de este modo/)).toBeTruthy();
  });

  it("Punto de venta: si no se guarda, lo dice en el paso", async () => {
    setStorePos.mockRejectedValue(new Error("not_saved"));
    const c = config();
    c.stores = [{ id: "s1", name: "Sucursal principal", afip_pos_number: null, is_default: true, registers: [] }];
    wrap(<ArcaWizard config={c} canWrite initialStep="punto_venta" />);
    fireEvent.change(screen.getByLabelText("Número de punto de venta"), { target: { value: "100" } });
    fireEvent.click(screen.getByRole("button", { name: "Guardar" }));
    await waitFor(() => expect(screen.getByText("El punto de venta no se guardó")).toBeTruthy());
  });
});
