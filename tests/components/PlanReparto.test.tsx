// ADR-164 · F22 · H146 (L3): Planificar reparto. Arma el reparto con la
// heurística local (sin ORS), muestra cada camión con su carga contra su
// capacidad y confirma todas las hojas con las entregas en orden.
import { describe, it, expect, vi } from "vitest";
import { act, fireEvent, render, screen } from "@testing-library/react";
import { ToastProvider } from "@/components/ui/Toast";
import type { PlanCandidate } from "@/modules/logistics/map";

const confirm = vi.fn(async (p: { routes: { dispatch_ids: string[] }[] }) => ({
  plan_id: "p1",
  routes: p.routes.map((_, i) => ({ id: `r${i}`, number: i + 1, stops: 1 })),
}));
const push = vi.fn();

const cand = (i: number, locality: string, lat: number): PlanCandidate => ({
  id: `d${i}`,
  number: i,
  status: "listo",
  store_id: "s1",
  fulfillment_store_id: "s1",
  arrived_at: null,
  customer_name: `Cliente ${i}`,
  ship_address: `Calle ${i}, ${locality}`,
  ship_to: { street: "Calle", number: String(i), locality, lat, lng: -58.45, geo_source: "georef", geo_quality: "exacta" },
  address_id: null,
  delivery_attempts: 0,
  sale: { number: 100 + i, customer_id: `c${i}` },
  items: [{ qty: 2 }],
});
const CANDIDATES = [cand(1, "Norte", -34.55), cand(2, "Norte", -34.551), cand(3, "Sur", -34.65), cand(4, "Sur", -34.651)];
const VEHICLES = [
  { id: "v1", name: "Camión 1", status: "activo", kind: "camion", plate: "AA 111 AA", capacity_packages: 4, max_stops: null, default_driver_user_id: "u1" },
  { id: "v2", name: "Camión 2", status: "activo", kind: "camion", plate: "BB 222 BB", capacity_packages: 4, max_stops: null, default_driver_user_id: null },
];

vi.mock("next/navigation", () => ({ useRouter: () => ({ push }) }));
vi.mock("@/modules/saas/gating", () => ({ useFeature: () => true }));
vi.mock("@/modules/branches/hooks", () => ({
  useBranchContext: () => ({ filterStoreId: "s1", posStoreId: "s1", branchName: () => "Centro" }),
}));
vi.mock("@/modules/logistics/api", () => ({
  useCan: () => true,
  useVehicles: () => ({ data: VEHICLES }),
  useDrivers: () => ({ data: [{ user_id: "u1", name: "Chofer", is_driver_role: true, profile: null, base_role: "cashier" }] }),
  useOrigins: () => ({ data: [{ id: "o1", store_id: "s1", name: "Depósito", lat: -34.6, lng: -58.45, is_default: true }] }),
}));
vi.mock("@/modules/logistics/map", () => ({
  usePlanCandidates: () => ({ data: CANDIDATES, isLoading: false }),
  useTrackingSettings: () => ({ data: undefined }),
  useRoutingAvailable: () => ({ data: false }),
  useMapMutations: () => ({ confirmPlan: { mutateAsync: confirm, isPending: false } }),
  mapApi: { optimize: vi.fn() },
}));
vi.mock("@/components/geo/leaflet", () => ({
  MAP_TILES: "",
  MAP_ATTRIBUTION: "",
  loadLeaflet: () => Promise.reject(new Error("sin red")),
}));
vi.mock("@/components/logistics/LogisticsNav", () => ({ LogisticsNav: () => null }));

describe("PlanPage", () => {
  it("reparte 4 entregas en 2 camiones por zona y capacidad y confirma las 2 hojas", async () => {
    const { PlanPage } = await import("@/components/logistics/plan/PlanPage");
    render(
      <ToastProvider>
        <PlanPage />
      </ToastProvider>,
    );
    expect(screen.getByText("4")).toBeInTheDocument();
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: /Armar el reparto/ }));
    });
    const c1 = screen.getByRole("region", { name: "Camión 1" });
    const c2 = screen.getByRole("region", { name: "Camión 2" });
    expect(c1).toHaveTextContent("4/4 bultos");
    expect(c2).toHaveTextContent("4/4 bultos");
    // Cada camión se queda con una zona.
    expect(c1.textContent!.includes("Norte") !== c2.textContent!.includes("Norte")).toBe(true);
    expect(screen.getByText(/Camión 2: elegí el repartidor/)).toBeInTheDocument();
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: /Confirmar y crear las 2 hojas/ }));
    });
    expect(confirm).toHaveBeenCalledTimes(1);
    const arg = confirm.mock.calls[0]![0] as unknown as { mode: string; store_id: string; routes: { vehicle_id: string; driver_user_id: string | null; dispatch_ids: string[] }[] };
    expect(arg).toMatchObject({ mode: "heuristica", store_id: "s1" });
    expect(arg.routes.map((r) => r.vehicle_id)).toEqual(["v1", "v2"]);
    expect(arg.routes[0]!.driver_user_id).toBe("u1");
    expect(arg.routes.flatMap((r) => r.dispatch_ids).sort()).toEqual(["d1", "d2", "d3", "d4"]);
    expect(push).toHaveBeenCalledWith(expect.stringMatching(/^\/logistica\/reparto\?dia=/));
  });
});
