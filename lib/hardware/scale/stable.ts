// Peso estable y tara (F10 · H24, ADR-063). PURO.
//
// Una lectura sirve para vender sólo cuando el peso está quieto:
//   • si la balanza informa estabilidad ("ST" / "US"), manda la balanza;
//   • si no la informa, se considera estable cuando las últimas
//     `minSamples` lecturas están dentro de ± `toleranceKg` durante al menos
//     `minStableMs`.
// La tara es del POS (descuenta el envase): neto = bruto - tara.

export interface StableOptions {
  toleranceKg: number;
  minSamples: number;
  minStableMs: number;
}

export const DEFAULT_STABLE: StableOptions = { toleranceKg: 0.002, minSamples: 3, minStableMs: 400 };

export interface Sample {
  weightKg: number;
  at: number;
  stableFlag: boolean | null;
}

export class StableDetector {
  private samples: Sample[] = [];
  constructor(private readonly opts: StableOptions = DEFAULT_STABLE) {}

  /** Suma una lectura y devuelve si el peso quedó estable. */
  push(s: Sample): boolean {
    this.samples.push(s);
    // Nos quedamos con lo necesario para decidir.
    const keep = Math.max(this.opts.minSamples, 20);
    if (this.samples.length > keep) this.samples.splice(0, this.samples.length - keep);
    if (s.stableFlag !== null) return s.stableFlag;
    return this.softwareStable();
  }

  private softwareStable(): boolean {
    const n = this.opts.minSamples;
    if (this.samples.length < n) return false;
    const last = this.samples[this.samples.length - 1]!;
    // Todas las lecturas recientes dentro de la tolerancia respecto de la última.
    let from = this.samples.length - 1;
    while (from > 0 && Math.abs(this.samples[from - 1]!.weightKg - last.weightKg) <= this.opts.toleranceKg + 1e-9) {
      from -= 1;
    }
    const run = this.samples.length - from;
    if (run < n) return false;
    return last.at - this.samples[from]!.at >= this.opts.minStableMs;
  }

  reset() {
    this.samples = [];
  }
}

const r3 = (n: number) => Math.round(n * 1000) / 1000;

/** Peso neto (bruto menos tara), con 3 decimales. */
export function netWeight(grossKg: number, tareKg: number): number {
  return r3(grossKg - Math.max(0, tareKg));
}

/** ¿El peso sirve para agregar al carrito? */
export function weightUsable(netKg: number, stable: boolean, minKg = 0.002): boolean {
  return stable && netKg >= minKg;
}

/** Texto del peso para la pantalla ("0,350 kg"). */
export function formatKg(kg: number): string {
  return `${kg.toLocaleString("es-AR", { minimumFractionDigits: 3, maximumFractionDigits: 3 })} kg`;
}
