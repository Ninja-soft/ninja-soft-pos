// ADR-126: sección interna "Mercado Libre (app)". La Clave secreta nunca se
// muestra (sólo "Guardada" y los últimos 4); App ID, Redirect URI, URL de
// notificaciones y tópicos para DevCenter; guardar valida el formato antes de
// llamar a la Edge.
import { describe, it, expect, vi } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";

const toast = vi.fn();
vi.mock("@/components/ui/Toast", () => ({ useToast: () => ({ toast }) }));

import { MlAppPanel } from "@/components/internal/mercadolibre/MlAppPanel";
import type { MlAppStatus } from "@/lib/mercadolibre/appSetup";

const STATUS: MlAppStatus = {
  updated_at: "2026-10-14T10:00:00Z",
  client_id: "1234567890123456",
  client_secret: true,
  redirect_uri: "https://pos.soft.ninja/api/ml/oauth/callback",
  hints: { client_secret: "…wxyz" },
  missing: [],
  origin: "platform",
  effective: { client_id: "1234567890123456", redirect_uri: "https://pos.soft.ninja/api/ml/oauth/callback" },
  env: { client_id: "1111222233334444", client_secret: true, redirect_uri: null },
  stats: {
    tenants_connected: 3,
    accounts_active: 4,
    accounts_reauth: 1,
    notifications_24h: 12,
    notifications_errors_24h: 0,
    last_notifications: [{ topic: "orders_v2", status: "done", source: "webhook", received_at: "2026-10-14T09:59:00Z" }],
  },
};

function renderPanel(over: Partial<Parameters<typeof MlAppPanel>[0]> = {}) {
  const onSave = vi.fn(async () => undefined);
  render(
    <MlAppPanel
      status={STATUS}
      loading={false}
      test={null}
      testing={false}
      webhookUrl="https://hooks.soft.ninja/ml"
      webhookDirectUrl="https://abc.supabase.co/functions/v1/ml_webhook"
      redirectUri="https://pos.soft.ninja/api/ml/oauth/callback"
      onSave={onSave}
      onTest={vi.fn()}
      onClear={vi.fn(async () => undefined)}
      {...over}
    />,
  );
  return { onSave };
}

describe("MlAppPanel", () => {
  it("muestra estado, URLs, tópicos y uso sin exponer la clave", () => {
    renderPanel();
    expect(screen.getByText("Configurada")).toBeTruthy();
    expect(screen.getByText("https://hooks.soft.ninja/ml")).toBeTruthy();
    expect(screen.getAllByText("https://pos.soft.ninja/api/ml/oauth/callback").length).toBeGreaterThan(0);
    expect(screen.getByText("shipments")).toBeTruthy();
    expect(screen.getByText(/3 negocios conectados/)).toBeTruthy();
    expect(screen.getByText(/termina en wxyz/)).toBeTruthy();
    expect(screen.getByDisplayValue("1234567890123456")).toBeTruthy();
  });

  it("valida el App ID antes de guardar", () => {
    const { onSave } = renderPanel();
    const input = screen.getByDisplayValue("1234567890123456");
    fireEvent.change(input, { target: { value: "yo@soft.ninja" } });
    expect(screen.getByText(/Cargaste un email/)).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Guardar App ID" }));
    expect(onSave).not.toHaveBeenCalled();
  });

  it("si no pudo leer el estado no muestra el formulario", () => {
    renderPanel({ status: null, loadError: true });
    expect(screen.getByText(/No pudimos leer la configuración/)).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Guardar App ID" })).toBeNull();
  });
});
