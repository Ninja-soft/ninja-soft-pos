import { describe, expect, it } from "vitest";
import {
  CMD,
  columnsFor,
  decodeEscpos,
  encodeText,
  encodeTicket,
  fitPair,
  testTicketLines,
  wrap,
} from "@/lib/print/escpos";
import {
  backoffMs,
  cancel,
  enqueue,
  fromBase64,
  markFailed,
  markPrinted,
  markPrinting,
  nextJob,
  parseQueue,
  prune,
  recover,
  reprint,
  retry,
  runQueueStep,
  toBase64,
  KEEP_FINISHED,
  type PrintJob,
} from "@/lib/print/queue";
import { SimulatedPrinter } from "@/lib/print/simulator";
import {
  decodePole,
  encodePole,
  poleLines,
  poleMoney,
  POLE_COLS,
} from "@/lib/hardware/poleDisplay";

describe("ESC/POS", () => {
  it("texto en PC850 con acentos y ñ, y reemplazo de lo que no entra", () => {
    expect(encodeText("Añá")).toEqual([0x41, 0xa4, 0xa0]);
    expect(encodeText("€")).toEqual([0x3f]);
    expect(encodeText("ç")).toEqual([0x63]);
  });

  it("columnas, pares y cortes de línea", () => {
    expect(columnsFor(58)).toBe(32);
    expect(columnsFor(80)).toBe(48);
    const pair = fitPair(
      "Producto con nombre muy largo que no entra",
      "$ 1.000,00",
      32,
    );
    expect(pair).toHaveLength(32);
    expect(pair.endsWith("$ 1.000,00")).toBe(true);
    expect(wrap("uno dos tres cuatro", 8)).toEqual([
      "uno dos",
      "tres",
      "cuatro",
    ]);
    expect(wrap("abcdefghij", 4)).toEqual(["abcd", "efgh", "ij"]);
  });

  it("ticket de prueba: init, corte, densidad y pulso; ida y vuelta", () => {
    const bytes = encodeTicket(
      testTicketLines({
        business: "Kiosco Ñandú",
        register: "Caja 1",
        when: new Date(2026, 9, 13, 10, 5),
      }),
      {
        paper: 58,
        cut: "full",
        density: 8,
        drawer: { pin: 5, onMs: 120, offMs: 240 },
      },
    );
    expect(Array.from(bytes.slice(0, 2))).toEqual(CMD.init);
    const p = decodeEscpos(bytes);
    expect(p.lines.some((l) => l.includes("Kiosco Ñandú"))).toBe(true);
    expect(p.lines.some((l) => l.includes("13/10/2026 10:05"))).toBe(true);
    expect(p.lines.every((l) => l.length <= 32)).toBe(true);
    expect(p.events).toContainEqual({ kind: "cut", partial: false });
    expect(p.events).toContainEqual({
      kind: "drawer",
      pin: 5,
      onMs: 120,
      offMs: 240,
    });
    expect(p.events).toContainEqual({ kind: "density", raw: 6 });
    expect(p.events.some((e) => e.kind === "unknown")).toBe(false);
  });

  it("sin corte no manda GS V y el corte parcial se reconoce", () => {
    const none = decodeEscpos(
      encodeTicket([{ kind: "text", text: "hola" }], { cut: "none" }),
    );
    expect(none.events.some((e) => e.kind === "cut")).toBe(false);
    const partial = decodeEscpos(
      encodeTicket([{ kind: "text", text: "hola" }], { cut: "partial" }),
    );
    expect(partial.events).toContainEqual({ kind: "cut", partial: true });
  });
});

const job = (q: PrintJob[], id: string, now = 0, printerId = "p1") =>
  enqueue(
    q,
    {
      id,
      doc: "sale_ticket",
      label: `Venta ${id}`,
      printerId,
      payload: toBase64(new Uint8Array([1, 2, 3])),
    },
    now,
  );

describe("cola de impresión", () => {
  it("FIFO y una a la vez por impresora", () => {
    let q = job([], "a", 1);
    q = job(q, "b", 2);
    q = job(q, "c", 3, "p2");
    expect(nextJob(q, 10)?.id).toBe("a");
    q = markPrinting(q, "a", 10);
    expect(nextJob(q, 10)?.id).toBe("c");
  });

  it("reintenta con backoff y queda fallido al agotar intentos", () => {
    let q = enqueue(
      [],
      {
        id: "a",
        doc: "test",
        label: "x",
        printerId: "p",
        payload: "",
        maxAttempts: 2,
      },
      0,
    );
    q = markFailed(markPrinting(q, "a", 0), "a", "sin papel", 0);
    expect(q[0]).toMatchObject({
      status: "pending",
      attempts: 1,
      lastError: "sin papel",
      nextAttemptAt: backoffMs(1),
    });
    expect(nextJob(q, 1000)).toBeNull();
    expect(nextJob(q, 2000)?.id).toBe("a");
    q = markFailed(markPrinting(q, "a", 2000), "a", "sin papel", 2000);
    expect(q[0]!.status).toBe("failed");
    q = retry(q, "a", 3000);
    expect(q[0]).toMatchObject({
      status: "pending",
      attempts: 0,
      nextAttemptAt: 3000,
    });
    expect(backoffMs(10)).toBe(30_000);
  });

  it("reimprimir, cancelar y recuperar", () => {
    let q = job([], "a");
    q = markPrinted(markPrinting(q, "a", 1), "a", 2);
    q = reprint(q, "a", "a2", 3);
    expect(q.find((j) => j.id === "a2")).toMatchObject({
      status: "pending",
      label: "Venta a (reimpresión)",
    });
    expect(reprint(q, "a2", "zz", 4)).toBe(q); // pendiente: no se reimprime
    q = cancel(q, "a2", 5);
    expect(q.find((j) => j.id === "a2")!.status).toBe("cancelled");
    let p = markPrinting(job([], "b"), "b", 1);
    expect(cancel(p, "b", 2)[0]!.status).toBe("printing"); // no se cancela lo que está saliendo
    p = recover(p, 9);
    expect(p[0]).toMatchObject({ status: "pending", nextAttemptAt: 9 });
  });

  it("prune conserva activos y los últimos terminados; parseQueue sanea", () => {
    let q: PrintJob[] = [];
    for (let i = 0; i < KEEP_FINISHED + 5; i++) {
      q = job(q, `d${i}`, i);
      q = markPrinted(markPrinting(q, `d${i}`, i), `d${i}`, i);
    }
    q = job(q, "live", 999);
    q = prune(q);
    expect(q.filter((j) => j.status === "printed")).toHaveLength(KEEP_FINISHED);
    expect(q.some((j) => j.id === "live")).toBe(true);
    expect(parseQueue([{ id: 1 }, null, ...q]).length).toBe(q.length);
    expect(parseQueue("x")).toEqual([]);
  });

  it("base64 ida y vuelta", () => {
    const b = new Uint8Array([0, 27, 64, 255, 10]);
    expect(Array.from(fromBase64(toBase64(b)))).toEqual(Array.from(b));
  });

  it("runQueueStep con la impresora simulada: falla, reintenta e imprime", async () => {
    const printer = new SimulatedPrinter(0);
    printer.fault = "flaky";
    const bytes = encodeTicket([{ kind: "text", text: "Hola" }]);
    let state = enqueue(
      [],
      {
        id: "t",
        doc: "test",
        label: "Prueba",
        printerId: "sim",
        payload: toBase64(bytes),
      },
      0,
    );
    let t = 0;
    const get = () => state;
    const set = (q: PrintJob[]) => {
      state = q;
    };
    const first = await runQueueStep(get, set, printer, () => t);
    expect(first).toMatchObject({ status: "pending", attempts: 1 });
    t = backoffMs(1);
    const second = await runQueueStep(get, set, printer, () => t);
    expect(second).toMatchObject({ status: "printed", attempts: 2 });
    expect(printer.printed[0]!.lines).toContain("Hola");
    expect(await runQueueStep(get, set, printer, () => t)).toBeNull();

    printer.fault = "paper_out";
    state = enqueue(
      state,
      {
        id: "u",
        doc: "test",
        label: "P2",
        printerId: "sim",
        payload: toBase64(bytes),
        maxAttempts: 1,
      },
      t,
    );
    const failed = await runQueueStep(get, set, printer, () => t);
    expect(failed).toMatchObject({
      status: "failed",
      lastError: "Sin papel (simulado)",
    });
  });
});

describe("visor de 2 líneas", () => {
  it("arma líneas de 20 y las lee igual del lado del visor", () => {
    const cases = [
      poleLines({
        kind: "item",
        name: "Yerba mate con palo 1 kg extra",
        qty: 2,
        price: 3250,
        total: 6500,
      }),
      poleLines({ kind: "total", total: 12840.5 }),
      poleLines({ kind: "change", paid: 15000, change: 2159.5 }),
      poleLines({ kind: "thanks" }, "Almacén Ñandú"),
      poleLines({ kind: "idle" }),
    ];
    for (const l of cases) {
      expect(l[0]).toHaveLength(POLE_COLS);
      expect(l[1]).toHaveLength(POLE_COLS);
      expect(decodePole(encodePole(l))).toEqual(l);
    }
    expect(cases[1]![1].trim()).toBe(poleMoney(12840.5));
    expect(cases[3]![1]).toContain("Almacen Nandu");
    expect(cases[2]![1]).toMatch(/^VUELTO\s+\$2\.159,50$/);
  });
});
