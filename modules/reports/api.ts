import { createClient } from "@/lib/supabase/client";
import { normalizeCompareReport, type BranchCompareReport } from "@/lib/reports/branchCompare";

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

// Rotación de mesas (turnover) y mozos con propinas (gastro_turnover_report,
// migración 20261105200400). Minutos con un decimal; null = sin dato.
export interface GastroTurnoverReport {
  orders: number;
  avg_seated_min: number;
  avg_first_item_min: number;
  avg_bill_to_close_min: number;
  tips_total: number;
  by_table: {
    table_label: string;
    area: string;
    orders: number;
    avg_seated_min: number | null;
    avg_first_item_min: number | null;
    avg_bill_to_close_min: number | null;
  }[];
  by_waiter: {
    waiter: string;
    orders: number;
    total: number;
    tips: number;
    avg_seated_min: number | null;
  }[];
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

// Tope de páginas (x1000 filas) para las consultas diferidas de gráficos.
const MAX_PAGES = 30;

export const reportsApi = {
  // Comparativo entre sucursales (F17 · H97 · ADR-057). storeIds null = todas
  // las que el usuario ve. El servidor valida el acceso a cada sucursal y exige
  // multi_sucursal para comparar más de una.
  branchCompare: async (
    fromISO: string,
    toISO: string,
    storeIds: string[] | null = null,
  ): Promise<BranchCompareReport> => {
    const supabase = createClient();
    // RPC nueva: no está en los tipos generados.
    const { data, error } = await supabase.rpc("branch_compare_report" as never, {
      p_from: fromISO,
      p_to: toISO,
      p_store_ids: storeIds && storeIds.length > 0 ? storeIds : null,
    } as never);
    if (error) throw error;
    return normalizeCompareReport(data);
  },

  // storeId: sucursal del chip (null = todas las que el usuario puede ver; el
  // servidor recorta a las permitidas, F17 · H97).
  sales: async (fromISO: string, toISO: string, storeId: string | null = null): Promise<SalesReport> => {
    const supabase = createClient();
    // p_store_id todavía no está en los tipos generados (no se regeneran).
    const { data, error } = await supabase.rpc("sales_report", {
      p_from: fromISO,
      p_to: toISO,
      p_store_id: storeId,
    } as never);
    if (error) throw error;
    return data as unknown as SalesReport;
  },

  // Reporte de garantías vendidas + comisión estimada (H28). Las garantías
  // entran como ítem libre "Garantía <plan>" en la venta; se agrupan por plan y
  // se cruzan con `warranty_plans` para la comisión. Solo lectura.
  warranties: async (
    fromISO: string,
    toISO: string,
    storeId: string | null = null,
  ): Promise<WarrantyReport> => {
    const supabase = createClient();
    let itemsQ = supabase
      .from("sale_items")
      .select("product_name, subtotal, sales!inner(created_at, status, store_id)")
      .is("product_id", null)
      .ilike("product_name", "Garantía %")
      .eq("sales.status", "completed")
      .gte("sales.created_at", fromISO)
      .lt("sales.created_at", toISO);
    if (storeId) itemsQ = itemsQ.eq("sales.store_id", storeId);
    const [itemsRes, plansRes] = await Promise.all([
      itemsQ,
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
    storeId: string | null = null,
  ): Promise<StaffProductivityRow[]> => {
    const supabase = createClient();
    const { data, error } = await supabase.rpc("staff_productivity" as never, {
      p_from: fromISO,
      p_to: toISO,
      p_store_id: storeId,
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
    storeId: string | null = null,
  ): Promise<GastroTablesReport> => {
    const supabase = createClient();
    const { data, error } = await supabase.rpc("gastro_tables_report" as never, {
      p_from: fromISO,
      p_to: toISO,
      p_store_id: storeId,
    } as never);
    if (error) throw error;
    return data as unknown as GastroTablesReport;
  },

  // Rotación de mesas + mozos y propinas (F13 · H51/H52).
  gastroTurnover: async (
    fromISO: string,
    toISO: string,
    storeId: string | null = null,
  ): Promise<GastroTurnoverReport> => {
    const supabase = createClient();
    const { data, error } = await supabase.rpc("gastro_turnover_report" as never, {
      p_from: fromISO,
      p_to: toISO,
      p_store_id: storeId,
    } as never);
    if (error) throw error;
    return data as unknown as GastroTurnoverReport;
  },

  gastroKitchen: async (
    fromISO: string,
    toISO: string,
    storeId: string | null = null,
  ): Promise<GastroKitchenReport> => {
    const supabase = createClient();
    const { data, error } = await supabase.rpc("gastro_kitchen_report" as never, {
      p_from: fromISO,
      p_to: toISO,
      p_store_id: storeId,
    } as never);
    if (error) throw error;
    return data as unknown as GastroKitchenReport;
  },

  gastroDelivery: async (
    fromISO: string,
    toISO: string,
    storeId: string | null = null,
  ): Promise<GastroDeliveryReport> => {
    const supabase = createClient();
    const { data, error } = await supabase.rpc("gastro_delivery_report" as never, {
      p_from: fromISO,
      p_to: toISO,
      p_store_id: storeId,
    } as never);
    if (error) throw error;
    return data as unknown as GastroDeliveryReport;
  },

  gastroTopItems: async (
    fromISO: string,
    toISO: string,
    storeId: string | null = null,
  ): Promise<GastroTopItemsReport> => {
    const supabase = createClient();
    const { data, error } = await supabase.rpc("gastro_top_items_report" as never, {
      p_from: fromISO,
      p_to: toISO,
      p_store_id: storeId,
    } as never);
    if (error) throw error;
    return data as unknown as GastroTopItemsReport;
  },
  // ── Consultas diferidas de gráficos (sólo cuando la sección entra en
  // pantalla). Lecturas directas bajo RLS de tablas existentes, paginadas de a
  // 1000 (tope de PostgREST) con un máximo para no explotar en rangos enormes.

  /** created_at + total de ventas completadas (heatmap día × hora). */
  saleTimes: async (
    fromISO: string,
    toISO: string,
    storeId: string | null = null,
  ): Promise<{ created_at: string; total: number }[]> => {
    const supabase = createClient();
    const out: { created_at: string; total: number }[] = [];
    const PAGE = 1000;
    for (let page = 0; page < MAX_PAGES; page++) {
      let q = supabase
        .from("sales")
        .select("created_at, total")
        .eq("status", "completed")
        .gte("created_at", fromISO)
        .lt("created_at", toISO);
      if (storeId) q = q.eq("store_id", storeId);
      const { data, error } = await q
        .order("created_at", { ascending: true })
        .range(page * PAGE, page * PAGE + PAGE - 1);
      if (error) throw error;
      out.push(...((data ?? []) as { created_at: string; total: number }[]));
      if (!data || data.length < PAGE) break;
    }
    return out;
  },

  /** Movimientos de caja del período (flujo de caja diario). */
  cashMovements: async (
    fromISO: string,
    toISO: string,
    storeId: string | null = null,
  ): Promise<{ type: string; amount: number; created_at: string; payment_method: string | null }[]> => {
    const supabase = createClient();
    const out: { type: string; amount: number; created_at: string; payment_method: string | null }[] = [];
    const PAGE = 1000;
    for (let page = 0; page < MAX_PAGES; page++) {
      // Con sucursal: los movimientos de los turnos de esa sucursal
      // (cash_shifts.store_id, desnormalizado en F17).
      let q = supabase
        .from("cash_movements")
        .select(
          storeId
            ? "type, amount, created_at, payment_method, cash_shifts!inner(store_id)"
            : "type, amount, created_at, payment_method",
        )
        .gte("created_at", fromISO)
        .lt("created_at", toISO);
      if (storeId) q = q.eq("cash_shifts.store_id" as never, storeId as never);
      const { data, error } = await q
        .order("created_at", { ascending: true })
        .range(page * PAGE, page * PAGE + PAGE - 1);
      if (error) throw error;
      out.push(
        ...(
          (data ?? []) as unknown as { type: string; amount: number; created_at: string; payment_method: string | null }[]
        ).map((m) => ({ type: m.type, amount: m.amount, created_at: m.created_at, payment_method: m.payment_method })),
      );
      if (!data || data.length < PAGE) break;
    }
    return out;
  },
};
