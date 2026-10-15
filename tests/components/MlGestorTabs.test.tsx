// H141 · ADR-132: Métricas y Posventa del gestor de Mercado Libre con datos
// (las consultas se reemplazan por fixtures): margen con el umbral, casos que
// afectan la reputación con filtros, "te toca" y vencimiento.
import { describe, it, expect, vi } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";

vi.mock("@/components/ui/Toast", () => ({ useToast: () => ({ toast: vi.fn() }) }));
vi.mock("@/components/charts/EChart", () => ({ EChart: ({ ariaLabel }: { ariaLabel: string }) => <div role="img" aria-label={ariaLabel} /> }));

const snap = {
  level_id: "4_light_green",
  power_seller_status: "silver",
  sales_completed: 500,
  sales_period: "60 days",
  claims: { rate: 0.006, value: 3, period: "60 days", real_value: 5, real_rate: 0.01 },
  cancellations: { rate: 0.004, value: 2, period: "60 days", real_value: null, real_rate: null },
  delayed: { rate: 0.02, value: 10, period: "60 days", real_value: null, real_rate: null },
  ratings: { positive: 0.9, neutral: 0.05, negative: 0.05 },
  transactions: { total: 520, completed: 500, canceled: 20, period: "historic" },
};
const now = Date.now();
const claim = (id: number, kind: string, over: Record<string, unknown> = {}) => ({
  id: `c${id}`,
  account_id: "acc",
  claim_id: id,
  resource_id: 2000000000 + id,
  pack_key: null,
  kind,
  type: "mediations",
  stage: "claim",
  status: "opened",
  reason_id: "PDD9939",
  due_at: new Date(now + 2 * 3600_000).toISOString(),
  action_responsible: "respondent",
  my_actions: [{ action: "send_message_to_complainant", mandatory: true, due_date: null }],
  detail_title: `Caso ${id}`,
  return_status: null,
  affects_reputation: true,
  resolution_result: null,
  exclusion_status: null,
  exclusion_note: null,
  assigned_to: null,
  date_created: new Date(now - 86400_000).toISOString(),
  ml_last_updated: null,
  ...over,
});
const claims = [claim(1, "reclamo"), claim(2, "mediacion"), claim(3, "devolucion", { action_responsible: "complainant", affects_reputation: false })];

vi.mock("@/modules/mercadolibre/gestorHooks", () => {
  const mut = { mutate: vi.fn(), mutateAsync: vi.fn(), isPending: false };
  return {
    useMlSnapshots: () => ({
      data: [
        { snap_date: "2026-10-14", claims_rate: 0.004, cancellations_rate: 0.004, delayed_rate: 0.02, data: snap, taken_at: "2026-10-14T09:20:00Z" },
        { snap_date: "2026-10-15", claims_rate: 0.006, cancellations_rate: 0.004, delayed_rate: 0.02, data: snap, taken_at: "2026-10-15T09:20:00Z" },
      ],
      isLoading: false,
    }),
    useMlGestorSettings: () => ({ data: null }),
    useMlClaims: () => ({ data: claims, isLoading: false }),
    useMlClaimDetail: () => ({ data: null, isLoading: true }),
    useMlPackMessages: () => ({ data: null }),
    useMlTemplates: () => ({ data: [], isError: false }),
    useMlGestorMutations: () =>
      new Proxy({}, { get: () => mut }),
  };
});

// Maestro de motivos (ADR-147): PDD9939 está; los PNR no, y se piden completar.
const ensure = vi.fn(() => [] as string[]);
vi.mock("@/modules/mercadolibre/reasonHooks", () => {
  const rows = [
    { id: "PDD9939", family: "PDD", title: "Llegó lo que compré en buenas condiciones pero no lo quiero", description: "Reclamo con el producto entregado.", flow: null, alias_of: null, excludable: true, recommended: true, active: true },
  ];
  return {
    useMlClaimReasons: () => ({ data: rows, index: new Map(rows.map((r) => [r.id, r])) }),
    useEnsureClaimReasons: (_i: unknown, ids: unknown) => ensure(ids as never),
  };
});

import { MlMetricsTab } from "@/components/mercadolibre/gestor/MlMetricsTab";
import { MlPostsaleTab } from "@/components/mercadolibre/gestor/MlPostsaleTab";
import type { MlAccount } from "@/modules/mercadolibre/hooks";

const account = { id: "acc", nickname: "TIENDA" } as MlAccount;

describe("MlMetricsTab", () => {
  it("nivel, MercadoLíder, margen con el umbral y casos con filtros", () => {
    render(<MlMetricsTab account={account} canManage />);
    expect(screen.getByText("Verde claro")).toBeTruthy();
    expect(screen.getByText(/MercadoLíder/)).toBeTruthy();
    // Reclamos 0,6 % de 500 con umbral 1 %: tope 5, quedan 2.
    expect(screen.getByText("Te quedan 2 reclamos de margen antes de pasar el 1 % (tope: 5).")).toBeTruthy();
    expect(screen.getByText("Sin excluir: 5 (1 %)")).toBeTruthy();
    // Demoras 2 % contra 8 %: en verde.
    expect(screen.getAllByText("En verde").length).toBeGreaterThan(0);
    expect(screen.getByRole("img", { name: /Evolución diaria/ })).toBeTruthy();
    // Afectan: reclamo y mediación (la devolución no).
    expect(screen.getByText("Todos 2")).toBeTruthy();
    fireEvent.click(screen.getByText("Mediaciones 1"));
    expect(screen.queryByText(/venta 2000000001/)).toBeNull();
    expect(screen.getByText(/venta 2000000002/)).toBeTruthy();
    // Título del motivo además del código.
    expect(screen.getAllByText("Llegó lo que compré en buenas condiciones pero no lo quiero").length).toBeGreaterThan(0);
    expect(screen.getAllByText(/\(PDD9939\)/).length).toBeGreaterThan(0);
  });
});

describe("MlPostsaleTab", () => {
  it("te toca primero, con vencimiento y acción", () => {
    render(<MlPostsaleTab account={account} canManage />);
    expect(screen.getByText("Te toca (2)")).toBeTruthy();
    expect(screen.getByText("Caso 1")).toBeTruthy();
    expect(screen.queryByText("Caso 3")).toBeNull();
    expect(screen.getAllByText(/Vence en menos de 4 h/).length).toBe(2);
    expect(screen.getAllByText(/Responder al comprador/).length).toBeGreaterThan(0);
    fireEvent.click(screen.getByText("Abiertos (3)"));
    expect(screen.getByText("Caso 3")).toBeTruthy();
    expect(screen.getByText("Le toca al comprador")).toBeTruthy();
    // Debajo del título del caso, el motivo del maestro con su código.
    expect(screen.getAllByText(/Motivo:/).length).toBe(3);
    expect(screen.getAllByText("Llegó lo que compré en buenas condiciones pero no lo quiero").length).toBe(3);
    // Se busca por el título del motivo.
    fireEvent.change(screen.getByPlaceholderText(/Buscar/i), { target: { value: "buenas condiciones" } });
    expect(screen.getByText("Caso 1")).toBeTruthy();
    expect(ensure).toHaveBeenCalled();
  });
});
