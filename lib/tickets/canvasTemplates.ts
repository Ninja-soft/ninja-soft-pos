// H9b PR4/PR5 — Modelos precargados para el modo "canvas" del ticket.
// Coordenadas en px (modelo v2) sobre el lienzo de ancho fijo por papel
// (CANVAS_WIDTH: 58→220, 80→300, a4→794). Cada entrada arma sus elementos con
// newCanvasElement(type) + overrides e imprime su identidad visual (color/bg/
// fontSize) para que el picker muestre miniaturas distintas. PR5-2.

import { newCanvasElement, type CanvasContent } from "@/lib/tickets/blocks";

export interface CanvasStarterTemplate {
  key: string;
  name: string;
  description: string;
  paper: "58" | "80" | "a4";
  kind: "sale" | "promo" | "gift";
  canvas: CanvasContent["canvas"];
}

export const CANVAS_STARTER_TEMPLATES: CanvasStarterTemplate[] = [
  {
    // Sobrio mono, gris de tema. Logo, negocio, ítems, QR y pie.
    key: "clasico",
    name: "Clásico",
    description: "Sobrio y mono: logo, datos del negocio, ítems y QR al pie.",
    paper: "80",
    kind: "sale",
    canvas: {
      height: 300,
      elements: [
        { ...newCanvasElement("logo"), x: 90, y: 10, w: 120, h: 50 },
        { ...newCanvasElement("text"), x: 10, y: 70, w: 280, text: "Mi negocio", bold: true, align: "center", font: "mono" },
        { ...newCanvasElement("items"), x: 0, y: 110, w: 300 },
        { ...newCanvasElement("qr"), x: 90, y: 200, w: 120, h: 120 },
        { ...newCanvasElement("text"), x: 10, y: 270, w: 280, text: "¡Gracias por su compra!", align: "center", font: "mono" },
      ],
    },
  },
  {
    // Encabezado oscuro full-width con acentos flame (#f97316), tipografía sans.
    key: "moderno-dark",
    name: "Moderno oscuro",
    description: "Encabezado oscuro full-width con acentos naranjas y tipografía sans.",
    paper: "80",
    kind: "sale",
    canvas: {
      height: 320,
      elements: [
        { ...newCanvasElement("text"), x: 0, y: 0, w: 300, h: 64, text: "MI NEGOCIO", bold: true, align: "center", font: "sans", bg: "#111827", color: "#f97316", fontSize: 22 },
        { ...newCanvasElement("text"), x: 10, y: 76, w: 280, text: "Ticket de venta", align: "center", font: "sans", color: "#6b7280" },
        { ...newCanvasElement("items"), x: 0, y: 110, w: 300 },
        { ...newCanvasElement("separator"), x: 10, y: 230, w: 280, h: 8, color: "#f97316" },
        { ...newCanvasElement("text"), x: 10, y: 250, w: 280, text: "¡Gracias!", bold: true, align: "center", font: "sans", color: "#f97316" },
      ],
    },
  },
  {
    // Volante rojo/amarillo: banda roja, imagen grande, oferta destacada.
    key: "promo-flyer",
    name: "Volante promo",
    description: "Flyer rojo y amarillo: banda con título, imagen grande y oferta.",
    paper: "80",
    kind: "promo",
    canvas: {
      height: 400,
      elements: [
        { ...newCanvasElement("text"), x: 0, y: 0, w: 300, h: 60, text: "¡PROMO!", bold: true, align: "center", font: "sans", bg: "#dc2626", color: "#ffffff", fontSize: 30 },
        { ...newCanvasElement("image"), x: 20, y: 72, w: 260, h: 150, url: "" },
        { ...newCanvasElement("text"), x: 10, y: 232, w: 280, h: 36, text: "2x1 todos los miércoles", bold: true, align: "center", font: "sans", bg: "#fef3c7", color: "#92400e", fontSize: 16 },
        { ...newCanvasElement("text"), x: 10, y: 290, w: 280, text: "Aprovechá las ofertas de la semana", align: "center", font: "sans" },
        { ...newCanvasElement("text"), x: 10, y: 350, w: 280, text: "Mi negocio", bold: true, align: "center", font: "sans", color: "#dc2626" },
      ],
    },
  },
  {
    // Gift card oscura + dorado: panel negro con marco dorado y datos para completar.
    key: "gift-card",
    name: "Gift card",
    description: "Vale oscuro con detalles dorados y datos del destinatario.",
    paper: "80",
    kind: "gift",
    canvas: {
      height: 320,
      elements: [
        { ...newCanvasElement("text"), x: 0, y: 0, w: 300, h: 320, text: "", bg: "#111827" },
        { ...newCanvasElement("text"), x: 10, y: 30, w: 280, text: "VALE DE REGALO", bold: true, align: "center", font: "serif", color: "#d4af37", fontSize: 22 },
        { ...newCanvasElement("separator"), x: 40, y: 78, w: 220, h: 8, color: "#d4af37" },
        { ...newCanvasElement("text"), x: 10, y: 110, w: 280, text: "Monto: $ ________", bold: true, align: "center", color: "#f9fafb" },
        { ...newCanvasElement("text"), x: 40, y: 160, w: 220, text: "Para: ____________\nDe: ____________", align: "left", color: "#f9fafb" },
        { ...newCanvasElement("separator"), x: 40, y: 250, w: 220, h: 8, color: "#d4af37" },
        { ...newCanvasElement("text"), x: 10, y: 275, w: 280, text: "Mi negocio", bold: true, align: "center", font: "serif", color: "#d4af37" },
      ],
    },
  },
  {
    // Cartel A4: tipografía gigante sans, alto contraste, imagen grande.
    key: "cartel-a4",
    name: "Cartel A4",
    description: "Cartel A4 de tipografía gigante y alto contraste con imagen grande.",
    paper: "a4",
    kind: "promo",
    canvas: {
      height: 700,
      elements: [
        { ...newCanvasElement("text"), x: 0, y: 0, w: 794, h: 130, text: "¡OFERTA!", bold: true, align: "center", font: "sans", bg: "#111827", color: "#f97316", fontSize: 80 },
        { ...newCanvasElement("image"), x: 80, y: 160, w: 634, h: 380, url: "" },
        { ...newCanvasElement("text"), x: 40, y: 560, w: 714, h: 56, text: "Hasta 50% OFF", bold: true, align: "center", font: "sans", color: "#dc2626", fontSize: 40 },
        { ...newCanvasElement("text"), x: 40, y: 640, w: 714, text: "Mi negocio", align: "center", font: "sans", fontSize: 20 },
      ],
    },
  },
];
