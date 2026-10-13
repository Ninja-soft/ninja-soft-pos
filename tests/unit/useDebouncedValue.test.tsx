// Test de hook de React (F0: "al menos un test por capa").
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, renderHook } from "@testing-library/react";
import { useDebouncedValue } from "@/hooks/useDebouncedValue";

describe("useDebouncedValue", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it("entrega el valor inicial de una y los cambios después del retraso", () => {
    const { result, rerender } = renderHook(({ v }) => useDebouncedValue(v, 300), { initialProps: { v: "a" } });
    expect(result.current).toBe("a");
    rerender({ v: "ab" });
    act(() => vi.advanceTimersByTime(299));
    expect(result.current).toBe("a");
    act(() => vi.advanceTimersByTime(1));
    expect(result.current).toBe("ab");
  });

  it("cada tecla reinicia la espera: sólo llega el último valor", () => {
    const { result, rerender } = renderHook(({ v }) => useDebouncedValue(v, 300), { initialProps: { v: "" } });
    for (const v of ["c", "co", "coc"]) {
      rerender({ v });
      act(() => vi.advanceTimersByTime(200));
    }
    expect(result.current).toBe("");
    act(() => vi.advanceTimersByTime(300));
    expect(result.current).toBe("coc");
  });
});
