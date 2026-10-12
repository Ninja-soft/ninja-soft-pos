import type { SaleMethod, ResolvedTender } from "@/lib/pos/tenders";

// Extra del cobro hacia el POS. `kind` decide qué hace create_sale (ver
// SaleExtraInput): warranty/surcharge entran como ítem de venta; 'tip' va a
// sales.tip_amount (no es ítem); 'professional' atribuye la comisión.
export interface PaymentExtra {
  kind: "warranty" | "surcharge" | "tip" | "professional";
  /** Etiqueta del ítem de venta (sólo warranty/surcharge). */
  name?: string;
  amount?: number;
  /** Medio de la propina (kind='tip'). */
  method?: string;
  /** professionals.id (kind='professional'). */
  id?: string;
}

/** Ítem del carrito para dividir "por ítem". */
export interface SplitItem {
  id: string;
  label: string;
  /** Subtotal de la línea (cant × precio − descuento). */
  amount: number;
}

export interface Promo {
  discount: number;
  id: string | null;
  name: string | null;
}

/** Pago que viaja a create_sale (p_payments). */
export interface CheckoutPayment {
  method: SaleMethod;
  amount: number;
  reference?: string;
  card_voucher?: { lote: string; cupon: string; autorizacion: string };
}

/** Resultado aprobado de un cobro electrónico (QR / link / Point). */
export interface ElectronicResult {
  reference: string;
  amount: number;
  method: SaleMethod;
  /** Recargos que sumó el propio modal (plan de cuotas del proveedor). */
  surcharges: { name: string; amount: number }[];
}

/** Pedido de cobro electrónico que la hoja delega al modal del proveedor. */
export interface ElectronicRequest {
  tender: ResolvedTender;
  amount: number;
  onApproved: (r: ElectronicResult) => void;
  onClose: () => void;
}
