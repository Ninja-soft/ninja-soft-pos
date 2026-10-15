// =============================================================================
// ADR-149 · F22 · H143 (L0): ordenar y arreglar la logística que ya existe.
// Lógica pura (pestañas de Expedición, modo de entrega de la venta, dirección
// para Envíos, valor para el aviso de COT, delivery cobrado), textos de error
// y contratos de la migración 20261221100000_logistica_l0_arreglos.
// =============================================================================
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  DELIVERY_TYPE_LABEL,
  EXPEDITION_TABS,
  FULFILLMENT_MODE_LABEL,
  dispatchCanMove,
  dispatchTab,
  expeditionCounts,
  expeditionList,
  fulfillmentModeOf,
  orderErrorMessage,
  type DeliveryType,
  type DispatchStatus,
} from "@/lib/orders/logic";
import { dispatchContents, dispatchDeclaredValue, shipmentFormFromDispatch, splitAddress } from "@/lib/shipping/fromDispatch";
import { buildCreatePayload, shipmentFormSchema, shippingErrorMessage, type ShipmentForm } from "@/lib/shipping/form";
import { remitoErrorMessage, remitoValueForCot } from "@/lib/remitos/logic";
import { nextDeliveryStatus } from "@/modules/delivery/api";
import { LOGISTICS_SECTIONS, isLogisticsPath } from "@/components/logistics/LogisticsNav";

const ROOT = process.cwd();
const MIG = readFileSync(join(ROOT, "supabase", "migrations", "20261221100000_logistica_l0_arreglos.sql"), "utf8");

const D = (over: Partial<{
  status: DispatchStatus;
  delivery_type: DeliveryType;
  store_id: string;
  fulfillment_store_id: string;
  sale_store_id: string | null;
  arrived_at: string | null;
}> = {}) => ({
  status: "pendiente" as DispatchStatus,
  delivery_type: "retiro" as DeliveryType,
  store_id: "A",
  fulfillment_store_id: "A",
  sale_store_id: "A",
  arrived_at: null,
  ...over,
});

describe("Expedición: pestañas, sucursal y modo (R14, A25)", () => {
  it("cada estado cae en una sola pestaña; despachado sigue En camino", () => {
    expect(EXPEDITION_TABS.map((t) => t.label)).toEqual(["Pendientes", "Armando", "Listos", "En camino", "Entregados"]);
    expect(dispatchTab("pendiente")).toBe("pendientes");
    expect(dispatchTab("armando")).toBe("armando");
    expect(dispatchTab("listo")).toBe("listos");
    expect(dispatchTab("en_transito")).toBe("en_camino");
    expect(dispatchTab("despachado")).toBe("en_camino");
    expect(dispatchTab("entregado")).toBe("entregados");
    expect(dispatchTab("cancelado")).toBe("entregados");
  });

  it("Pendientes filtra por sucursal (incluida la que vendió) y por modo", () => {
    const all = [
      D(),
      D({ delivery_type: "envio" }),
      D({ store_id: "B", fulfillment_store_id: "B", sale_store_id: "C" }),
      D({ store_id: "B", fulfillment_store_id: "B", sale_store_id: "B" }),
    ];
    const f = { tab: "pendientes" as const, storeId: "A", mode: "todos" as const, showImmediate: false };
    expect(expeditionList(all, f)).toHaveLength(2);
    expect(expeditionList(all, { ...f, mode: "envio" })).toHaveLength(1);
    expect(expeditionList(all, { ...f, storeId: "C" })).toHaveLength(1);
    expect(expeditionList(all, { ...f, storeId: null })).toHaveLength(4);
    expect(expeditionCounts(all, "A", "todos").pendientes).toBe(2);
    expect(expeditionCounts(all, "A", "retiro").pendientes).toBe(1);
  });

  it("Entregados filtra por sucursal y oculta lo que se llevó en el momento salvo que se pida", () => {
    const done = [
      D({ status: "entregado", delivery_type: "inmediato" }),
      D({ status: "entregado" }),
      D({ status: "entregado", store_id: "B", fulfillment_store_id: "B", sale_store_id: "B" }),
    ];
    const f = { tab: "entregados" as const, storeId: "A", mode: "todos" as const, showImmediate: false };
    expect(expeditionList(done, f)).toHaveLength(1);
    expect(expeditionList(done, { ...f, showImmediate: true })).toHaveLength(2);
  });

  it("un solo nombre para lo que se lleva en el momento (A24)", () => {
    expect(DELIVERY_TYPE_LABEL.inmediato).toBe("Se lo lleva ahora");
  });

  it("lo despachado se entrega a mano sólo si es envío (espejo de _dispatch_can)", () => {
    expect(dispatchCanMove("despachado", "entregado", "envio", false, false)).toBe(true);
    expect(dispatchCanMove("despachado", "cancelado", "envio", false, false)).toBe(false);
    expect(dispatchCanMove("despachado", "entregado", "retiro", false, false)).toBe(false);
  });

  it("textos de los errores nuevos", () => {
    expect(orderErrorMessage(new Error("nothing_pending"))).toBe("De esa venta ya no queda nada por entregar.");
    expect(orderErrorMessage(new Error("delivery_qty_mismatch"))).toBe("Pediste más de lo que falta entregar.");
    expect(orderErrorMessage(new Error("shipment_in_use"))).toMatch(/otra entrega/);
    expect(remitoErrorMessage(new Error("remito_already_covered"))).toMatch(/otro remito vigente/);
    expect(shippingErrorMessage(new Error("dispatch_has_shipment"))).toBe("Esa entrega ya tiene un envío creado.");
  });
});

describe("Venta: cómo se entrega (R18)", () => {
  it("etiquetas y lectura segura del modo", () => {
    expect(FULFILLMENT_MODE_LABEL.retiro).toBe("Retira en tienda");
    expect(FULFILLMENT_MODE_LABEL.envio).toBe("Envío a domicilio");
    expect(fulfillmentModeOf("mixto")).toBe("mixto");
    expect(fulfillmentModeOf("otro")).toBeNull();
    expect(fulfillmentModeOf(undefined)).toBeNull();
  });
});

describe("Envío desde la entrega (A11, A12)", () => {
  it("separa calle, altura, piso, depto, localidad, provincia y CP", () => {
    expect(splitAddress("Av. San Martín 1234 piso 2 depto B, Pilar, Buenos Aires (1629)")).toEqual({
      street: "Av. San Martín",
      number: "1234",
      floor: "2",
      apartment: "B",
      city: "Pilar",
      province: "Buenos Aires",
      postal_code: "1629",
    });
    expect(splitAddress("Calle 9 N° 100, Tigre, CP 1648").postal_code).toBe("1648");
    expect(splitAddress("Calle 9 N° 100, Tigre").number).toBe("100");
    expect(splitAddress("Mitre 55, Rosario, Santa Fe, S2000ABC").postal_code).toBe("S2000ABC");
    // Sin marca, un número de 4 dígitos es la altura, no el CP.
    expect(splitAddress("Belgrano 1629, Tigre")).toMatchObject({ street: "Belgrano", number: "1629", postal_code: "" });
    expect(splitAddress("Barrio Los Pinos lote 4").street).toBe("Barrio Los Pinos lote");
    expect(splitAddress("")).toMatchObject({ street: "", number: "" });
  });

  const src = {
    dispatchId: "11111111-1111-4111-8111-111111111111",
    dispatchNumber: 12,
    saleId: "22222222-2222-4222-8222-222222222222",
    saleNumber: 340,
    storeId: "33333333-3333-4333-8333-333333333333",
    shipAddress: "Calle 9 100, Tigre, Buenos Aires, CP 1648",
    customerName: "Ana Pérez",
    customer: { name: "Ana Pérez", email: "ana@x.com", phone: "1155", document_number: "30111222", address: "Domicilio fiscal 1, CABA" },
    items: [
      { name: "Mesa", qty: 2, unitPrice: 1000 },
      { name: "Silla", qty: 1.5, unitPrice: 200 },
    ],
  };
  const base: ShipmentForm = {
    store_id: "",
    source: "manual",
    sale_id: null,
    dispatch_id: null,
    order_ref: "",
    service_type: "door",
    recipient: { name: "", document: "", email: "", phone: "" },
    destination: { street: "", number: "", floor: "", apartment: "", city: "", province: "", postal_code: "", reference: "" },
    pickup_point: null,
    packages: [{ weight_kg: 1, length_cm: 30, width_cm: 20, height_cm: 10 }],
    declared_value: 0,
    notes: "",
  };

  it("precarga con la dirección de ENTREGA, el cliente, el contenido y el valor", () => {
    const f = shipmentFormFromDispatch(src, base);
    expect(f.source).toBe("pos_sale");
    expect(f.dispatch_id).toBe(src.dispatchId);
    expect(f.destination).toMatchObject({ street: "Calle 9", number: "100", city: "Tigre", province: "Buenos Aires", postal_code: "1648" });
    expect(f.recipient).toMatchObject({ name: "Ana Pérez", document: "30111222" });
    expect(f.declared_value).toBe(2300);
    expect(f.notes).toBe("Entrega N° 12 · Venta #340: 2 Mesa, 1,5 Silla");
    expect(shipmentFormSchema.safeParse(f).success).toBe(true);
    expect(buildCreatePayload(f, { idempotencyKey: "envio:1", quote: null, submit: false })).toMatchObject({
      source: "pos_sale",
      sale_id: src.saleId,
      dispatch_id: src.dispatchId,
    });
  });

  it("sin dirección de entrega usa la del cliente; sin precios, valor 0", () => {
    const f = shipmentFormFromDispatch({ ...src, shipAddress: null, items: [{ name: "Mesa", qty: 1, unitPrice: null }] }, base);
    expect(f.destination.street).toBe("Domicilio fiscal");
    expect(dispatchDeclaredValue([{ name: "x", qty: 1, unitPrice: null }])).toBe(0);
    expect(dispatchContents({ dispatchNumber: 3, saleNumber: null, items: [] })).toBe("Entrega N° 3");
  });

  it("un envío manual no manda entrega", () => {
    expect(buildCreatePayload({ ...base, dispatch_id: "x" } as ShipmentForm, { idempotencyKey: "envio:2", quote: null, submit: false }).dispatch_id).toBeNull();
  });
});

describe("Remito: valor para el aviso de COT antes de emitir (A9)", () => {
  it("lo tipeado manda; vacío, el del servidor", () => {
    expect(remitoValueForCot("5000", 100)).toBe(5000);
    expect(remitoValueForCot("1.234,5".replace(".", ""), null)).toBe(1234.5);
    expect(remitoValueForCot("", 2500)).toBe(2500);
    expect(remitoValueForCot("  ", null)).toBeNull();
    expect(remitoValueForCot("abc", 10)).toBeNull();
  });
});

describe("Delivery cobrado antes de salir (A7)", () => {
  it("sin cobrar no se entrega desde el tablero; cobrado, el último paso es Entregado", () => {
    expect(nextDeliveryStatus("delivery", "en_camino")).toBeNull();
    expect(nextDeliveryStatus("delivery", "en_camino", true)).toBe("entregado");
    expect(nextDeliveryStatus("delivery", "preparando", true)).toBe("en_camino");
    expect(nextDeliveryStatus("takeaway", "listo", true)).toBe("entregado");
    expect(nextDeliveryStatus("mostrador", "listo", false)).toBeNull();
  });
});

describe("Menú Logística (A24)", () => {
  it("una entrada con Expedición, Remitos y Envíos como sub-páginas", () => {
    expect(LOGISTICS_SECTIONS.map((s) => s.href)).toEqual(["/expedicion", "/remitos", "/envios"]);
    expect(isLogisticsPath("/expedicion")).toBe(true);
    expect(isLogisticsPath("/envios")).toBe(true);
    expect(isLogisticsPath("/logistica")).toBe(true);
    expect(isLogisticsPath("/ventas")).toBe(false);
    const shell = readFileSync(join(ROOT, "components", "layout", "AppShell.tsx"), "utf8");
    expect(shell).toContain('{ href: "/logistica", label: "Logística"');
    for (const old of ['href: "/expedicion"', 'href: "/remitos"', 'href: "/envios"']) expect(shell).not.toContain(old);
  });
});

describe("migración 20261221100000_logistica_l0_arreglos", () => {
  it("sin policies nuevas ni is_internal", () => {
    expect(MIG).not.toMatch(/create policy/i);
    expect(MIG).not.toMatch(/is_internal\(\)/);
  });

  it("toda función nueva o reescrita es SECURITY DEFINER con search_path fijo", () => {
    const fns = [...MIG.matchAll(/create or replace function (?:public\.)?(\w+)\(/g)].map((m) => m[1]!);
    expect(fns).toEqual(
      expect.arrayContaining([
        "_sale_fulfillment_mode",
        "_dispatch_close",
        "dispatch_create_for_sale",
        "dispatch_sale_pending",
        "dispatch_ship",
        "dispatch_deliver",
        "shipment_create",
        "_remito_lines",
        "remito_issue",
        "remito_preview",
        "trg_sales_void_dispatches",
        "trg_sale_return_items_dispatches",
        "trg_shipments_dispatch_sync",
        "trg_delivery_orders_paid_status",
      ]),
    );
    for (const name of fns) {
      const start = MIG.search(new RegExp(`create or replace function (?:public\\.)?${name}\\(`));
      const head = MIG.slice(start, start + 600).toLowerCase();
      expect(head, name).toMatch(/set search_path (to 'public'|= public)/);
      if (!["_dispatch_can", "trg_delivery_orders_paid_status"].includes(name)) expect(head, name).toContain("security definer");
    }
  });

  it("las internas no se exponen y las RPC sólo para authenticated", () => {
    for (const fn of ["_sale_fulfillment_mode(uuid)", "_dispatch_close(uuid, text, text)", "_remito_lines(uuid, uuid, jsonb)", "trg_sales_void_dispatches()"]) {
      expect(MIG).toContain(`revoke all on function ${fn} from public, anon, authenticated;`);
    }
    for (const fn of ["dispatch_sale_pending(uuid)", "remito_preview(jsonb)", "dispatch_ship(uuid, text, uuid)", "shipment_create(jsonb)"]) {
      expect(MIG).toContain(`grant execute on function public.${fn} to authenticated;`);
    }
  });

  it("auditoría en cada cierre y cambio de estado", () => {
    for (const action of ["p_action", "'sale_voided_logistics'", "'dispatch_created'", "'dispatch_shipped'", "'dispatch_delivered'", "'dispatch_shipment_cancelled'", "'remito_issued'"]) {
      expect(MIG).toContain(action);
    }
  });

  it("A6: despachar escribe shipped_at y no delivered_at", () => {
    const ship = MIG.slice(MIG.indexOf("create or replace function public.dispatch_ship("), MIG.indexOf("create or replace function public.dispatch_deliver("));
    expect(ship).toMatch(/set status = 'despachado', shipped_by = auth\.uid\(\), shipped_at = now\(\)/);
    expect(ship).not.toMatch(/'despachado', delivered_by/);
  });

  it("columnas nuevas legibles y modo de la venta con check", () => {
    expect(MIG).toContain("grant select (shipped_by, shipped_at, shipment_status, stock_returned_at) on dispatches to authenticated;");
    expect(MIG).toMatch(/fulfillment_mode in \('en_mostrador', 'retiro', 'envio', 'logistica', 'mixto'\)/);
    expect(MIG).toMatch(/create unique index if not exists shipments_dispatch_active_key/);
  });
});
