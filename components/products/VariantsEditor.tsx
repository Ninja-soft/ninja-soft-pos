"use client";

import { useEffect, useState } from "react";
import { Trash2, Wand2 } from "lucide-react";
import { Button } from "@/components/ui/Button";
import { Input } from "@/components/ui/Input";
import { useToast } from "@/components/ui/Toast";
import {
  generateCombos,
  parseAxisValues,
  variantSku,
  type Combo,
} from "@/lib/variants/matrix";
import {
  useVariants,
  useSaveVariants,
  useRemoveVariant,
} from "@/modules/products/hooks";
import type { VariantRow } from "@/modules/products/api";

interface Props {
  productId: string;
  tenantId: string;
  parentSku: string | null;
  parentPrice: number;
}

// Fila en edición (extiende VariantRow con campos de UI no persistidos).
interface EditRow extends VariantRow {
  // Clave estable para React mientras la fila no tiene id (combos nuevos).
  key: string;
  // false cuando el combo ya no está en los ejes definidos → ofrece "quitar".
  inAxes: boolean;
}

function comboKey(c: Combo): string {
  return `${c.option1}␟${c.option2 ?? ""}`;
}

function comboLabel(option1: string, option2: string | null): string {
  return option2 != null ? `${option1} / ${option2}` : option1;
}

export function VariantsEditor({
  productId,
  tenantId,
  parentSku,
  parentPrice,
}: Props) {
  const { toast } = useToast();
  const { data: existing } = useVariants(productId, true);
  const save = useSaveVariants(productId, tenantId);
  const removeVariant = useRemoveVariant(productId);

  // Definición de ejes (texto crudo del usuario).
  const [axis1Name, setAxis1Name] = useState("");
  const [axis1Values, setAxis1Values] = useState("");
  const [axis2Name, setAxis2Name] = useState("");
  const [axis2Values, setAxis2Values] = useState("");

  const [rows, setRows] = useState<EditRow[]>([]);

  // Hidrata ejes + filas desde lo guardado. Solo cuando llegan los datos
  // (no reescribe lo que el usuario está editando en cada render).
  const [hydrated, setHydrated] = useState(false);
  useEffect(() => {
    if (!existing || hydrated) return;
    setRows(
      existing.map((v) => ({
        key: v.id,
        id: v.id,
        option1: v.option1,
        option2: v.option2,
        sku: v.sku,
        barcode: v.barcode,
        price_override: v.price_override,
        stock: v.stock,
        inAxes: true,
      })),
    );
    setHydrated(true);
  }, [existing, hydrated]);

  function generate() {
    const axes = [
      { name: axis1Name.trim() || "Eje 1", values: parseAxisValues(axis1Values) },
      { name: axis2Name.trim() || "Eje 2", values: parseAxisValues(axis2Values) },
    ];
    const combos = generateCombos(axes);
    if (combos.length === 0) {
      toast({
        title: "Definí al menos un eje con valores",
        variant: "error",
      });
      return;
    }

    const wantedKeys = new Set(combos.map(comboKey));
    const byKey = new Map(rows.map((r) => [comboKey(r), r]));

    // Combos nuevos → fila nueva con sku auto; combos existentes conservan
    // su id/stock/precio. Filas fuera de los ejes quedan marcadas inAxes=false
    // (no se borran: se ofrece "quitar").
    const next: EditRow[] = combos.map((c) => {
      const prev = byKey.get(comboKey(c));
      if (prev) return { ...prev, inAxes: true };
      return {
        key: comboKey(c),
        option1: c.option1,
        option2: c.option2,
        sku: variantSku(parentSku, c),
        barcode: null,
        price_override: null,
        stock: 0,
        inAxes: true,
      };
    });

    const orphans = rows
      .filter((r) => !wantedKeys.has(comboKey(r)))
      .map((r) => ({ ...r, inAxes: false }));

    setRows([...next, ...orphans]);
  }

  function patchRow(key: string, patch: Partial<EditRow>) {
    setRows((rs) => rs.map((r) => (r.key === key ? { ...r, ...patch } : r)));
  }

  function dropRow(row: EditRow) {
    if (row.id) {
      // Persistida → baja lógica inmediata.
      removeVariant.mutate(row.id, {
        onSuccess: () => {
          setRows((rs) => rs.filter((r) => r.key !== row.key));
          toast({ title: "Variante eliminada", variant: "success" });
        },
        onError: () =>
          toast({ title: "No se pudo eliminar", variant: "error" }),
      });
      return;
    }
    // Solo en memoria → la saco de la lista.
    setRows((rs) => rs.filter((r) => r.key !== row.key));
  }

  function persist() {
    const toSave = rows.filter((r) => r.inAxes || r.id);
    if (toSave.length === 0) {
      toast({ title: "No hay combinaciones para guardar", variant: "error" });
      return;
    }
    const axes = [axis1Name.trim(), axis2Name.trim()].filter(Boolean);
    save.mutate(
      {
        rows: toSave.map(({ key: _k, inAxes: _a, ...rest }) => rest),
        axes: axes.length ? axes : ["Eje 1"],
      },
      {
        onSuccess: () => {
          setHydrated(false); // re-hidrata con ids reales
          toast({ title: "Variantes guardadas", variant: "success" });
        },
        onError: (e) =>
          toast({
            title: "No se pudo guardar",
            description: e instanceof Error ? e.message : undefined,
            variant: "error",
          }),
      },
    );
  }

  return (
    <div className="rounded-lg border border-border bg-muted/30 p-3">
      <div className="mb-2 text-sm font-medium text-foreground">
        Variantes (talle / color…)
      </div>
      <p className="mb-3 text-xs text-muted-foreground">
        Definí hasta dos ejes con sus valores (ej. Talle: S, M, L y Color: Rojo,
        Negro) y generá la matriz de combinaciones. Cada combinación tiene su
        propio SKU, código de barras, precio y stock. El stock del producto vive
        acá, en las variantes.
      </p>

      {/* Definición de ejes */}
      <div className="space-y-2">
        <div className="grid grid-cols-2 gap-2">
          <Input
            label="Eje 1 (nombre)"
            placeholder="Talle"
            value={axis1Name}
            onChange={(e) => setAxis1Name(e.target.value)}
          />
          <Input
            label="Valores (separados por coma)"
            placeholder="S, M, L"
            value={axis1Values}
            onChange={(e) => setAxis1Values(e.target.value)}
          />
        </div>
        <div className="grid grid-cols-2 gap-2">
          <Input
            label="Eje 2 (opcional)"
            placeholder="Color"
            value={axis2Name}
            onChange={(e) => setAxis2Name(e.target.value)}
          />
          <Input
            label="Valores (separados por coma)"
            placeholder="Rojo, Negro"
            value={axis2Values}
            onChange={(e) => setAxis2Values(e.target.value)}
          />
        </div>
        <Button
          type="button"
          variant="secondary"
          size="sm"
          onClick={generate}
        >
          <Wand2 size={15} /> Generar combinaciones
        </Button>
      </div>

      {/* Tabla de combinaciones */}
      <div className="mt-4">
        {rows.length === 0 ? (
          <p className="rounded-md border border-dashed border-border p-3 text-xs text-muted-foreground">
            Todavía no hay combinaciones. Cargá los ejes arriba y tocá
            “Generar combinaciones”.
          </p>
        ) : (
          <div className="space-y-2">
            {rows.map((r) => (
              <div
                key={r.key}
                className={`rounded-md border bg-background p-2 ${
                  r.inAxes ? "border-border" : "border-destructive/50"
                }`}
              >
                <div className="mb-2 flex items-center justify-between gap-2">
                  <span className="text-sm font-medium">
                    {comboLabel(r.option1, r.option2)}
                    {!r.inAxes && (
                      <span className="ml-2 text-xs text-destructive">
                        fuera de los ejes
                      </span>
                    )}
                  </span>
                  <button
                    type="button"
                    onClick={() => dropRow(r)}
                    className="text-muted-foreground hover:text-destructive"
                    title="Quitar variante"
                  >
                    <Trash2 size={14} />
                  </button>
                </div>
                <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
                  <input
                    value={r.sku ?? ""}
                    onChange={(e) =>
                      patchRow(r.key, { sku: e.target.value || null })
                    }
                    placeholder="SKU"
                    className="h-9 w-full rounded-lg border border-input bg-background px-2 text-sm text-foreground outline-none focus:border-ninja-flameSoft"
                  />
                  <input
                    value={r.barcode ?? ""}
                    onChange={(e) =>
                      patchRow(r.key, { barcode: e.target.value || null })
                    }
                    placeholder="Cód. barras"
                    className="h-9 w-full rounded-lg border border-input bg-background px-2 text-sm text-foreground outline-none focus:border-ninja-flameSoft"
                  />
                  <input
                    type="number"
                    step="0.01"
                    value={r.price_override ?? ""}
                    onChange={(e) =>
                      patchRow(r.key, {
                        price_override:
                          e.target.value === "" ? null : Number(e.target.value),
                      })
                    }
                    placeholder={`${parentPrice} (hereda)`}
                    className="h-9 w-full rounded-lg border border-input bg-background px-2 text-right text-sm text-foreground outline-none focus:border-ninja-flameSoft"
                  />
                  <input
                    type="number"
                    step="0.001"
                    value={r.stock}
                    onChange={(e) =>
                      patchRow(r.key, { stock: Number(e.target.value) })
                    }
                    placeholder="Stock"
                    className="h-9 w-full rounded-lg border border-input bg-background px-2 text-right text-sm text-foreground outline-none focus:border-ninja-flameSoft"
                  />
                </div>
              </div>
            ))}
          </div>
        )}
      </div>

      <div className="mt-3 flex justify-end">
        <Button type="button" size="sm" onClick={persist} loading={save.isPending}>
          Guardar variantes
        </Button>
      </div>
    </div>
  );
}
