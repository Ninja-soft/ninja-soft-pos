import type { Page } from "@playwright/test";
import { test, expect, requireSession, settle } from "./support/fixtures";
import { AUTH_STATE_PATH, RUN_PREFIX } from "./support/env";
import {
  addToCart,
  appears,
  createSimpleProduct,
  deleteProduct,
  dialog,
  ensureShiftOpen,
  gotoClean,
  openCheckout,
} from "./support/app";
import { fakeUuid, fulfillJson, guardEdgeFunctions, patchJson, wantsObject } from "./support/mocks";

// Cobros en espera (ADR-048): listado con filtros, estacionar un cobro con
// link de Mercado Pago y cancelarlo. El tenant QA no tiene proveedores
// conectados y contra producción NUNCA se crea un cobro real: la cuenta de MP,
// el link (Edge mp_create_qr) y el estacionado (park_pending_charge, que exige
// un intent real) se responden desde el navegador. Lo que se valida es el
// flujo de la UI de punta a punta, sin escribir nada en la base.

const PRODUCT = `${RUN_PREFIX} Espera item`;
const PRICE = 1250;
const CUSTOMER = `${RUN_PREFIX} Cliente espera`;

/** Mercado Pago "conectado" sólo en este navegador (lecturas reales + parche). */
async function fakeMercadoPago(page: Page) {
  await patchJson(page, /\/rest\/v1\/tenant_payment_methods(\?|$)/, (json) => {
    const rows = (Array.isArray(json) ? json : []) as Record<string, unknown>[];
    const others = rows.filter((r) => r.provider_key !== "mercadopago");
    const base = others.length > 0 ? others : [
      { provider_key: "cash", enabled: true, config: {}, surcharge_pct: 0 },
      { provider_key: "transfer", enabled: true, config: {}, surcharge_pct: 0 },
    ];
    return [
      ...base,
      {
        provider_key: "mercadopago",
        enabled: true,
        config: { connected: true, plan_mode: "global" },
        surcharge_pct: 0,
      },
    ];
  });
  await patchJson(page, /\/rest\/v1\/rpc\/gating_summary/, (json) => {
    const j = (json ?? {}) as { features?: Record<string, boolean> };
    return { ...j, features: { ...(j.features ?? {}), mercado_pago: true, cobros_en_espera: true } };
  });
  // Estado del intent mientras espera: siempre pendiente.
  await page.route(/\/rest\/v1\/mp_payment_intents(\?|$)/, (route) => {
    const row = { status: "pending", mp_payment_id: null };
    return fulfillJson(route, wantsObject(route.request()) ? row : [row]);
  });
}

async function emptyCart(page: Page) {
  const clear = page.getByRole("button", { name: "Vaciar carrito" });
  if (await appears(clear, 2_000)) {
    await clear.click();
    await page.getByRole("button", { name: "Vaciar", exact: true }).click();
  }
}

test.describe("cobros en espera", () => {
  requireSession();
  test.describe.configure({ mode: "serial" });

  test("listado: resumen y filtros por estado", async ({ page }) => {
    await gotoClean(page, "/cobros-en-espera");
    await expect(page.getByRole("heading", { level: 1, name: "Cobros en espera" })).toBeVisible();
    for (const kpi of ["Esperando pago", "Pagados sin venta", "Para revisar"]) {
      await expect(page.getByText(kpi, { exact: true }).first()).toBeVisible();
    }
    const filter = page.getByRole("radiogroup", { name: "Filtrar por estado" });
    for (const f of ["Cobrados", "Cancelados y vencidos", "Todos", "Abiertos"]) {
      await filter.getByRole("radio", { name: f }).click();
      await expect(filter.getByRole("radio", { name: f })).toHaveAttribute("aria-checked", "true");
      await settle(page);
    }
  });

  test.describe("estacionar desde el POS (Mercado Pago simulado)", () => {
    test.beforeAll(async ({ browser }) => {
      const page = await browser.newPage({ storageState: AUTH_STATE_PATH });
      await createSimpleProduct(page, PRODUCT, PRICE);
      await page.close();
    });

    test.afterAll(async ({ browser }) => {
      const page = await browser.newPage({ storageState: AUTH_STATE_PATH });
      await deleteProduct(page, PRODUCT).catch(() => undefined);
      await page.close();
    });

    test("dejar en espera un cobro con link", async ({ page, allowConsole }) => {
      allowConsole(/functions\/v1|status of 503/);
      const intentId = fakeUuid();
      const parked: Record<string, unknown>[] = [];
      await guardEdgeFunctions(page, {
        // Sin caja QR: el modal cae al link de Checkout Pro.
        mp_qr: () => ({ error: "qr_pos_not_configured" }),
        mp_create_qr: () => ({ intent_id: intentId, init_point: "https://e2e.invalid/checkout/espera" }),
      });
      await fakeMercadoPago(page);
      await page.route(/\/rest\/v1\/rpc\/park_pending_charge/, (route) => {
        parked.push(route.request().postDataJSON() as Record<string, unknown>);
        return fulfillJson(route, {
          id: fakeUuid(),
          expires_at: new Date(Date.now() + 86_400_000).toISOString(),
          amount: PRICE,
        });
      });

      await gotoClean(page, "/pos");
      await ensureShiftOpen(page);
      await emptyCart(page);
      await addToCart(page, PRODUCT);
      const sheet = await openCheckout(page);

      // Con varios canales es un radiogroup; con uno solo, un botón.
      const link = sheet.getByRole("radio", { name: "Mercado Pago Link" });
      if (await appears(link, 3_000)) await link.click();
      else await sheet.getByRole("button", { name: /^Mercado Pago/ }).first().click();
      await sheet.getByRole("button", { name: /^Generar link/ }).click();

      const modal = dialog(page, /Cobrar con link/);
      await expect(modal).toBeVisible();
      await expect(modal.getByText("Esperando pago").first()).toBeVisible();
      await modal.getByRole("button", { name: "Dejar en espera" }).click();

      await expect(
        page.getByRole("region", { name: /Notifications/ }).getByText("Cobro en espera", { exact: true }),
      ).toBeVisible();
      expect(parked).toHaveLength(1);
      expect(parked[0]).toMatchObject({ p_intent_id: intentId, p_channel: "link" });
      await emptyCart(page);
    });
  });

  test("cancelar un cobro en espera (datos simulados)", async ({ page, allowConsole }) => {
    allowConsole(/functions\/v1|status of 503/);
    await guardEdgeFunctions(page);
    const id = fakeUuid();
    let cancelled = false;
    const now = Date.now();
    const charge = () => ({
      id,
      tenant_id: null,
      store_id: null,
      register_id: null,
      cash_shift_id: null,
      origin_shift_id: null,
      created_by: null,
      customer_id: null,
      customer_name: CUSTOMER,
      customer_email: null,
      customer_phone: null,
      lines: [],
      cart: {},
      amount: PRICE,
      sale_total: PRICE,
      provider_key: "mercadopago",
      channel: "link",
      intent_id: fakeUuid(),
      previous_intent_ids: [],
      share_url: "https://e2e.invalid/checkout/espera",
      qr_data: null,
      shared_via: [],
      share_count: 0,
      status: cancelled ? "cancelled" : "waiting",
      expires_at: new Date(now + 86_400_000).toISOString(),
      paid_at: null,
      paid_amount: null,
      completed_at: null,
      sale_id: null,
      sale_number: null,
      cancelled_at: cancelled ? new Date().toISOString() : null,
      cancel_reason: cancelled ? "E2E" : null,
      carry_over: false,
      needs_review: false,
      last_error: null,
      attempts: 0,
      acknowledged_at: null,
      notes: null,
      version: 1,
      created_at: new Date(now - 60_000).toISOString(),
      updated_at: new Date(now - 60_000).toISOString(),
    });
    await page.route(/\/rest\/v1\/pending_charges(\?|$)/, (route) => {
      const url = new URL(route.request().url());
      const status = url.searchParams.get("status") ?? "";
      // "Abiertos" pide status=in.(waiting,paid): después de cancelar, vacío.
      const rows = cancelled && status.includes("waiting") ? [] : [charge()];
      return fulfillJson(route, wantsObject(route.request()) ? charge() : rows);
    });
    await page.route(/\/rest\/v1\/pending_charge_events(\?|$)/, (route) => fulfillJson(route, []));
    await page.route(/\/rest\/v1\/mp_payment_intents(\?|$)/, (route) => {
      const row = { status: "pending", mp_payment_id: null };
      return fulfillJson(route, wantsObject(route.request()) ? row : [row]);
    });
    const cancelCalls: Record<string, unknown>[] = [];
    await page.route(/\/rest\/v1\/rpc\/cancel_pending_charge/, (route) => {
      cancelCalls.push(route.request().postDataJSON() as Record<string, unknown>);
      cancelled = true;
      return fulfillJson(route, { id, intent_id: null, provider_key: "mercadopago", channel: "link" });
    });

    await gotoClean(page, "/cobros-en-espera");
    const row = page.getByRole("button").filter({ hasText: CUSTOMER }).first();
    await expect(row).toBeVisible();
    await expect(row).toContainText("Esperando pago");
    await row.click();

    const detail = page.getByRole("dialog").filter({ hasText: CUSTOMER }).first();
    await expect(detail).toBeVisible();
    await detail.getByRole("button", { name: "Cancelar cobro" }).click();
    const confirm = dialog(page, "Cancelar el cobro en espera");
    await expect(confirm).toBeVisible();
    const ok = confirm.getByRole("button", { name: "Cancelar cobro" });
    await expect(ok).toBeDisabled(); // el motivo es obligatorio
    await confirm.getByLabel("Motivo").fill(`${RUN_PREFIX} cancelado por e2e`);
    await ok.click();
    await expect(page.getByText("Cobro cancelado").first()).toBeVisible();
    expect(cancelCalls).toHaveLength(1);
    expect(cancelCalls[0]).toMatchObject({ p_id: id });
  });
});
