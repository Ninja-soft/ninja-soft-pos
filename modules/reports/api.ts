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
};
