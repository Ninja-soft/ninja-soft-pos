// =============================================================================
// H32 · ADR-129: pedidos de salón, reserva por minutos y expedición.
// Lógica pura (config, transiciones, renglones a reservar, disponible,
// textos), espejos contra el SQL de la migración, contratos de la migración
// (gating, RLS, auditoría, grants) y los botones del POS.
// =============================================================================
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import {
  DEFAULT_ORDER_CONFIG,
  DISPATCH_STATUS_LABEL,
  ORDER_MINUTES_MAX,
  ORDER_MINUTES_MIN,
  availableStock,
  crossBranchAllowed,
  dispatchCanMove,
  dispatchIsForStore,
  enabledDeliveryTypes,
  minutesLeftLabel,
  orderConfig,
  orderErrorMessage,
  orderItemsFromCart,
  orderReservationState,
  pickupFailureText,
  primaryDispatchAction,
  reservationLabel,
  reservedByProduct,
  type DeliveryType,
  type DispatchStatus,
} from "@/lib/orders/logic";
import { FEATURE_INFO } from "@/lib/saas/featureInfo";
import { SaleActions } from "@/components/pos/screen/SaleActions";

vi.mock("next/link", () => ({
  default: ({ href, children, ...rest }: { href: string; children: React.ReactNode }) => (
    <a href={href} {...rest}>
      {children}
    </a>
  ),
}));
import { OrdersBar } from "@/components/orders/OrdersBar";
import type { SaleOrder } from "@/modules/orders/api";

const MIG_DIR = join(process.cwd(), "supabase", "migrations");
const MAIN = readFileSync(join(MIG_DIR, "20261123100100_pedidos_despacho.sql"), "utf8");
const FEAT = readFileSync(join(MIG_DIR, "20261123100000_features_pedidos_despacho.sql"), "utf8");

function fnBody(sql: string, name: string): string {
  const start = sql.indexOf(`create or replace function ${name}(`);
  expect(start, name).toBeGreaterThanOrEqual(0);
  const end = sql.indexOf("\n$$;", start);
  return sql.slice(start, end);
}

describe("config (pos_settings.order_config) espejo de pos_order_config", () => {
  it("defaults iguales a los del SQL", () => {
    const body = fnBody(MAIN, "pos_order_config");
    expect(body).toMatch(/else 30 end/);
    expect(body).toMatch(/least\(greatest\(v_m, 5\), 1440\)/);
    expect(body).toMatch(/when r ->> 'expiry_action' = 'cancel' then 'cancel' else 'release'/);
    expect(body).toMatch(/'immediate_via_dispatch', _jbool\(r, 'immediate_via_dispatch', true\)/);
    expect(body).toMatch(/'retiro'.*'cross_branch', false\)/s);
    expect(body).toMatch(/'pickup_code', true\)/);
    expect(DEFAULT_ORDER_CONFIG.reservation_minutes).toBe(30);
    expect(ORDER_MINUTES_MIN).toBe(5);
    expect(ORDER_MINUTES_MAX).toBe(1440);
    expect(orderConfig(null)).toEqual(DEFAULT_ORDER_CONFIG);
    expect(orderConfig("x")).toEqual(DEFAULT_ORDER_CONFIG);
  });

  it("topes, tipos raros y retiro inmediato nunca cross-branch", () => {
    expect(orderConfig({ reservation_minutes: 1 }).reservation_minutes).toBe(5);
    expect(orderConfig({ reservation_minutes: 99999 }).reservation_minutes).toBe(1440);
    expect(orderConfig({ reservation_minutes: "45" }).reservation_minutes).toBe(45);
    expect(orderConfig({ reservation_minutes: "abc" }).reservation_minutes).toBe(30);
    expect(orderConfig({ reservation_minutes: 12.5 }).reservation_minutes).toBe(30);
    expect(orderConfig({ expiry_action: "otra" }).expiry_action).toBe("release");
    expect(orderConfig({ expiry_action: "cancel" }).expiry_action).toBe("cancel");
    const c = orderConfig({ delivery_types: { inmediato: { cross_branch: true }, retiro: { cross_branch: "si" }, envio: { enabled: false } } });
    expect(c.delivery_types.inmediato.cross_branch).toBe(false);
    expect(c.delivery_types.retiro.cross_branch).toBe(false);
    expect(enabledDeliveryTypes(c)).toEqual(["inmediato", "retiro"]);
    expect(crossBranchAllowed(orderConfig({ delivery_types: { retiro: { cross_branch: true } } }), "retiro")).toBe(true);
    expect(crossBranchAllowed(orderConfig({ delivery_types: { retiro: { cross_branch: true } } }), "inmediato")).toBe(false);
  });
});

describe("expedición: transiciones espejo de _dispatch_can", () => {
  const ALL: DispatchStatus[] = ["pendiente", "armando", "listo", "en_transito", "entregado", "despachado", "cancelado"];
  const TYPES: DeliveryType[] = ["inmediato", "retiro", "envio"];

  // Evalúa el CASE del SQL con los mismos argumentos (traducción literal).
  function sqlCan(from: string, to: string, type: string, cross: boolean, arrived: boolean): boolean {
    if (["entregado", "despachado", "cancelado"].includes(from)) return false;
    if (to === "cancelado") return true;
    if (from === "pendiente") return ["armando", "listo"].includes(to);
    if (from === "armando") return ["pendiente", "listo"].includes(to);
    if (from === "en_transito") return to === "listo";
    if (from === "listo") {
      if (to === "armando") return !(cross && arrived);
      if (to === "en_transito") return cross && !arrived;
      if (to === "entregado") return ["inmediato", "retiro"].includes(type) && (!cross || arrived);
      if (to === "despachado") return type === "envio" && (!cross || arrived);
      return false;
    }
    return false;
  }

  it("el SQL tiene exactamente esas ramas", () => {
    const body = fnBody(MAIN, "_dispatch_can");
    for (const frag of [
      "when p_from in ('entregado', 'despachado', 'cancelado') then false",
      "when p_to = 'cancelado' then true",
      "when p_from = 'pendiente' then p_to in ('armando', 'listo')",
      "when p_from = 'armando' then p_to in ('pendiente', 'listo')",
      "when p_from = 'en_transito' then p_to = 'listo'",
      "when p_to = 'armando' then not (p_cross and p_arrived)",
      "when p_to = 'en_transito' then p_cross and not p_arrived",
      "when p_to = 'entregado' then p_type in ('inmediato', 'retiro') and (not p_cross or p_arrived)",
      "when p_to = 'despachado' then p_type = 'envio' and (not p_cross or p_arrived)",
    ]) {
      expect(body).toContain(frag);
    }
  });

  it("TS y SQL coinciden en toda la matriz", () => {
    for (const from of ALL)
      for (const to of ALL)
        for (const type of TYPES)
          for (const cross of [false, true])
            for (const arrived of [false, true]) {
              expect(dispatchCanMove(from, to, type, cross, arrived), `${from}->${to} ${type} ${cross} ${arrived}`).toBe(
                sqlCan(from, to, type, cross, arrived),
              );
            }
  });

  it("acción principal y sucursal que la ve", () => {
    const base = { store_id: "A", fulfillment_store_id: "A", arrived_at: null, delivery_type: "retiro" as DeliveryType };
    expect(primaryDispatchAction({ ...base, status: "pendiente" })).toBe("armando");
    expect(primaryDispatchAction({ ...base, status: "armando" })).toBe("listo");
    expect(primaryDispatchAction({ ...base, status: "listo" })).toBe("entregar");
    expect(primaryDispatchAction({ ...base, status: "listo", delivery_type: "envio" })).toBe("despachar");
    const cross = { ...base, fulfillment_store_id: "B" };
    expect(primaryDispatchAction({ ...cross, status: "listo" })).toBe("en_transito");
    expect(primaryDispatchAction({ ...cross, status: "en_transito" })).toBe("recibir");
    expect(primaryDispatchAction({ ...cross, status: "listo", arrived_at: "2026-10-14T10:00:00Z" })).toBe("entregar");
    expect(primaryDispatchAction({ ...base, status: "entregado" })).toBeNull();
    expect(dispatchIsForStore({ ...cross, status: "listo", arrived_at: "x" }, "A")).toBe(false);
    expect(dispatchIsForStore({ ...cross, status: "listo", arrived_at: "x" }, "B")).toBe(true);
    expect(dispatchIsForStore({ ...cross, status: "pendiente" }, "B")).toBe(true);
    expect(dispatchIsForStore({ ...base, status: "pendiente" }, "C")).toBe(false);
    expect(DISPATCH_STATUS_LABEL.en_transito).toBe("En camino");
  });
});

describe("pedido: renglones, reserva y disponible", () => {
  it("renglones a reservar: suma por producto y variante, sin regalos, packs ni montos libres", () => {
    const items = orderItemsFromCart([
      { productId: "p1", quantity: 2 },
      { productId: "p1", quantity: 1.5 },
      { productId: "p1", variantId: "v1", quantity: 1 },
      { productId: null, quantity: 1 },
      { productId: "p2", quantity: 1, giftPromoId: "promo" },
      { productId: "p3", quantity: 1, packCreditId: "pack" },
      { productId: "p4", quantity: 0 },
    ]);
    expect(items).toEqual([
      { product_id: "p1", variant_id: null, qty: 3.5 },
      { product_id: "p1", variant_id: "v1", qty: 1 },
    ]);
  });

  it("estado de la reserva y su texto", () => {
    const now = new Date("2026-10-14T12:00:00Z");
    const o = { status: "abierto" as const, reservation_id: "r", reserved_until: "2026-10-14T12:12:00Z", reservation_released_at: null };
    expect(orderReservationState(o, now)).toEqual({ kind: "active", msLeft: 12 * 60_000 });
    expect(reservationLabel(o, now)).toBe("Stock reservado, vence en 12 min");
    expect(reservationLabel({ ...o, reserved_until: "2026-10-14T11:59:00Z" }, now)).toMatch(/liberada/);
    expect(reservationLabel({ ...o, reservation_released_at: "x" }, now)).toMatch(/liberada/);
    expect(reservationLabel({ ...o, reservation_id: null }, now)).toBe("Sin reserva de stock");
    expect(minutesLeftLabel(90 * 60_000)).toBe("1 h 30 min");
    expect(minutesLeftLabel(60 * 60_000)).toBe("1 h");
    expect(minutesLeftLabel(150 * 60_000)).toBe("2 h");
    expect(minutesLeftLabel(10_000)).toBe("1 min");
  });

  it("disponible = stock − reservado (por sucursal o total)", () => {
    expect(availableStock(10, 4)).toBe(6);
    expect(availableStock(2, 3)).toBe(-1);
    expect(availableStock(5, -2)).toBe(5);
    const rows = [
      { store_id: "A", product_id: "p1", variant_id: null, reserved: 2 },
      { store_id: "A", product_id: "p1", variant_id: "v", reserved: 1 },
      { store_id: "B", product_id: "p1", variant_id: null, reserved: 5 },
    ];
    expect(reservedByProduct(rows, "A").get("p1")).toBe(3);
    expect(reservedByProduct(rows, null).get("p1")).toBe(8);
  });

  it("textos de error rioplatenses", () => {
    expect(orderErrorMessage(new Error("insufficient_available_stock: Campera"))).toBe("No hay stock libre para reservar Campera.");
    expect(orderErrorMessage({ message: "order_taken_by_other" })).toBe("Otra caja está cobrando ese pedido.");
    expect(orderErrorMessage(new Error("feature_not_in_plan: pedidos_despacho"))).toMatch(/plan/);
    expect(orderErrorMessage(new Error("cross_branch_not_allowed: retiro"))).toMatch(/otra sucursal/);
    expect(orderErrorMessage(new Error("algo raro"))).toBe("No se pudo completar la operación.");
    expect(pickupFailureText("pickup_code_invalid", 1)).toBe("Código incorrecto. Queda 1 intento.");
    expect(pickupFailureText("pickup_code_locked", 0)).toMatch(/bloqueado/);
    for (const t of [orderErrorMessage(new Error("x")), reservationLabel({ status: "abierto", reservation_id: null, reserved_until: null, reservation_released_at: null })]) {
      expect(t).not.toContain("—");
    }
  });
});

describe("migraciones (contratos)", () => {
  it("versión posterior a la última de main y ninguna aplicada por error", () => {
    const names = readdirSync(MIG_DIR).filter((f) => f.includes("pedidos_despacho")).sort();
    expect(names).toEqual(["20261123100000_features_pedidos_despacho.sql", "20261123100100_pedidos_despacho.sql"]);
    for (const n of names) expect(Number(n.slice(0, 14))).toBeGreaterThan(20261122100000);
  });

  it("feature OPTIONAL en Pro, Business y Enterprise con copy", () => {
    expect(FEAT).toMatch(/'pedidos_despacho', 'Pedidos de salón y expedición'/);
    expect(FEAT).toMatch(/'ventas', false, 56/);
    expect(FEAT).toMatch(/p\.key in \('pro', 'business', 'enterprise'\)/);
    expect(FEATURE_INFO.pedidos_despacho?.minPlan).toBe("Pro");
  });

  it("gating real en cada RPC de escritura", () => {
    expect(fnBody(MAIN, "_order_assert")).toMatch(/tenant_has_feature_for\(v_tenant, 'pedidos_despacho'\)/);
    expect(fnBody(MAIN, "_dispatch_lock")).toMatch(/tenant_has_feature_for\(v_d\.tenant_id, 'pedidos_despacho'\)/);
    for (const fn of ["sale_order_create", "sale_order_take", "sale_order_leave", "sale_order_cancel", "sale_order_complete", "dispatch_create_for_sale"]) {
      expect(fnBody(MAIN, fn), fn).toMatch(/_order_assert\(/);
    }
    for (const fn of ["dispatch_advance", "dispatch_deliver", "dispatch_ship", "dispatch_cancel"]) {
      expect(fnBody(MAIN, fn), fn).toMatch(/_dispatch_lock\(p_id\)/);
    }
    // La reserva pide además reservas_stock.
    expect(fnBody(MAIN, "sale_order_create")).toMatch(/tenant_has_feature_for\(v_tenant, 'reservas_stock'\)/);
  });

  it("RLS sin is_internal(), con initplan y sin escritura por REST", () => {
    const code = MAIN.split(/\r?\n/).filter((l) => !l.trim().startsWith("--")).join("\n");
    expect(code).not.toMatch(/is_internal\(\)/);
    expect(MAIN).not.toMatch(/create policy[^;]*for (insert|update|delete|all)/i);
    const policies = MAIN.match(/create policy[\s\S]*?;/g) ?? [];
    expect(policies.length).toBe(4);
    for (const p of policies) {
      expect(p.replace(/\(select current_tenant_id\(\)\)/g, "")).not.toMatch(/current_tenant_id\(\)/);
      expect(p.replace(/\(select internal_scope\(\)\)/g, "")).not.toMatch(/internal_scope\(\)/);
    }
    expect(MAIN).toMatch(/revoke all on sale_orders from anon, authenticated;/);
    expect(MAIN).toMatch(/revoke all on dispatches from anon, authenticated;/);
    // El hash del código no se concede por columna.
    const grants = MAIN.match(/grant select \([\s\S]*?\) on (sale_orders|dispatches) to authenticated;/g) ?? [];
    expect(grants.length).toBe(2);
    for (const g of grants) expect(g).not.toMatch(/pickup_code_hash/);
  });

  it("auditoría en cada acción crítica y job sólo de service_role", () => {
    for (const a of [
      "sale_order_created",
      "sale_order_taken",
      "sale_order_left",
      "sale_order_cancelled",
      "sale_order_paid",
      "sale_order_reservation_released",
      "sale_order_expired",
      "dispatch_created",
      "dispatch_status_changed",
      "dispatch_delivered",
      "dispatch_pickup_failed",
      "dispatch_shipped",
      "dispatch_cancelled",
    ]) {
      expect(MAIN, a).toContain(`'${a}'`);
    }
    expect(MAIN).toMatch(/revoke all on function sale_orders_expire_due\(int\) from public, anon, authenticated;/);
    expect(MAIN).toMatch(/cron\.schedule\('sale-orders-expire', '\* \* \* \* \*'/);
  });

  it("no recrea create_sale: se engancha con el trigger de la reserva", () => {
    expect(MAIN).not.toMatch(/function (public\.)?create_sale\(/);
    expect(MAIN).toMatch(/after update of status on stock_reservations/);
    // El trigger nunca hace fallar la venta.
    expect(fnBody(MAIN, "stock_reservations_sale_order_sync")).toMatch(/exception when others then\s+raise warning/);
  });
});

describe("POS: botones", () => {
  it("Pedido junto a Pausar y Limpiar, con candado sin el plan", () => {
    const onOrder = vi.fn();
    const { rerender } = render(
      <SaleActions disabled={false} onPause={() => undefined} onClear={() => undefined} onOrder={onOrder} />,
    );
    fireEvent.click(screen.getByRole("button", { name: /Pedido/ }));
    expect(onOrder).toHaveBeenCalled();
    rerender(<SaleActions disabled={false} onPause={() => undefined} onClear={() => undefined} onOrder={onOrder} orderLocked />);
    expect(screen.getByRole("button", { name: /Pedido/ }).getAttribute("title")).toMatch(/no incluida en tu plan/);
    rerender(<SaleActions disabled={false} onPause={() => undefined} onClear={() => undefined} onOrder={onOrder} orderBlocked="Ya estás cobrando un pedido." />);
    expect((screen.getByRole("button", { name: /Pedido/ }) as HTMLButtonElement).disabled).toBe(true);
    rerender(<SaleActions disabled={false} onPause={() => undefined} onClear={() => undefined} />);
    expect(screen.queryByRole("button", { name: /Pedido/ })).toBeNull();
  });

  it("barra de pedidos para la caja", () => {
    const base = {
      store_id: "A",
      fulfillment_store_id: "A",
      delivery_type: "retiro",
      customer_id: null,
      customer_phone: null,
      pickup_name: null,
      ship_address: null,
      notes: null,
      seller_user_id: "u",
      seller_professional_id: null,
      seller_name: "Juan",
      cart: { v: 1, lines: [], discountTotal: 0, couponCode: null, customer: null, offeredWarrantyId: "", pricing: { listId: null, termId: null }, notes: null },
      checkout: null,
      item_count: 1,
      reservation_id: "r",
      reserved_until: new Date(Date.now() + 20 * 60_000).toISOString(),
      reservation_released_at: null,
      taken_at: null,
      sale_id: null,
      paid_at: null,
      cashier_user_id: null,
      cancel_reason: null,
      created_at: new Date().toISOString(),
    } as const;
    const list = [
      { ...base, id: "o1", number: 7, status: "abierto", customer_name: "Ana", total: 1500, taken_by: null },
      { ...base, id: "o2", number: 8, status: "tomado", customer_name: null, total: 900, taken_by: "otra" },
    ] as unknown as SaleOrder[];
    const onTake = vi.fn();
    render(<OrdersBar list={list} currentUserId="yo" onTake={onTake} />);
    fireEvent.click(screen.getByRole("button", { name: /Cobrar el pedido 7/ }));
    expect(onTake).toHaveBeenCalledWith(list[0]);
    expect((screen.getByRole("button", { name: /Cobrar el pedido 8/ }) as HTMLButtonElement).disabled).toBe(true);
    expect(screen.getByText("En otra caja")).toBeTruthy();
  });
});
