"use client";

// Libro IVA Digital (F18 · H108, ADR-076). Va con la facturación electrónica
// (feature facturacion_afip), no con la contabilidad: no usa AccountingFrame.
import { LibroIvaDigital } from "@/components/tax/LibroIvaDigital";

export default function LibroIvaPage() {
  return <LibroIvaDigital />;
}
