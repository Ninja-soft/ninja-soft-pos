"use client";

import { useEffect, useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Download, SlidersHorizontal } from "lucide-react";
import { format, startOfDay, startOfMonth, subDays } from "date-fns";
import { createClient } from "@/lib/supabase/client";
import { Button } from "@/components/ui/Button";
import { Eyebrow, Display } from "@/components/ui/Typography";
import { InfoHint } from "@/components/ui/InfoHint";
import { Card, CardContent } from "@/components/ui/Card";
import { DateRangePicker, type DateRange } from "@/components/ui/DateRangePicker";
import { Switch } from "@/components/ui/Switch";
import {
  Dropdown,
  DropdownContent,
  DropdownLabel,
  DropdownTrigger,
} from "@/components/ui/Dropdown";
import { GatedButton } from "@/components/saas/GatedAction";
import {
  useSalesReport,
  useWarrantyReport,
  useStaffProductivity,
  useGastroTablesReport,
  useGastroKitchenReport,
  useGastroDeliveryReport,
  useGastroTopItemsReport,
} from "@/modules/reports/hooks";
import { useDiningEnabled } from "@/modules/dining/hooks";
import { useDeliveryEnabled } from "@/modules/delivery/hooks";
import {
  DELIVERY_CHANNEL_LABELS,
  DELIVERY_TYPE_LABELS,
  type DeliveryChannel,
  type DeliveryOrderType,
} from "@/modules/delivery/api";
import { formatCurrency, formatQty } from "@/lib/utils/format";
import { exportXlsx } from "@/lib/utils/xlsx";
import { loadReportPrefs, saveReportPrefs } from "@/lib/theme/preferences";
import { PAYMENT_METHOD_LABELS as METHOD_LABELS } from "@/lib/utils/paymentMethods";
import { ReportSection } from "@/components/reports/ReportSection";
import type { ReportChartDatum } from "@/components/reports/ReportChart";

const REPORTS = [
  { key: "by_day", label: "Por día" },
  { key: "by_method", label: "Por medio de pago" },
  { key: "by_category", label: "Por categoría" },
  { key: "by_user", label: "Por cajero" },
  { key: "by_product", label: "Top productos" },
  { key: "by_customer", label: "Top clientes" },
  { key: "warranties", label: "Garantías y comisiones" },
  { key: "staff", label: "Productividad del staff" },
  { key: "low_stock", label: "Stock bajo" },
  // Gastronomía (F13 · H52): sólo se ofrecen en el menú si el tenant usa
  // mesas/delivery (gateadas más abajo por dining/delivery).
  { key: "gastro_tables", label: "Gastro · Mesas y salón" },
  { key: "gastro_kitchen", label: "Gastro · Tiempos de cocina" },
  { key: "gastro_delivery", label: "Gastro · Delivery" },
  { key: "gastro_top_items", label: "Gastro · Top ítems" },
] as const;
type ReportKey = (typeof REPORTS)[number]["key"];
const DEFAULT_VIS: Record<ReportKey, boolean> = {
  by_day: true,
  by_method: true,
  by_category: true,
  by_user: true,
  by_product: true,
  by_customer: true,
  warranties: true,
  staff: true,
  low_stock: true,
  gastro_tables: true,
  gastro_kitchen: true,
  gastro_delivery: true,
  gastro_top_items: true,
};

export default function ReportesPage() {
  const [range, setRange] = useState<DateRange | undefined>(() => ({
    from: startOfDay(subDays(new Date(), 6)),
    to: startOfDay(new Date()),
  }));

  const { fromISO, toISO } = useMemo(() => {
    const f = startOfDay(range?.from ?? new Date());
    const t = startOfDay(range?.to ?? range?.from ?? new Date());
    t.setDate(t.getDate() + 1); // inclusivo del día "hasta"
    return { fromISO: f.toISOString(), toISO: t.toISOString() };
  }, [range]);

  const { data, isLoading } = useSalesReport(fromISO, toISO);
  const { data: warranty } = useWarrantyReport(fromISO, toISO);
  // Productividad por profesional (H39): el owner liquida comisiones de la semana
  // mirando esta tabla (+ export XLSX).
  const { data: staff } = useStaffProductivity(fromISO, toISO);

  // ── Gastronomía (F13 · H52): la sección sólo aparece si el tenant usa mesas
  // o delivery. Cada RPC se consulta gateada por su modo (top ítems = cualquiera).
  const { data: diningEnabled = false } = useDiningEnabled();
  const { data: deliveryEnabled = false } = useDeliveryEnabled();
  const showGastro = diningEnabled || deliveryEnabled;
  const { data: gTables } = useGastroTablesReport(fromISO, toISO, diningEnabled);
  const { data: gKitchen } = useGastroKitchenReport(fromISO, toISO, showGastro);
  const { data: gDelivery } = useGastroDeliveryReport(fromISO, toISO, deliveryEnabled);
  const { data: gTop } = useGastroTopItemsReport(fromISO, toISO, showGastro);

  async function exportReporte() {
    if (!data) return;
    const tag = `${format(range?.from ?? new Date(), "yyyy-MM-dd")}_${format(
      range?.to ?? range?.from ?? new Date(),
      "yyyy-MM-dd",
    )}`;
    const sheets: Parameters<typeof exportXlsx>[1] = [
      {
        name: "Resumen",
        title: `Reporte de ventas · ${tag}`,
        columns: [
          { header: "Métrica", key: "k", width: 22 },
          { header: "Valor", key: "v", type: "money", width: 18 },
        ],
        rows: [
          { k: "Total vendido", v: data.total },
          { k: "Cantidad de ventas", v: data.count },
        ],
      },
      {
        name: "Por día",
        columns: [
          { header: "Día", key: "day", width: 14 },
          { header: "Total", key: "total", type: "money" },
          { header: "Ventas", key: "count", type: "number" },
        ],
        rows: data.by_day,
        totals: {
          total: data.by_day.reduce((a, r) => a + r.total, 0),
          count: data.by_day.reduce((a, r) => a + r.count, 0),
        },
      },
      {
        name: "Medios de pago",
        columns: [
          { header: "Medio", key: "method", width: 18 },
          { header: "Total", key: "total", type: "money" },
        ],
        rows: data.by_method.map((r) => ({
          method: METHOD_LABELS[r.method] ?? r.method,
          total: r.total,
        })),
        totals: { total: data.by_method.reduce((a, r) => a + r.total, 0) },
      },
      {
        name: "Categorías",
        columns: [
          { header: "Categoría", key: "category", width: 24 },
          { header: "Total", key: "total", type: "money" },
          { header: "Cantidad", key: "qty", type: "number" },
        ],
        rows: data.by_category,
        totals: { total: data.by_category.reduce((a, r) => a + r.total, 0) },
      },
      {
        name: "Cajeros",
        columns: [
          { header: "Cajero", key: "cashier", width: 24 },
          { header: "Total", key: "total", type: "money" },
          { header: "Ventas", key: "count", type: "number" },
        ],
        rows: data.by_user,
        totals: { total: data.by_user.reduce((a, r) => a + r.total, 0) },
      },
      {
        name: "Top productos",
        columns: [
          { header: "Producto", key: "product", width: 28 },
          { header: "Total", key: "total", type: "money" },
          { header: "Cantidad", key: "qty", type: "number" },
        ],
        rows: data.by_product,
        totals: { total: data.by_product.reduce((a, r) => a + r.total, 0) },
      },
      {
        name: "Top clientes",
        columns: [
          { header: "Cliente", key: "customer", width: 28 },
          { header: "Total", key: "total", type: "money" },
          { header: "Ventas", key: "count", type: "number" },
        ],
        rows: data.by_customer,
        totals: { total: data.by_customer.reduce((a, r) => a + r.total, 0) },
      },
      {
        name: "Garantías",
        columns: [
          { header: "Garantía", key: "label", width: 26 },
          { header: "Vendidas", key: "qty", type: "number" },
          { header: "Total", key: "total", type: "money" },
          { header: "Comisión %", key: "commission_pct", type: "number" },
          { header: "Comisión", key: "commission", type: "money" },
        ],
        rows: (warranty?.rows ?? []).map((r) => ({
          label: r.label,
          qty: r.qty,
          total: r.total,
          commission_pct: r.commission_pct,
          commission: r.commission,
        })),
        totals: {
          total: warranty?.total ?? 0,
          commission: warranty?.commission ?? 0,
        },
      },
      {
        name: "Productividad staff",
        title: "Comisiones y propinas por profesional",
        columns: [
          { header: "Profesional", key: "professional", width: 24 },
          { header: "Servicios", key: "services", type: "number" },
          { header: "Productos", key: "products_qty", type: "number" },
          { header: "Ventas", key: "sales_count", type: "number" },
          { header: "Facturado", key: "billed", type: "money" },
          { header: "Comisión", key: "commission", type: "money" },
          { header: "Propinas", key: "tips", type: "money" },
          { header: "Ticket prom.", key: "avg_ticket", type: "money" },
        ],
        rows: (staff ?? []).map((r) => ({
          professional: r.professional,
          services: r.services,
          products_qty: r.products_qty,
          sales_count: r.sales_count,
          billed: r.billed,
          commission: r.commission,
          tips: r.tips,
          avg_ticket: r.avg_ticket,
        })),
        totals: {
          billed: (staff ?? []).reduce((a, r) => a + r.billed, 0),
          commission: (staff ?? []).reduce((a, r) => a + r.commission, 0),
          tips: (staff ?? []).reduce((a, r) => a + r.tips, 0),
        },
      },
    ];

    // ── Hojas de gastronomía (F13 · H52): se agregan sólo si el tenant usa el
    // modo correspondiente. El export ya está gateado por export_xlsx (botón).
    if (diningEnabled && gTables) {
      sheets.push({
        name: "Gastro · Salones",
        columns: [
          { header: "Salón", key: "area", width: 24 },
          { header: "Vendido", key: "total", type: "money" },
          { header: "Pedidos", key: "orders", type: "number" },
          { header: "Ticket prom.", key: "avg_ticket", type: "money" },
        ],
        rows: gTables.by_area,
        totals: {
          total: gTables.by_area.reduce((a, r) => a + r.total, 0),
          orders: gTables.by_area.reduce((a, r) => a + r.orders, 0),
        },
      });
      sheets.push({
        name: "Gastro · Mesas",
        columns: [
          { header: "Mesa", key: "table_label", width: 16 },
          { header: "Salón", key: "area", width: 20 },
          { header: "Vendido", key: "total", type: "money" },
          { header: "Pedidos", key: "orders", type: "number" },
          { header: "Ticket prom.", key: "avg_ticket", type: "money" },
        ],
        rows: gTables.by_table,
        totals: {
          total: gTables.by_table.reduce((a, r) => a + r.total, 0),
          orders: gTables.by_table.reduce((a, r) => a + r.orders, 0),
        },
      });
      sheets.push({
        name: "Gastro · Mozos",
        columns: [
          { header: "Mozo", key: "waiter", width: 24 },
          { header: "Vendido", key: "total", type: "money" },
          { header: "Pedidos", key: "orders", type: "number" },
          { header: "Ticket prom.", key: "avg_ticket", type: "money" },
        ],
        rows: gTables.by_waiter,
        totals: {
          total: gTables.by_waiter.reduce((a, r) => a + r.total, 0),
          orders: gTables.by_waiter.reduce((a, r) => a + r.orders, 0),
        },
      });
    }
    if (showGastro && gKitchen) {
      sheets.push({
        name: "Gastro · Cocina",
        title: "Tiempos de preparación por estación (segundos)",
        columns: [
          { header: "Estación", key: "station", width: 20 },
          { header: "Ítems", key: "items", type: "number" },
          { header: "Prom. (s)", key: "avg_seconds", type: "number" },
          { header: "Mín. (s)", key: "min_seconds", type: "number" },
          { header: "Máx. (s)", key: "max_seconds", type: "number" },
        ],
        rows: gKitchen.by_station,
      });
    }
    if (deliveryEnabled && gDelivery) {
      sheets.push({
        name: "Gastro · Delivery canal",
        columns: [
          { header: "Canal", key: "channel", width: 20 },
          { header: "Pedidos", key: "orders", type: "number" },
          { header: "Vendido", key: "total", type: "money" },
          { header: "Envíos", key: "delivery_fees", type: "money" },
          { header: "Ticket prom.", key: "avg_ticket", type: "money" },
        ],
        rows: gDelivery.by_channel.map((r) => ({
          channel: DELIVERY_CHANNEL_LABELS[r.channel as DeliveryChannel] ?? r.channel,
          orders: r.orders,
          total: r.total,
          delivery_fees: r.delivery_fees,
          avg_ticket: r.avg_ticket,
        })),
        totals: {
          total: gDelivery.total,
          delivery_fees: gDelivery.delivery_fees,
        },
      });
      sheets.push({
        name: "Gastro · Delivery zona",
        columns: [
          { header: "Zona", key: "zone", width: 22 },
          { header: "Pedidos", key: "orders", type: "number" },
          { header: "Vendido", key: "total", type: "money" },
          { header: "Envíos", key: "delivery_fees", type: "money" },
          { header: "Ticket prom.", key: "avg_ticket", type: "money" },
        ],
        rows: gDelivery.by_zone,
        totals: {
          total: gDelivery.by_zone.reduce((a, r) => a + r.total, 0),
          delivery_fees: gDelivery.by_zone.reduce((a, r) => a + r.delivery_fees, 0),
        },
      });
    }
    if (showGastro && gTop) {
      sheets.push({
        name: "Gastro · Top ítems",
        columns: [
          { header: "Ítem", key: "name", width: 28 },
          { header: "Cantidad", key: "qty", type: "number" },
          { header: "Importe", key: "total", type: "money" },
          { header: "Costo (receta)", key: "cost", type: "money" },
          { header: "Margen", key: "margin", type: "money" },
        ],
        rows: gTop.top,
        totals: { total: gTop.top.reduce((a, r) => a + r.total, 0) },
      });
    }

    await exportXlsx(`reporte-ventas-${tag}`, sheets);
  }

  const [vis, setVis] = useState<Record<ReportKey, boolean>>(DEFAULT_VIS);
  useEffect(() => {
    loadReportPrefs().then((p) => {
      if (p) setVis((v) => ({ ...v, ...p }));
    });
  }, []);
  function toggle(k: ReportKey) {
    setVis((prev) => {
      const next = { ...prev, [k]: !prev[k] };
      void saveReportPrefs(next);
      return next;
    });
  }

  // Stock bajo (no depende del rango: es stock actual).
  const { data: lowStock = [] } = useQuery({
    queryKey: ["report-low-stock"],
    queryFn: async () => {
      const supabase = createClient();
      const { data } = await supabase
        .from("products")
        .select("name, stock, stock_min, unit")
        .is("deleted_at", null)
        .eq("is_active", true)
        .gt("stock_min", 0)
        .order("stock", { ascending: true });
      return (data ?? []).filter((p) => p.stock <= (p.stock_min ?? 0));
    },
  });

  // --- Datos para los gráficos por sección (es-AR / ARS). ---
  const chart = useMemo(() => {
    const dayLabel = (iso: string) => {
      const [, mm, dd] = iso.split("-");
      return dd && mm ? `${dd}/${mm}` : iso;
    };
    return {
      by_day: (data?.by_day ?? []).map<ReportChartDatum>((r) => ({
        label: dayLabel(r.day),
        value: r.total,
        secondary: r.count,
      })),
      by_method: (data?.by_method ?? []).map<ReportChartDatum>((r) => ({
        label: METHOD_LABELS[r.method] ?? r.method,
        value: r.total,
      })),
      by_category: (data?.by_category ?? []).map<ReportChartDatum>((r) => ({
        label: r.category,
        value: r.total,
        secondary: r.qty,
      })),
      by_user: (data?.by_user ?? []).map<ReportChartDatum>((r) => ({
        label: r.cashier,
        value: r.total,
        secondary: r.count,
      })),
      // Top 8 para que el gráfico no se sature; la tabla mantiene todo.
      by_product: (data?.by_product ?? []).slice(0, 8).map<ReportChartDatum>((r) => ({
        label: r.product,
        value: r.total,
        secondary: r.qty,
      })),
      by_customer: (data?.by_customer ?? []).slice(0, 8).map<ReportChartDatum>((r) => ({
        label: r.customer,
        value: r.total,
        secondary: r.count,
      })),
      warranties: (warranty?.rows ?? []).map<ReportChartDatum>((r) => ({
        label: r.label,
        value: r.total,
        secondary: r.qty,
      })),
      // Comisión por profesional (la barra principal); facturado como secundario.
      staff: (staff ?? []).map<ReportChartDatum>((r) => ({
        label: r.professional,
        value: r.commission,
        secondary: r.billed,
      })),
      low_stock: lowStock.slice(0, 10).map<ReportChartDatum>((p) => ({
        label: p.name,
        value: p.stock,
      })),
      // ── Gastronomía (F13 · H52) ──────────────────────────────────────────
      gastro_area: (gTables?.by_area ?? []).map<ReportChartDatum>((r) => ({
        label: r.area,
        value: r.total,
        secondary: r.orders,
      })),
      // Tiempo promedio por estación (en minutos para que el gráfico sea legible).
      gastro_kitchen: (gKitchen?.by_station ?? []).map<ReportChartDatum>((r) => ({
        label: r.station,
        value: Math.round((r.avg_seconds / 60) * 10) / 10,
        secondary: r.items,
      })),
      gastro_delivery_channel: (gDelivery?.by_channel ?? []).map<ReportChartDatum>(
        (r) => ({
          label:
            DELIVERY_CHANNEL_LABELS[r.channel as DeliveryChannel] ?? r.channel,
          value: r.total,
          secondary: r.orders,
        }),
      ),
      gastro_top_items: (gTop?.top ?? []).slice(0, 8).map<ReportChartDatum>((r) => ({
        label: r.name,
        value: r.qty,
        secondary: r.total,
      })),
    };
  }, [data, warranty, staff, lowStock, gTables, gKitchen, gDelivery, gTop]);

  return (
    <>
      <div className="mx-auto max-w-6xl px-6 py-8">
        <Eyebrow>Información</Eyebrow>
        <Display className="mt-3 flex items-center gap-2 text-3xl md:text-4xl">
          Reportes
          <InfoHint section="reportes" size={18} />
        </Display>

        <div className="-mx-6 mt-6 flex items-end gap-3 overflow-x-auto px-6 pb-1 sm:mx-0 sm:flex-wrap sm:overflow-visible sm:px-0 [scrollbar-width:none] [&::-webkit-scrollbar]:hidden">
          <div className="flex shrink-0 flex-col gap-1">
            <label className="text-xs text-muted-foreground">Período</label>
            <DateRangePicker value={range} onChange={setRange} />
          </div>
          <div className="flex shrink-0 flex-col gap-1">
            <label className="text-xs text-muted-foreground">Rápido</label>
            <div className="flex gap-1">
              {(
                [
                  { label: "Hoy", days: 0 },
                  { label: "7 días", days: 6 },
                  { label: "30 días", days: 29 },
                  { label: "Mes", month: true },
                ] as const
              ).map((p) => (
                <button
                  key={p.label}
                  type="button"
                  onClick={() =>
                    setRange({
                      from:
                        "month" in p
                          ? startOfMonth(new Date())
                          : startOfDay(subDays(new Date(), p.days)),
                      to: startOfDay(new Date()),
                    })
                  }
                  className="rounded-md border border-input bg-background px-2.5 py-2 text-xs text-muted-foreground transition hover:border-ninja-flameSoft hover:text-foreground"
                >
                  {p.label}
                </button>
              ))}
            </div>
          </div>
          <GatedButton
            feature="export_xlsx"
            featureLabel="Exportar a Excel"
            variant="secondary"
            className="shrink-0"
            onClick={exportReporte}
            disabled={!data}
          >
            <Download size={16} /> Exportar XLSX
          </GatedButton>
          <Dropdown>
            <DropdownTrigger asChild>
              <Button variant="secondary" className="shrink-0">
                <SlidersHorizontal size={16} /> Personalizar
              </Button>
            </DropdownTrigger>
            <DropdownContent align="end" className="w-60">
              <DropdownLabel>Reportes a mostrar</DropdownLabel>
              {REPORTS.filter((r) => {
                // Los toggles gastro sólo se ofrecen si el tenant usa el modo.
                if (r.key === "gastro_tables") return diningEnabled;
                if (r.key === "gastro_delivery") return deliveryEnabled;
                if (r.key === "gastro_kitchen" || r.key === "gastro_top_items")
                  return showGastro;
                return true;
              }).map((r) => (
                <div
                  key={r.key}
                  className="flex items-center justify-between gap-3 px-2 py-1.5 text-sm"
                >
                  {r.label}
                  <Switch
                    checked={vis[r.key]}
                    onCheckedChange={() => toggle(r.key)}
                    label={r.label}
                  />
                </div>
              ))}
            </DropdownContent>
          </Dropdown>
        </div>

        <div className="mt-6 grid gap-4 sm:grid-cols-2">
          <Card>
            <CardContent className="p-5">
              <p className="text-sm text-muted-foreground">Total vendido</p>
              <p className="mt-2 price-hl font-price tabular-nums text-3xl font-black">
                {formatCurrency(data?.total ?? 0)}
              </p>
            </CardContent>
          </Card>
          <Card>
            <CardContent className="p-5">
              <p className="text-sm text-muted-foreground">Cantidad de ventas</p>
              <p className="mt-2 font-display text-3xl font-black">
                {data?.count ?? 0}
              </p>
            </CardContent>
          </Card>
        </div>

        {isLoading ? (
          <p className="mt-8 text-center text-sm text-muted-foreground">Cargando…</p>
        ) : (
          <div className="mt-8 grid gap-6 lg:grid-cols-2">
            {vis.by_day && (
              <ReportSection
                id="by_day"
                title="Por día"
                chartData={chart.by_day}
                chartTypes={["bar", "line", "area"]}
                valueName="Vendido"
                className="lg:col-span-2"
                table={
                  <BareTable
                    cols={["Día", "Total", "Ventas"]}
                    rows={(data?.by_day ?? []).map((r) => [
                      r.day,
                      formatCurrency(r.total),
                      String(r.count),
                    ])}
                  />
                }
              />
            )}
            {vis.by_method && (
              <ReportSection
                id="by_method"
                title="Por medio de pago"
                chartData={chart.by_method}
                chartTypes={["pie", "bar"]}
                valueName="Total"
                table={
                  <BareTable
                    cols={["Medio", "Total"]}
                    rows={(data?.by_method ?? []).map((r) => [
                      METHOD_LABELS[r.method] ?? r.method,
                      formatCurrency(r.total),
                    ])}
                  />
                }
              />
            )}
            {vis.by_category && (
              <ReportSection
                id="by_category"
                title="Por categoría"
                chartData={chart.by_category}
                chartTypes={["pie", "bar"]}
                valueName="Total"
                table={
                  <BareTable
                    cols={["Categoría", "Total", "Cant."]}
                    rows={(data?.by_category ?? []).map((r) => [
                      r.category,
                      formatCurrency(r.total),
                      formatQty(r.qty),
                    ])}
                  />
                }
              />
            )}
            {vis.by_user && (
              <ReportSection
                id="by_user"
                title="Por cajero"
                chartData={chart.by_user}
                chartTypes={["bar", "pie"]}
                valueName="Total"
                table={
                  <BareTable
                    cols={["Cajero", "Total", "Ventas"]}
                    rows={(data?.by_user ?? []).map((r) => [
                      r.cashier,
                      formatCurrency(r.total),
                      String(r.count),
                    ])}
                  />
                }
              />
            )}
            {vis.by_product && (
              <ReportSection
                id="by_product"
                title="Top productos"
                chartData={chart.by_product}
                chartTypes={["bar", "pie"]}
                valueName="Total"
                table={
                  <BareTable
                    cols={["Producto", "Total", "Cant."]}
                    rows={(data?.by_product ?? []).map((r) => [
                      r.product,
                      formatCurrency(r.total),
                      formatQty(r.qty),
                    ])}
                  />
                }
              />
            )}
            {vis.by_customer && (
              <ReportSection
                id="by_customer"
                title="Top clientes"
                chartData={chart.by_customer}
                chartTypes={["bar", "pie"]}
                valueName="Total"
                table={
                  <BareTable
                    cols={["Cliente", "Total", "Ventas"]}
                    rows={(data?.by_customer ?? []).map((r) => [
                      r.customer,
                      formatCurrency(r.total),
                      String(r.count),
                    ])}
                  />
                }
              />
            )}
            {vis.warranties && (
              <ReportSection
                id="warranties"
                title="Garantías y comisiones"
                chartData={chart.warranties}
                chartTypes={["bar", "pie"]}
                valueName="Total"
                table={
                  <BareTable
                    cols={["Garantía", "Vend.", "Total", "Com.%", "Comisión"]}
                    rows={(warranty?.rows ?? []).map((r) => [
                      r.label,
                      String(r.qty),
                      formatCurrency(r.total),
                      `${r.commission_pct}%`,
                      formatCurrency(r.commission),
                    ])}
                  />
                }
              />
            )}
            {vis.staff && (
              <ReportSection
                id="staff"
                title="Productividad del staff"
                chartData={chart.staff}
                chartTypes={["bar", "pie"]}
                valueName="Comisión"
                className="lg:col-span-2"
                table={
                  <BareTable
                    cols={[
                      "Profesional",
                      "Serv.",
                      "Prod.",
                      "Ventas",
                      "Facturado",
                      "Comisión",
                      "Propinas",
                      "Ticket prom.",
                    ]}
                    rows={(staff ?? []).map((r) => [
                      r.professional,
                      String(r.services),
                      formatQty(r.products_qty),
                      String(r.sales_count),
                      formatCurrency(r.billed),
                      formatCurrency(r.commission),
                      formatCurrency(r.tips),
                      formatCurrency(r.avg_ticket),
                    ])}
                  />
                }
              />
            )}
            {vis.low_stock && (
              <ReportSection
                id="low_stock"
                title="Stock bajo"
                chartData={chart.low_stock}
                chartTypes={["bar"]}
                valueFormat="number"
                valueName="Stock"
                table={
                  <BareTable
                    cols={["Producto", "Stock", "Mínimo"]}
                    rows={lowStock.map((p) => [
                      p.name,
                      `${formatQty(p.stock)} ${p.unit}`,
                      formatQty(p.stock_min ?? 0),
                    ])}
                  />
                }
              />
            )}
          </div>
        )}

        {/* ── Gastronomía (F13 · H52): mesas/salón, cocina (KDS), delivery y top
             ítems. Sólo si el tenant usa mesas o delivery. ──────────────────── */}
        {showGastro && (
          <div className="mt-12">
            <Eyebrow>Operación gastronómica</Eyebrow>
            <Display className="mt-2 text-2xl md:text-3xl">Gastronomía</Display>
            <div className="mt-6 grid gap-6 lg:grid-cols-2">
              {diningEnabled && vis.gastro_tables && (
                <ReportSection
                  id="gastro_tables"
                  title="Mesas y salón"
                  chartData={chart.gastro_area}
                  chartTypes={["bar", "pie"]}
                  valueName="Vendido"
                  className="lg:col-span-2"
                  table={
                    <div className="space-y-6 p-4">
                      <div>
                        <p className="mb-2 text-xs uppercase tracking-[0.14em] text-muted-foreground">
                          Por salón
                        </p>
                        <BareTable
                          cols={["Salón", "Vendido", "Pedidos", "Ticket prom."]}
                          rows={(gTables?.by_area ?? []).map((r) => [
                            r.area,
                            formatCurrency(r.total),
                            String(r.orders),
                            formatCurrency(r.avg_ticket),
                          ])}
                        />
                      </div>
                      <div>
                        <p className="mb-2 text-xs uppercase tracking-[0.14em] text-muted-foreground">
                          Por mesa (rotación = pedidos cerrados)
                        </p>
                        <BareTable
                          cols={["Mesa", "Salón", "Vendido", "Pedidos", "Ticket prom."]}
                          rows={(gTables?.by_table ?? []).map((r) => [
                            r.table_label,
                            r.area,
                            formatCurrency(r.total),
                            String(r.orders),
                            formatCurrency(r.avg_ticket),
                          ])}
                        />
                      </div>
                      <div>
                        <p className="mb-2 text-xs uppercase tracking-[0.14em] text-muted-foreground">
                          Por mozo
                        </p>
                        <BareTable
                          cols={["Mozo", "Vendido", "Pedidos", "Ticket prom."]}
                          rows={(gTables?.by_waiter ?? []).map((r) => [
                            r.waiter,
                            formatCurrency(r.total),
                            String(r.orders),
                            formatCurrency(r.avg_ticket),
                          ])}
                        />
                      </div>
                    </div>
                  }
                />
              )}
              {vis.gastro_kitchen && (
                <ReportSection
                  id="gastro_kitchen"
                  title="Tiempos de cocina (KDS)"
                  chartData={chart.gastro_kitchen}
                  chartTypes={["bar"]}
                  valueFormat="number"
                  valueName="Min. promedio"
                  table={
                    <div className="p-4">
                      <p className="mb-3 text-sm text-muted-foreground">
                        {gKitchen && gKitchen.items > 0
                          ? `${gKitchen.items} ítems · promedio global ${formatDuration(
                              gKitchen.avg_seconds,
                            )}`
                          : "Sin datos en el período"}
                      </p>
                      <BareTable
                        cols={["Estación", "Ítems", "Prom.", "Mín.", "Máx."]}
                        rows={(gKitchen?.by_station ?? []).map((r) => [
                          r.station,
                          String(r.items),
                          formatDuration(r.avg_seconds),
                          formatDuration(r.min_seconds),
                          formatDuration(r.max_seconds),
                        ])}
                      />
                    </div>
                  }
                />
              )}
              {deliveryEnabled && vis.gastro_delivery && (
                <ReportSection
                  id="gastro_delivery"
                  title="Delivery / take away"
                  chartData={chart.gastro_delivery_channel}
                  chartTypes={["bar", "pie"]}
                  valueName="Vendido"
                  table={
                    <div className="space-y-6 p-4">
                      <p className="text-sm text-muted-foreground">
                        {gDelivery && gDelivery.orders > 0
                          ? `${gDelivery.orders} pedidos · envíos ${formatCurrency(
                              gDelivery.delivery_fees,
                            )} · ticket prom. ${formatCurrency(gDelivery.avg_ticket)}`
                          : "Sin datos en el período"}
                      </p>
                      <div>
                        <p className="mb-2 text-xs uppercase tracking-[0.14em] text-muted-foreground">
                          Por canal
                        </p>
                        <BareTable
                          cols={["Canal", "Pedidos", "Vendido", "Envíos"]}
                          rows={(gDelivery?.by_channel ?? []).map((r) => [
                            DELIVERY_CHANNEL_LABELS[r.channel as DeliveryChannel] ??
                              r.channel,
                            String(r.orders),
                            formatCurrency(r.total),
                            formatCurrency(r.delivery_fees),
                          ])}
                        />
                      </div>
                      <div>
                        <p className="mb-2 text-xs uppercase tracking-[0.14em] text-muted-foreground">
                          Por zona
                        </p>
                        <BareTable
                          cols={["Zona", "Pedidos", "Vendido", "Envíos"]}
                          rows={(gDelivery?.by_zone ?? []).map((r) => [
                            r.zone,
                            String(r.orders),
                            formatCurrency(r.total),
                            formatCurrency(r.delivery_fees),
                          ])}
                        />
                      </div>
                      <div>
                        <p className="mb-2 text-xs uppercase tracking-[0.14em] text-muted-foreground">
                          Por tipo
                        </p>
                        <BareTable
                          cols={["Tipo", "Pedidos", "Vendido"]}
                          rows={(gDelivery?.by_type ?? []).map((r) => [
                            DELIVERY_TYPE_LABELS[r.order_type as DeliveryOrderType] ??
                              r.order_type,
                            String(r.orders),
                            formatCurrency(r.total),
                          ])}
                        />
                      </div>
                    </div>
                  }
                />
              )}
              {vis.gastro_top_items && (
                <ReportSection
                  id="gastro_top_items"
                  title="Top ítems (mesa + delivery)"
                  chartData={chart.gastro_top_items}
                  chartTypes={["bar", "pie"]}
                  valueFormat="number"
                  valueName="Cantidad"
                  className="lg:col-span-2"
                  table={
                    <div className="space-y-6 p-4">
                      <div>
                        <p className="mb-2 text-xs uppercase tracking-[0.14em] text-muted-foreground">
                          Top ítems
                        </p>
                        <BareTable
                          cols={["Ítem", "Cantidad", "Importe", "Margen"]}
                          rows={(gTop?.top ?? []).map((r) => [
                            r.name,
                            formatQty(r.qty),
                            formatCurrency(r.total),
                            // Margen sólo significativo si el producto tiene receta
                            // cargada (cost > 0); si no, "—" (H50/H52).
                            r.cost > 0 ? formatCurrency(r.margin) : "—",
                          ])}
                        />
                      </div>
                      <div className="grid gap-6 sm:grid-cols-2">
                        <div>
                          <p className="mb-2 text-xs uppercase tracking-[0.14em] text-muted-foreground">
                            Por estación
                          </p>
                          <BareTable
                            cols={["Estación", "Cant.", "Importe"]}
                            rows={(gTop?.by_station ?? []).map((r) => [
                              r.station,
                              formatQty(r.qty),
                              formatCurrency(r.total),
                            ])}
                          />
                        </div>
                        <div>
                          <p className="mb-2 text-xs uppercase tracking-[0.14em] text-muted-foreground">
                            Por curso / tiempo
                          </p>
                          <BareTable
                            cols={["Tiempo", "Cant.", "Importe"]}
                            rows={(gTop?.by_course ?? []).map((r) => [
                              `Tiempo ${r.course}`,
                              formatQty(r.qty),
                              formatCurrency(r.total),
                            ])}
                          />
                        </div>
                      </div>
                    </div>
                  }
                />
              )}
            </div>
          </div>
        )}
      </div>
    </>
  );
}

// Formatea una duración en segundos como "Xm Ys" (o "Ys" si < 1 min). Para los
// tiempos de cocina del reporte gastro (H52).
function formatDuration(seconds: number | null | undefined): string {
  const s = Math.max(0, Math.round(seconds ?? 0));
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  const rest = s % 60;
  return rest === 0 ? `${m}m` : `${m}m ${rest}s`;
}

// Tabla "desnuda" (sin card ni header): el chrome lo aporta ReportSection.
function BareTable({ cols, rows }: { cols: string[]; rows: string[][] }) {
  return (
    <div className="overflow-x-auto">
      <table className="w-full min-w-[320px] text-sm">
        <thead className="text-left text-xs uppercase tracking-[0.14em] text-muted-foreground">
          <tr>
            {cols.map((c, i) => (
              <th key={c} className={i === 0 ? "px-4 py-2" : "px-4 py-2 text-right"}>
                {c}
              </th>
            ))}
          </tr>
        </thead>
        <tbody className="divide-y divide-border text-foreground">
          {rows.length === 0 ? (
            <tr>
              <td colSpan={cols.length} className="px-4 py-6 text-center text-muted-foreground">
                Sin datos.
              </td>
            </tr>
          ) : (
            rows.map((r, ri) => (
              <tr key={ri}>
                {r.map((cell, ci) => (
                  <td
                    key={ci}
                    className={ci === 0 ? "px-4 py-2" : "px-4 py-2 text-right"}
                  >
                    {cell}
                  </td>
                ))}
              </tr>
            ))
          )}
        </tbody>
      </table>
    </div>
  );
}
