// H9b PR5 — Back-compat del modelo canvas v1 (% del ancho) → v2 (px).
// v1: x/w eran porcentajes del ancho del papel (0-100), sin alto (h ausente).
// v2: x/y/w/h en px sobre un lienzo de ancho fijo por papel (CANVAS_WIDTH).
//
// Se aplica al cargar contenido tanto en el renderer como en el editor. Es
// idempotente: contenido ya v2 se devuelve tal cual.
import { CANVAS_WIDTH, type CanvasContent } from "@/lib/tickets/blocks";

type Canvas = CanvasContent["canvas"];

// Heurística de detección de v1: todos los elementos tienen w <= 100 y x <= 100
// y ninguno define h. En v2 los anchos en px superan 100 (CANVAS_WIDTH mínimo
// es 220), o algún elemento trae h definido.
function isLegacyV1(canvas: Canvas): boolean {
  const els = canvas.elements;
  if (els.length === 0) return false; // nada que convertir; ya es válido v2
  return els.every((e) => e.w <= 100 && e.x <= 100 && e.h === undefined);
}

export function upgradeCanvas(
  canvas: Canvas,
  paper: "58" | "80" | "a4",
): Canvas {
  if (!isLegacyV1(canvas)) return clampCanvas(canvas, paper);

  const width = CANVAS_WIDTH[paper];
  return clampCanvas(
    {
      ...canvas,
      elements: canvas.elements.map((e) => ({
        ...e,
        x: Math.round((e.x / 100) * width),
        w: Math.round((e.w / 100) * width),
        // y se mantiene (ya estaba en px en v1), h queda auto (undefined).
      })),
    },
    paper,
  );
}

/**
 * Mantiene cada elemento dentro del papel (ancho fijo CANVAS_WIDTH[paper]) para
 * que nada se pinte fuera de la hoja blanca:
 *  - x ∈ [0, width-24]; y ≥ 0; w ≤ width (mínimo 24).
 *  - el lienzo crece (height) para contener el elemento más bajo (maxY + 40),
 *    sin reducir el alto explícito ya guardado.
 * El elemento "items" no se acota en x/w (marca el punto de corte de flujo).
 */
export function clampCanvas(canvas: Canvas, paper: "58" | "80" | "a4"): Canvas {
  const width = CANVAS_WIDTH[paper];
  let maxY = 0;
  const elements = canvas.elements.map((e) => {
    const y = Math.max(0, Math.round(e.y));
    if (e.type === "items") {
      maxY = Math.max(maxY, y);
      return { ...e, y, x: 0, w: width };
    }
    const w = Math.min(Math.max(24, Math.round(e.w)), width);
    const x = Math.min(Math.max(0, Math.round(e.x)), Math.max(0, width - 24));
    const bottom = y + (typeof e.h === "number" ? e.h : 24);
    maxY = Math.max(maxY, bottom);
    return { ...e, x, y, w };
  });
  return {
    elements,
    height: Math.max(canvas.height || 0, maxY + 40, 120),
  };
}
