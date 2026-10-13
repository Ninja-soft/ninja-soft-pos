"use client";

import { Fragment, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { useQuery } from "@tanstack/react-query";
import {
  ArrowDown,
  ArrowUp,
  Bookmark,
  ChartArea,
  ChartBar,
  ChartBarStacked,
  ChartColumn,
  ChartLine,
  ChartPie,
  CreditCard,
  Landmark,
  Download,
  Grid3x3,
  LayoutGrid,
  SlidersHorizontal,
} from "lucide-react";
import { addDays, format, startOfDay, startOfMonth, subDays } from "date-fns";
import { createClient } from "@/lib/supabase/client";
import Link from "next/link";
import { Button, buttonVariants } from "@/components/ui/Button";
import { cn } from "@/lib/utils/cn";
import { Eyebrow, Display } from "@/components/ui/Typography";
import { InfoHint } from "@/components/ui/InfoHint";
import { DateRangePicker, type DateRange } from "@/components/ui/DateRangePicker";
import { Switch } from "@/components/ui/Switch";
import { Select, type SelectOption } from "@/components/ui/Select";
import { useToast } from "@/components/ui/Toast";
import { Skeleton } from "@/components/ui/Skeleton";
import { useCategories } from "@/modules/products/hooks";
import { ReportPresetsModal, describeFilters } from "@/components/reports/ReportPresetsModal";
import {
  EMPTY_PRESETS,
  activeFilterCount,
  detectRange,
  moveInOrder,
  removePreset,
  resolveOrder,
  resolveRange,
  sanitizePresets,
  setDefaultPreset,
  upsertPreset,
  type ReportFilters,
  type ReportPreset,
  type ReportPresetState,
} from "@/lib/reports/savedFilters";
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
  useGastroTurnoverReport,
  useGastroKitchenReport,
  useGastroDeliveryReport,
  useGastroTopItemsReport,
  useSaleTimes,
  useCashFlow,
} from "@/modules/reports/hooks";
import {
  byHour,
  cashFlowByDay,
  fillDays,
  hourMatrix,
  peakHour,
  previousRange,
  rangeDays,
  type DayPoint,
} from "@/modules/reports/derive";
import { useDiningEnabled } from "@/modules/dining/hooks";
import { useBranchContext } from "@/modules/branches/hooks";
import { ALL_BRANCHES } from "@/modules/branches/logic";
import { BranchCompare } from "@/components/reports/BranchCompare";
import { BranchDot } from "@/components/branches/BranchSwitcher";
import { useLowStockByStore, useMultiStoreStock } from "@/modules/stock/hooks";
import { branchFileTag, filterByStore, reportScopeLabel } from "@/lib/reports/branchScope";
import { useDeliveryEnabled } from "@/modules/delivery/hooks";
import {
  DELIVERY_CHANNEL_LABELS,
  DELIVERY_TYPE_LABELS,
  type DeliveryChannel,
  type DeliveryOrderType,
} from "@/modules/delivery/api";
import { formatCurrency, formatQty } from "@/lib/utils/format";
import { exportXlsx } from "@/lib/utils/xlsx";
import {
  loadReportSettings,
  saveReportOrder,
  saveReportPresets,
  saveReportPrefs,
} from "@/lib/theme/preferences";
import { PAYMENT_METHOD_LABELS as METHOD_LABELS } from "@/lib/utils/paymentMethods";
import { ReportSection, type ReportChartSpec } from "@/components/reports/ReportSection";
import { KpiCard } from "@/components/reports/KpiCard";
import { PaymentFeesSection } from "@/components/reports/PaymentFeesSection";
import { Segmented, type SegmentedOption } from "@/components/ui/Segmented";
import {
  bulletOption,
  cashFlowOption,
  columnBarOption,
  doughnutOption,
  heatmapOption,
  rankingBarOption,
  stackedBarOption,
  timeSeriesOption,
  treemapOption,
  WEEKDAYS,
  type CategoryDatum,
  type SeriesKind,
} from "@/components/charts/builders";
import { deltaPct, formatChartValue, type ValueFormat } from "@/components/charts/chartTheme";
import { NoData } from "@/components/ui/NoData";
import { splitTips, type TipSplitMode } from "@/lib/gastro/tips";

const REPORTS = [
  { key: "by_day", label: "Evolución de ventas" },
  { key: "by_hour", label: "Ventas por día y hora" },
  { key: "by_method", label: "Medios de pago" },
  { key: "by_category", label: "Categorías" },
  { key: "by_user", label: "Por cajero" },
  { key: "by_product", label: "Top productos" },
  { key: "by_customer", label: "Top clientes" },
  { key: "cash_flow", label: "Flujo de caja" },
  { key: "warranties", label: "Garantías y comisiones" },
  { key: "staff", label: "Productividad del staff" },
  { key: "low_stock", label: "Stock bajo" },
  // Gastronomía (F13 · H52): sólo se ofrecen en el menú si el tenant usa
  // mesas/delivery (gateadas más abajo por dining/delivery).
  { key: "gastro_tables", label: "Gastro · Mesas y salón" },
  { key: "gastro_turnover", label: "Gastro · Rotación, mozos y propinas" },
  { key: "gastro_kitchen", label: "Gastro · Tiempos de cocina" },
  { key: "gastro_delivery", label: "Gastro · Delivery" },
  { key: "gastro_top_items", label: "Gastro · Top ítems" },
] as const;
type ReportKey = (typeof REPORTS)[number]["key"];
const REPORT_KEYS: ReportKey[] = REPORTS.map((r) => r.key);
const GASTRO_KEYS: ReportKey[] = REPORT_KEYS.filter((k) => k.startsWith("gastro_"));
const MAIN_KEYS: ReportKey[] = REPORT_KEYS.filter((k) => !k.startsWith("gastro_"));
const ALL = "all";
type ReportView = "consolidated" | "branch" | "compare";
const DEFAULT_VIS: Record<ReportKey, boolean> = {
  by_day: true,
  by_hour: true,
  by_method: true,
  by_category: true,
  by_user: true,
  by_product: true,
  by_customer: true,
  cash_flow: true,
  warranties: true,
  staff: true,
  low_stock: true,
  gastro_tables: true,
  gastro_turnover: true,
  gastro_kitchen: true,
  gastro_delivery: true,
  gastro_top_items: true,
};

export default function ReportesPage() {
  // El rango por defecto se arma después de montar, con la hora del navegador:
  // en el servidor (UTC) después de las 21 h de Argentina ya es "mañana" y el
  // HTML no coincidía con el cliente (errores de hidratación #425/#422).
  const [range, setRange] = useState<DateRange | undefined>(undefined);
  useEffect(() => {
    setRange((r) => r ?? { from: startOfDay(subDays(new Date(), 6)), to: startOfDay(new Date()) });
  }, []);

  const { fromISO, toISO } = useMemo(() => {
    const f = startOfDay(range?.from ?? new Date());
    const t = startOfDay(range?.to ?? range?.from ?? new Date());
    t.setDate(t.getDate() + 1); // inclusivo del día "hasta"
    return { fromISO: f.toISOString(), toISO: t.toISOString() };
  }, [range]);

  // Sucursal del chip del panel (F17 · H97): null = todas las que el usuario
  // puede ver. El servidor recorta igual a las sucursales permitidas.
  const branch = useBranchContext();
  const storeId = branch.filterStoreId;
  const scopeLabel = reportScopeLabel(branch.isMulti, branch.filterStore);

  // Filtros extra guardables (TX-5 · ADR-100): medio de pago y categoría
  // filtran el reporte de ventas en el servidor (sales_report).
  const [method, setMethod] = useState<string | null>(null);
  const [categoryId, setCategoryId] = useState<string | null>(null);
  const { data: categories = [] } = useCategories();
  const categoryOptions = useMemo<SelectOption<string>[]>(() => {
    const live = categories.filter((c) => !c.deleted_at);
    const roots = live.filter((c) => !c.parent_id);
    const out: SelectOption<string>[] = [{ value: ALL, label: "Todas" }];
    for (const r of roots) {
      out.push({ value: r.id, label: r.name });
      for (const ch of live.filter((c) => c.parent_id === r.id)) out.push({ value: ch.id, label: `${r.name} / ${ch.name}` });
    }
    return out;
  }, [categories]);
  const methodOptions = useMemo<SelectOption<string>[]>(
    () => [{ value: ALL, label: "Todos" }, ...Object.entries(METHOD_LABELS).map(([value, label]) => ({ value, label }))],
    [],
  );

  // Vista (F17 · H97 · ADR-057): Consolidado / Por sucursal salen del chip
  // (una sola fuente de verdad para todo el panel); Comparar es local.
  const [compareBranches, setCompareBranches] = useState(false);
  const canCompare = branch.isMulti && branch.allowed.length > 1;
  const view: ReportView = compareBranches && canCompare ? "compare" : storeId ? "branch" : "consolidated";
  function changeView(v: ReportView) {
    if (v === "compare") {
      setCompareBranches(true);
      return;
    }
    setCompareBranches(false);
    if (v === "consolidated") branch.setSelection(ALL_BRANCHES);
    else if (!storeId) {
      const first = branch.posStoreId ?? branch.allowed[0]?.id;
      if (first) branch.setSelection(first);
    }
  }
  const viewOptions: SegmentedOption<ReportView>[] = [
    { value: "consolidated", label: "Consolidado" },
    { value: "branch", label: "Por sucursal" },
    ...(canCompare ? [{ value: "compare" as const, label: "Comparar sucursales" }] : []),
  ];

  const { data, isLoading } = useSalesReport(fromISO, toISO, {
    storeId,
    method,
    categoryId,
    enabled: view !== "compare",
  });
  const { data: warranty } = useWarrantyReport(fromISO, toISO, storeId);
  // Productividad por profesional (H39): el owner liquida comisiones de la semana
  // mirando esta tabla (+ export XLSX).
  const { data: staff } = useStaffProductivity(fromISO, toISO, storeId);

  // ── Gastronomía (F13 · H52): la sección sólo aparece si el tenant usa mesas
  // o delivery. Cada RPC se consulta gateada por su modo (top ítems = cualquiera).
  const { data: diningEnabled = false } = useDiningEnabled();
  const { data: deliveryEnabled = false } = useDeliveryEnabled();
  const showGastro = diningEnabled || deliveryEnabled;
  const { data: gTables } = useGastroTablesReport(fromISO, toISO, diningEnabled, storeId);
  const { data: gTurn } = useGastroTurnoverReport(fromISO, toISO, diningEnabled, storeId);
  const [tipMode, setTipMode] = useState<TipSplitMode>("por_mozo");
  const { data: gKitchen } = useGastroKitchenReport(fromISO, toISO, showGastro, storeId);
  const { data: gDelivery } = useGastroDeliveryReport(fromISO, toISO, deliveryEnabled, storeId);
  const { data: gTop } = useGastroTopItemsReport(fromISO, toISO, showGastro, storeId);

  async function exportReporte() {
    if (!data) return;
    const tag = `${format(range?.from ?? new Date(), "yyyy-MM-dd")}_${format(
      range?.to ?? range?.from ?? new Date(),
      "yyyy-MM-dd",
    )}`;
    const sheets: Parameters<typeof exportXlsx>[1] = [
      {
        name: "Resumen",
        title: scopeLabel ? `Reporte de ventas · ${scopeLabel} · ${tag}` : `Reporte de ventas · ${tag}`,
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
    if (diningEnabled && gTurn) {
      sheets.push({
        name: "Gastro · Rotación",
        columns: [
          { header: "Mesa", key: "table_label", width: 16 },
          { header: "Salón", key: "area", width: 20 },
          { header: "Pedidos", key: "orders", type: "number" },
          { header: "Min. sentados", key: "avg_seated_min", type: "number" },
          { header: "Min. hasta pedir", key: "avg_first_item_min", type: "number" },
          { header: "Min. cuenta a cobro", key: "avg_bill_to_close_min", type: "number" },
        ],
        rows: gTurn.by_table,
      });
      const shares = splitTips(gTurn.by_waiter, tipMode);
      sheets.push({
        name: "Gastro · Propinas",
        columns: [
          { header: "Mozo", key: "waiter", width: 24 },
          { header: "Pedidos", key: "orders", type: "number" },
          { header: "Vendido", key: "total", type: "money" },
          { header: "Propinas", key: "tips", type: "money" },
          { header: "Reparto", key: "share", type: "money" },
        ],
        rows: gTurn.by_waiter.map((r) => ({
          ...r,
          share: shares.find((x) => x.waiter === r.waiter)?.share ?? 0,
        })),
        totals: { tips: gTurn.tips_total },
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

    const fileTag = branchFileTag(branch.isMulti, branch.filterStore);
    await exportXlsx(`reporte-ventas-${fileTag ? `${fileTag}-` : ""}${tag}`, sheets);
  }

  // ── Preferencias por usuario (users.settings, cross-device): visibilidad,
  // orden y filtros guardados (TX-5). Una sola lectura al montar.
  const { toast } = useToast();
  const [vis, setVis] = useState<Record<ReportKey, boolean>>(DEFAULT_VIS);
  const [order, setOrder] = useState<ReportKey[]>(REPORT_KEYS);
  const [presets, setPresets] = useState<ReportPresetState>(EMPTY_PRESETS);
  const [prefsLoaded, setPrefsLoaded] = useState(false);
  const [presetsOpen, setPresetsOpen] = useState(false);
  useEffect(() => {
    let alive = true;
    loadReportSettings().then((s) => {
      if (!alive) return;
      if (s.visibility) setVis((v) => ({ ...v, ...s.visibility }));
      setOrder(resolveOrder(s.order, REPORT_KEYS));
      setPresets(sanitizePresets(s.presets));
      setPrefsLoaded(true);
    });
    return () => {
      alive = false;
    };
  }, []);
  function toggle(k: ReportKey) {
    setVis((prev) => {
      const next = { ...prev, [k]: !prev[k] };
      void saveReportPrefs(next);
      return next;
    });
  }
  function move(k: ReportKey, dir: -1 | 1) {
    setOrder((prev) => {
      const group = GASTRO_KEYS.includes(k) ? GASTRO_KEYS : MAIN_KEYS;
      const next = moveInOrder(prev, k, dir, group);
      if (next !== prev) void saveReportOrder(next);
      return next;
    });
  }

  const currentFilters: ReportFilters = {
    ...detectRange(range?.from ?? new Date(), range?.to ?? range?.from ?? new Date()),
    storeId,
    method,
    categoryId,
  };
  const describe = (f: ReportFilters) =>
    describeFilters(f, {
      store: (id) => {
        const b = branch.allowed.find((x) => x.id === id);
        return b ? b.short_name?.trim() || b.name : null;
      },
      method: (k) => METHOD_LABELS[k] ?? k,
      category: (id) => categoryOptions.find((o) => o.value === id)?.label ?? null,
    });
  function applyPreset(p: ReportPreset, quiet = false) {
    const r = resolveRange(p.filters);
    setRange({ from: r.from, to: r.to });
    const store = p.filters.storeId;
    if (branch.isMulti) {
      if (store && branch.allowed.some((b) => b.id === store)) branch.setSelection(store);
      else if (!store) branch.setSelection(ALL_BRANCHES);
    }
    setCompareBranches(false);
    setMethod(p.filters.method);
    setCategoryId(p.filters.categoryId);
    setPresetsOpen(false);
    if (!quiet) toast({ title: `Filtro aplicado: ${p.name}`, variant: "success" });
  }
  function persistPresets(next: ReportPresetState) {
    setPresets(next);
    void saveReportPresets(next);
  }
  function savePreset(name: string): string | null {
    const r = upsertPreset(presets, name, currentFilters);
    if ("error" in r) return r.error === "empty_name" ? "Poné un nombre." : "Llegaste al máximo de filtros guardados.";
    persistPresets(r.state);
    toast({ title: "Filtro guardado", description: name.trim(), variant: "success" });
    return null;
  }
  // Predeterminado: se aplica una vez, cuando ya están las prefs y las sucursales.
  const appliedDefault = useRef(false);
  useEffect(() => {
    if (appliedDefault.current || !prefsLoaded || !branch.ready) return;
    appliedDefault.current = true;
    const p = presets.presets.find((x) => x.id === presets.defaultId);
    if (p) applyPreset(p, true);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [prefsLoaded, branch.ready]);
  const extraFilters = activeFilterCount({ ...currentFilters, storeId: null });

  // Stock bajo (no depende del rango: es stock actual). Con una sucursal
  // elegida y stock por sucursal en el plan, es el faltante de esa sucursal
  // (contra su mínimo); si no, el del total del producto como siempre.
  const multiStore = useMultiStoreStock();
  const lowByBranch = multiStore.enabled && Boolean(storeId);
  const { data: lowRows } = useLowStockByStore(lowByBranch);
  const { data: lowTotal = [] } = useQuery({
    queryKey: ["report-low-stock"],
    enabled: !lowByBranch,
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
  const lowStock = useMemo(
    () =>
      lowByBranch
        ? filterByStore(lowRows ?? [], storeId).map((r) => ({
            name: r.variant_label ? `${r.product_name} · ${r.variant_label}` : r.product_name,
            stock: r.qty,
            stock_min: r.min_qty,
            unit: r.unit,
          }))
        : lowTotal,
    [lowByBranch, lowRows, lowTotal, storeId],
  );

  // ── Comparación con el período anterior (misma cantidad de días). Se pide
  // recién cuando el reporte principal ya está: no compite con el primer paint.
  const [compare, setCompare] = useState(true);
  useEffect(() => {
    try {
      if (window.localStorage.getItem("rep-compare") === "0") setCompare(false);
    } catch {
      /* sin storage */
    }
  }, []);
  function toggleCompare(v: boolean) {
    setCompare(v);
    try {
      window.localStorage.setItem("rep-compare", v ? "1" : "0");
    } catch {
      /* sin storage */
    }
  }
  const { rangeFrom, rangeTo, prev } = useMemo(() => {
    const f = startOfDay(range?.from ?? new Date());
    const t = startOfDay(range?.to ?? range?.from ?? new Date());
    return { rangeFrom: f, rangeTo: t, prev: previousRange(f, t) };
  }, [range]);
  const nDays = rangeDays(rangeFrom, rangeTo);
  const prevFromISO = prev.from.toISOString();
  const prevToISO = addDays(prev.to, 1).toISOString();
  const { data: prevData, isLoading: prevLoading } = useSalesReport(prevFromISO, prevToISO, {
    enabled: compare && !!data,
    storeId,
    method,
    categoryId,
  });
  const prevHint = nDays === 1 ? "vs. día anterior" : `vs. ${nDays} días anteriores`;

  // ── Consultas diferidas (sólo cuando la sección entra en pantalla).
  const [wantHours, setWantHours] = useState(false);
  const [wantCash, setWantCash] = useState(false);
  const { data: saleTimes, isLoading: hoursLoading } = useSaleTimes(
    fromISO,
    toISO,
    wantHours && vis.by_hour,
    storeId,
  );
  const { data: cashMoves, isLoading: cashLoading } = useCashFlow(
    fromISO,
    toISO,
    wantCash && vis.cash_flow,
    storeId,
  );

  // ── Series derivadas (client-side, sin consultas extra).
  const days = useMemo(
    () => fillDays(rangeFrom, rangeTo, data?.by_day ?? []),
    [data, rangeFrom, rangeTo],
  );
  const prevDays = useMemo(
    () => (prevData ? fillDays(prev.from, prev.to, prevData.by_day) : null),
    [prevData, prev],
  );
  const hours = useMemo(() => (saleTimes ? hourMatrix(saleTimes) : null), [saleTimes]);
  const peak = hours ? peakHour(hours.totals) : null;
  const flow = useMemo(
    () => (cashMoves ? cashFlowByDay(rangeFrom, rangeTo, cashMoves) : null),
    [cashMoves, rangeFrom, rangeTo],
  );

  const total = data?.total ?? 0;
  const count = data?.count ?? 0;
  const ticket = count ? total / count : 0;
  const prevTicket = prevData && prevData.count ? prevData.total / prevData.count : null;
  const bestDay = days.reduce<DayPoint | null>(
    (b, d) => (d.total > 0 && (!b || d.total > b.total) ? d : b),
    null,
  );
  const showDelta = compare && !!data;

  const [metric, setMetric] = useState<DayMetric>("total");
  const metricValue = (d: DayPoint) =>
    metric === "total" ? d.total : metric === "count" ? d.count : d.count ? d.total / d.count : 0;
  const metricFormat: ValueFormat = metric === "count" ? "number" : "currency";
  const metricName = METRIC_LABELS[metric];

  // --- Datos categóricos por sección (es-AR / ARS). ---
  const chart = useMemo(() => {
    return {
      by_method: (data?.by_method ?? []).map<CategoryDatum>((r) => ({
        label: METHOD_LABELS[r.method] ?? r.method,
        value: r.total,
      })),
      by_category: (data?.by_category ?? []).map<CategoryDatum>((r) => ({
        label: r.category,
        value: r.total,
        note: `${formatQty(r.qty)} unidades`,
      })),
      by_user: (data?.by_user ?? []).map<CategoryDatum>((r) => ({
        label: r.cashier,
        value: r.total,
        note: `${r.count} ventas`,
      })),
      // Top 10 para que el gráfico no se sature; la tabla mantiene todo.
      by_product: (data?.by_product ?? []).slice(0, 10).map<CategoryDatum>((r) => ({
        label: r.product,
        value: r.total,
        note: `${formatQty(r.qty)} unidades`,
      })),
      by_customer: (data?.by_customer ?? []).slice(0, 10).map<CategoryDatum>((r) => ({
        label: r.customer,
        value: r.total,
        note: `${r.count} ventas`,
      })),
      warranties: (warranty?.rows ?? []).map<CategoryDatum>((r) => ({
        label: r.label,
        value: r.total,
        note: `${r.qty} vendidas · comisión ${formatCurrency(r.commission)}`,
      })),
      low_stock: lowStock.slice(0, 10).map((p) => ({
        label: p.name,
        value: p.stock,
        target: p.stock_min ?? 0,
        unit: p.unit,
      })),
      // ── Gastronomía (F13 · H52) ──────────────────────────────────────────
      gastro_area: (gTables?.by_area ?? []).map<CategoryDatum>((r) => ({
        label: r.area,
        value: r.total,
        note: `${r.orders} pedidos · ticket ${formatCurrency(r.avg_ticket)}`,
      })),
      // Tiempo promedio por estación (en minutos para que el gráfico sea legible).
      gastro_turnover: (gTurn?.by_table ?? []).map<CategoryDatum>((r) => ({
        label: `Mesa ${r.table_label}`,
        value: Number(r.avg_seated_min ?? 0),
        note: `${r.orders} pedidos`,
      })),
      gastro_kitchen: (gKitchen?.by_station ?? []).map<CategoryDatum>((r) => ({
        label: r.station,
        value: Math.round((r.avg_seconds / 60) * 10) / 10,
        note: `${r.items} ítems · mín. ${formatDuration(r.min_seconds)} · máx. ${formatDuration(r.max_seconds)}`,
      })),
      gastro_delivery_channel: (gDelivery?.by_channel ?? []).map<CategoryDatum>((r) => ({
        label: DELIVERY_CHANNEL_LABELS[r.channel as DeliveryChannel] ?? r.channel,
        value: r.total,
        note: `${r.orders} pedidos`,
      })),
      gastro_top_items: (gTop?.top ?? []).slice(0, 10).map<CategoryDatum>((r) => ({
        label: r.name,
        value: r.qty,
        note: `Importe ${formatCurrency(r.total)}`,
      })),
    };
  }, [data, warranty, lowStock, gTables, gTurn, gKitchen, gDelivery, gTop]);

  // Horas con actividad (para el gráfico "Por hora"; recorta madrugadas vacías).
  const activeHours = useMemo(() => {
    if (!hours) return [];
    const perHour = byHour(hours.totals);
    const first = perHour.findIndex((v) => v > 0);
    if (first < 0) return [];
    let last = 23;
    while (last > first && (perHour[last] ?? 0) <= 0) last--;
    return perHour.slice(first, last + 1).map((v, i) => ({ h: first + i, v }));
  }, [hours]);

  return (
    <>
      <div className="mx-auto max-w-6xl px-4 py-8 sm:px-6">
        <Eyebrow>Información</Eyebrow>
        <Display className="mt-3 flex items-center gap-2 text-3xl md:text-4xl">
          Reportes
          <InfoHint section="reportes" size={18} />
        </Display>
        {branch.isMulti && (
          <div className="mt-4 flex flex-col gap-2 sm:flex-row sm:flex-wrap sm:items-center">
            <Segmented
              aria-label="Alcance del reporte"
              value={view}
              onChange={changeView}
              options={viewOptions}
              size="sm"
            />
            {view === "branch" && (
              <div className="flex flex-wrap gap-1.5" role="radiogroup" aria-label="Sucursal">
                {branch.allowed.map((b) => {
                  const on = b.id === storeId;
                  return (
                    <button
                      key={b.id}
                      type="button"
                      role="radio"
                      aria-checked={on}
                      onClick={() => branch.setSelection(b.id)}
                      className={cn(
                        "inline-flex h-8 items-center gap-1.5 rounded-md border border-border px-2.5 text-xs transition-colors",
                        on ? "bg-muted font-medium text-foreground" : "text-muted-foreground hover:bg-muted/60 hover:text-foreground",
                      )}
                    >
                      <BranchDot branch={b} />
                      {b.short_name?.trim() || b.name}
                    </button>
                  );
                })}
              </div>
            )}
          </div>
        )}
        {scopeLabel && view !== "compare" && (
          <p className="mt-2 text-sm text-muted-foreground">
            Mirando <span className="font-medium text-foreground">{scopeLabel}</span>
            {storeId ? "" : " (consolidado de las sucursales que ves)"}. También cambia desde el
            selector de sucursal del panel.
          </p>
        )}

        <div className="-mx-4 mt-6 flex items-end gap-3 overflow-x-auto px-4 pb-1 sm:mx-0 sm:flex-wrap sm:overflow-visible sm:px-0 [scrollbar-width:none] [&::-webkit-scrollbar]:hidden">
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
          {view !== "compare" && (
            <div className="flex w-40 shrink-0 flex-col gap-1">
              <span className="text-xs text-muted-foreground">Medio de pago</span>
              <Select
                aria-label="Filtrar por medio de pago"
                value={method ?? ALL}
                options={methodOptions}
                onChange={(v) => setMethod(v === ALL ? null : v)}
              />
            </div>
          )}
          {view !== "compare" && (
            <div className="flex w-48 shrink-0 flex-col gap-1">
              <span className="text-xs text-muted-foreground">Categoría</span>
              <Select
                aria-label="Filtrar por categoría"
                value={categoryId ?? ALL}
                options={categoryOptions}
                onChange={(v) => setCategoryId(v === ALL ? null : v)}
              />
            </div>
          )}
          {view !== "compare" && (
          <div className="flex shrink-0 flex-col gap-1">
            <span className="text-xs text-muted-foreground">Comparar</span>
            <div className="flex h-9 items-center gap-2 text-xs text-muted-foreground">
              <Switch
                checked={compare}
                onCheckedChange={toggleCompare}
                label="Comparar con el período anterior"
              />
              <span className="whitespace-nowrap">Período anterior</span>
            </div>
          </div>
          )}
          {/* Acciones agrupadas a la derecha: si no entran en la fila bajan
              juntas (nunca queda un botón suelto en una segunda fila). */}
          <div className="flex shrink-0 items-center gap-2 sm:ml-auto">
            <Button
              variant="secondary"
              className="shrink-0"
              onClick={() => setPresetsOpen(true)}
              aria-haspopup="dialog"
            >
              <Bookmark size={16} /> Guardados
              {presets.presets.length > 0 && (
                <span className="font-mono text-xs text-muted-foreground">{presets.presets.length}</span>
              )}
            </Button>
            <Link
              href="/reportes/conciliacion"
              title="Conciliación de tarjetas"
              className={cn(buttonVariants({ variant: "secondary" }), "shrink-0")}
            >
              <CreditCard size={16} /> Conciliación
            </Link>
            <Link
              href="/reportes/iva"
              title="IVA ventas por alícuota y percepciones"
              className={cn(buttonVariants({ variant: "secondary" }), "shrink-0")}
            >
              <Landmark size={16} /> IVA
            </Link>
            {view !== "compare" && (
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
            )}
            {view !== "compare" && (
            <Dropdown>
              <DropdownTrigger asChild>
                <Button variant="secondary" className="shrink-0">
                  <SlidersHorizontal size={16} /> Personalizar
                </Button>
              </DropdownTrigger>
              <DropdownContent align="end" className="w-72">
                <DropdownLabel>Reportes a mostrar y orden</DropdownLabel>
                {order.flatMap((k) => REPORTS.filter((r) => r.key === k)).filter((r) => {
                  // Los toggles gastro sólo se ofrecen si el tenant usa el modo.
                  if (r.key === "gastro_tables" || r.key === "gastro_turnover") return diningEnabled;
                  if (r.key === "gastro_delivery") return deliveryEnabled;
                  if (r.key === "gastro_kitchen" || r.key === "gastro_top_items")
                    return showGastro;
                  return true;
                }).map((r) => (
                  <div
                    key={r.key}
                    className="flex items-center justify-between gap-2 px-2 py-1.5 text-sm"
                  >
                    <span className="min-w-0 flex-1 truncate">{r.label}</span>
                    <button
                      type="button"
                      onClick={() => move(r.key, -1)}
                      aria-label={`Subir ${r.label}`}
                      title="Subir"
                      className="grid h-7 w-7 shrink-0 place-items-center rounded-md text-muted-foreground transition-colors hover:bg-muted hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                    >
                      <ArrowUp size={14} strokeWidth={1.75} />
                    </button>
                    <button
                      type="button"
                      onClick={() => move(r.key, 1)}
                      aria-label={`Bajar ${r.label}`}
                      title="Bajar"
                      className="grid h-7 w-7 shrink-0 place-items-center rounded-md text-muted-foreground transition-colors hover:bg-muted hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                    >
                      <ArrowDown size={14} strokeWidth={1.75} />
                    </button>
                    <Switch
                      checked={vis[r.key]}
                      onCheckedChange={() => toggle(r.key)}
                      label={r.label}
                    />
                  </div>
                ))}
              </DropdownContent>
            </Dropdown>
            )}
          </div>
        </div>

        {view === "compare" ? (
          <div className="mt-6">
            <BranchCompare
              fromISO={fromISO}
              toISO={toISO}
              rangeFrom={rangeFrom}
              rangeTo={rangeTo}
              periodLabel={`${format(rangeFrom, "dd/MM/yyyy")} al ${format(rangeTo, "dd/MM/yyyy")}`}
            />
          </div>
        ) : (
        <>

        <div className="mt-6 grid grid-cols-2 gap-3 lg:grid-cols-4">
          <KpiCard
            label="Total vendido"
            value={formatChartValue(total, "currency")}
            valueClassName="price-hl font-price"
            delta={showDelta && prevData ? deltaPct(total, prevData.total) : undefined}
            deltaLoading={showDelta && prevLoading}
            deltaHint={showDelta ? prevHint : undefined}
            spark={days.map((d) => d.total)}
          />
          <KpiCard
            label="Cantidad de ventas"
            value={count.toLocaleString("es-AR")}
            delta={showDelta && prevData ? deltaPct(count, prevData.count) : undefined}
            deltaLoading={showDelta && prevLoading}
            deltaHint={showDelta ? prevHint : undefined}
            spark={days.map((d) => d.count)}
          />
          <KpiCard
            label="Ticket promedio"
            value={formatChartValue(ticket, "currency")}
            delta={showDelta && prevData ? deltaPct(ticket, prevTicket) : undefined}
            deltaLoading={showDelta && prevLoading}
            deltaHint={showDelta ? prevHint : undefined}
            spark={days.map((d) => (d.count ? d.total / d.count : 0))}
          />
          <KpiCard
            label="Mejor día"
            value={bestDay ? formatChartValue(bestDay.total, "currency") : <NoData />}
            hint={
              bestDay
                ? `${bestDay.long} · ${bestDay.count} ventas`
                : "Sin ventas en el período"
            }
          />
        </div>

        {extraFilters > 0 && (
          <p className="mt-4 text-xs text-muted-foreground" role="status">
            Medio y categoría filtran las ventas (indicadores, evolución, medios, categorías,
            productos, cajeros y clientes). Garantías, staff, stock y gastronomía no cambian.
          </p>
        )}

        {isLoading ? (
          <div className="mt-6 grid gap-4 lg:grid-cols-2" aria-busy="true" aria-label="Cargando reportes">
            <Skeleton className="h-[340px] lg:col-span-2" />
            <Skeleton className="h-[300px]" />
            <Skeleton className="h-[300px]" />
          </div>
        ) : (
          <div className="mt-6 grid gap-4 lg:grid-flow-dense lg:grid-cols-2">
            {renderOrdered(order, {
              by_day: vis.by_day && (
                <ReportSection<SeriesKind>
                  id="by_day"
                  title="Evolución de ventas"
                  subtitle={
                    days.length > 1
                      ? `${metricName} · promedio diario ${formatChartValue(
                          days.reduce((a, d) => a + metricValue(d), 0) / days.length,
                          metricFormat,
                        )}`
                      : metricName
                  }
                  className="lg:col-span-2"
                  chartTypes={TIME_TYPES}
                  controls={
                    <Segmented<DayMetric>
                      aria-label="Métrica"
                      value={metric}
                      onChange={setMetric}
                      size="sm"
                      options={METRIC_OPTIONS}
                    />
                  }
                  chart={(kind) => ({
                    option: timeSeriesOption({
                      labels: days.map((d) => d.label),
                      tooltipLabels: days.map((d) => d.long),
                      values: days.map(metricValue),
                      name: metricName,
                      format: metricFormat,
                      kind,
                      showAverage: true,
                      previous:
                        compare && prevDays
                          ? {
                              values: prevDays.map(metricValue),
                              labels: prevDays.map((d) => d.long),
                              name: "Período anterior",
                            }
                          : null,
                    }),
                    height: 300,
                    compactHeight: 260,
                    empty: !days.some((d) => d.count > 0),
                    ariaLabel: `${metricName} por día`,
                    summary: {
                      columns: ["Día", metricName],
                      rows: days.map((d) => [d.long, formatChartValue(metricValue(d), metricFormat)]),
                    },
                })}
                table={
                  <BareTable
                    cols={["Día", "Total", "Ventas", "Ticket prom."]}
                    rows={days.map((d) => [
                      d.long,
                      formatCurrency(d.total),
                      String(d.count),
                      d.count ? formatCurrency(d.total / d.count) : <NoData key="nd" />,
                    ])}
                  />
                }
              />
            ),
            by_hour: vis.by_hour && (
              <ReportSection<"heatmap" | "bar">
                id="by_hour"
                title="Ventas por día y hora"
                subtitle={
                  peak
                    ? `Pico: ${WEEKDAYS[peak.weekday]} de ${peak.hour} a ${peak.hour + 1} h`
                    : "Cuándo se concentran tus ventas"
                }
                className="lg:col-span-2"
                onVisible={() => setWantHours(true)}
                loading={!hours && (hoursLoading || !wantHours)}
                chartTypes={HOUR_TYPES}
                chart={(kind) => ({
                  option:
                    kind === "heatmap"
                      ? heatmapOption({
                          totals: hours?.totals ?? [],
                          counts: hours?.counts ?? [],
                          format: "currency",
                        })
                      : columnBarOption({
                          items: activeHours.map((x) => ({ label: `${x.h}h`, value: x.v })),
                          name: "Vendido",
                          format: "currency",
                        }),
                  height: kind === "heatmap" ? 300 : 260,
                  compactHeight: kind === "heatmap" ? 320 : 240,
                  empty: activeHours.length === 0,
                  ariaLabel: "Ventas por día de la semana y hora",
                  summary: {
                    columns: ["Hora", "Vendido"],
                    rows: activeHours.map((x) => [`${x.h} h`, formatCurrency(x.v)]),
                  },
                })}
                table={
                  <BareTable
                    cols={["Día", "Hora pico", "Vendido", "Ventas"]}
                    rows={(hours?.totals ?? []).map((day, w) => {
                      const h = day.indexOf(Math.max(...day));
                      const sum = day.reduce((a, v) => a + v, 0);
                      const c = (hours?.counts[w] ?? []).reduce((a, v) => a + v, 0);
                      return [
                        WEEKDAYS[w] ?? "",
                        sum > 0 ? `${h} a ${h + 1} h` : <NoData key="nd" />,
                        formatCurrency(sum),
                        String(c),
                      ];
                    })}
                  />
                }
              />
            ),
            by_method: vis.by_method && (
              <>
              <ReportSection<"doughnut" | "ranking">
                id="by_method"
                title="Medios de pago"
                subtitle={topShare(chart.by_method)}
                chartTypes={MIX_TYPES}
                chart={(kind) =>
                  categoryChart(kind, chart.by_method, "Total", "currency", "Total por medio de pago")
                }
                table={<BareTable cols={["Medio", "Total", "%"]} rows={withShare(chart.by_method)} />}
              />
              {/* F8 · ADR-099: comisiones estimadas y propinas por medio. */}
              <PaymentFeesSection fromISO={fromISO} toISO={toISO} storeId={storeId} />
              </>
            ),
            by_category: vis.by_category && (
              <ReportSection<"treemap" | "doughnut" | "ranking">
                id="by_category"
                title="Categorías"
                subtitle={topShare(chart.by_category)}
                chartTypes={WEIGHT_TYPES}
                chart={(kind) =>
                  categoryChart(kind, chart.by_category, "Total", "currency", "Total por categoría")
                }
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
            ),
            by_product: vis.by_product && (
              <ReportSection<"ranking" | "treemap">
                id="by_product"
                title="Top productos"
                subtitle="Los 10 que más facturaron"
                chartTypes={TOP_TYPES}
                chart={(kind) =>
                  categoryChart(kind, chart.by_product, "Total", "currency", "Top productos por facturación")
                }
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
            ),
            by_customer: vis.by_customer && (
              <ReportSection<"ranking">
                id="by_customer"
                title="Top clientes"
                subtitle="Los 10 que más compraron"
                chart={() =>
                  categoryChart("ranking", chart.by_customer, "Total", "currency", "Top clientes por compras")
                }
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
            ),
            by_user: vis.by_user && (
              <ReportSection<"ranking" | "doughnut">
                id="by_user"
                title="Por cajero"
                subtitle={topShare(chart.by_user)}
                chartTypes={RANK_MIX_TYPES}
                chart={(kind) => categoryChart(kind, chart.by_user, "Total", "currency", "Total por cajero")}
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
            ),
            warranties: vis.warranties && (
              <ReportSection<"ranking" | "doughnut">
                id="warranties"
                title="Garantías y comisiones"
                subtitle={
                  warranty && warranty.qty > 0
                    ? `${warranty.qty} vendidas · comisión ${formatCurrency(warranty.commission)}`
                    : undefined
                }
                chartTypes={RANK_MIX_TYPES}
                chart={(kind) =>
                  categoryChart(kind, chart.warranties, "Total", "currency", "Garantías vendidas")
                }
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
            ),
            cash_flow: vis.cash_flow && (
              <ReportSection<"flow">
                id="cash_flow"
                title="Flujo de caja"
                subtitle={
                  flow
                    ? `Neto del período ${formatCurrency(
                        flow.reduce((a, d) => a + d.inflow - d.outflow, 0),
                      )}`
                    : "Ingresos y egresos de las cajas por día"
                }
                className="lg:col-span-2"
                onVisible={() => setWantCash(true)}
                loading={!flow && (cashLoading || !wantCash)}
                chart={() => ({
                  option: cashFlowOption({
                    labels: (flow ?? []).map((d) => d.label),
                    tooltipLabels: (flow ?? []).map((d) => d.long),
                    inflow: (flow ?? []).map((d) => d.inflow),
                    outflow: (flow ?? []).map((d) => d.outflow),
                  }),
                  height: 300,
                  compactHeight: 280,
                  empty: !flow || !flow.some((d) => d.inflow > 0 || d.outflow > 0),
                  ariaLabel: "Flujo de caja diario: ingresos, egresos y neto",
                  summary: {
                    columns: ["Día", "Ingresos", "Egresos", "Neto"],
                    rows: (flow ?? []).map((d) => [
                      d.long,
                      formatCurrency(d.inflow),
                      formatCurrency(d.outflow),
                      formatCurrency(d.inflow - d.outflow),
                    ]),
                  },
                })}
                table={
                  <BareTable
                    cols={["Día", "Ingresos", "Egresos", "Neto"]}
                    rows={(flow ?? []).map((d) => [
                      d.long,
                      formatCurrency(d.inflow),
                      formatCurrency(d.outflow),
                      formatCurrency(d.inflow - d.outflow),
                    ])}
                  />
                }
              />
            ),
            staff: vis.staff && (
              <ReportSection<"stacked" | "ranking">
                id="staff"
                title="Productividad del staff"
                subtitle="Comisión y propinas por profesional"
                className="lg:col-span-2"
                chartTypes={STAFF_TYPES}
                chart={(kind) => {
                  const rows = staff ?? [];
                  return {
                    option:
                      kind === "stacked"
                        ? stackedBarOption({
                            categories: rows.map((r) => r.professional),
                            series: [
                              { name: "Comisión", values: rows.map((r) => r.commission) },
                              { name: "Propinas", values: rows.map((r) => r.tips) },
                            ],
                            format: "currency",
                            horizontal: true,
                          })
                        : rankingBarOption({
                            items: rows.map((r) => ({
                              label: r.professional,
                              value: r.billed,
                              note: `${r.sales_count} ventas · ticket ${formatCurrency(r.avg_ticket)}`,
                            })),
                            name: "Facturado",
                            format: "currency",
                          }),
                    height: barsHeight(rows.length, kind === "stacked" ? 48 : 0),
                    empty: rows.length === 0,
                    ariaLabel: "Comisión y propinas por profesional",
                    summary: {
                      columns: ["Profesional", "Facturado", "Comisión", "Propinas"],
                      rows: rows.map((r) => [
                        r.professional,
                        formatCurrency(r.billed),
                        formatCurrency(r.commission),
                        formatCurrency(r.tips),
                      ]),
                    },
                  };
                }}
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
            ),
            low_stock: vis.low_stock && (
              <ReportSection<"bullet">
                id="low_stock"
                title="Stock bajo"
                subtitle={
                  lowStock.length
                    ? `${lowStock.length} productos por debajo del mínimo`
                    : "Todo por encima del mínimo"
                }
                chart={() => ({
                  option: bulletOption({ items: chart.low_stock }),
                  height: barsHeight(chart.low_stock.length, 40),
                  empty: chart.low_stock.length === 0,
                  ariaLabel: "Stock actual contra stock mínimo",
                  summary: {
                    columns: ["Producto", "Stock", "Mínimo"],
                    rows: chart.low_stock.map((p) => [p.label, formatQty(p.value), formatQty(p.target)]),
                  },
                })}
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
            ),
            })}
          </div>
        )}

        {/* ── Gastronomía (F13 · H52): mesas/salón, cocina (KDS), delivery y top
             ítems. Sólo si el tenant usa mesas o delivery. ──────────────────── */}
        {showGastro && (
          <div className="mt-12">
            <Eyebrow>Operación gastronómica</Eyebrow>
            <Display className="mt-2 text-2xl md:text-3xl">Gastronomía</Display>
            <div className="mt-6 grid gap-4 lg:grid-flow-dense lg:grid-cols-2">
              {renderOrdered(order, {
                gastro_tables: diningEnabled && vis.gastro_tables && (
                  <ReportSection<"ranking" | "doughnut">
                    id="gastro_tables"
                    title="Mesas y salón"
                    subtitle={
                      gTables && gTables.orders > 0
                        ? `${gTables.orders} pedidos · ticket prom. ${formatCurrency(gTables.avg_ticket)}`
                        : undefined
                    }
                    className="lg:col-span-2"
                    chartTypes={RANK_MIX_TYPES}
                    chart={(kind) =>
                      categoryChart(kind, chart.gastro_area, "Vendido", "currency", "Vendido por salón")
                    }
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
                ),
                gastro_turnover: diningEnabled && vis.gastro_turnover && (
                  <ReportSection<"column">
                    id="gastro_turnover"
                    title="Rotación de mesas, mozos y propinas"
                    subtitle={
                      gTurn && gTurn.orders > 0
                        ? `${gTurn.orders} mesas cobradas · ${fmtMin(gTurn.avg_seated_min)} sentados en promedio`
                        : undefined
                    }
                    className="lg:col-span-2"
                    chart={() => ({
                      option: columnBarOption({
                        items: chart.gastro_turnover,
                        name: "Minutos sentados",
                        format: "minutes",
                      }),
                      height: 260,
                      empty: chart.gastro_turnover.length === 0,
                      ariaLabel: "Minutos promedio sentados por mesa",
                      summary: {
                        columns: ["Mesa", "Minutos sentados"],
                        rows: chart.gastro_turnover.map((d) => [d.label, d.value]),
                      },
                  })}
                  table={
                    <div className="space-y-6 p-4">
                      <div className="grid grid-cols-3 gap-3 text-sm">
                        <div>
                          <p className="text-xs text-muted-foreground">Hasta pedir</p>
                          <p className="font-semibold tabular-nums">{fmtMin(gTurn?.avg_first_item_min)}</p>
                        </div>
                        <div>
                          <p className="text-xs text-muted-foreground">Sentados</p>
                          <p className="font-semibold tabular-nums">{fmtMin(gTurn?.avg_seated_min)}</p>
                        </div>
                        <div>
                          <p className="text-xs text-muted-foreground">Cuenta a cobro</p>
                          <p className="font-semibold tabular-nums">{fmtMin(gTurn?.avg_bill_to_close_min)}</p>
                        </div>
                      </div>
                      <div>
                        <p className="mb-2 text-xs uppercase tracking-[0.14em] text-muted-foreground">
                          Por mesa
                        </p>
                        <BareTable
                          cols={["Mesa", "Salón", "Pedidos", "Sentados", "Hasta pedir", "Cuenta a cobro"]}
                          rows={(gTurn?.by_table ?? []).map((r) => [
                            r.table_label,
                            r.area,
                            String(r.orders),
                            fmtMin(r.avg_seated_min),
                            fmtMin(r.avg_first_item_min),
                            fmtMin(r.avg_bill_to_close_min),
                          ])}
                        />
                      </div>
                      <div>
                        <div className="mb-2 flex flex-wrap items-center justify-between gap-2">
                          <p className="text-xs uppercase tracking-[0.14em] text-muted-foreground">
                            Mozos y propinas ({formatCurrency(gTurn?.tips_total ?? 0)})
                          </p>
                          <Segmented<TipSplitMode>
                            size="sm"
                            aria-label="Reparto de propinas"
                            value={tipMode}
                            onChange={setTipMode}
                            options={[
                              { value: "por_mozo", label: "Cada mozo lo suyo" },
                              { value: "pozo", label: "Pozo común" },
                            ]}
                          />
                        </div>
                        <BareTable
                          cols={["Mozo", "Pedidos", "Vendido", "Propinas", "Le toca"]}
                          rows={(gTurn?.by_waiter ?? []).map((r) => [
                            r.waiter,
                            String(r.orders),
                            formatCurrency(r.total),
                            formatCurrency(r.tips),
                            formatCurrency(
                              splitTips(gTurn?.by_waiter ?? [], tipMode).find((x) => x.waiter === r.waiter)
                                ?.share ?? 0,
                            ),
                          ])}
                        />
                      </div>
                    </div>
                  }
                />
              ),
              gastro_kitchen: vis.gastro_kitchen && (
                <ReportSection<"column">
                  id="gastro_kitchen"
                  title="Tiempos de cocina (KDS)"
                  subtitle={
                    gKitchen && gKitchen.items > 0
                      ? `${gKitchen.items} ítems · promedio global ${formatDuration(gKitchen.avg_seconds)}`
                      : undefined
                  }
                  chart={() => ({
                    option: columnBarOption({
                      items: chart.gastro_kitchen,
                      name: "Promedio",
                      format: "minutes",
                    }),
                    height: 260,
                    empty: chart.gastro_kitchen.length === 0,
                    ariaLabel: "Minutos promedio de preparación por estación",
                    summary: {
                      columns: ["Estación", "Minutos promedio"],
                      rows: chart.gastro_kitchen.map((d) => [d.label, d.value]),
                    },
                  })}
                  table={
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
                  }
                />
              ),
              gastro_delivery: deliveryEnabled && vis.gastro_delivery && (
                <ReportSection<"doughnut" | "ranking">
                  id="gastro_delivery"
                  title="Delivery / take away"
                  subtitle={
                    gDelivery && gDelivery.orders > 0
                      ? `${gDelivery.orders} pedidos · envíos ${formatCurrency(gDelivery.delivery_fees)}`
                      : undefined
                  }
                  chartTypes={MIX_TYPES}
                  chart={(kind) =>
                    categoryChart(kind, chart.gastro_delivery_channel, "Vendido", "currency", "Vendido por canal")
                  }
                  table={
                    <div className="space-y-6 p-4">
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
              ),
              gastro_top_items: vis.gastro_top_items && (
                <ReportSection<"ranking" | "treemap">
                  id="gastro_top_items"
                  title="Top ítems (mesa + delivery)"
                  subtitle="Los 10 más pedidos, por cantidad"
                  className="lg:col-span-2"
                  chartTypes={TOP_TYPES}
                  chart={(kind) =>
                    categoryChart(kind, chart.gastro_top_items, "Cantidad", "number", "Top ítems por cantidad")
                  }
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
                            // cargada (cost > 0); si no, <NoData /> (H50/H52).
                            r.cost > 0 ? formatCurrency(r.margin) : <NoData key="nd" />,
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
              ),
              })}
            </div>
          </div>
        )}
        </>
        )}
      </div>
      <ReportPresetsModal
        open={presetsOpen}
        onOpenChange={setPresetsOpen}
        state={presets}
        current={currentFilters}
        describe={describe}
        onApply={(p) => applyPreset(p)}
        onSave={savePreset}
        onDelete={(id) => persistPresets(removePreset(presets, id))}
        onSetDefault={(id) => persistPresets(setDefaultPreset(presets, id))}
      />
    </>
  );
}

/** Renderiza las secciones en el orden elegido por el usuario (orden real del
 *  DOM, así el foco con Tab sigue el orden visual). */
function renderOrdered(order: ReportKey[], nodes: Partial<Record<ReportKey, ReactNode>>): ReactNode {
  return order.map((k) => (nodes[k] ? <Fragment key={k}>{nodes[k]}</Fragment> : null));
}

// ── Tipos de gráfico por familia de datos ──────────────────────────────────
type DayMetric = "total" | "count" | "ticket";
const METRIC_LABELS: Record<DayMetric, string> = {
  total: "Vendido",
  count: "Ventas",
  ticket: "Ticket promedio",
};
const METRIC_OPTIONS: SegmentedOption<DayMetric>[] = [
  { value: "total", label: "Vendido" },
  { value: "count", label: "Ventas" },
  { value: "ticket", label: "Ticket" },
];
const ICON = { size: 14, strokeWidth: 1.75 } as const;
const TIME_TYPES: SegmentedOption<SeriesKind>[] = [
  { value: "area", label: "Área", icon: <ChartArea {...ICON} /> },
  { value: "line", label: "Línea", icon: <ChartLine {...ICON} /> },
  { value: "bar", label: "Barras", icon: <ChartColumn {...ICON} /> },
];
const HOUR_TYPES: SegmentedOption<"heatmap" | "bar">[] = [
  { value: "heatmap", label: "Mapa de calor", icon: <Grid3x3 {...ICON} /> },
  { value: "bar", label: "Por hora", icon: <ChartColumn {...ICON} /> },
];
const MIX_TYPES: SegmentedOption<"doughnut" | "ranking">[] = [
  { value: "doughnut", label: "Dona", icon: <ChartPie {...ICON} /> },
  { value: "ranking", label: "Barras", icon: <ChartBar {...ICON} /> },
];
const RANK_MIX_TYPES: SegmentedOption<"ranking" | "doughnut">[] = [
  { value: "ranking", label: "Barras", icon: <ChartBar {...ICON} /> },
  { value: "doughnut", label: "Dona", icon: <ChartPie {...ICON} /> },
];
const WEIGHT_TYPES: SegmentedOption<"treemap" | "doughnut" | "ranking">[] = [
  { value: "treemap", label: "Mosaico", icon: <LayoutGrid {...ICON} /> },
  { value: "doughnut", label: "Dona", icon: <ChartPie {...ICON} /> },
  { value: "ranking", label: "Barras", icon: <ChartBar {...ICON} /> },
];
const TOP_TYPES: SegmentedOption<"ranking" | "treemap">[] = [
  { value: "ranking", label: "Ranking", icon: <ChartBar {...ICON} /> },
  { value: "treemap", label: "Mosaico", icon: <LayoutGrid {...ICON} /> },
];
const STAFF_TYPES: SegmentedOption<"stacked" | "ranking">[] = [
  { value: "stacked", label: "Comisión + propinas", icon: <ChartBarStacked {...ICON} /> },
  { value: "ranking", label: "Facturado", icon: <ChartBar {...ICON} /> },
];

/** Alto de un gráfico de barras horizontales según la cantidad de filas. */
function barsHeight(rows: number, extra = 0) {
  return Math.max(180, Math.min(rows, 12) * 36 + 24 + extra);
}

/** Gráfico categórico (ranking / dona / mosaico) con resumen accesible. */
function categoryChart(
  kind: "ranking" | "doughnut" | "treemap",
  items: CategoryDatum[],
  name: string,
  format: ValueFormat,
  ariaLabel: string,
): ReportChartSpec {
  const summary = {
    columns: ["Categoría", name],
    rows: items.map((d) => [d.label, formatChartValue(d.value, format)]),
  };
  const empty = !items.some((d) => d.value > 0);
  if (kind === "doughnut") {
    return {
      option: doughnutOption({ items, name, format }),
      height: 260,
      compactHeight: 320,
      empty,
      ariaLabel,
      summary,
    };
  }
  if (kind === "treemap") {
    return { option: treemapOption({ items, name, format }), height: 280, empty, ariaLabel, summary };
  }
  return {
    option: rankingBarOption({ items, name, format }),
    height: barsHeight(items.length),
    empty,
    ariaLabel,
    summary,
  };
}

/** "Efectivo concentra el 62%" (o undefined sin datos). */
function topShare(items: CategoryDatum[]): string | undefined {
  const total = items.reduce((a, d) => a + d.value, 0);
  const top = [...items].sort((a, b) => b.value - a.value)[0];
  if (!top || total <= 0) return undefined;
  return `${top.label} concentra el ${Math.round((top.value / total) * 100)}%`;
}

function withShare(items: CategoryDatum[]): ReactNode[][] {
  const total = items.reduce((a, d) => a + d.value, 0);
  return items.map((d) => [
    d.label,
    formatCurrency(d.value),
    total ? `${(Math.round((d.value / total) * 1000) / 10).toLocaleString("es-AR")}%` : "0%",
  ]);
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

// Minutos con un decimal del reporte de rotación (F13 · H51). null = sin dato.
function fmtMin(min: number | null | undefined): string {
  if (min === null || min === undefined) return "s/d";
  const n = Number(min);
  if (n < 60) return `${n.toLocaleString("es-AR", { maximumFractionDigits: 1 })} min`;
  const h = Math.floor(n / 60);
  return `${h} h ${Math.round(n - h * 60)} min`;
}

// Tabla "desnuda" (sin card ni header): el chrome lo aporta ReportSection.
function BareTable({ cols, rows }: { cols: string[]; rows: ReactNode[][] }) {
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
