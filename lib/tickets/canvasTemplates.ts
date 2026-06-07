// H9b PR4 — Modelos precargados para el modo "canvas" del ticket.
// Cada entrada arma sus elementos con newCanvasElement(type) + overrides.
// Espeja la forma de HTML_STARTER_TEMPLATES (ver lib/tickets/htmlTemplates.ts).

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
        { ...newCanvasElement("logo"), x: 30, y: 10, w: 40 },
        { ...newCanvasElement("text"), x: 5, y: 70, w: 90, text: "Mi negocio", bold: true, align: "center" },
        { ...newCanvasElement("items"), x: 0, y: 110, w: 100 },
        { ...newCanvasElement("qr"), x: 35, y: 200, w: 30 },
        { ...newCanvasElement("text"), x: 5, y: 260, w: 90, text: "¡Gracias por su compra!", align: "center" },
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
        { ...newCanvasElement("text"), x: 5, y: 10, w: 90, text: "Mi negocio", bold: true, align: "center" },
        { ...newCanvasElement("items"), x: 0, y: 50, w: 100 },
        { ...newCanvasElement("barcode"), x: 15, y: 230, w: 70 },
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
        { ...newCanvasElement("text"), x: 5, y: 20, w: 90, text: "¡PROMO!", size: "lg", bold: true, align: "center" },
        { ...newCanvasElement("image"), x: 5, y: 70, w: 90, url: "" },
        { ...newCanvasElement("text"), x: 5, y: 220, w: 90, text: "Descripción de la oferta…", align: "center" },
        { ...newCanvasElement("text"), x: 5, y: 330, w: 90, text: "Mi negocio", bold: true, align: "center" },
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
        { ...newCanvasElement("text"), x: 5, y: 30, w: 90, text: "VALE DE REGALO", size: "lg", bold: true, align: "center" },
        { ...newCanvasElement("separator"), x: 10, y: 80, w: 80 },
        { ...newCanvasElement("text"), x: 5, y: 120, w: 90, text: "Monto: $ ________", align: "center" },
        { ...newCanvasElement("text"), x: 10, y: 170, w: 80, text: "Para: ____________\nDe: ____________", align: "left" },
        { ...newCanvasElement("text"), x: 5, y: 260, w: 90, text: "Mi negocio", bold: true, align: "center" },
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
        { ...newCanvasElement("text"), x: 5, y: 40, w: 90, text: "¡OFERTA!", size: "lg", bold: true, align: "center" },
        { ...newCanvasElement("image"), x: 10, y: 120, w: 80, url: "" },
        { ...newCanvasElement("text"), x: 5, y: 560, w: 90, text: "Mi negocio", align: "center" },
      ],
    },
  },
];
