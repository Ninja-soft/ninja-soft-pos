// Certificado de ARCA de la plataforma (ADR-133, rediseño 2026-10): estado
// arriba, pestañas (cargar, probar, configuración, generar), carga del par
// con CUIT y resultado del padrón. Sólo producción.
import { beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";

const toast = vi.fn();
vi.mock("@/components/ui/Toast", () => ({ useToast: () => ({ toast }) }));

const subirPar = vi.fn();
const subirCertificado = vi.fn();
const setCuit = vi.fn();
const generarCsr = vi.fn();
const testCuit = vi.fn();
const savePadron = vi.fn();
let platformData: Record<string, unknown> = {};

const mut = (fn: ReturnType<typeof vi.fn>) => ({ mutateAsync: fn, isPending: false });

vi.mock("@/modules/arca/hooks", () => ({
  useArcaPlatform: () => ({ isLoading: false, error: null, data: platformData }),
  usePlatformMutations: () => ({
    setCuit: mut(setCuit),
    generarCsr: mut(generarCsr),
    subirCertificado: mut(subirCertificado),
    subirPar: mut(subirPar),
  }),
}));

const PADRON = {
  config: {
    enabled: true,
    environment: "produccion",
    cache_days: 7,
    tenant_per_hour: 30,
    tenant_per_day: 200,
    global_per_hour: 1000,
    last_test_at: null,
    last_test_ok: null,
    last_test_cuit: null,
    last_test_message: null,
    updated_at: null,
  },
  certificates: { produccion: { cuit: "30712345671", has_cert: true, has_key: true, subject: null, not_after: null, ready: true } },
  usage: { arca_hour: 3, arca_day: 12, cache_day: 40, errors_day: 0, tenants_day: 5, cache_entries: 300, day_start: "2026-10-15T03:00:00Z" },
  recent: [],
};

vi.mock("@/modules/padron/hooks", () => ({
  useInternalPadron: () => ({ isLoading: false, error: null, data: PADRON }),
  useInternalPadronMutations: () => ({ save: mut(savePadron), test: mut(testCuit) }),
}));
vi.mock("@/modules/fiscalProfile/hooks", () => ({
  usePlatformIssuer: () => ({ data: { profiles: [{ environment: "produccion", iva_condition: "responsable_inscripto" }] } }),
}));
vi.mock("@/modules/internal/hooks", () => ({ useMyStaffLevel: () => ({ loaded: true, level: "super_admin" }) }));

import { ArcaCertificateSettings } from "@/components/internal/arca/ArcaCertificateSettings";

const B64 = "MIIBszCCAVmgAwIBAgIUQ2sZ" + "A".repeat(120);
const CERT = `-----BEGIN CERTIFICATE-----\n${B64}\n-----END CERTIFICATE-----\n`;
const KEY_BODY = "SECRETOSUPERPRIVADO" + "B".repeat(100);
const KEY = `-----BEGIN PRIVATE KEY-----\n${KEY_BODY}\n-----END PRIVATE KEY-----\n`;

const inFuture = new Date(Date.now() + 400 * 86_400_000).toISOString();

function activeCert() {
  return {
    produccion: {
      cuit: "30712345671",
      has_cert: true,
      has_key: true,
      pending_csr: false,
      csr_pem: null,
      subject: "C=AR, O=NinjaSoft SAS, CN=ninjasoftpos, serialNumber=CUIT 30712345671",
      issuer: "C=AR, O=AFIP, CN=Computadores, serialNumber=CUIT 33693450239",
      serial: "1",
      not_after: inFuture,
      fingerprint_sha256: "x",
      ready: true,
      updated_at: null,
    },
  };
}

function pick(label: string, file: File) {
  fireEvent.change(screen.getByLabelText(label), { target: { files: [file] } });
}

beforeEach(() => {
  vi.clearAllMocks();
  platformData = activeCert();
});

describe("ArcaCertificateSettings", () => {
  it("muestra el estado del certificado de producción y arranca en Cargar certificado", () => {
    render(<ArcaCertificateSettings />);
    const status = screen.getByTestId("cert-status");
    expect(within(status).getByText("Activo")).toBeTruthy();
    expect(within(status).getByText("NinjaSoft SAS")).toBeTruthy();
    expect(within(status).getByText("30-71234567-1")).toBeTruthy();
    expect(within(status).getByText(/Certificado vence el/)).toBeTruthy();
    expect(within(status).getByText(/Computadores, producción/)).toBeTruthy();
    expect(screen.getByRole("radio", { name: "Cargar certificado" }).getAttribute("aria-checked")).toBe("true");
    expect(screen.queryByText(/Homologación/)).toBeNull();
    expect((screen.getByRole("button", { name: /Validar y guardar/ }) as HTMLButtonElement).disabled).toBe(true);
  });

  it("sin certificado avisa Falta certificado", () => {
    platformData = {};
    render(<ArcaCertificateSettings />);
    expect(screen.getByText("Falta certificado")).toBeTruthy();
    expect(screen.getByText(/Todavía no hay certificado/)).toBeTruthy();
  });

  it("cambia de pestaña", () => {
    render(<ArcaCertificateSettings />);
    fireEvent.click(screen.getByRole("radio", { name: "Probar con un CUIT" }));
    expect(screen.getByLabelText("CUIT a consultar")).toBeTruthy();
    fireEvent.click(screen.getByRole("radio", { name: "Configuración" }));
    expect(screen.getByRole("button", { name: "Guardar configuración" })).toBeTruthy();
    expect(screen.getByText("Activo para todos los negocios")).toBeTruthy();
    fireEvent.click(screen.getByRole("radio", { name: "Generar certificado" }));
    expect(screen.getByRole("button", { name: /Generar pedido/ })).toBeTruthy();
    expect(screen.getByText("ws_sr_constancia_inscripcion")).toBeTruthy();
  });

  it("carga CUIT, certificado y clave y muestra lo que validó la Edge", async () => {
    subirPar.mockResolvedValue({
      ok: true,
      certificate: {
        cuit: "30712345671",
        subject: "C=AR, O=Empresa Nueva SA, CN=nuevo, serialNumber=CUIT 30712345671",
        issuer: "C=AR, CN=Computadores",
        not_after: "2028-09-10T00:00:00Z",
      },
    });
    render(<ArcaCertificateSettings />);
    const cuit = screen.getByLabelText("CUIT de la empresa titular del certificado");
    fireEvent.change(cuit, { target: { value: "30-71234567-0" } });
    expect(screen.getByText(/dígito verificador/)).toBeTruthy();
    fireEvent.change(cuit, { target: { value: "30-71234567-1" } });

    pick("Certificado (.crt o .pem)", new File([CERT], "ninjasoft.crt"));
    pick("Clave privada (.key)", new File([KEY], "ninjasoft.key"));
    await screen.findByText("Certificado en texto PEM", { exact: false });
    await screen.findByText("Clave privada en texto PEM", { exact: false });
    // La clave nunca se muestra.
    expect(document.body.textContent).not.toContain("SECRETOSUPERPRIVADO");

    fireEvent.click(screen.getByRole("button", { name: /Validar y guardar/ }));
    await waitFor(() => expect(subirPar).toHaveBeenCalledTimes(1));
    expect(subirPar).toHaveBeenCalledWith({ env: "produccion", cert: CERT, key: KEY, cuit: "30712345671" });
    expect(await screen.findByText("Certificado validado y guardado")).toBeTruthy();
    expect(screen.getByText("Empresa Nueva SA")).toBeTruthy();
    expect(screen.getByText("Certificado vence el 10/09/2028")).toBeTruthy();
  });

  it("rechaza archivos cambiados de lugar y explica la CUIT distinta", async () => {
    subirPar.mockResolvedValue({
      ok: false,
      error: "cert_check_failed",
      problems: ["cert_cuit_distinto"],
      certificate: { cuit: "20123456786" },
    });
    render(<ArcaCertificateSettings />);
    pick("Certificado (.crt o .pem)", new File([KEY], "clave.key"));
    expect(await screen.findByText("Ese archivo es una clave privada, no el certificado")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Quitar clave.key" }));
    pick("Certificado (.crt o .pem)", new File([CERT], "ok.crt"));
    pick("Clave privada (.key)", new File([KEY], "ok.key"));
    await screen.findByText("Clave privada en texto PEM", { exact: false });
    fireEvent.click(screen.getByRole("button", { name: /Validar y guardar/ }));
    expect(await screen.findByText(/La CUIT no coincide con la del certificado/)).toBeTruthy();
    expect(screen.getByText(/20-12345678-6/)).toBeTruthy();
  });

  it("prueba un CUIT y muestra el resultado de ARCA con la factura", async () => {
    testCuit.mockResolvedValue({
      ok: true,
      cached: false,
      status: "ok",
      environment: "produccion",
      fetched_at: "2026-10-15T13:00:00Z",
      persona: {
        cuit: "20123456786",
        tipo_persona: "FISICA",
        razon_social: "PEREZ JUAN",
        estado_clave: "ACTIVO",
        activa: true,
        domicilio: null,
        provincia: "CIUDAD AUTONOMA BUENOS AIRES",
        iva_condition: "monotributo",
        iva_source: "monotributo",
        impuestos: [20],
        monotributo_categoria: "D",
        avisos: [],
        actividades: [
          { id: "620100", descripcion: "Servicios de consultores en informática", orden: 1 },
          { id: "474020", descripcion: "Venta de equipos", orden: 2 },
        ],
        domicilio_partes: { direccion: "AV CORRIENTES 1234", localidad: "CAPITAL FEDERAL", provincia: "CIUDAD AUTONOMA BUENOS AIRES", cod_postal: "1043", id_provincia: 0 },
        inicio_actividades: "2015-03-01",
      },
    });
    render(<ArcaCertificateSettings />);
    fireEvent.click(screen.getByRole("radio", { name: "Probar con un CUIT" }));
    fireEvent.change(screen.getByLabelText("CUIT a consultar"), { target: { value: "20123456786" } });
    fireEvent.click(screen.getByRole("button", { name: /Consultar/ }));
    expect(await screen.findByText("PEREZ JUAN")).toBeTruthy();
    expect(testCuit).toHaveBeenCalledWith("20123456786");
    expect(screen.getByText("Monotributo")).toBeTruthy();
    expect(screen.getByText("Categoría D")).toBeTruthy();
    expect(screen.getByText("Principal")).toBeTruthy();
    expect(screen.getByText(/03\/2015/)).toBeTruthy();
    expect(screen.getByText(/CP 1043/)).toBeTruthy();
    expect(screen.getByText("Factura A")).toBeTruthy();
  });

  it("guardar la configuración pide motivo y deja el padrón en producción", async () => {
    savePadron.mockResolvedValue(PADRON);
    render(<ArcaCertificateSettings />);
    fireEvent.click(screen.getByRole("radio", { name: "Configuración" }));
    const save = screen.getByRole("button", { name: "Guardar configuración" }) as HTMLButtonElement;
    fireEvent.change(screen.getByLabelText("Días que se guarda cada CUIT"), { target: { value: "10" } });
    expect(save.disabled).toBe(true);
    fireEvent.change(screen.getByLabelText("Motivo del cambio"), { target: { value: "más cache" } });
    expect(save.disabled).toBe(false);
    fireEvent.click(save);
    await waitFor(() => expect(savePadron).toHaveBeenCalledTimes(1));
    expect(savePadron.mock.calls[0]?.[0]).toMatchObject({ p: { environment: "produccion", cache_days: 10 }, reason: "más cache" });
  });
});
