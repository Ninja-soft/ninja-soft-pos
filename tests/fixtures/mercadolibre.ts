// Fixtures de la API de Mercado Libre (H87 · ADR-104), con la forma de los
// ejemplos de developers.mercadolibre.com.ar (leídos 2026-10-13). Ids y datos
// personales son inventados.
import type {
  MlBillingInfoLegacy,
  MlBillingInfoNew,
  MlCategoryAttribute,
  MlItem,
  MlOrder,
  MlQuestion,
  MlShipment,
} from "@/supabase/functions/_shared/mercadolibre/types";

export const APP_ID = "5503910054141466";
export const SELLER_ID = 468424240;

/** Notificación de orders_v2 (doc "Notificaciones"). */
export const notificationOrder = {
  _id: "f9f08571-1f65-4c46-9e0a-c0f43faac1c5",
  resource: "/orders/2000003508419013",
  user_id: SELLER_ID,
  topic: "orders_v2",
  application_id: Number(APP_ID),
  attempts: 1,
  sent: "2026-10-13T16:19:20.129Z",
  received: "2026-10-13T16:19:20.106Z",
};

export const tokenResponse = {
  access_token: "APP_USR-123456-101315-8cc4448aa53bc0a6dd5ae5b1d7d1c2f3-468424240",
  token_type: "bearer",
  expires_in: 21600,
  scope: "offline_access read write",
  user_id: SELLER_ID,
  refresh_token: "TG-5b9032b4e23464aed1f959f-1234567",
};

export function order(id: number, opts: Partial<MlOrder> = {}): MlOrder {
  return {
    id,
    date_created: "2026-10-13T12:00:00.000-03:00",
    date_closed: "2026-10-13T12:00:05.000-03:00",
    last_updated: "2026-10-13T12:00:06.000-03:00",
    status: "paid",
    status_detail: null,
    tags: ["paid", "not_delivered"],
    total_amount: 3000,
    paid_amount: 3000,
    currency_id: "ARS",
    pack_id: null,
    buyer: { id: 123456, nickname: "COMPRADOR_TEST", billing_info: { id: "BI-777" } },
    seller: { id: SELLER_ID },
    order_items: [
      {
        item: { id: "MLA1500000001", title: "Remera algodón", category_id: "MLA109276", variation_id: null, seller_sku: "REM-01" },
        quantity: 2,
        unit_price: 1500,
        full_unit_price: 1500,
        currency_id: "ARS",
        sale_fee: 195.5,
        listing_type_id: "gold_special",
      },
    ],
    payments: [{ id: 99001, status: "approved", transaction_amount: 3000, shipping_cost: 0 }],
    shipping: { id: 40123456789 },
    cancel_detail: null,
    ...opts,
  };
}

export const billingNewCuit: MlBillingInfoNew = {
  buyer: {
    billing_info: {
      name: "Juan",
      last_name: "Pérez",
      identification: { type: "CUIT", number: "20-12345678-6" },
      taxes: { taxpayer_type: { description: "IVA Responsable Inscripto" } },
      address: { street_name: "Av. Corrientes", street_number: "1234", city_name: "CABA", state: { name: "Capital Federal" }, zip_code: "1043" },
      attributes: { vat_discriminated_billing: "true", cust_type: "BU", business_name: "Pérez SRL" },
    },
  },
};

export const billingNewDni: MlBillingInfoNew = {
  buyer: {
    billing_info: {
      name: "Ana",
      last_name: "Gómez",
      identification: { type: "DNI", number: "30111222" },
      taxes: { taxpayer_type: { description: "Consumidor Final" } },
      address: { street_name: "San Martín", street_number: "50", city_name: "Rosario", state: { name: "Santa Fe" }, zip_code: "2000" },
    },
  },
};

export const billingLegacy: MlBillingInfoLegacy = {
  billing_info: {
    doc_type: "CUIT",
    doc_number: "30712345678",
    additional_info: [
      { type: "BUSINESS_NAME", value: "Comercial Sur SA" },
      { type: "TAXPAYER_TYPE_ID", value: "Monotributo" },
      { type: "STREET_NAME", value: "Belgrano" },
      { type: "STREET_NUMBER", value: "10" },
      { type: "CITY_NAME", value: "Mendoza" },
    ],
  },
};

export const shipmentNew: MlShipment = {
  id: 40123456789,
  status: "ready_to_ship",
  substatus: "ready_to_print",
  logistic: { mode: "me2", type: "cross_docking", direction: "forward" },
  tracking_number: "TRK123",
  tracking_method: "MEL Distribution",
  lead_time: { cost: 450.5 },
  destination: { receiver_address: { city: { name: "Córdoba" }, state: { name: "Córdoba" }, zip_code: "5000" } },
  date_created: "2026-10-13T12:00:10.000-03:00",
};

export const shipmentOld: MlShipment = {
  id: 40123456790,
  mode: "me2",
  logistic_type: "fulfillment",
  status: "shipped",
  substatus: null,
  shipping_option: { cost: 0 },
  receiver_address: { city: { name: "La Plata" }, state: { name: "Buenos Aires" }, zip_code: "1900" },
  order_id: 2000003508419014,
};

export const categoryAttributes: MlCategoryAttribute[] = [
  { id: "BRAND", name: "Marca", value_type: "string", tags: { required: true, catalog_required: true }, value_max_length: 255 },
  { id: "MODEL", name: "Modelo", value_type: "string", tags: { required: true } },
  { id: "COLOR", name: "Color", value_type: "list", tags: { allow_variations: true, variation_attribute: true, required: true }, values: [{ id: "52049", name: "Negro" }] },
  { id: "SIZE", name: "Talle", value_type: "string", tags: { allow_variations: true, variation_attribute: true } },
  { id: "GTIN", name: "Código universal de producto", value_type: "string", tags: { conditional_required: true } },
  { id: "SELLER_SKU", name: "SKU", value_type: "string", tags: {} },
  { id: "ITEM_CONDITION", name: "Condición", value_type: "list", tags: { hidden: true } },
  { id: "PRODUCT_DATA_SOURCE", name: "Fuente", value_type: "string", tags: { read_only: true } },
  { id: "MATERIAL", name: "Material", value_type: "string", tags: {} },
];

export const itemClassicWithVariations: MlItem = {
  id: "MLA1500000002",
  title: "Zapatilla urbana",
  category_id: "MLA109027",
  price: 25000,
  currency_id: "ARS",
  available_quantity: 7,
  status: "active",
  listing_type_id: "gold_pro",
  shipping: { mode: "me2", logistic_type: "drop_off" },
  attributes: [{ id: "BRAND", value_name: "Marca X" }],
  variations: [
    { id: 174997747229, available_quantity: 3, attribute_combinations: [{ id: "SIZE", value_name: "40" }], attributes: [{ id: "SELLER_SKU", value_name: "ZAP-40" }] },
    { id: 174997747230, available_quantity: 4, attribute_combinations: [{ id: "SIZE", value_name: "41" }], attributes: [{ id: "GTIN", value_name: "7790000000411" }] },
  ],
};

export const itemUp: MlItem = {
  id: "MLA1500000003",
  title: "Taza cerámica 350 ml",
  family_name: "Taza cerámica",
  user_product_id: "MLAU123456789",
  category_id: "MLA1234",
  price: 4200,
  available_quantity: 12,
  status: "active",
  tags: ["good_quality_thumbnail"],
  shipping: { mode: "me2", logistic_type: "fulfillment" },
  attributes: [{ id: "SELLER_SKU", value_name: "TAZA-350" }, { id: "GTIN", value_name: "7791234567890" }],
};

export const question: MlQuestion = {
  id: 12345678901,
  seller_id: SELLER_ID,
  item_id: "MLA1500000001",
  text: "¿Tenés talle L?",
  status: "UNANSWERED",
  date_created: "2026-10-13T15:00:00.000-04:00",
  from: { id: 555 },
  answer: null,
};
