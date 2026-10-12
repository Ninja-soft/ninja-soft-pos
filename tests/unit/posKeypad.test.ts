import { describe, expect, it } from "vitest";
import { applyKey, keypadNumber } from "@/components/pos/ui/Keypad";

describe("teclado del POS", () => {
  it("arma montos con coma decimal y máximo dos decimales", () => {
    let v = "";
    for (const k of ["1", "2", ",", "5", "0", "9"] as const) v = applyKey(v, k);
    expect(v).toBe("12,50");
    expect(applyKey("12,50", "back")).toBe("12,5");
    expect(applyKey("", ",")).toBe("0,");
  });

  it("interpreta coma o punto como decimal y el punto como miles con coma", () => {
    expect(keypadNumber("1.234,5")).toBe(1234.5);
    expect(keypadNumber("1234.5")).toBe(1234.5);
    expect(keypadNumber("10000")).toBe(10000);
    expect(keypadNumber("abc")).toBe(0);
  });
});
