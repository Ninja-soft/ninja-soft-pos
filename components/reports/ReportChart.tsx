"use client";

import { useId, useMemo } from "react";
import {
  Area,
  AreaChart,
  Bar,
  BarChart,
  CartesianGrid,
  Cell,
  Legend,
  Line,
  LineChart,
  Pie,
  PieChart,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";
import { Segmented } from "@/components/ui/Segmented";
import { formatCurrency } from "@/lib/utils/format";

export type ChartType = "bar" | "line" | "area" | "pie";

const TYPE_LABELS: Record<ChartType, string> = {
  bar: "Barras",
  line: "Línea",
  area: "Área",
  pie: "Torta",
};

// Paleta de marca NinjaSoft (tokens fijos de tailwind.config / brand book).
// Se usa para las porciones de torta y para diferenciar barras categóricas.
const FLAME = "#FF4B22";
const PIE_PALETTE = [
  "#FF4B22", // ninja.flame
  "#FF8A1F", // gradiente medio
  "#FFD21F", // ninja.gold
  "#6D4AFF", // ninja.brightViolet
  "#FF6A1A", // ninja.flameSoft
  "#B8AEDC", // ninja.lavender
  "#E63E18", // ninja.flameDeep
  "#2B1A67", // ninja.midViolet
  "#FFE45C", // ninja.goldSoft
  "#7F75A6", // ninja.slate
];

export interface ReportChartDatum {
  /** Etiqueta del eje X / leyenda (día, categoría, cliente…). */
  label: string;
  /** Valor principal graficado. */
  value: number;
  /** Valor secundario opcional (p. ej. cantidad de ventas). */
  secondary?: number;
}

interface ReportChartProps {
  data: ReportChartDatum[];
  /** Tipos de gráfico disponibles para alternar. */
  types: ChartType[];
  /** Tipo activo. */
  type: ChartType;
  onTypeChange: (t: ChartType) => void;
  /** Cómo formatear el valor (montos ARS vs. cantidades). */
  valueFormat?: "currency" | "number";
  /** Nombre legible de la serie de valor (tooltip / leyenda). */
  valueName?: string;
  /** Altura del área de dibujo. */
  height?: number;
}

const numberFmt = new Intl.NumberFormat("es-AR");

function fmtValue(v: number, mode: "currency" | "number") {
  return mode === "currency" ? formatCurrency(v) : numberFmt.format(v);
}

// Tooltip propio para respetar tokens del tema (recharts no hereda CSS vars
// en su tooltip por defecto y queda ilegible sobre fondo oscuro).
function ChartTooltip({
  active,
  payload,
  label,
  valueFormat,
  valueName,
}: {
  active?: boolean;
  payload?: Array<{ value?: number | string; name?: string; payload?: ReportChartDatum }>;
  label?: string | number;
  valueFormat: "currency" | "number";
  valueName: string;
}) {
  if (!active || !payload?.length) return null;
  const datum = payload[0]?.payload;
  const title = label ?? datum?.label ?? "";
  return (
    <div className="rounded-lg border border-border bg-popover px-3 py-2 text-xs shadow-ninjaSoft">
      <p className="mb-1 font-semibold text-popover-foreground">{title}</p>
      <p className="tabular-nums text-popover-foreground">
        <span className="text-muted-foreground">{valueName}: </span>
        {fmtValue(Number(payload[0]?.value ?? 0), valueFormat)}
      </p>
      {datum?.secondary != null && (
        <p className="tabular-nums text-muted-foreground">
          Ventas: {numberFmt.format(datum.secondary)}
        </p>
      )}
    </div>
  );
}

export function ReportChart({
  data,
  types,
  type,
  onTypeChange,
  valueFormat = "currency",
  valueName = "Total",
  height = 240,
}: ReportChartProps) {
  const gradientId = useId().replace(/:/g, "");

  // Compacta etiquetas largas (clientes/productos) para que el eje no explote.
  const ticks = useMemo(
    () =>
      data.map((d) => ({
        ...d,
        short: d.label.length > 14 ? `${d.label.slice(0, 13)}…` : d.label,
      })),
    [data],
  );

  const axisProps = {
    stroke: "var(--muted-foreground)",
    tick: { fontSize: 11, fill: "var(--muted-foreground)" },
    tickLine: false,
    axisLine: { stroke: "var(--border)" },
  } as const;

  const yTickFmt = (v: number) =>
    valueFormat === "currency"
      ? v >= 1000
        ? `${Math.round(v / 1000)}k`
        : String(v)
      : numberFmt.format(v);

  const tooltip = (
    <Tooltip
      cursor={{ fill: "var(--muted)", opacity: 0.4 }}
      content={
        <ChartTooltip valueFormat={valueFormat} valueName={valueName} />
      }
    />
  );

  function renderChart() {
    switch (type) {
      case "line":
        return (
          <LineChart data={ticks} margin={{ top: 8, right: 12, left: 0, bottom: 0 }}>
            <CartesianGrid strokeDasharray="3 3" stroke="var(--border)" vertical={false} />
            <XAxis dataKey="short" {...axisProps} interval="preserveStartEnd" />
            <YAxis {...axisProps} width={44} tickFormatter={yTickFmt} />
            {tooltip}
            <Line
              type="monotone"
              dataKey="value"
              name={valueName}
              stroke={FLAME}
              strokeWidth={2.5}
              dot={{ r: 3, fill: FLAME, strokeWidth: 0 }}
              activeDot={{ r: 5 }}
            />
          </LineChart>
        );
      case "area":
        return (
          <AreaChart data={ticks} margin={{ top: 8, right: 12, left: 0, bottom: 0 }}>
            <defs>
              <linearGradient id={`area-${gradientId}`} x1="0" y1="0" x2="0" y2="1">
                <stop offset="0%" stopColor={FLAME} stopOpacity={0.5} />
                <stop offset="100%" stopColor={FLAME} stopOpacity={0.02} />
              </linearGradient>
            </defs>
            <CartesianGrid strokeDasharray="3 3" stroke="var(--border)" vertical={false} />
            <XAxis dataKey="short" {...axisProps} interval="preserveStartEnd" />
            <YAxis {...axisProps} width={44} tickFormatter={yTickFmt} />
            {tooltip}
            <Area
              type="monotone"
              dataKey="value"
              name={valueName}
              stroke={FLAME}
              strokeWidth={2.5}
              fill={`url(#area-${gradientId})`}
            />
          </AreaChart>
        );
      case "pie":
        return (
          <PieChart margin={{ top: 4, right: 4, left: 4, bottom: 4 }}>
            {tooltip}
            <Legend
              wrapperStyle={{ fontSize: 11, color: "var(--muted-foreground)" }}
              formatter={(v) => <span className="text-muted-foreground">{v}</span>}
            />
            <Pie
              data={ticks}
              dataKey="value"
              nameKey="short"
              cx="50%"
              cy="50%"
              outerRadius="78%"
              innerRadius="48%"
              paddingAngle={2}
              stroke="var(--card)"
              strokeWidth={2}
            >
              {ticks.map((_, i) => (
                <Cell key={i} fill={PIE_PALETTE[i % PIE_PALETTE.length]} />
              ))}
            </Pie>
          </PieChart>
        );
      case "bar":
      default:
        return (
          <BarChart data={ticks} margin={{ top: 8, right: 12, left: 0, bottom: 0 }}>
            <defs>
              <linearGradient id={`bar-${gradientId}`} x1="0" y1="0" x2="0" y2="1">
                <stop offset="0%" stopColor="#FF8A1F" />
                <stop offset="100%" stopColor={FLAME} />
              </linearGradient>
            </defs>
            <CartesianGrid strokeDasharray="3 3" stroke="var(--border)" vertical={false} />
            <XAxis dataKey="short" {...axisProps} interval={0} angle={data.length > 6 ? -25 : 0} textAnchor={data.length > 6 ? "end" : "middle"} height={data.length > 6 ? 52 : 30} />
            <YAxis {...axisProps} width={44} tickFormatter={yTickFmt} />
            {tooltip}
            <Bar
              dataKey="value"
              name={valueName}
              fill={`url(#bar-${gradientId})`}
              radius={[4, 4, 0, 0]}
              maxBarSize={56}
            />
          </BarChart>
        );
    }
  }

  return (
    <div>
      {types.length > 1 && (
        <div className="mb-3 flex justify-end">
          <Segmented
            value={type}
            onChange={(t) => onTypeChange(t as ChartType)}
            options={types.map((t) => ({ value: t, label: TYPE_LABELS[t] }))}
          />
        </div>
      )}
      {data.length === 0 ? (
        <div
          className="flex items-center justify-center text-sm text-muted-foreground"
          style={{ height }}
        >
          Sin datos para graficar.
        </div>
      ) : (
        <ResponsiveContainer width="100%" height={height}>
          {renderChart()}
        </ResponsiveContainer>
      )}
    </div>
  );
}
