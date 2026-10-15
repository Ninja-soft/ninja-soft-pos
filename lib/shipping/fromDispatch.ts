// =============================================================================
// lib/shipping/fromDispatch.ts  (ADR-149 · L0, A11 y A12) · PURO
// "Crear envío con logística" desde una entrega de Expedición: arma el
// formulario de Envíos con la dirección de ENTREGA (no la fiscal del cliente),
// el destinatario, el contenido y el valor de lo que lleva esa entrega.
// La dirección hoy es texto libre (L1 la estructura): acá se separa lo que se
// puede y el resto se completa a mano.
// =============================================================================
import { POSTAL_CODE_RE, type ShipmentForm } from "@/lib/shipping/form";

export interface SplitAddress {
  street: string;
  number: string;
  floor: string;
  apartment: string;
  city: string;
  province: string;
  postal_code: string;
}

const EMPTY: SplitAddress = { street: "", number: "", floor: "", apartment: "", city: "", province: "", postal_code: "" };

const CPA_RE = /\b([A-Za-z]\d{4}[A-Za-z]{3})\b/;
// Un CP de 4 dígitos sólo si viene marcado (CP 1629, C.P. 1629 o entre paréntesis):
// suelto se confunde con la altura.
const CP4_RE = /(?:\bC\.?\s?P\.?\s*:?\s*(\d{4})\b)|\((\d{4})\)/i;
const FLOOR_RE = /\bpiso\s*([0-9A-Za-zº°]+)/i;
const APT_RE = /\b(?:depto|dpto|dto|departamento|dep)\.?\s*([0-9A-Za-z]+)/i;

/**
 * Separa "Av. San Martín 1234 piso 2 depto B, Pilar, Buenos Aires (1629)" en
 * calle, altura, piso, depto, localidad, provincia y código postal. Lo que no
 * reconoce queda vacío (nunca inventa).
 */
export function splitAddress(text: string | null | undefined): SplitAddress {
  let rest = (text ?? "").replace(/\s+/g, " ").trim();
  if (!rest) return { ...EMPTY };
  const out: SplitAddress = { ...EMPTY };

  const cpa = rest.match(CPA_RE);
  if (cpa) {
    out.postal_code = cpa[1]!.toUpperCase();
    rest = rest.replace(cpa[0], " ");
  } else {
    const cp = rest.match(CP4_RE);
    if (cp) {
      out.postal_code = (cp[1] ?? cp[2])!;
      rest = rest.replace(cp[0], " ");
    }
  }

  const parts = rest
    .split(",")
    .map((p) => p.replace(/\s+/g, " ").trim())
    .filter(Boolean);
  let first = parts[0] ?? "";
  // Una parte que es sólo el CP (", 1629,") cuenta como código postal.
  const tail = parts.slice(1).filter((p) => {
    if (!out.postal_code && /^\d{4}$/.test(p)) {
      out.postal_code = p;
      return false;
    }
    return true;
  });
  out.city = tail[0] ?? "";
  out.province = tail[1] ?? "";

  const floor = first.match(FLOOR_RE);
  if (floor) {
    out.floor = floor[1]!.replace(/[º°]/g, "");
    first = first.replace(floor[0], " ");
  }
  const apt = first.match(APT_RE);
  if (apt) {
    out.apartment = apt[1]!;
    first = first.replace(apt[0], " ");
  }
  first = first.replace(/\s+/g, " ").trim();
  const num = first.match(/^(.*?\S)\s+(?:n(?:°|º|ro\.?|\.)\s*)?(\d{1,6}[A-Za-z]?)$/i);
  if (num) {
    out.street = num[1]!.trim();
    out.number = num[2]!;
  } else {
    out.street = first;
  }
  return out;
}

export interface DispatchShipmentSource {
  dispatchId: string;
  dispatchNumber: number;
  saleId: string;
  saleNumber: number | null;
  /** Sucursal de donde sale la mercadería. */
  storeId: string;
  shipAddress: string | null;
  customerName: string | null;
  customer: { name: string | null; email: string | null; phone: string | null; document_number: string | null; address: string | null } | null;
  items: { name: string; qty: number; unitPrice: number | null }[];
}

/** Valor de lo que lleva la entrega (cantidad × precio neto de la venta). */
export function dispatchDeclaredValue(items: DispatchShipmentSource["items"]): number {
  const v = items.reduce((t, i) => t + (Number(i.qty) || 0) * (Number(i.unitPrice) || 0), 0);
  return Math.round(v * 100) / 100;
}

/** "Entrega N° 12 · Venta #340: 2 Mesa, 1 Silla" (hasta 500 caracteres). */
export function dispatchContents(src: Pick<DispatchShipmentSource, "dispatchNumber" | "saleNumber" | "items">): string {
  const fmt = (n: number) => (Number.isInteger(n) ? String(n) : String(Math.round(n * 1000) / 1000).replace(".", ","));
  const head = `Entrega N° ${src.dispatchNumber}${src.saleNumber != null ? ` · Venta #${src.saleNumber}` : ""}`;
  const body = src.items.map((i) => `${fmt(Number(i.qty))} ${i.name}`).join(", ");
  return (body ? `${head}: ${body}` : head).slice(0, 500);
}

/**
 * Formulario de Envíos precargado desde la entrega. La dirección es la de
 * ENTREGA (A12); si la entrega no tiene, la del cliente. El código postal
 * queda vacío si no se pudo leer: el formulario lo pide.
 */
export function shipmentFormFromDispatch(src: DispatchShipmentSource, base: ShipmentForm): ShipmentForm {
  const addr = splitAddress(src.shipAddress || src.customer?.address || "");
  return {
    ...base,
    store_id: src.storeId || base.store_id,
    source: "pos_sale",
    sale_id: src.saleId,
    dispatch_id: src.dispatchId,
    recipient: {
      name: src.customer?.name ?? src.customerName ?? "",
      email: src.customer?.email ?? "",
      phone: src.customer?.phone ?? "",
      document: src.customer?.document_number ?? "",
    },
    destination: {
      ...base.destination,
      street: addr.street,
      number: addr.number,
      floor: addr.floor,
      apartment: addr.apartment,
      city: addr.city,
      province: addr.province,
      postal_code: POSTAL_CODE_RE.test(addr.postal_code) ? addr.postal_code : "",
    },
    declared_value: dispatchDeclaredValue(src.items) || base.declared_value,
    notes: dispatchContents(src),
  };
}
