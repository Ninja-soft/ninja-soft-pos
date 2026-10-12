// Registro mínimo de ECharts (tree-shaking): sólo los tipos de gráfico y
// componentes que usa la app. Este módulo se importa SIEMPRE de forma dinámica
// desde EChart.tsx, así queda en un chunk aparte y no pesa en el primer render.
import * as echarts from "echarts/core";
import { BarChart, HeatmapChart, LineChart, PieChart, TreemapChart } from "echarts/charts";
import {
  DataZoomComponent,
  GridComponent,
  LegendComponent,
  MarkLineComponent,
  TitleComponent,
  TooltipComponent,
  VisualMapComponent,
} from "echarts/components";
import { CanvasRenderer } from "echarts/renderers";

echarts.use([
  BarChart,
  LineChart,
  PieChart,
  HeatmapChart,
  TreemapChart,
  GridComponent,
  TooltipComponent,
  LegendComponent,
  DataZoomComponent,
  VisualMapComponent,
  MarkLineComponent,
  TitleComponent,
  CanvasRenderer,
]);

export { echarts };
