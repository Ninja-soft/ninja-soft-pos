// H9b PR4/PR5/PR6 — Modelos precargados para el modo "canvas" del ticket.
// Coordenadas en px (modelo v2) sobre el lienzo de ancho fijo por papel
// (CANVAS_WIDTH: 58→220, 80→300, a4→794). Cada entrada imprime la IDENTIDAD
// NINJAPOS (paleta ninja: void/violet oscuros, flame, dorado) e incluye logo +
// QR movibles en los modelos de venta. Feedback de usuario (PR6): las plantillas
// de canvas deben mostrar logo y QR para mover, y reflejar la marca NinjaPos.

import { newCanvasElement, type CanvasContent } from "@/lib/tickets/blocks";

export interface CanvasStarterTemplate {
  key: string;
  name: string;
  description: string;
  paper: "58" | "80" | "a4";
  kind: "sale" | "promo" | "gift";
  canvas: CanvasContent["canvas"];
}

// Paleta NinjaPos (ver tailwind.config.ts → colors.ninja).
const NINJA = {
  flame: "#FF4B22",
  flameSoft: "#FF6A1A",
  gold: "#FFD21F",
  void: "#09051C",
  deepViolet: "#140D35",
  softWhite: "#F7F7FF",
} as const;

export const CANVAS_STARTER_TEMPLATES: CanvasStarterTemplate[] = [
  {
    // Clásico NinjaPos: logo arriba, título flame, ítems, QR al pie. Venta.
    key: "clasico",
    name: "Clásico Ninja",
    description: "Logo, negocio, ítems y QR movibles con acentos flame.",
    paper: "80",
    kind: "sale",
    canvas: {
      height: 360,
      elements: [
        { ...newCanvasElement("logo"), x: 90, y: 10, w: 120, h: 50 },
        { ...newCanvasElement("text"), x: 10, y: 70, w: 280, text: "Mi negocio", bold: true, align: "center", font: "mono", color: NINJA.flame, fontSize: 16 },
        { ...newCanvasElement("separator"), x: 20, y: 100, w: 260, h: 8, color: NINJA.flame },
        { ...newCanvasElement("items"), x: 0, y: 128, w: 300 },
        { ...newCanvasElement("separator"), x: 20, y: 250, w: 260, h: 8, color: NINJA.flame },
        { ...newCanvasElement("qr"), x: 90, y: 268, w: 120, h: 120 },
        { ...newCanvasElement("text"), x: 10, y: 330, w: 280, text: "¡Gracias por su compra!", align: "center", font: "mono", color: NINJA.flame },
      ],
    },
  },
  {
    // Moderno oscuro: encabezado void full-width con logo + título flame, QR. Venta.
    key: "moderno-dark",
    name: "Moderno oscuro",
    description: "Encabezado oscuro NinjaPos con logo, acentos flame y QR.",
    paper: "80",
    kind: "sale",
    canvas: {
      height: 380,
      elements: [
        { ...newCanvasElement("text"), x: 0, y: 0, w: 300, h: 96, text: "", bg: NINJA.void },
        { ...newCanvasElement("logo"), x: 100, y: 10, w: 100, h: 44 },
        { ...newCanvasElement("text"), x: 0, y: 58, w: 300, text: "TICKET DE VENTA", bold: true, align: "center", font: "sans", color: NINJA.flameSoft, fontSize: 16 },
        { ...newCanvasElement("items"), x: 0, y: 110, w: 300 },
        { ...newCanvasElement("separator"), x: 10, y: 240, w: 280, h: 8, color: NINJA.gold },
        { ...newCanvasElement("qr"), x: 90, y: 258, w: 120, h: 120 },
        { ...newCanvasElement("text"), x: 10, y: 350, w: 280, text: "¡Gracias!", bold: true, align: "center", font: "sans", color: NINJA.flameSoft },
      ],
    },
  },
  {
    // Volante promo NinjaPos: banda flame, imagen grande, oferta dorada.
    key: "promo-flyer",
    name: "Volante Ninja",
    description: "Flyer flame y dorado: banda con título, imagen y oferta.",
    paper: "80",
    kind: "promo",
    canvas: {
      height: 400,
      elements: [
        { ...newCanvasElement("text"), x: 0, y: 0, w: 300, h: 60, text: "¡PROMO!", bold: true, align: "center", font: "sans", bg: NINJA.flame, color: NINJA.softWhite, fontSize: 30 },
        { ...newCanvasElement("image"), x: 20, y: 72, w: 260, h: 150, url: "" },
        { ...newCanvasElement("text"), x: 10, y: 232, w: 280, h: 36, text: "2x1 todos los miércoles", bold: true, align: "center", font: "sans", bg: NINJA.gold, color: NINJA.void, fontSize: 16 },
        { ...newCanvasElement("text"), x: 10, y: 290, w: 280, text: "Aprovechá las ofertas de la semana", align: "center", font: "sans" },
        { ...newCanvasElement("text"), x: 10, y: 350, w: 280, text: "Mi negocio", bold: true, align: "center", font: "sans", color: NINJA.flame },
      ],
    },
  },
  {
    // Gift card NinjaPos: panel void con marco dorado y datos para completar.
    key: "gift-card",
    name: "Gift card Ninja",
    description: "Vale oscuro NinjaPos con detalles dorados y destinatario.",
    paper: "80",
    kind: "gift",
    canvas: {
      height: 320,
      elements: [
        { ...newCanvasElement("text"), x: 0, y: 0, w: 300, h: 320, text: "", bg: NINJA.void },
        { ...newCanvasElement("text"), x: 10, y: 30, w: 280, text: "VALE DE REGALO", bold: true, align: "center", font: "serif", color: NINJA.gold, fontSize: 22 },
        { ...newCanvasElement("separator"), x: 40, y: 78, w: 220, h: 8, color: NINJA.gold },
        { ...newCanvasElement("text"), x: 10, y: 110, w: 280, text: "Monto: $ ________", bold: true, align: "center", color: NINJA.softWhite },
        { ...newCanvasElement("text"), x: 40, y: 160, w: 220, text: "Para: ____________\nDe: ____________", align: "left", color: NINJA.softWhite },
        { ...newCanvasElement("separator"), x: 40, y: 250, w: 220, h: 8, color: NINJA.gold },
        { ...newCanvasElement("text"), x: 10, y: 275, w: 280, text: "Mi negocio", bold: true, align: "center", font: "serif", color: NINJA.gold },
      ],
    },
  },
  {
    // Cartel A4 NinjaPos: tipografía gigante flame sobre void, imagen grande.
    key: "cartel-a4",
    name: "Cartel A4 Ninja",
    description: "Cartel A4 de tipografía gigante flame sobre fondo oscuro.",
    paper: "a4",
    kind: "promo",
    canvas: {
      height: 700,
      elements: [
        { ...newCanvasElement("text"), x: 0, y: 0, w: 794, h: 130, text: "¡OFERTA!", bold: true, align: "center", font: "sans", bg: NINJA.void, color: NINJA.flame, fontSize: 80 },
        { ...newCanvasElement("image"), x: 80, y: 160, w: 634, h: 380, url: "" },
        { ...newCanvasElement("text"), x: 40, y: 560, w: 714, h: 56, text: "Hasta 50% OFF", bold: true, align: "center", font: "sans", color: NINJA.flame, fontSize: 40 },
        { ...newCanvasElement("text"), x: 40, y: 640, w: 714, text: "Mi negocio", align: "center", font: "sans", fontSize: 20 },
      ],
    },
  },
];
