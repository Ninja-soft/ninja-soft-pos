// Venta ficticia para el preview del editor de tickets (H9b).
export interface SampleBrand {
  logo_url: string | null;
  legal_name: string | null;
  accent?: string | null;
  cuit: string | null;
  phone: string | null;
  address: string | null;
  ticket_footer: string | null;
  ticket_width: string | null;
  ticket_title: string | null;
  ticket_legend: string | null;
  ticket_show_qr: boolean | null;
  ticket_show_logo: boolean | null;
}

export interface SampleTicketData {
  sale: {
    number: number;
    numberLabel: string;
    created_at: string;
    subtotal: number;
    discount_total: number;
    total: number;
    status: string;
  };
  items: { id: string; product_name: string; quantity: number; unit_price: number; subtotal: number }[];
  payments: { id: string; method: string; amount: number }[];
  customer?: { name: string; email?: string | null } | null;
  brand: SampleBrand | null;
}

export function sampleTicketData(brand: SampleBrand | null): SampleTicketData {
  return {
    sale: {
      number: 1042,
      numberLabel: "#0001042",
      created_at: new Date("2026-06-06T16:30:00").toISOString(),
      subtotal: 14500,
      discount_total: 500,
      total: 14000,
      status: "completed",
    },
    items: [
      { id: "s1", product_name: "Remera básica negra M", quantity: 2, unit_price: 4500, subtotal: 9000 },
      { id: "s2", product_name: "Gorra trucker", quantity: 1, unit_price: 3500, subtotal: 3500 },
      { id: "s3", product_name: "Medias pack x3", quantity: 1, unit_price: 2000, subtotal: 2000 },
    ],
    payments: [
      { id: "p1", method: "cash", amount: 10000 },
      { id: "p2", method: "transfer", amount: 4000 },
    ],
    customer: { name: "Juan Pérez", email: "juan@example.com" },
    brand,
  };
}
