// Tokens de gráficos derivados del tema activo (ninja-dark / ninja-noir /
// ninja-light / ninja-sand). ECharts dibuja en canvas y no entiende CSS vars,
// así que se leen del elemento contenedor con getComputedStyle y se resuelven
// a colores concretos. Sin dependencias de echarts: es importable en tests.

export interface ChartTheme {
  isDark: boolean;
  foreground: string;
  muted: string; // texto secundario (ejes, leyendas)
  border: string; // líneas de grilla / ejes
  surface: string; // fondo sobre el que se dibuja (para separadores 2px)
  tooltipBg: string;
  tooltipFg: string;
  primary: string;
  /** Paleta categórica en orden fijo (validada CVD para cada modo). */
  palette: string[];
  /** Escala secuencial de un solo tono (heatmap), de "casi cero" a máximo. */
  sequential: string[];
  /** Serie de comparación (período anterior): neutra, nunca categórica. */
  comparison: string;
  positive: string;
  negative: string;
  fontFamily: string;
}

// Orden fijo de la paleta categórica: flame, violeta, teal, oro, magenta, azul.
// Validada con el validador de dataviz (banda de luminancia OKLCH, croma,
// separación CVD adyacente >= 8, contraste >= 3:1) contra la superficie de cada modo.
export const PALETTE_DARK = ["#F0561E", "#7B5CFF", "#16A08C", "#B8890E", "#E0457A", "#3A86E8"];
export const PALETTE_LIGHT = ["#E8431B", "#6A4BE8", "#0F8C78", "#B07D00", "#C93670", "#2F74D0"];

const FALLBACK_DARK = {
  foreground: "#f4f2ff",
  muted: "#a99fd0",
  border: "rgba(255, 255, 255, 0.1)",
  surface: "#160f30",
  tooltipBg: "#15103a",
  tooltipFg: "#f4f2ff",
  primary: "#ff5a2c",
};

function read(style: CSSStyleDeclaration | null, name: string, fallback: string) {
  const v = style?.getPropertyValue(name).trim();
  return v ? v : fallback;
}

/** Superficie opaca aproximada: las cards oscuras son translúcidas (rgba). */
function opaqueSurface(card: string, background: string) {
  return card.startsWith("rgba") ? background : card;
}

export function readChartTheme(el?: Element | null): ChartTheme {
  const style =
    typeof window !== "undefined" && el ? window.getComputedStyle(el) : null;
  const scheme = style?.getPropertyValue("color-scheme").trim() ?? "dark";
  const isDark = !scheme.includes("light");
  const fb = FALLBACK_DARK;
  const background = read(style, "--background", isDark ? "#0a0518" : "#ffffff");
  const card = read(style, "--card", isDark ? fb.surface : "#ffffff");
  const surface = opaqueSurface(card, background);
  const primary = read(style, "--primary", fb.primary);

  return {
    isDark,
    foreground: read(style, "--foreground", fb.foreground),
    muted: read(style, "--muted-foreground", fb.muted),
    border: read(style, "--border", fb.border),
    surface,
    tooltipBg: read(style, "--popover", fb.tooltipBg),
    tooltipFg: read(style, "--popover-foreground", fb.tooltipFg),
    primary,
    palette: isDark ? PALETTE_DARK : PALETTE_LIGHT,
    sequential: isDark
      ? ["rgba(240, 86, 30, 0.08)", "#5a2416", "#a83b17", "#F0561E", "#FFB088"]
      : ["#FFF3EC", "#FFD2BB", "#FF9E73", "#E8431B", "#9E2A0C"],
    comparison: isDark ? "rgba(185, 176, 220, 0.55)" : "rgba(92, 84, 120, 0.5)",
    positive: isDark ? "#16A08C" : "#0F8C78",
    negative: isDark ? "#E0457A" : "#C93670",
    fontFamily:
      read(style, "font-family", "") || "Inter, system-ui, -apple-system, sans-serif",
  };
}

// ── Formato es-AR ──────────────────────────────────────────────────────────

const ars = new Intl.NumberFormat("es-AR", {
  style: "currency",
  currency: "ARS",
  maximumFractionDigits: 0,
});
const num = new Intl.NumberFormat("es-AR", { maximumFractionDigits: 1 });
const compact = new Intl.NumberFormat("es-AR", {
  notation: "compact",
  maximumFractionDigits: 1,
});

export type ValueFormat = "currency" | "number" | "minutes";

/** Valor completo para tooltips y tablas. */
export function formatChartValue(v: number, mode: ValueFormat): string {
  if (mode === "currency") return ars.format(v);
  if (mode === "minutes") return `${num.format(v)} min`;
  return num.format(v);
}

/** Valor compacto para ejes ("$ 1,2 M", "15 mil"). */
export function formatAxisValue(v: number, mode: ValueFormat): string {
  if (mode === "currency") return `$ ${compact.format(v)}`;
  if (mode === "minutes") return `${num.format(v)}`;
  return compact.format(v);
}

/** Porcentaje de variación entre dos valores; null si no hay base. */
export function deltaPct(current: number, previous: number | null | undefined): number | null {
  if (previous == null || !Number.isFinite(previous) || previous === 0) return null;
  return ((current - previous) / Math.abs(previous)) * 100;
}

export function formatDelta(pct: number): string {
  const sign = pct > 0 ? "+" : pct < 0 ? "−" : "";
  return `${sign}${num.format(Math.abs(pct))}%`;
}

/** Recorta etiquetas largas sin romper palabras cortas. */
export function truncateLabel(label: string, max = 16): string {
  return label.length > max ? `${label.slice(0, max - 1).trimEnd()}…` : label;
}
