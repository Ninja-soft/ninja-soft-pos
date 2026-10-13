"use client";

import { useState } from "react";
import { BookOpenCheck, Check } from "lucide-react";
import { Button } from "@/components/ui/Button";
import { useToast } from "@/components/ui/Toast";
import { accErrorMessage } from "@/lib/accounting/sources";
import { useAccountingMutations } from "@/modules/accounting/hooks";

const POINTS = [
  "Plan de cuentas comercial argentino, editable, con centros de costo por sucursal.",
  "Asientos solos desde ventas, cobros, devoluciones, caja, compras, pagos, tesorería y procesadores.",
  "Mapeos para elegir a qué cuenta va cada medio de cobro, alícuota, proveedor o procesador.",
  "Cierre mensual, Libro Diario, Mayor, sumas y saldos y export para el estudio.",
];

function firstOfMonth(): string {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-01`;
}

/** Alta de la contabilidad del negocio. */
export function SetupCard() {
  const { toast } = useToast();
  const m = useAccountingMutations();
  const [start, setStart] = useState(firstOfMonth());
  const [vat, setVat] = useState<"included_rate" | "none">("included_rate");
  const [cmv, setCmv] = useState<"none" | "perpetual">("none");
  const [fy, setFy] = useState(1);

  async function submit() {
    try {
      await m.setup.mutateAsync({ start_date: start, vat_mode: vat, cmv_mode: cmv, fiscal_year_start_month: fy });
      toast({ title: "Contabilidad activada", description: "Los asientos se generan solos desde ahora. Podés generar los del período desde el Resumen.", variant: "success" });
    } catch (e) {
      toast({ title: "No se pudo activar", description: accErrorMessage(e), variant: "error" });
    }
  }

  const field = "h-10 w-full rounded-lg border border-input bg-background px-3 text-sm text-foreground outline-none transition focus:border-ninja-flameSoft focus:ring-4 focus:ring-ninja-flameSoft/15";

  return (
    <div className="mt-6 grid gap-6 rounded-xl bg-card p-6 ring-1 ring-border lg:grid-cols-[1.1fr_1fr]">
      <div>
        <div className="flex items-center gap-2 text-ninja-flameSoft">
          <BookOpenCheck size={20} />
          <span className="text-sm font-semibold">Activá la contabilidad del negocio</span>
        </div>
        <h2 className="mt-2 text-xl font-bold">Todo lo que pasa en el negocio, en asientos que tu contador puede importar</h2>
        <ul className="mt-4 space-y-2 text-sm text-muted-foreground">
          {POINTS.map((p) => (
            <li key={p} className="flex gap-2">
              <Check size={16} className="mt-0.5 shrink-0 text-success" />
              {p}
            </li>
          ))}
        </ul>
      </div>
      <div className="space-y-4">
        <label className="block text-sm">
          <span className="font-medium">Generar asientos desde</span>
          <input type="date" className={`mt-1 ${field}`} value={start} onChange={(e) => setStart(e.target.value)} />
          <span className="mt-1 block text-xs text-muted-foreground">Lo anterior no se contabiliza (cargalo con un asiento de apertura).</span>
        </label>
        <label className="block text-sm">
          <span className="font-medium">IVA de las ventas</span>
          <select className={`mt-1 ${field}`} value={vat} onChange={(e) => setVat(e.target.value as "included_rate" | "none")}>
            <option value="included_rate" className="bg-popover text-popover-foreground">Responsable inscripto: IVA incluido en el precio, por alícuota del producto</option>
            <option value="none" className="bg-popover text-popover-foreground">Monotributo o exento: sin IVA</option>
          </select>
        </label>
        <label className="block text-sm">
          <span className="font-medium">Costo de lo vendido</span>
          <select className={`mt-1 ${field}`} value={cmv} onChange={(e) => setCmv(e.target.value as "none" | "perpetual")}>
            <option value="none" className="bg-popover text-popover-foreground">Por diferencia de inventario (lo calcula el estudio)</option>
            <option value="perpetual" className="bg-popover text-popover-foreground">En cada venta, al costo vigente del producto</option>
          </select>
        </label>
        <label className="block text-sm">
          <span className="font-medium">El ejercicio empieza en</span>
          <select className={`mt-1 ${field}`} value={fy} onChange={(e) => setFy(Number(e.target.value))}>
            {["Enero", "Febrero", "Marzo", "Abril", "Mayo", "Junio", "Julio", "Agosto", "Septiembre", "Octubre", "Noviembre", "Diciembre"].map((n, i) => (
              <option key={n} value={i + 1} className="bg-popover text-popover-foreground">
                {n}
              </option>
            ))}
          </select>
        </label>
        <Button className="w-full" onClick={() => void submit()} loading={m.setup.isPending}>
          Activar con el plan de cuentas argentino
        </Button>
      </div>
    </div>
  );
}
