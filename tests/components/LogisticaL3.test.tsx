// ADR-164 · F22 · H146 (L3): aviso de seguimiento en la app del repartidor,
// detalle de una entrega tocada en el mapa (remito, firma, foto, ubicación,
// camión y repartidor) y el mapa que cae a la lista si Leaflet no carga.
import { describe, it, expect, vi } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { TrackingBanner } from "@/components/reparto/TrackingBanner";
import { DEFAULT_LOGISTICS_SETTINGS } from "@/lib/logistics/logic";
import type { RouteDetail } from "@/modules/logistics/api";
import type { LiveRoute } from "@/modules/logistics/map";

const detail: RouteDetail = {
  route: {
    id: "r1",
    number: 7,
    store_id: "s1",
    origin_id: null,
    service_date: "2026-10-16",
    vehicle_id: "v1",
    driver_user_id: "u1",
    helper_user_id: null,
    status: "en_curso",
    optimize_mode: "heuristica",
    planned_distance_m: 5000,
    started_at: "2026-10-16T12:00:00Z",
    closed_at: null,
    summary: null,
    notes: null,
    return_to_origin: true,
    load_checked_at: null,
  },
  store: null,
  origin: null,
  vehicle: null,
  driver: { user_id: "u1", name: "Chofer" },
  helper: null,
  settings: DEFAULT_LOGISTICS_SETTINGS,
  stops: [
    {
      id: "st1",
      seq: 1,
      kind: "entrega",
      status: "entregada",
      customer_id: "c1",
      address_text: "Belgrano 50, Tigre",
      ship_to: null,
      lat: -34.42,
      lng: -58.58,
      contact_name: "Ana",
      contact_phone: "1155550000",
      notes: null,
      arrived_at: null,
      completed_at: "2026-10-16T12:30:00Z",
      failure_reason_label: null,
      dispatches: [
        {
          id: "d1",
          number: 31,
          status: "entregado",
          outcome: "entregado",
          customer_name: "Ana",
          notes: null,
          sale_number: 120,
          items: [{ name: "Mesa", qty: 2, unit: "un", sku: null }],
          remito: { id: "rm1", pto_vta: 1, number: 42, cot_number: "COT123", signed_copy_path: null },
        },
      ],
      last_event: {
        id: "e1",
        type: "entregado",
        occurred_at: "2026-10-16T12:30:00Z",
        reason_label: null,
        note: null,
        lat: -34.4205,
        lng: -58.5801,
        distance_to_stop_m: 60,
        photo_paths: ["t/routes/r1/e1-foto1.webp"],
        signature_path: "t/routes/r1/e1-firma.png",
        remito_photo_path: null,
        received_by_name: "Ana",
        received_by_doc: "30123456",
      },
    },
  ],
};

const live: LiveRoute = {
  id: "r1",
  number: 7,
  status: "en_curso",
  store_id: "s1",
  service_date: "2026-10-16",
  started_at: "2026-10-16T12:00:00Z",
  closed_at: null,
  optimize_mode: "heuristica",
  return_to_origin: true,
  planned_distance_m: 5000,
  planned_duration_s: 1800,
  planned_path: null,
  vehicle: {
    id: "v1",
    name: "Camión 1",
    plate: "AB 123 CD",
    kind: "camion",
    brand: "Iveco",
    model: "Daily",
    color: null,
    cover_photo_path: null,
    capacity_kg: null,
    capacity_packages: 40,
  },
  driver: { user_id: "u1", name: "Chofer", phone: "1144443333" },
  origin: null,
  last: null,
  alert: null,
  stops: [],
};

vi.mock("@/modules/logistics/api", () => ({
  useRouteDetail: () => ({ data: detail, isLoading: false }),
  useSignedUrl: (p: string | null) => ({ data: p ? `https://x/${p}` : null, isLoading: false }),
}));
vi.mock("@/modules/tenants/hooks", () => ({ useMyTenant: () => ({ data: { canManage: true } }) }));
vi.mock("@/components/remitos/RemitoDetailModal", () => ({
  RemitoDetailModal: ({ id }: { id: string | null }) => (id ? <div>Remito abierto {id}</div> : null),
}));
vi.mock("@/components/geo/leaflet", () => ({
  MAP_TILES: "",
  MAP_ATTRIBUTION: "",
  loadLeaflet: () => Promise.reject(new Error("sin red")),
}));

describe("TrackingBanner", () => {
  const base = { pending: 0, accuracy: null, wakeLock: false, accept: () => undefined };

  it("la primera vez pide compartir la ubicación y explica cuándo", () => {
    const accept = vi.fn();
    render(<TrackingBanner t={{ ...base, status: "needs_consent", accept }} />);
    expect(screen.getByText(/Sólo con la hoja en curso/)).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: /Compartir ubicación/ }));
    expect(accept).toHaveBeenCalled();
  });

  it("muestra siempre que se está compartiendo, la precisión y lo que falta enviar", () => {
    render(<TrackingBanner t={{ ...base, status: "on", accuracy: 8, pending: 3 }} />);
    expect(screen.getByRole("status")).toHaveTextContent("Estás compartiendo tu ubicación");
    expect(screen.getByRole("status")).toHaveTextContent("± 8 m · 3 sin enviar");
  });

  it("avisa si la ubicación está bloqueada y no muestra nada sin hoja en curso", () => {
    const { rerender, container } = render(<TrackingBanner t={{ ...base, status: "denied" }} />);
    expect(screen.getByRole("status")).toHaveTextContent(/bloqueada/);
    rerender(<TrackingBanner t={{ ...base, status: "off" }} />);
    expect(container).toBeEmptyDOMElement();
  });
});

describe("StopDetailSheet", () => {
  it("al tocar una entrega muestra remito, quién recibió, firma, foto, ubicación, camión y repartidor", async () => {
    const { StopDetailSheet } = await import("@/components/logistics/map/StopDetailSheet");
    render(<StopDetailSheet route={live} stopId="st1" onClose={() => undefined} />);
    expect(screen.getByText(/Entregado a Ana/)).toBeInTheDocument();
    expect(screen.getByText(/DNI 30123456/)).toBeInTheDocument();
    expect(screen.getByAltText("Firma de quien recibió")).toBeInTheDocument();
    expect(screen.getByAltText("Foto 1 de la entrega")).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Dónde se marcó" })).toHaveAttribute("href", "https://www.google.com/maps?q=-34.4205,-58.5801");
    expect(screen.getByText(/a 60 m de la dirección/)).toBeInTheDocument();
    expect(screen.getByText("COT COT123")).toBeInTheDocument();
    expect(screen.getByText("Camión 1")).toBeInTheDocument();
    expect(screen.getByText(/AB 123 CD · Camión · Iveco Daily/)).toBeInTheDocument();
    expect(screen.getByText("Chofer")).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Llamar al repartidor" })).toHaveAttribute("href", "tel:1144443333");
    fireEvent.click(screen.getByRole("button", { name: /Remito 0001-00000042/ }));
    expect(screen.getByText("Remito abierto rm1")).toBeInTheDocument();
  });
});

describe("RouteMap", () => {
  it("si el mapa no carga, avisa y deja la lista", async () => {
    const { RouteMap } = await import("@/components/logistics/map/RouteMap");
    render(<RouteMap routes={[]} stops={[]} />);
    await waitFor(() => expect(screen.getByText(/No se pudo cargar el mapa/)).toBeInTheDocument());
  });
});
