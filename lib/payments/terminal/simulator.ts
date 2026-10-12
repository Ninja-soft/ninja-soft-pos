// Simulador de terminal integrada (ADR-053): cumple TerminalAdapter sin
// hardware, para demos, capacitación y tests. Cobra de verdad nada.
//
// Escenarios por los CENTAVOS del monto (como las tarjetas de prueba):
//   ,51 → rechazada "Fondos insuficientes" (código 51)
//   ,05 → rechazada "No autorizada" (código 05)
//   ,91 → cobra pero no responde (timeout; se recupera con "última operación")
//   ,96 → error de comunicación
//   resto → aprobada
// Además se puede forzar con `forced` (pantalla de prueba de Configuración).

import {
  TerminalError,
  abortError,
  type AdapterCapabilities,
  type CardType,
  type CloseBatchResult,
  type OpOptions,
  type RefundRequest,
  type SaleRequest,
  type TerminalAdapter,
  type TerminalResult,
  type TerminalStatus,
  type VoidRequest,
} from "./types";

export type SimScenario = "approve" | "decline_funds" | "decline_generic" | "no_response" | "comm_error";

export interface SimulatorOptions {
  /** Demora hasta "pasar la tarjeta" y responder. */
  delayMs?: number;
  merchantNumber?: string | null;
  terminalNumber?: string;
  /** Semilla para datos reproducibles (tests). */
  seed?: number;
  forced?: SimScenario | null;
  /** Fecha fija (tests). */
  now?: () => Date;
}

export function scenarioForAmount(amount: number): SimScenario {
  const cents = Math.round(Math.abs(amount) * 100) % 100;
  if (cents === 51) return "decline_funds";
  if (cents === 5) return "decline_generic";
  if (cents === 91) return "no_response";
  if (cents === 96) return "comm_error";
  return "approve";
}

const BRANDS: { brand: string; type: CardType }[] = [
  { brand: "VISA", type: "credit" },
  { brand: "VISA DEBITO", type: "debit" },
  { brand: "MASTERCARD", type: "credit" },
  { brand: "MAESTRO", type: "debit" },
  { brand: "CABAL", type: "debit" },
  { brand: "AMEX", type: "credit" },
  { brand: "NARANJA", type: "credit" },
];

/** PRNG chico y determinístico (mulberry32). */
function rng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

interface SimTx {
  cupon: string;
  amount: number;
  voided: boolean;
  kind: "sale" | "refund";
}

export class SimulatorAdapter implements TerminalAdapter {
  readonly key = "simulator" as const;
  readonly label = "Simulador";
  readonly specStatus = "ready" as const;
  readonly capabilities: AdapterCapabilities = {
    void: true,
    refund: true,
    closeBatch: true,
    installments: true,
    cancelInFlight: true,
    requiresBrand: false,
    lastTransaction: true,
  };
  private last: TerminalResult | null = null;

  private connected = false;
  private busy = false;
  private lote = 1;
  private cuponSeq = 0;
  private batch: SimTx[] = [];
  private readonly rand: () => number;
  private readonly o: Required<Omit<SimulatorOptions, "forced" | "merchantNumber" | "seed">> & {
    forced: SimScenario | null;
    merchantNumber: string | null;
  };

  constructor(opts: SimulatorOptions = {}) {
    this.rand = rng(opts.seed ?? Date.now());
    this.o = {
      delayMs: opts.delayMs ?? 1800,
      merchantNumber: opts.merchantNumber ?? "12345678",
      terminalNumber: opts.terminalNumber ?? "SIM00001",
      forced: opts.forced ?? null,
      now: opts.now ?? (() => new Date()),
    };
  }

  /** Cambia el escenario forzado (null = por centavos). */
  force(s: SimScenario | null) {
    this.o.forced = s;
  }

  async connect(opts?: OpOptions): Promise<void> {
    if (opts?.signal?.aborted) throw abortError(opts.signal);
    this.connected = true;
  }

  async disconnect(): Promise<void> {
    this.connected = false;
  }

  private wait(ms: number, signal?: AbortSignal): Promise<void> {
    return new Promise((resolve, reject) => {
      if (signal?.aborted) return reject(abortError(signal));
      const t = setTimeout(() => {
        signal?.removeEventListener("abort", onAbort);
        resolve();
      }, ms);
      const onAbort = () => {
        clearTimeout(t);
        reject(abortError(signal));
      };
      signal?.addEventListener("abort", onAbort, { once: true });
    });
  }

  private ensure() {
    if (!this.connected) throw new TerminalError("not_connected", "El simulador no está conectado");
    if (this.busy) throw new TerminalError("busy", "La terminal tiene una operación en curso");
  }

  private base(op: TerminalResult["op"], amount: number | null): TerminalResult {
    return {
      approved: false,
      op,
      amount,
      authCode: null,
      lote: String(this.lote),
      cupon: null,
      cardBrand: null,
      cardType: null,
      last4: null,
      installments: null,
      merchantNumber: this.o.merchantNumber,
      terminalNumber: this.o.terminalNumber,
      responseCode: null,
      message: null,
      raw: "",
      at: this.o.now().toISOString(),
    };
  }

  private async run<T>(fn: () => Promise<T>): Promise<T> {
    this.ensure();
    this.busy = true;
    try {
      return await fn();
    } finally {
      this.busy = false;
    }
  }

  async sale(req: SaleRequest, opts: OpOptions = {}): Promise<TerminalResult> {
    if (!(req.amount > 0)) throw new TerminalError("protocol", "Monto inválido");
    return this.run(async () => {
      const scenario = this.o.forced ?? scenarioForAmount(req.amount);
      opts.onEvent?.({ type: "sent" });
      opts.onEvent?.({ type: "prompt", message: "Acerque, inserte o deslice la tarjeta" });
      await this.wait(this.o.delayMs / 2, opts.signal);
      if (scenario === "comm_error") throw new TerminalError("transport", "Se cortó la comunicación con la terminal");
      opts.onEvent?.({ type: "prompt", message: "Procesando" });
      await this.wait(this.o.delayMs / 2, opts.signal);

      const pick = (() => {
        const want = req.installments && req.installments > 1 ? "credit" : (req.cardType ?? null);
        const pool = want ? BRANDS.filter((b) => b.type === want) : BRANDS;
        return pool[Math.floor(this.rand() * pool.length)]!;
      })();
      const last4 = String(Math.floor(this.rand() * 10000)).padStart(4, "0");
      const r = this.base("sale", req.amount);
      r.cardBrand = pick.brand;
      r.cardType = pick.type;
      r.last4 = last4;
      r.installments = pick.type === "credit" ? (req.installments ?? 1) : 1;
      if (scenario === "approve" || scenario === "no_response") {
        const cupon = String(++this.cuponSeq);
        r.approved = true;
        r.cupon = cupon;
        r.authCode = String(Math.floor(this.rand() * 1_000_000)).padStart(6, "0");
        r.responseCode = "00";
        r.message = "APROBADA";
        this.batch.push({ cupon, amount: req.amount, voided: false, kind: "sale" });
      } else {
        r.responseCode = scenario === "decline_funds" ? "51" : "05";
        r.message = scenario === "decline_funds" ? "FONDOS INSUFICIENTES" : "NO AUTORIZADA";
      }
      r.raw = JSON.stringify({ sim: true, scenario, ref: req.reference });
      this.last = r;
      if (scenario === "no_response") {
        // La terminal cobró pero la respuesta "se pierde": sólo sale por
        // timeout o cancelación, y se recupera con lastTransaction().
        await this.wait(24 * 3600_000, opts.signal);
      }
      return r;
    });
  }

  async void(req: VoidRequest, opts: OpOptions = {}): Promise<TerminalResult> {
    return this.run(async () => {
      await this.wait(this.o.delayMs / 2, opts.signal);
      const r = this.base("void", req.amount);
      const tx = this.batch.find((t) => t.cupon === String(req.cupon).replace(/^0+/, "") && t.kind === "sale");
      if (!tx || tx.voided) {
        r.responseCode = "12";
        r.message = tx ? "YA ANULADA" : "CUPON INEXISTENTE EN EL LOTE";
      } else if (Math.abs(tx.amount - req.amount) > 0.005) {
        r.responseCode = "13";
        r.message = "MONTO NO COINCIDE";
      } else {
        tx.voided = true;
        r.approved = true;
        r.cupon = String(++this.cuponSeq);
        r.authCode = String(Math.floor(this.rand() * 1_000_000)).padStart(6, "0");
        r.responseCode = "00";
        r.message = "ANULACION APROBADA";
      }
      r.raw = JSON.stringify({ sim: true, op: "void", ref: req.reference });
      return r;
    });
  }

  async refund(req: RefundRequest, opts: OpOptions = {}): Promise<TerminalResult> {
    if (!(req.amount > 0)) throw new TerminalError("protocol", "Monto inválido");
    return this.run(async () => {
      await this.wait(this.o.delayMs, opts.signal);
      const r = this.base("refund", req.amount);
      const cupon = String(++this.cuponSeq);
      r.approved = true;
      r.cupon = cupon;
      r.authCode = String(Math.floor(this.rand() * 1_000_000)).padStart(6, "0");
      r.responseCode = "00";
      r.message = "DEVOLUCION APROBADA";
      r.installments = req.installments ?? null;
      this.batch.push({ cupon, amount: -req.amount, voided: false, kind: "refund" });
      r.raw = JSON.stringify({ sim: true, op: "refund", ref: req.reference });
      return r;
    });
  }

  async closeBatch(opts: OpOptions = {}): Promise<CloseBatchResult> {
    return this.run(async () => {
      await this.wait(this.o.delayMs / 2, opts.signal);
      const live = this.batch.filter((t) => !t.voided);
      const total = Math.round(live.reduce((a, t) => a + t.amount, 0) * 100) / 100;
      const res: CloseBatchResult = {
        ok: true,
        lote: String(this.lote),
        count: live.length,
        total,
        message: "CIERRE OK",
        raw: JSON.stringify({ sim: true, op: "close_batch" }),
        at: this.o.now().toISOString(),
      };
      this.lote += 1;
      this.batch = [];
      return res;
    });
  }

  async lastTransaction(): Promise<TerminalResult | null> {
    return this.last;
  }

  async status(): Promise<TerminalStatus> {
    return {
      connected: this.connected,
      ready: this.connected && !this.busy,
      model: "Simulador NinjaPOS",
      serial: this.o.terminalNumber,
      message: this.connected ? "Listo" : "Desconectado",
    };
  }
}
