import { afterEach, describe, expect, it, vi } from "vitest";
import {
  ACK,
  ETX,
  FrameDecoder,
  LinkSession,
  NAK,
  STX,
  encodeFrame,
  latin1,
  lrc,
  memoryPair,
  toBytes,
} from "@/lib/payments/terminal/framing";
import {
  PaywayAdapter,
  VpiDecoder,
  brandFromBin,
  buildVpiRequest,
  encodeRefund,
  encodeSale,
  encodeVoid,
  parseTrxData,
  vpiToResult,
} from "@/lib/payments/terminal/adapters/payway";
import { GetnetAdapter } from "@/lib/payments/terminal/adapters/getnet";
import { FiservPosnetAdapter } from "@/lib/payments/terminal/adapters/fiserv";
import { SimulatorAdapter, scenarioForAmount } from "@/lib/payments/terminal/simulator";
import {
  INITIAL_CHARGE,
  chargeReducer,
  runSale,
  type ChargeEvent,
  type ChargeState,
} from "@/lib/payments/terminal/charge";
import {
  cardTypeFromBrand,
  declineMessage,
  last4Of,
  normalizeCardBrand,
  normalizeResult,
  toCardVoucher,
} from "@/lib/payments/terminal/normalize";
import { integrationProblem, parseIntegration, withIntegration, bridgeUrlOk } from "@/lib/payments/terminal/config";
import { BridgeTransport, b64decode, b64encode } from "@/lib/payments/terminal/transports";
import { pickIntegratedTerminal, type PaymentTerminal } from "@/lib/payments/terminals";
import { INTEGRATED_CARD_TENDER_ID, integratedCardTender, type TenderDef } from "@/lib/pos/tenders";
import { TerminalError, type TerminalResult } from "@/lib/payments/terminal/types";

const bytes = (...n: number[]) => Uint8Array.from(n);

function result(p: Partial<TerminalResult> = {}): TerminalResult {
  return {
    approved: true,
    op: "sale",
    amount: 100,
    authCode: "123456",
    lote: "007",
    cupon: "0000042",
    cardBrand: "VISA DEBITO",
    cardType: null,
    last4: "************4321",
    installments: 1,
    merchantNumber: "123-456",
    terminalNumber: "T1",
    responseCode: "00",
    message: "APROBADA",
    raw: "",
    at: "2026-10-18T10:00:00.000Z",
    ...p,
  };
}

afterEach(() => {
  vi.useRealTimers();
});

// ── Framing genérico ────────────────────────────────────────────────────────

describe("framing ISO 1745", () => {
  it("arma STX + datos + ETX + LRC (XOR desde después del STX, ETX incluido)", () => {
    const f = encodeFrame(toBytes("AB"));
    expect(Array.from(f)).toEqual([STX, 0x41, 0x42, ETX, 0x41 ^ 0x42 ^ ETX]);
    expect(lrc(bytes(0x41, 0x42, ETX))).toBe(f[4]);
  });

  it("decodifica tramas partidas en cualquier lugar y valida el LRC", () => {
    const f = encodeFrame(toBytes("HOLA"));
    const d = new FrameDecoder();
    const out = [...d.push(bytes(ACK, ...f.slice(0, 3))), ...d.push(f.slice(3))];
    expect(out[0]).toEqual({ type: "ack" });
    expect(out[1]).toMatchObject({ type: "frame", valid: true });
    expect(latin1((out[1] as { payload: Uint8Array }).payload)).toBe("HOLA");
    const bad = Uint8Array.from(f);
    bad[bad.length - 1] = bad[bad.length - 1]! ^ 0xff;
    expect(new FrameDecoder().push(bad)[0]).toMatchObject({ type: "frame", valid: false });
  });

  it("LinkSession reenvía ante NAK y confirma con ACK la respuesta", async () => {
    const [pc, term] = memoryPair();
    await pc.open();
    await term.open();
    const seen: number[] = [];
    let naks = 0;
    term.onData((c) => {
      if (c[0] !== STX) return;
      seen.push(c.length);
      if (naks++ === 0) void term.write(bytes(NAK));
      else {
        void term.write(bytes(ACK));
        void term.write(encodeFrame(toBytes("OK")));
      }
    });
    const acks: number[] = [];
    term.onData((c) => c[0] === ACK && acks.push(1));
    const link = new LinkSession(pc, { ackTimeoutMs: 200 });
    link.attach();
    await link.send(toBytes("PING"));
    const res = await link.receive(500);
    expect(latin1(res)).toBe("OK");
    expect(seen.length).toBe(2);
    await new Promise((r) => setTimeout(r, 0));
    expect(acks.length).toBe(1);
  });

  it("LinkSession falla con timeout si nadie responde", async () => {
    const [pc] = memoryPair();
    await pc.open();
    const link = new LinkSession(pc, { ackTimeoutMs: 10, maxRetries: 1 });
    link.attach();
    await expect(link.send(toBytes("X"))).rejects.toMatchObject({ code: "protocol" });
    await expect(link.receive(10)).rejects.toMatchObject({ code: "timeout" });
  });
});

// ── Payway VPI ──────────────────────────────────────────────────────────────

/** Respuesta VPI armada como la describen las fuentes públicas. */
function vpiResponse(cmd: string, status: string, data: string, withLrc = true): Uint8Array {
  const body = toBytes(data);
  const head = [...toBytes(cmd), ...toBytes(status), body.length & 0xff, body.length >> 8];
  const frame = [STX, ...head, ...body, ETX];
  if (withLrc) frame.push(lrc(Uint8Array.from(frame.slice(1))));
  return Uint8Array.from(frame);
}

function trxData(p: { code?: string; msg?: string; auth?: string; cupon?: string; lote?: string; last4?: string; first6?: string } = {}) {
  return (
    (p.code ?? "00") +
    (p.msg ?? "APROBADA").padEnd(32, " ") +
    (p.auth ?? "654321") +
    (p.cupon ?? "0000123") +
    (p.lote ?? "045") +
    "JUAN PEREZ".padEnd(26, " ") +
    (p.last4 ?? "4321") +
    (p.first6 ?? "450799") +
    "18/10/2026" +
    "10:11:12" +
    "TERM0001"
  );
}

describe("Payway VPI (fuente pública no oficial)", () => {
  it("arma VEN con anchos fijos (125 bytes de datos)", () => {
    const d = encodeSale({
      amount: 1234.5,
      receipt: "77",
      installments: 3,
      cardCode: "VI",
      merchantCode: "12345678",
      merchantName: "Kiosco Ñandú",
      cuit: "20123456789",
    });
    expect(d.length).toBe(12 + 12 + 2 + 3 + 1 + 12 + 15 + 23 + 23 + 1);
    expect(d.slice(0, 12)).toBe("000000123450");
    expect(d.slice(12, 24)).toBe("000000000077");
    expect(d.slice(24, 26)).toBe("03");
    expect(d.slice(26, 29)).toBe("0VI");
    expect(d.slice(29, 30)).toBe("0");
    expect(d.slice(42, 57)).toBe("12345678       ");
    expect(d.slice(57, 80)).toBe("Kiosco Nandu".padStart(23, " "));
    expect(d.charCodeAt(d.length - 1)).toBe(1);
  });

  it("arma ANV y DEV", () => {
    expect(encodeVoid({ cupon: "42", cardCode: "MC" })).toBe("00000420MC");
    const dev = encodeRefund({
      amount: 10,
      cardCode: "VI",
      installments: 1,
      originalCupon: "42",
      originalDate: "17/10/2026",
      receipt: "9",
      merchantCode: "1",
      merchantName: "",
      cuit: "",
    });
    expect(dev.length).toBe(12 + 3 + 1 + 2 + 7 + 10 + 12 + 15 + 23 + 23 + 1);
    expect(dev.slice(25, 35)).toBe("17/10/2026");
  });

  it("la trama de pedido lleva largo little-endian y LRC", () => {
    const f = buildVpiRequest("TES");
    expect(Array.from(f)).toEqual([STX, 0x54, 0x45, 0x53, 0, 0, ETX, lrc(bytes(0x54, 0x45, 0x53, 0, 0, ETX))]);
    const big = buildVpiRequest("VEN", "x".repeat(300));
    expect(big[4]).toBe(300 & 0xff);
    expect(big[5]).toBe(1);
  });

  it("decodifica por largo aunque un byte del largo valga ETX", () => {
    const d = new VpiDecoder();
    const raw = vpiResponse("TAR", "000", "abc"); // largo 3 = 0x03
    const out = [...d.push(raw.slice(0, 5)), ...d.push(raw.slice(5))];
    expect(out).toHaveLength(1);
    expect(out[0]).toMatchObject({ command: "TAR", status: "000", lrcOk: true });
    expect(latin1(out[0]!.data)).toBe("abc");
  });

  it("acepta respuestas sin LRC (flush) y detecta LRC malo", () => {
    const d = new VpiDecoder();
    expect(d.push(vpiResponse("TES", "000", "", false))).toHaveLength(0);
    expect(d.flush()[0]).toMatchObject({ command: "TES", lrcOk: null });
    const bad = vpiResponse("TES", "000", "");
    bad[bad.length - 1] = bad[bad.length - 1]! ^ 0x55;
    expect(new VpiDecoder().push(bad)[0]).toMatchObject({ lrcOk: false });
  });

  it("parsea la transacción y normaliza aprobado / rechazado", () => {
    const t = parseTrxData(toBytes(trxData()));
    expect(t).toMatchObject({ hostCode: "00", authCode: "654321", cupon: "0000123", lote: "045", last4: "4321", terminalId: "TERM0001" });
    const ok = vpiToResult(
      "sale",
      { command: "VEN", status: "000", data: toBytes(trxData()), lrcOk: true, raw: bytes() },
      { amount: 10, installments: 1, cardBrandLabel: null, merchantNumber: "1" },
    );
    expect(ok).toMatchObject({ approved: true, cardBrand: "VISA", authCode: "654321" });
    const no = vpiToResult(
      "sale",
      { command: "VEN", status: "000", data: toBytes(trxData({ code: "51", msg: "FONDOS INSUFICIENTES" })), lrcOk: true, raw: bytes() },
      { amount: 10, installments: 1, cardBrandLabel: null, merchantNumber: null },
    );
    expect(no).toMatchObject({ approved: false, responseCode: "51", message: "FONDOS INSUFICIENTES" });
    const cancelled = vpiToResult(
      "sale",
      { command: "VEN", status: "201", data: bytes(), lrcOk: null, raw: bytes() },
      { amount: 10, installments: 1, cardBrandLabel: null, merchantNumber: null },
    );
    expect(cancelled).toMatchObject({ approved: false, responseCode: "201", message: "Operación cancelada en la terminal" });
  });

  it("marca por BIN", () => {
    expect(brandFromBin("450799")).toBe("VISA");
    expect(brandFromBin("540000")).toBe("MASTERCARD");
    expect(brandFromBin("222100")).toBe("MASTERCARD");
    expect(brandFromBin("371234")).toBe("AMEX");
    expect(brandFromBin("589657")).toBeNull();
  });

  it("venta de punta a punta contra una terminal falsa por memoria", async () => {
    const [pc, term] = memoryPair();
    await term.open();
    const got: string[] = [];
    let sawEnq = false;
    term.onData((c) => {
      if (c[0] === 0x05) sawEnq = true;
      if (c[0] !== STX) return;
      const cmd = latin1(c.subarray(1, 4));
      got.push(cmd);
      void term.write(vpiResponse(cmd, "000", cmd === "VEN" ? trxData() : ""));
    });
    const a = new PaywayAdapter(pc, { cardCodes: { visa: "VI" }, merchantNumber: "999" });
    await a.connect();
    const r = await a.sale({ amount: 50, installments: 1, reference: "abc-123", cardBrand: "visa" });
    expect(sawEnq).toBe(true);
    expect(got).toEqual(["VEN"]);
    expect(r).toMatchObject({ approved: true, cupon: "0000123", lote: "045", cardBrand: "Visa", merchantNumber: "999" });
    await expect(a.sale({ amount: 50, installments: 1, reference: "x", cardBrand: "amex" })).rejects.toMatchObject({
      code: "protocol",
    });
    expect((await a.status()).ready).toBe(true);
  });

  it("Getnet y Fiserv quedan pendientes del kit", async () => {
    const [pc] = memoryPair();
    for (const a of [new GetnetAdapter(pc), new FiservPosnetAdapter(pc)]) {
      expect(a.specStatus).toBe("pending_kit");
      await expect(a.sale({ amount: 1, installments: 1, reference: "r" })).rejects.toMatchObject({ code: "spec_pending" });
    }
  });
});

// ── Normalización ───────────────────────────────────────────────────────────

describe("normalización", () => {
  it("marca, tipo y últimos 4", () => {
    expect(normalizeCardBrand("VISA DEBITO")).toBe("visa");
    expect(normalizeCardBrand("MasterCard")).toBe("master");
    expect(normalizeCardBrand("AMERICAN EXPRESS")).toBe("amex");
    expect(normalizeCardBrand("Tarjeta Naranja")).toBe("naranja");
    expect(normalizeCardBrand("XYZ")).toBeNull();
    expect(cardTypeFromBrand("VISA DEBITO")).toBe("debit");
    expect(cardTypeFromBrand("MAESTRO")).toBe("debit");
    expect(cardTypeFromBrand("VISA")).toBeNull();
    expect(last4Of("XXXX-XXXX-1234")).toBe("1234");
    expect(last4Of("12")).toBeNull();
  });

  it("limpia el resultado y arma el card_voucher con los nombres del POS", () => {
    const n = normalizeResult(result());
    expect(n).toMatchObject({ lote: "7", cupon: "42", last4: "4321", cardType: "debit", merchantNumber: "123456" });
    const v = toCardVoucher(result({ installments: 3, cardBrand: "MASTERCARD" }), { terminalTxId: "tx-1", acquirer: "payway" });
    expect(v).toEqual({
      lote: "7",
      cupon: "42",
      autorizacion: "123456",
      marca: "Mastercard",
      ultimos4: "4321",
      cuotas: 3,
      comercio: "123456",
      adquirente: "payway",
      origen: "terminal",
      terminal_tx: "tx-1",
    });
    expect(declineMessage({ message: "FONDOS INSUFICIENTES", responseCode: "51" })).toBe("Fondos insuficientes");
    expect(declineMessage({ message: null, responseCode: "05" })).toContain("05");
  });
});

// ── Máquina de estados ──────────────────────────────────────────────────────

describe("máquina de estados del cobro", () => {
  const run = (...evs: ChargeEvent[]) => evs.reduce<ChargeState>(chargeReducer, INITIAL_CHARGE);

  it("aprobado y rechazado", () => {
    expect(run({ type: "start" }, { type: "connected" }, { type: "result", result: result() }).phase).toBe("approved");
    const d = run({ type: "start" }, { type: "connected" }, { type: "result", result: result({ approved: false, message: "NO AUTORIZADA" }) });
    expect(d).toMatchObject({ phase: "declined", message: "No autorizada" });
  });

  it("timeout es incierto y una aprobación tardía se respeta", () => {
    const t = run({ type: "start" }, { type: "connected" }, { type: "timeout" });
    expect(t.phase).toBe("timeout");
    expect(t.message).toMatch(/Revisá/);
    expect(chargeReducer(t, { type: "result", result: result() }).phase).toBe("approved");
    expect(chargeReducer(t, { type: "result", result: result({ approved: false }) }).phase).toBe("timeout");
  });

  it("cancelar, reintentar y nunca reintentar un aprobado", () => {
    const c = run({ type: "start" }, { type: "cancel" });
    expect(c.phase).toBe("cancelled");
    const r = chargeReducer(c, { type: "retry" });
    expect(r).toMatchObject({ phase: "connecting", attempt: 2 });
    const a = run({ type: "start" }, { type: "connected" }, { type: "result", result: result() });
    expect(chargeReducer(a, { type: "retry" })).toBe(a);
    expect(chargeReducer(a, { type: "cancel" })).toBe(a);
  });

  it("error de comunicación", () => {
    expect(run({ type: "start" }, { type: "error", code: "transport", message: "corte" })).toMatchObject({
      phase: "error",
      errorCode: "transport",
    });
  });
});

// ── Simulador ───────────────────────────────────────────────────────────────

describe("simulador", () => {
  const collect = () => {
    let s = chargeReducer(INITIAL_CHARGE, { type: "start" });
    return { dispatch: (e: ChargeEvent) => (s = chargeReducer(s, e)), get: () => s };
  };

  it("escenarios por centavos", () => {
    expect(scenarioForAmount(100)).toBe("approve");
    expect(scenarioForAmount(100.51)).toBe("decline_funds");
    expect(scenarioForAmount(100.05)).toBe("decline_generic");
    expect(scenarioForAmount(100.91)).toBe("no_response");
    expect(scenarioForAmount(100.96)).toBe("comm_error");
  });

  it("aprueba con datos de cupón y crédito si hay cuotas", async () => {
    const sim = new SimulatorAdapter({ delayMs: 0, seed: 1 });
    const c = collect();
    const r = await runSale(sim, { amount: 1500, installments: 6, reference: "v1" }, { dispatch: c.dispatch });
    expect(c.get().phase).toBe("approved");
    expect(r).toMatchObject({ approved: true, cupon: "1", lote: "1", installments: 6, cardType: "credit" });
    expect(r!.authCode).toMatch(/^\d{6}$/);
  });

  it("rechaza y deja el motivo", async () => {
    const sim = new SimulatorAdapter({ delayMs: 0, seed: 2 });
    const c = collect();
    await runSale(sim, { amount: 10.51, installments: 1, reference: "v" }, { dispatch: c.dispatch });
    expect(c.get()).toMatchObject({ phase: "declined", message: "Fondos insuficientes", errorCode: "51" });
  });

  it("timeout y recuperación con la última operación", async () => {
    vi.useFakeTimers();
    const sim = new SimulatorAdapter({ delayMs: 0, seed: 3 });
    const c = collect();
    const p = runSale(sim, { amount: 10.91, installments: 1, reference: "v" }, { dispatch: c.dispatch, timeoutMs: 1000 });
    await vi.advanceTimersByTimeAsync(1500);
    expect(await p).toBeNull();
    expect(c.get().phase).toBe("timeout");
    const last = await sim.lastTransaction();
    expect(last?.approved).toBe(true);
    expect(chargeReducer(c.get(), { type: "result", result: last! }).phase).toBe("approved");
  });

  it("cancelación por el cajero", async () => {
    vi.useFakeTimers();
    const sim = new SimulatorAdapter({ delayMs: 5000, seed: 4 });
    const c = collect();
    const ctrl = new AbortController();
    const p = runSale(sim, { amount: 10, installments: 1, reference: "v" }, { dispatch: c.dispatch, signal: ctrl.signal });
    await vi.advanceTimersByTimeAsync(100);
    ctrl.abort();
    await vi.advanceTimersByTimeAsync(10);
    expect(await p).toBeNull();
    expect(c.get().phase).toBe("cancelled");
  });

  it("error de comunicación", async () => {
    const sim = new SimulatorAdapter({ delayMs: 0, seed: 5 });
    const c = collect();
    await runSale(sim, { amount: 10.96, installments: 1, reference: "v" }, { dispatch: c.dispatch });
    expect(c.get()).toMatchObject({ phase: "error", errorCode: "transport" });
  });

  it("anulación, devolución y cierre de lote", async () => {
    const sim = new SimulatorAdapter({ delayMs: 0, seed: 6 });
    await sim.connect();
    const s1 = await sim.sale({ amount: 100, installments: 1, reference: "a" });
    await sim.sale({ amount: 50, installments: 1, reference: "b" });
    const v = await sim.void({ cupon: s1.cupon!, amount: 100, reference: "a" });
    expect(v.approved).toBe(true);
    expect((await sim.void({ cupon: s1.cupon!, amount: 100, reference: "a" })).approved).toBe(false);
    expect((await sim.refund({ amount: 20, reference: "c" })).approved).toBe(true);
    const close = await sim.closeBatch();
    expect(close).toMatchObject({ ok: true, lote: "1", count: 2, total: 30 });
    const next = await sim.sale({ amount: 1, installments: 1, reference: "d" });
    expect(next.lote).toBe("2");
  });

  it("no acepta dos operaciones a la vez", async () => {
    const sim = new SimulatorAdapter({ delayMs: 50, seed: 7 });
    await sim.connect();
    const first = sim.sale({ amount: 1, installments: 1, reference: "a" });
    await expect(sim.sale({ amount: 1, installments: 1, reference: "b" })).rejects.toBeInstanceOf(TerminalError);
    await first;
  });
});

// ── Configuración, puente y selección de terminal ──────────────────────────

describe("configuración", () => {
  it("sanea external_meta.integration", () => {
    expect(parseIntegration(null)).toMatchObject({ adapter: "simulator", transport: "none", timeoutSec: 120 });
    const c = parseIntegration({
      integration: {
        adapter: "payway_lapos",
        transport: "none",
        timeoutSec: 9999,
        cardCodes: { visa: "vi", "bad key": "X", master: "TOOLONG" },
        cuit: "20-12345678-9",
        bridgeTarget: { kind: "tcp", host: "192.168.0.50", port: 9000 },
      },
    });
    expect(c).toMatchObject({ adapter: "payway_lapos", transport: "webserial", timeoutSec: 300, cuit: "20123456789" });
    expect(c.serial.baudRate).toBe(19200);
    expect(c.cardCodes).toEqual({ visa: "VI" });
    expect(c.bridgeTarget).toEqual({ kind: "tcp", host: "192.168.0.50", port: 9000 });
    expect(withIntegration({ otro: 1 }, c)).toMatchObject({ otro: 1, integration: { adapter: "payway_lapos" } });
  });

  it("problemas de emparejamiento", () => {
    const serial = parseIntegration({ integration: { adapter: "payway_lapos", transport: "webserial" } });
    expect(integrationProblem(serial, null)).toMatch(/emparejar/);
    expect(integrationProblem(serial, { device: { vendorId: 1, productId: 2, index: 0, name: "x" } })).toBeNull();
    const bridge = parseIntegration({ integration: { adapter: "getnet", transport: "bridge" } });
    expect(integrationProblem(bridge, null)).toMatch(/puerto o la dirección/);
    expect(integrationProblem(parseIntegration({}), null)).toBeNull();
    expect(bridgeUrlOk("ws://127.0.0.1:47800")).toBe(true);
    expect(bridgeUrlOk("ws://192.168.0.2:47800")).toBe(false);
  });

  it("el puente hace hello, open y pasa datos en base64", async () => {
    const sent: Record<string, unknown>[] = [];
    let sock: {
      readyState: number;
      send: (d: string) => void;
      close: () => void;
      onopen: ((e: unknown) => void) | null;
      onmessage: ((e: { data: unknown }) => void) | null;
      onclose: ((e: unknown) => void) | null;
      onerror: ((e: unknown) => void) | null;
    } | null = null;
    const reply = (m: unknown) => sock!.onmessage!({ data: JSON.stringify(m) });
    const factory = () => {
      sock = {
        readyState: 1,
        send: (d: string) => {
          const m = JSON.parse(d) as Record<string, unknown>;
          sent.push(m);
          if (m.type === "hello") queueMicrotask(() => reply({ type: "welcome", version: 1, bridge: "test" }));
          if (m.type === "open") queueMicrotask(() => reply({ type: "opened" }));
        },
        close: () => undefined,
        onopen: null,
        onmessage: null,
        onclose: null,
        onerror: null,
      };
      queueMicrotask(() => sock!.onopen!({}));
      return sock;
    };
    const t = new BridgeTransport(
      { url: "ws://127.0.0.1:47800", token: "tok", target: { kind: "serial", path: "COM3", baudRate: 19200 } },
      factory,
    );
    await t.open();
    expect(sent.map((m) => m.type)).toEqual(["hello", "open"]);
    expect(sent[0]).toMatchObject({ token: "tok" });
    const got: number[] = [];
    t.onData((c) => got.push(...c));
    reply({ type: "data", b64: b64encode(bytes(1, 2, 3)) });
    expect(got).toEqual([1, 2, 3]);
    await t.write(bytes(9));
    expect(b64decode(String(sent[2]!.b64))).toEqual(bytes(9));
  });

  it("el puente rechaza un token malo", async () => {
    const factory = () => {
      const s = {
        readyState: 1,
        send: (d: string) => {
          if ((JSON.parse(d) as { type: string }).type === "hello") {
            queueMicrotask(() => s.onmessage!({ data: JSON.stringify({ type: "error", code: "bad_token" }) }));
          }
        },
        close: () => undefined,
        onopen: null as ((e: unknown) => void) | null,
        onmessage: null as ((e: { data: unknown }) => void) | null,
        onclose: null as ((e: unknown) => void) | null,
        onerror: null as ((e: unknown) => void) | null,
      };
      queueMicrotask(() => s.onopen!({}));
      return s;
    };
    const t = new BridgeTransport({ url: "ws://127.0.0.1:1", token: "x", target: { kind: "tcp", host: "h", port: 1 } }, factory);
    await expect(t.open()).rejects.toMatchObject({ code: "bridge_auth" });
  });

  it("elige la terminal integrada de la caja", () => {
    const base: PaymentTerminal = {
      id: "a",
      store_id: "s1",
      cash_register_id: null,
      provider_key: "payway",
      kind: "pinpad",
      external_id: "T1",
      environment: null,
      label: "Pinpad",
      merchant_number: null,
      acquirer: null,
      is_default: false,
      active: true,
      last_seen_at: null,
    };
    const ts: PaymentTerminal[] = [
      base,
      { ...base, id: "b", cash_register_id: "r1", kind: "posnet_integrado" },
      { ...base, id: "c", kind: "posnet_manual" },
      { ...base, id: "d", cash_register_id: "r2" },
    ];
    expect(pickIntegratedTerminal({ terminals: ts, storeId: "s1", registerId: "r1" }).terminal?.id).toBe("b");
    expect(pickIntegratedTerminal({ terminals: ts, storeId: "s1", registerId: "r3" }).terminal?.id).toBe("a");
    expect(pickIntegratedTerminal({ terminals: ts, storeId: "s2", registerId: null }).reason).toBe("none");
  });
});

describe("tender Tarjeta en terminal", () => {
  it("deriva de Tarjeta en posnet con la terminal de la caja", () => {
    const card: TenderDef = {
      id: "card",
      group: "card",
      brand: "card",
      brandLabel: "Tarjeta en posnet",
      channel: "manual",
      label: "Tarjeta en posnet",
      method: null,
      provider: null,
      connection: null,
      featureKey: null,
      logo: null,
      flow: "card",
    };
    const t = integratedCardTender(card, {
      terminalId: "t1",
      label: "Pinpad caja 1",
      providerKey: "payway",
      requiresBrand: true,
      simulated: false,
    });
    expect(t).toMatchObject({ id: INTEGRATED_CARD_TENDER_ID, flow: "card", group: "card", integrated: { terminalId: "t1" } });
    expect(t.hint).toContain("Pinpad caja 1");
    expect(card.id).toBe("card");
  });
});
