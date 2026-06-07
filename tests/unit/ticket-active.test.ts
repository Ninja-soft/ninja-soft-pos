import { describe, expect, it } from "vitest";
import { emailTemplateDiffers } from "@/modules/tickets/api";

// H9b PR3 — resolución de nodo para el PNG de email en TicketModal:
// reutilizar el ticket de impresión vs. renderizar uno propio (oculto).
describe("emailTemplateDiffers", () => {
  it("sin plantilla de email reutiliza la de impresión (false)", () => {
    expect(emailTemplateDiffers({ id: "p1" }, null)).toBe(false);
    expect(emailTemplateDiffers(null, undefined)).toBe(false);
  });

  it("misma plantilla en ambos destinos no difiere (false)", () => {
    expect(emailTemplateDiffers({ id: "same" }, { id: "same" })).toBe(false);
  });

  it("plantilla de email distinta difiere (true)", () => {
    expect(emailTemplateDiffers({ id: "print" }, { id: "email" })).toBe(true);
  });

  it("email activo sin plantilla de impresión difiere (true)", () => {
    expect(emailTemplateDiffers(null, { id: "email" })).toBe(true);
  });
});
