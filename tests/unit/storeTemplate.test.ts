import { describe, expect, it } from "vitest";
import {
  copyResultMessage,
  defaultParts,
  normalizeParts,
  partsFor,
  templateSummary,
} from "@/lib/branches/storeTemplate";

describe("plantilla de sucursal (ADR-057)", () => {
  it("heredar todo no copia nada", () => {
    expect(partsFor("inherit")).toEqual([]);
    expect(defaultParts("inherit")).toEqual([]);
  });

  it("desde otra sucursal: todo marcado menos el personal, que es opcional", () => {
    expect(partsFor("store").map((p) => p.key)).toEqual(["config", "payment_methods", "printers", "plans", "staff"]);
    expect(defaultParts("store")).toEqual(["config", "payment_methods", "printers", "plans"]);
  });

  it("desde una plantilla: nunca personal y sólo lo que la plantilla guardó", () => {
    expect(partsFor("template").map((p) => p.key)).not.toContain("staff");
    expect(defaultParts("template", ["config", "plans"])).toEqual(["config", "plans"]);
  });

  it("normaliza el pedido: orden canónico, sin inválidos ni partes fuera del origen", () => {
    expect(normalizeParts(["plans", "staff", "config", "nada", "plans"], "store")).toEqual(["config", "plans", "staff"]);
    expect(normalizeParts(["staff", "printers"], "template", ["config", "printers"])).toEqual(["printers"]);
    expect(normalizeParts(["config"], "inherit")).toEqual([]);
  });

  it("resume lo que trae una plantilla", () => {
    expect(
      templateSummary({
        overrides: [
          { domain: "pos_settings", domain_key: "", patch: { rounding_multiple: 10 } },
          { domain: "ticket", domain_key: "", patch: { ticket_footer: "Gracias" } },
          { domain: "payment_method", domain_key: "payway", patch: { surcharge_pct: 5 } },
        ],
        printers: [{}],
        plans: [{}, {}],
      }),
    ).toEqual({ config: 2, paymentMethods: 1, printers: 1, plans: 2 });
    expect(templateSummary(null)).toEqual({ config: 0, paymentMethods: 0, printers: 0, plans: 0 });
  });

  it("explica el resultado de la copia", () => {
    expect(copyResultMessage({ overrides: 2, printers: 1, plans: 1, staff: 0 })).toBe(
      "Se copiaron 2 ajustes, 1 impresora, 1 plan.",
    );
    expect(copyResultMessage({})).toMatch(/hereda todo/);
    expect(copyResultMessage({ staff: 3, skipped: 1 })).toBe(
      "Se copiaron 3 personas. 1 item no se pudo copiar (fuera del plan o ya existentes).",
    );
  });
});
