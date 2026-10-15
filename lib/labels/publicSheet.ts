// Tipos de la ficha pública del producto (RPC public_product_sheet, ADR-148).
import type { PublicPaymentMethod, PublicPaymentPlan } from "./paymentSim";

export interface PublicProductSheet {
  tenant: { name: string; slug: string };
  branding: {
    logo_url: string | null;
    accent: string | null;
    legal_name: string | null;
    trade_name: string | null;
    phone: string | null;
    address: string | null;
  } | null;
  product: {
    id: string;
    name: string;
    description: string | null;
    brand: string | null;
    category: string | null;
    unit: string | null;
    price: number;
    net_content: number | null;
    net_content_unit: string | null;
    images: string[];
    variants: { label: string | null; price: number }[] | null;
  };
  payments: { methods: PublicPaymentMethod[]; plans: PublicPaymentPlan[] };
  catalog: { enabled: boolean; ordering: boolean };
}

/** Normaliza lo que vuelve de la RPC (números como string, nulls). */
export function normalizeSheet(raw: unknown): PublicProductSheet | null {
  if (!raw || typeof raw !== "object") return null;
  const r = raw as PublicProductSheet;
  if (!r.product?.id) return null;
  return {
    ...r,
    product: {
      ...r.product,
      price: Number(r.product.price ?? 0),
      net_content: r.product.net_content == null ? null : Number(r.product.net_content),
      images: Array.isArray(r.product.images) ? r.product.images.filter((u) => typeof u === "string" && /^https?:\/\//.test(u)) : [],
      variants: Array.isArray(r.product.variants) ? r.product.variants.map((v) => ({ label: v.label, price: Number(v.price ?? 0) })) : null,
    },
    payments: {
      methods: (r.payments?.methods ?? []).map((m) => ({ ...m, surcharge_pct: Number(m.surcharge_pct ?? 0) })),
      plans: (r.payments?.plans ?? []).map((p) => ({
        ...p,
        installments: Number(p.installments ?? 1),
        surcharge_pct: Number(p.surcharge_pct ?? 0),
      })),
    },
    catalog: { enabled: Boolean(r.catalog?.enabled), ordering: Boolean(r.catalog?.ordering) },
  };
}
