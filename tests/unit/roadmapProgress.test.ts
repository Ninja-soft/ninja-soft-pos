import { describe, it, expect } from "vitest";
import { countByPhase, renderTable, applyTable, isUpToDate } from "@/scripts/roadmap-progress.mjs";

const base = (table: string) => `# Roadmap

## F0 · Base
- [x] uno
- [ ] dos
### Entregables
- [~] tres

## F21 · Fase alta
- [x] cuatro

## Notas
- [ ] no cuenta

<!-- roadmap-progress:start -->
${table}
<!-- roadmap-progress:end -->
`;

describe("roadmap-progress", () => {
  it("cuenta fases de dos dígitos (F19+) y subtítulos dentro de la fase", () => {
    const p = countByPhase(base(""));
    expect(p.get("F0")).toEqual({ done: 1, partial: 1, pending: 1 });
    expect(p.get("F21")).toEqual({ done: 1, partial: 0, pending: 0 });
    expect(p.size).toBe(2);
  });

  it("--check: falla con la tabla desactualizada y pasa después de --write", () => {
    const stale = base("| tabla vieja |");
    expect(isUpToDate(stale)).toBe(false);
    const fixed = applyTable(stale)!;
    expect(fixed).toContain(renderTable(countByPhase(stale)));
    expect(isUpToDate(fixed)).toBe(true);
    expect(isUpToDate(fixed.replace(/\n/g, "\r\n"))).toBe(true);
  });

  it("sin marcadores no hay tabla que aplicar", () => {
    expect(applyTable("## F0\n- [x] a\n")).toBeNull();
    expect(isUpToDate("## F0\n- [x] a\n")).toBe(false);
  });
});
