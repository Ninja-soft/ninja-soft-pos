import { code39Segments } from "@/lib/barcode/code39";

// Renderiza un código de barras Code 39 como SVG (negro sobre transparente).
// height en px; el ancho se calcula por la cantidad de módulos.
export function Barcode({
  value,
  height = 40,
  module = 1.4,
  className,
}: {
  value: string;
  height?: number;
  module?: number; // ancho en px de un módulo angosto
  className?: string;
}) {
  let segs;
  try {
    segs = code39Segments(value);
  } catch {
    return null;
  }
  const totalModules = segs.reduce((acc, s) => acc + s.width, 0);
  const width = totalModules * module;

  let x = 0;
  const bars: { x: number; w: number }[] = [];
  for (const s of segs) {
    if (s.on) bars.push({ x, w: s.width * module });
    x += s.width * module;
  }

  return (
    <svg
      className={className}
      width={width}
      height={height}
      viewBox={`0 0 ${width} ${height}`}
      preserveAspectRatio="none"
      role="img"
      aria-label={`Código ${value}`}
    >
      {bars.map((b, i) => (
        <rect key={i} x={b.x} y={0} width={b.w} height={height} fill="#000" />
      ))}
    </svg>
  );
}
