import { describe, it, expect, vi } from "vitest";
import {
  batchResultText,
  chunk,
  pruneSelection,
  runInBatches,
  selectionState,
  selectionTotals,
  setIds,
  toggleGroup,
} from "@/lib/reports/selection";

describe("selección múltiple", () => {
  it("setIds prende y apaga sin mutar la selección original", () => {
    const a = new Set(["1"]);
    const b = setIds(a, ["2", "3"], true);
    expect([...b].sort()).toEqual(["1", "2", "3"]);
    expect([...a]).toEqual(["1"]);
    expect([...setIds(b, ["1", "3"], false)]).toEqual(["2"]);
  });

  it("selectionState da todos, algunos o ninguno", () => {
    const s = new Set(["1", "2"]);
    expect(selectionState(s, ["1", "2"])).toBe("all");
    expect(selectionState(s, ["1", "9"])).toBe("some");
    expect(selectionState(s, ["8", "9"])).toBe("none");
    expect(selectionState(s, [])).toBe("none");
  });

  it("toggleGroup completa un grupo a medias y vacía uno completo", () => {
    const s = new Set(["1"]);
    const full = toggleGroup(s, ["1", "2"]);
    expect([...full].sort()).toEqual(["1", "2"]);
    expect([...toggleGroup(full, ["1", "2"])]).toEqual([]);
  });

  it("pruneSelection deja sólo lo visible y no cambia la referencia si no hace falta", () => {
    const s = new Set(["1", "2"]);
    expect(pruneSelection(s, ["1", "2", "3"])).toBe(s);
    expect([...pruneSelection(s, ["2"])]).toEqual(["2"]);
  });

  it("selectionTotals suma cantidad y monto de lo elegido", () => {
    const items = [
      { id: "a", amount: 100.1 },
      { id: "b", amount: 200.2 },
      { id: "c", amount: 5 },
    ];
    expect(selectionTotals(items, new Set(["a", "b"]), (i) => i.id, (i) => i.amount)).toEqual({ count: 2, amount: 300.3 });
  });
});

describe("acciones en lote", () => {
  it("chunk parte en tandas", () => {
    expect(chunk([1, 2, 3, 4, 5], 2)).toEqual([[1, 2], [3, 4], [5]]);
    expect(chunk([], 3)).toEqual([]);
    expect(chunk([1], 0)).toEqual([[1]]);
  });

  it("runInBatches corre todas las tandas, informa avance y junta los errores sin cortar", async () => {
    const seen: number[][] = [];
    const progress = vi.fn();
    const r = await runInBatches(
      [1, 2, 3, 4, 5],
      2,
      async (batch) => {
        seen.push(batch);
        if (batch.includes(3)) throw new Error("forbidden");
      },
      { onProgress: progress },
    );
    expect(seen).toEqual([[1, 2], [3, 4], [5]]);
    expect(r).toMatchObject({ total: 5, done: 3, failedCount: 2 });
    expect(r.failed[0]!.items).toEqual([3, 4]);
    expect((r.failed[0]!.error as Error).message).toBe("forbidden");
    expect(progress).toHaveBeenLastCalledWith(5, 5);
    expect(progress).toHaveBeenCalledTimes(3);
  });

  it("respeta la concurrencia pedida", async () => {
    let running = 0;
    let peak = 0;
    const r = await runInBatches(
      Array.from({ length: 10 }, (_, i) => i),
      1,
      async () => {
        running++;
        peak = Math.max(peak, running);
        await new Promise((res) => setTimeout(res, 2));
        running--;
      },
      { concurrency: 3 },
    );
    expect(r.done).toBe(10);
    expect(peak).toBeLessThanOrEqual(3);
    expect(peak).toBeGreaterThan(1);
  });

  it("con la lista vacía no llama al worker", async () => {
    const worker = vi.fn();
    const r = await runInBatches([], 10, worker);
    expect(worker).not.toHaveBeenCalled();
    expect(r).toMatchObject({ total: 0, done: 0, failedCount: 0 });
  });

  it("batchResultText arma la frase del resultado", () => {
    const noun = { one: "cobro", many: "cobros" };
    const verb = { done: "Conciliados", partial: "Se conciliaron" };
    expect(batchResultText({ total: 3, done: 3, failedCount: 0 }, noun, verb)).toBe("Conciliados: 3 cobros.");
    expect(batchResultText({ total: 1, done: 1, failedCount: 0 }, noun, verb)).toBe("Conciliados: 1 cobro.");
    expect(batchResultText({ total: 5, done: 3, failedCount: 2 }, noun, verb)).toBe(
      "Se conciliaron 3 de 5 cobros. 2 no se pudieron guardar.",
    );
    expect(batchResultText({ total: 2, done: 0, failedCount: 2 }, noun, verb)).toBe("No se pudo: 2 cobros sin cambios.");
  });
});
