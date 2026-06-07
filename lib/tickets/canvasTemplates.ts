// H9b PR4/PR5 — Modelos precargados para el modo "canvas" del ticket.
// Coordenadas en px (modelo v2) sobre el lienzo de ancho fijo por papel
// (CANVAS_WIDTH: 58→220, 80→300, a4→794). Cada entrada arma sus elementos con
// newCanvasElement(type) + overrides. Espeja HTML_STARTER_TEMPLATES.

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
    key: "clasico",
    name: "Clásico",
    description: "Ticket de venta con logo, datos del negocio, ítems y QR al pie.",
    paper: "80",
    kind: "sale",
    canvas: {
      height: 300,
      elements: [
        { ...newCanvasElement("logo"), x: 90, y: 10, w: 120, h: 50 },
        { ...newCanvasElement("text"), x: 10, y: 70, w: 280, text: "Mi negocio", bold: true, align: "center" },
        { ...newCanvasElement("items"), x: 0, y: 110, w: 300 },
        { ...newCanvasElement("qr"), x: 90, y: 200, w: 120, h: 120 },
        { ...newCanvasElement("text"), x: 10, y: 270, w: 280, text: "¡Gracias por su compra!", align: "center" },
      ],
    },
  },
  {
    key: "compacto",
    name: "Compacto 58",
    description: "Layout reducido para 58 mm: negocio, ítems y código de barras.",
    paper: "58",
    kind: "sale",
    canvas: {
      height: 280,
      elements: [
        { ...newCanvasElement("text"), x: 10, y: 10, w: 200, text: "Mi negocio", bold: true, align: "center" },
        { ...newCanvasElement("items"), x: 0, y: 50, w: 220 },
        { ...newCanvasElement("barcode"), x: 20, y: 230, w: 180, h: 48 },
      ],
    },
  },
  {
    key: "promo-flyer",
    name: "Volante promo",
    description: "Flyer con título grande, imagen central y descripción de la oferta.",
    paper: "80",
    kind: "promo",
    canvas: {
      height: 380,
      elements: [
        { ...newCanvasElement("text"), x: 10, y: 20, w: 280, text: "¡PROMO!", size: "lg", bold: true, align: "center" },
        { ...newCanvasElement("image"), x: 20, y: 70, w: 260, h: 140, url: "" },
        { ...newCanvasElement("text"), x: 10, y: 220, w: 280, text: "Descripción de la oferta…", align: "center" },
        { ...newCanvasElement("text"), x: 10, y: 330, w: 280, text: "Mi negocio", bold: true, align: "center" },
      ],
    },
  },
  {
    key: "gift-card",
    name: "Gift card",
    description: "Vale de regalo con monto y datos del destinatario.",
    paper: "80",
    kind: "gift",
    canvas: {
      height: 300,
      elements: [
        { ...newCanvasElement("text"), x: 10, y: 30, w: 280, text: "VALE DE REGALO", size: "lg", bold: true, align: "center" },
        { ...newCanvasElement("separator"), x: 30, y: 80, w: 240, h: 8 },
        { ...newCanvasElement("text"), x: 10, y: 120, w: 280, text: "Monto: $ ________", align: "center" },
        { ...newCanvasElement("text"), x: 30, y: 170, w: 240, text: "Para: ____________\nDe: ____________", align: "left" },
        { ...newCanvasElement("text"), x: 10, y: 260, w: 280, text: "Mi negocio", bold: true, align: "center" },
      ],
    },
  },
  {
    key: "a4-cartel",
    name: "Cartel A4",
    description: "Cartel promocional en A4 con título, imagen grande y pie.",
    paper: "a4",
    kind: "promo",
    canvas: {
      height: 640,
      elements: [
        { ...newCanvasElement("text"), x: 40, y: 40, w: 714, text: "¡OFERTA!", size: "lg", bold: true, align: "center" },
        { ...newCanvasElement("image"), x: 80, y: 120, w: 634, h: 400, url: "" },
        { ...newCanvasElement("text"), x: 40, y: 560, w: 714, text: "Mi negocio", align: "center" },
      ],
    },
  },
];
