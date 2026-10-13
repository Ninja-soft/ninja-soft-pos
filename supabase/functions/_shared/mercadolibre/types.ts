// =============================================================================
// _shared/mercadolibre/types.ts (H87 · ADR-104). PURO.
//
// Tipos de la API de Mercado Libre que usa NinjaSoft, sólo los campos que se
// leen. Fuente: developers.mercadolibre.com.ar (leído 2026-10-13). Los campos
// opcionales lo son porque la API los omite según el caso (vendedor User
// Products o clásico, ME1 o ME2, orden con o sin carrito).
// =============================================================================

export type MlId = number;

/** POST /oauth/token (authorization_code y refresh_token). */
export interface MlTokenResponse {
  access_token: string;
  token_type?: string;
  expires_in: number;
  scope?: string;
  user_id: MlId;
  refresh_token?: string;
}

/** Error JSON de la API (oauth y recursos). */
export interface MlErrorBody {
  message?: string;
  error?: string;
  status?: number;
  cause?: Array<{ code?: string; message?: string; type?: string; cause_id?: number; references?: string[] } | string>;
}

/** GET /users/me */
export interface MlUser {
  id: MlId;
  nickname: string;
  site_id: string;
  email?: string;
  first_name?: string;
  last_name?: string;
  tags?: string[];
  user_type?: string;
  seller_reputation?: { level_id?: string | null; power_seller_status?: string | null };
  status?: { site_status?: string };
}

/** Payload de la callback de notificaciones (igual para todos los tópicos). */
export interface MlNotification {
  _id?: string;
  resource: string;
  user_id: MlId;
  topic: string;
  application_id: MlId;
  attempts?: number;
  sent?: string;
  received?: string;
  actions?: string[];
}

export interface MlOrderItem {
  item: {
    id: string;
    title: string;
    category_id?: string;
    variation_id?: MlId | null;
    seller_sku?: string | null;
    seller_custom_field?: string | null;
    variation_attributes?: Array<{ id?: string; name: string; value_name: string | null }>;
  };
  quantity: number;
  unit_price: number;
  full_unit_price?: number;
  currency_id?: string;
  sale_fee?: number | null;
  listing_type_id?: string;
}

export interface MlOrder {
  id: MlId;
  date_created: string;
  date_closed?: string | null;
  last_updated?: string;
  status: string;
  status_detail?: string | null;
  tags?: string[];
  total_amount: number;
  paid_amount?: number;
  currency_id?: string;
  pack_id?: MlId | null;
  buyer: { id: MlId; nickname?: string; first_name?: string; last_name?: string; billing_info?: { id?: string | null } | null };
  seller?: { id: MlId };
  order_items: MlOrderItem[];
  payments?: Array<{ id: MlId; status: string; transaction_amount?: number; shipping_cost?: number; total_paid_amount?: number }>;
  shipping?: { id?: MlId | null } | null;
  cancel_detail?: { group?: string; code?: string; description?: string; requested_by?: string; date?: string } | null;
  fulfilled?: boolean | null;
}

/** GET /packs/{id} */
export interface MlPack {
  id: MlId;
  status?: string;
  orders: Array<{ id: MlId }>;
  shipment?: { id: MlId } | null;
}

/** GET /orders/billing-info/MLA/{billing_info_id} (formato nuevo). */
export interface MlBillingInfoNew {
  buyer?: {
    billing_info?: {
      name?: string;
      last_name?: string;
      identification?: { type?: string; number?: string };
      taxes?: { taxpayer_type?: { description?: string; id?: string } };
      address?: {
        street_name?: string;
        street_number?: string;
        city_name?: string;
        state?: { name?: string; code?: string };
        zip_code?: string;
      };
      attributes?: { vat_discriminated_billing?: string; cust_type?: string; business_name?: string };
    };
  };
}

/** GET /orders/{id}/billing_info (formato anterior, todavía vigente en MLA). */
export interface MlBillingInfoLegacy {
  billing_info?: {
    doc_type?: string;
    doc_number?: string;
    additional_info?: Array<{ type: string; value: string }>;
  };
}

/** GET /shipments/{id} (con o sin header x-format-new). */
export interface MlShipment {
  id: MlId;
  mode?: string;
  status: string;
  substatus?: string | null;
  logistic_type?: string;
  logistic?: { mode?: string; type?: string; direction?: string };
  tracking_number?: string | null;
  tracking_method?: string | null;
  order_id?: MlId;
  date_created?: string;
  last_updated?: string;
  shipping_option?: { cost?: number; list_cost?: number; estimated_delivery_time?: { date?: string } };
  lead_time?: { cost?: number; list_cost?: number; estimated_delivery_time?: { date?: string } };
  receiver_address?: { city?: { name?: string }; state?: { name?: string }; zip_code?: string };
  destination?: { receiver_address?: { city?: { name?: string }; state?: { name?: string }; zip_code?: string } };
}

export interface MlAttributeValue {
  id: string;
  name?: string;
  value_id?: string | null;
  value_name?: string | null;
}

export interface MlVariation {
  id: MlId;
  price?: number;
  available_quantity?: number;
  sold_quantity?: number;
  attribute_combinations?: MlAttributeValue[];
  attributes?: MlAttributeValue[];
  seller_custom_field?: string | null;
  picture_ids?: string[];
  user_product_id?: string | null;
  inventory_id?: string | null;
}

/** GET /items/{id} */
export interface MlItem {
  id: string;
  site_id?: string;
  seller_id?: MlId;
  title: string;
  family_name?: string | null;
  family_id?: MlId | string | null;
  user_product_id?: string | null;
  category_id: string;
  price?: number;
  currency_id?: string;
  available_quantity?: number;
  sold_quantity?: number;
  listing_type_id?: string;
  status: string;
  sub_status?: string[];
  tags?: string[];
  permalink?: string;
  thumbnail?: string;
  secure_thumbnail?: string;
  pictures?: Array<{ id: string; url?: string; secure_url?: string }>;
  shipping?: { mode?: string; logistic_type?: string; free_shipping?: boolean };
  variations?: MlVariation[];
  attributes?: MlAttributeValue[];
  catalog_listing?: boolean;
  catalog_product_id?: string | null;
  health?: number | null;
  inventory_id?: string | null;
  date_created?: string;
  last_updated?: string;
}

/** GET /categories/{id}/attributes */
export interface MlCategoryAttribute {
  id: string;
  name: string;
  value_type: string;
  tags?: Record<string, boolean | undefined>;
  values?: Array<{ id: string; name: string }>;
  allowed_units?: Array<{ id: string; name: string }>;
  default_unit?: string;
  value_max_length?: number;
  hierarchy?: string;
  relevance?: number;
  hint?: string;
  tooltip?: string;
}

/** GET /sites/MLA/domain_discovery/search */
export interface MlDomainSuggestion {
  domain_id: string;
  domain_name: string;
  category_id: string;
  category_name: string;
  attributes?: Array<{ id: string; name?: string; value_id?: string | null; value_name?: string | null }>;
}

/** GET /questions/{id} */
export interface MlQuestion {
  id: MlId;
  seller_id?: MlId;
  item_id: string;
  text: string;
  status: string;
  date_created: string;
  from?: { id: MlId };
  answer?: { text: string; status?: string; date_created?: string } | null;
  deleted_from_listing?: boolean;
  hold?: boolean;
}

/** GET /user-products/{id}/stock (header x-version). */
export interface MlUserProductStock {
  id?: string;
  user_id?: MlId;
  locations: Array<{ type: string; quantity: number; store_id?: string; network_node_id?: string }>;
}

/** GET /missed_feeds?app_id= */
export interface MlMissedFeeds {
  messages: Array<MlNotification & { request?: unknown; response?: unknown }>;
  total?: number;
  offset?: number;
  limit?: number;
}

/** GET /orders/search */
export interface MlOrderSearch {
  results: MlOrder[];
  paging?: { total: number; offset: number; limit: number };
}

/** GET /users/{id}/items/search */
export interface MlItemSearch {
  results: string[];
  paging?: { total: number; offset: number; limit: number };
  scroll_id?: string | null;
}
