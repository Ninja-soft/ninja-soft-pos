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
  /**
   * payments.card_voucher (jsonb). `marca`, `ultimos4` y `adquirente` los suma
   * la tarjeta en posnet (opcionales; el ticket sigue leyendo
   * lote/cupón/autorización). Mismos nombres que las terminales integradas.
   */
  card_voucher?: {
    lote: string;
    cupon: string;
    autorizacion: string;
    marca?: string;
    ultimos4?: string;
    comercio?: string;
    cuotas?: number;
    /** Adquirente (payway, fiserv, getnet...). */
    adquirente?: string;
    /** Terminal integrada (ADR-053): el cupón lo informó la terminal. */
    origen?: "terminal";
    /** terminal_transactions.id; lo valida el trigger de payments. */
    terminal_tx?: string;
  };
}

/** Cobro aprobado por la terminal integrada (ADR-053). */
export interface TerminalChargeResult {
  method: "debit" | "credit";
  card_voucher: NonNullable<CheckoutPayment["card_voucher"]>;
  /** Marca (clave de lib/pos/cardBrands) para el logo, si se reconoce. */
  brandKey: string | null;
}

/** Pedido de cobro que la hoja delega a la terminal integrada de la caja. */
export interface TerminalChargeRequest {
  amount: number;
  /** Cuotas pedidas (null = las elige el cliente en la terminal, si se puede). */
  installments: number | null;
  cardKind: "debit" | "credit";
  /** Marca elegida (clave de lib/pos/cardBrands) si el protocolo la pide. */
  cardBrand: string | null;
  onApproved: (r: TerminalChargeResult) => void;
  /** Pasar a "Tarjeta en posnet" con carga manual del cupón. */
  onManual: () => void;
  onClose: () => void;
}

/** Resultado aprobado de un cobro electrónico (QR / link / Point). */
export interface ElectronicResult {
  reference: string;
  amount: number;
  method: SaleMethod;
  /** Recargos que sumó el propio modal (plan de cuotas del proveedor). */
  surcharges: { name: string; amount: number }[];
}

/** QR / link que se deja esperando el pago (ADR-048). */
export interface ElectronicParkInput {
  intentId: string;
  amount: number;
  surcharges: { name: string; amount: number }[];
  provider: string;
  channel: "qr" | "link";
  shareUrl: string | null;
  qrData: string | null;
  expiresMinutes: number;
  customerEmail: string | null;
  customerPhone: string | null;
  sharedVia: { via: "whatsapp" | "email" | "sms" | "copy" | "native" | "qr"; to: string | null }[];
}

/** Lo que la hoja arma para estacionar la venta: igual que onConfirm + el QR. */
export interface SheetParkRequest {
  payments: CheckoutPayment[];
  extras: PaymentExtra[];
  promo: Promo | null;
  qr: ElectronicParkInput;
}

/** Contexto de "Dejar en espera" que provee el POS. */
export interface SheetParkOptions {
  /** Motivo por el que no se puede (plan, caja, mesa...). null = se puede. */
  blockedReason: string | null;
  label: string;
  customerName: string | null;
  customerEmail: string | null;
  customerPhone: string | null;
  onPark: (r: SheetParkRequest) => Promise<{ id: string } | null>;
  onEmail?: (chargeId: string, to: string, note: string) => Promise<void>;
}

/** Pedido de cobro electrónico que la hoja delega al modal del proveedor. */
export interface ElectronicRequest {
  tender: ResolvedTender;
  amount: number;
  onApproved: (r: ElectronicResult) => void;
  onClose: () => void;
  /** Dejar en espera (sólo QR / link que cubren toda la venta). */
  park?: {
    blockedReason: string | null;
    label: string;
    customerName: string | null;
    customerEmail: string | null;
    customerPhone: string | null;
    onPark: (r: ElectronicParkInput) => Promise<{ id: string } | null>;
    onEmail?: (chargeId: string, to: string, note: string) => Promise<void>;
  };
}

/**
 * Estado del panel de cuenta corriente v2 (AccountPayPanel). `reference` viaja
 * en payments.reference para el trigger de cargo: {"installments": N} y/o
 * {"override_reason": "..."} (dueño/encargado) o {"override_token": "..."}
 * (PIN de supervisor). `blocked` = no se puede registrar el pago todavía.
 */
export interface AccountPayState {
  reference: string | undefined;
  blocked: boolean;
}

/** Pedido de render del panel de cuenta corriente para el monto de la línea. */
export interface AccountPayRequest {
  amount: number;
  onChange: (s: AccountPayState) => void;
}
