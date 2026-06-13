import { createClient } from "@/lib/supabase/client";

export interface SalesReport {
  total: number;
  count: number;
  by_day: { day: string; total: number; count: number }[];
  by_method: { method: string; total: number }[];
  by_category: { category: string; total: number; qty: number }[];
  by_user: { cashier: string; total: number; count: number }[];
  by_product: { product: string; total: number; qty: number }[];
  by_customer: { customer: string; total: number; count: number }[];
}

export interface WarrantyReportRow {
  label: string;
  qty: number;
  total: number;
  commission_pct: number;
  commission: number;
}
export interface WarrantyReport {
  rows: WarrantyReportRow[];
  total: number;
  commission: number;
  qty: number;
}

// ── Reportes gastronómicos (F13 · H52) ──────────────────────────────────────
// Cuatro RPCs SECURITY DEFINER tenant-scoped (gastro_*_report) agregan EN SQL la
// operación gastro del período. No están en los tipos generados (no se regeneran):
// se castean args + payload, como sales_report/staff_productivity.

export interface GastroTablesReport {
  total: number;
  orders: number;
  avg_ticket: number;
  by_area: { area: string; total: number; orders: number; avg_ticket: number }[];
  by_table: {
    table_label: string;
    area: string;
    total: number;
    orders: number;
    avg_ticket: number;
  }[];
  by_waiter: { waiter: string; total: number; orders: number; avg_ticket: number }[];
}

export interface GastroKitchenReport {
  items: number;
  avg_seconds: number;
  min_seconds: number;
  max_seconds: number;
  by_station: {
    station: string;
    items: number;
    avg_seconds: number;
    min_seconds: number;
    max_seconds: number;
  }[];
}

export interface GastroDeliveryReport {
  orders: number;
  total: number;
  delivery_fees: number;
  avg_ticket: number;
  by_channel: {
    channel: string;
    orders: number;
    total: number;
    delivery_fees: number;
    avg_ticket: number;
  }[];
  by_zone: {
    zone: string;
    orders: number;
    total: number;
    delivery_fees: number;
    avg_ticket: number;
  }[];
  by_type: { order_type: string; orders: number; total: number }[];
}

export interface GastroTopItemsReport {
  // `cost` y `margin` (F13 · H52): costo estimado del plato según su receta
  // (H50, `product_recipes`) por la cantidad vendida, y margen = total − cost.
  // cost = 0 cuando el producto no tiene receta cargada (margen no significativo).
  top: { name: string; qty: number; total: number; cost: number; margin: number }[];
  by_station: { station: string; qty: number; total: number }[];
  by_course: { course: number; qty: number; total: number }[];
}

// Productividad por profesional (H39): una fila por profesional con actividad en
// el período. Lo calcula la RPC staff_productivity (SECURITY DEFINER, tenant-
// scoped; respeta pos_settings.staff_sees_own_only).
export interface StaffProductivityRow {
  professional_id: string;
  professional: string;
  services: number; // turnos realizados
  products_qty: number; // unidades de producto vendidas
  sales_count: number; // ventas atribuidas
  billed: number; // total facturado (productos, sin propina)
  commission: number; // comisión calculada
  tips: number; // propinas atribuidas
  avg_ticket: number; // billed / sales_count
}

export const reportsApi = {
  sales: async (fromISO: string, toISO: string): Promise<SalesReport> => {
    const supabase = createClient();
    const { data, error } = await supabase.rpc("sales_report", {
      p_from: fromISO,
      p_to: toISO,
    });
    if (error) throw error;
    return data as unknown as SalesReport;
  },

  // Reporte de garantías vendidas + comisión estimada (H28). Las garantías
  // entran como ítem libre "Garantía <plan>" en la venta; se agrupan por plan y
  // se cruzan con `warranty_plans` para la comisión. Solo lectura.
  warranties: async (fromISO: string, toISO: string): Promise<WarrantyReport> => {
    const supabase = createClient();
    const [itemsRes, plansRes] = await Promise.all([
      supabase
        .from("sale_items")
        .select("product_name, subtotal, sales!inner(created_at, status)")
        .is("product_id", null)
        .ilike("product_name", "Garantía %")
        .eq("sales.status", "completed")
        .gte("sales.created_at", fromISO)
        .lt("sales.created_at", toISO),
      supabase.from("warranty_plans").select("label, commission_pct"),
    ]);
    if (itemsRes.error) throw itemsRes.error;

    // Mapa "Garantía <label>" -> commission_pct
    const commissionByName = new Map<string, number>();
    for (const p of plansRes.data ?? []) {
      commissionByName.set(`Garantía ${p.label}`, Number(p.commission_pct) || 0);
    }

    const byLabel = new Map<string, { qty: number; total: number; pct: number }>();
    for (const it of (itemsRes.data ?? []) as { product_name: string; subtotal: number }[]) {
      const name = it.product_name;
      const entry = byLabel.get(name) ?? {
        qty: 0,
        total: 0,
        pct: commissionByName.get(name) ?? 0,
      };
      entry.qty += 1;
      entry.total += Number(it.subtotal) || 0;
      byLabel.set(name, entry);
    }

    const rows: WarrantyReportRow[] = [...byLabel.entries()]
      .map(([name, e]) => ({
        label: name.replace(/^Garantía\s+/, ""),
        qty: e.qty,
        total: e.total,
        commission_pct: e.pct,
        commission: Math.round(((e.total * e.pct) / 100) * 100) / 100,
      }))
      .sort((a, b) => b.total - a.total);

    return {
      rows,
      total: rows.reduce((a, r) => a + r.total, 0),
      commission: rows.reduce((a, r) => a + r.commission, 0),
      qty: rows.reduce((a, r) => a + r.qty, 0),
    };
  },

  // Productividad por profesional (H39). RPC staff_productivity no está en los
  // tipos generados (no se regeneran): se castean args y payload.
  staffProductivity: async (
    fromISO: string,
    toISO: string,
  ): Promise<StaffProductivityRow[]> => {
    const supabase = createClient();
    const { data, error } = await supabase.rpc("staff_productivity" as never, {
      p_from: fromISO,
      p_to: toISO,
    } as never);
    if (error) throw error;
    return (data ?? []) as unknown as StaffProductivityRow[];
  },

  // ── Reportes gastronómicos (F13 · H52) ────────────────────────────────────
  // Las RPCs gastro_*_report no están en los tipos generados → cast de args y
  // payload (mismo criterio que staff_productivity). Devuelven jsonb agregado.
  gastroTables: async (
    fromISO: string,
    toISO: string,
  ): Promise<GastroTablesReport> => {
    const supabase = createClient();
    const { data, error } = await supabase.rpc("gastro_tables_report" as never, {
      p_from: fromISO,
      p_to: toISO,
    } as never);
    if (error) throw error;
    return data as unknown as GastroTablesReport;
  },

  gastroKitchen: async (
    fromISO: string,
    toISO: string,
  ): Promise<GastroKitchenReport> => {
    const supabase = createClient();
    const { data, error } = await supabase.rpc("gastro_kitchen_report" as never, {
      p_from: fromISO,
      p_to: toISO,
    } as never);
    if (error) throw error;
    return data as unknown as GastroKitchenReport;
  },

  gastroDelivery: async (
    fromISO: string,
    toISO: string,
  ): Promise<GastroDeliveryReport> => {
    const supabase = createClient();
    const { data, error } = await supabase.rpc("gastro_delivery_report" as never, {
      p_from: fromISO,
      p_to: toISO,
    } as never);
    if (error) throw error;
    return data as unknown as GastroDeliveryReport;
  },

  gastroTopItems: async (
    fromISO: string,
    toISO: string,
  ): Promise<GastroTopItemsReport> => {
    const supabase = createClient();
    const { data, error } = await supabase.rpc("gastro_top_items_report" as never, {
      p_from: fromISO,
      p_to: toISO,
    } as never);
    if (error) throw error;
    return data as unknown as GastroTopItemsReport;
  },
};
