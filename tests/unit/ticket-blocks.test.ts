import { describe, expect, it } from "vitest";
import { defaultSaleBlocks, newBlock, BLOCK_LABELS } from "@/lib/tickets/blocks";

describe("ticket blocks", () => {
  it("defaultSaleBlocks replica el ticket actual (orden y tipos)", () => {
    const types = defaultSaleBlocks().map((b) => b.type);
    expect(types).toEqual([
      "logo", "business", "title", "separator", "saleInfo", "separator",
      "items", "separator", "totals", "separator", "payments", "qr", "footer",
    ]);
  });
  it("cada bloque default tiene id único", () => {
    const ids = defaultSaleBlocks().map((b) => b.id);
    expect(new Set(ids).size).toBe(ids.length);
  });
  it("newBlock crea bloque con defaults por tipo", () => {
    const b = newBlock("text");
    expect(b.type).toBe("text");
    expect(b.id).toBeTruthy();
    if (b.type === "text") expect(b.text).toBe("Texto");
  });
  it("hay label para cada tipo", () => {
    for (const t of Object.keys(BLOCK_LABELS)) expect(BLOCK_LABELS[t as keyof typeof BLOCK_LABELS]).toBeTruthy();
  });
});
