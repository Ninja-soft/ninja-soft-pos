"use client";

import { useEffect, useMemo, useState } from "react";
import { Modal } from "@/components/ui/Modal";
import { Button } from "@/components/ui/Button";
import { useToast } from "@/components/ui/Toast";
import {
  useProductModifiers,
  modifiersSummary,
  type ModifierGroupWithOptions,
  type ModifierOption,
  type SaleLineModifierGroup,
} from "@/modules/products/modifiers";
import { formatCurrency } from "@/lib/utils/format";

export interface ModifierPickerProduct {
  id: string;
  name: string;
  sku: string | null;
  price: number; // precio base (ya resuelto por la lista mostrador)
  warrantyMonths?: number;
}

// Selector de modificadores al agregar un producto con grupos (H37). Grupos
// obligatorios primero; radio para max=1, multi (con límite) para varios. Muestra
// el precio en vivo (base + deltas) y valida min/max antes de confirmar.
export function ModifierPickerModal({
  product,
  onClose,
  onConfirm,
}: {
  product: ModifierPickerProduct | null;
  onClose: () => void;
  onConfirm: (args: {
    price: number;
    modifiers: SaleLineModifierGroup[];
    modifiersLabel: string;
  }) => void;
}) {
  const { toast } = useToast();
  const { data: groups, isLoading } = useProductModifiers(
    product?.id ?? null,
    product !== null,
  );

  // Selección por grupo: set de option ids elegidos.
  const [selected, setSelected] = useState<Record<string, Set<string>>>({});

  // Reset al abrir/cambiar de producto.
  useEffect(() => {
    setSelected({});
  }, [product?.id]);

  // Solo opciones activas; grupos obligatorios primero, luego por sort.
  const groupsView = useMemo<ModifierGroupWithOptions[]>(() => {
    const gs = (groups ?? []).map((g) => ({
      ...g,
      options: g.options.filter((o) => o.is_active),
    }));
    return gs.sort((a, b) => {
      if (a.required !== b.required) return a.required ? -1 : 1;
      return a.sort - b.sort;
    });
  }, [groups]);

  function isRadio(g: ModifierGroupWithOptions): boolean {
    return g.max_select === 1;
  }

  function toggle(g: ModifierGroupWithOptions, opt: ModifierOption) {
    setSelected((prev) => {
      const cur = new Set(prev[g.id] ?? []);
      if (isRadio(g)) {
        // Radio: reemplaza la elección del grupo.
        return { ...prev, [g.id]: new Set([opt.id]) };
      }
      if (cur.has(opt.id)) {
        cur.delete(opt.id);
      } else {
        // Multi con tope: no deja superar el máximo.
        if (g.max_select != null && cur.size >= g.max_select) {
          toast({
            title: `Máximo ${g.max_select} en “${g.name}”`,
            variant: "error",
          });
          return prev;
        }
        cur.add(opt.id);
      }
      return { ...prev, [g.id]: cur };
    });
  }

  // Snapshot de los grupos/opciones elegidos (para precio, label y persistencia).
  const chosen = useMemo<SaleLineModifierGroup[]>(() => {
    const out: SaleLineModifierGroup[] = [];
    for (const g of groupsView) {
      const ids = selected[g.id];
      if (!ids || ids.size === 0) continue;
      const opts = g.options
        .filter((o) => ids.has(o.id))
        .map((o) => ({ name: o.name, price_delta: o.price_delta }));
      if (opts.length > 0) out.push({ group: g.name, options: opts });
    }
    return out;
  }, [groupsView, selected]);

  const delta = chosen.reduce(
    (acc, g) => acc + g.options.reduce((a, o) => a + (o.price_delta || 0), 0),
    0,
  );
  const price = (product?.price ?? 0) + delta;

  function confirm() {
    if (!product) return;
    // Validación min/max por grupo.
    for (const g of groupsView) {
      const n = selected[g.id]?.size ?? 0;
      if ((g.required || g.min_select > 0) && n < Math.max(g.min_select, g.required ? 1 : 0)) {
        toast({
          title:
            g.min_select > 1
              ? `Elegí al menos ${g.min_select} en “${g.name}”`
              : `“${g.name}” es obligatorio`,
          variant: "error",
        });
        return;
      }
      if (g.max_select != null && n > g.max_select) {
        toast({ title: `Máximo ${g.max_select} en “${g.name}”`, variant: "error" });
        return;
      }
    }
    onConfirm({ price, modifiers: chosen, modifiersLabel: modifiersSummary(chosen) });
  }

  return (
    <Modal
      open={product !== null}
      onOpenChange={(o) => !o && onClose()}
      title={product ? product.name : "Modificadores"}
    >
      <div className="space-y-4">
        {isLoading && (
          <p className="py-6 text-center text-sm text-muted-foreground">Cargando opciones…</p>
        )}
        {!isLoading && groupsView.length === 0 && (
          <p className="py-6 text-center text-sm text-muted-foreground">
            Este producto no tiene modificadores cargados.
          </p>
        )}

        <div className="max-h-[55vh] space-y-4 overflow-y-auto">
          {groupsView.map((g) => {
            const count = selected[g.id]?.size ?? 0;
            return (
              <div key={g.id}>
                <div className="mb-1.5 flex items-center justify-between gap-2">
                  <span className="text-sm font-semibold text-foreground">
                    {g.name}
                    {g.required && <span className="ml-1 text-ninja-flameSoft">*</span>}
                  </span>
                  <span className="text-xs text-muted-foreground">
                    {isRadio(g)
                      ? "Elegí 1"
                      : g.max_select != null
                        ? `${count}/${g.max_select}`
                        : `${count} elegidas`}
                  </span>
                </div>
                <div className="space-y-1.5">
                  {g.options.map((o) => {
                    const checked = selected[g.id]?.has(o.id) ?? false;
                    return (
                      <label
                        key={o.id}
                        className={`flex cursor-pointer items-center justify-between gap-2 rounded-lg border px-3 py-2 text-sm transition ${
                          checked
                            ? "border-ninja-flameSoft/60 bg-ninja-flame/10"
                            : "border-border hover:bg-muted"
                        }`}
                      >
                        <span className="flex items-center gap-2">
                          <input
                            type={isRadio(g) ? "radio" : "checkbox"}
                            name={`mod-${g.id}`}
                            className="accent-ninja-flame"
                            checked={checked}
                            onChange={() => toggle(g, o)}
                          />
                          <span className="text-foreground">{o.name}</span>
                        </span>
                        {o.price_delta !== 0 && (
                          <span className="text-xs font-medium text-muted-foreground">
                            +{formatCurrency(o.price_delta)}
                          </span>
                        )}
                      </label>
                    );
                  })}
                  {g.options.length === 0 && (
                    <p className="text-xs text-muted-foreground">Sin opciones activas.</p>
                  )}
                </div>
              </div>
            );
          })}
        </div>

        {groupsView.length > 0 && (
          <>
            <div className="flex items-center justify-between border-t border-border pt-3">
              <span className="text-sm text-muted-foreground">Precio</span>
              <span className="font-price text-2xl font-black tabular-nums text-foreground">
                {formatCurrency(price)}
              </span>
            </div>
            <div className="flex justify-end gap-2">
              <Button type="button" variant="ghost" onClick={onClose}>
                Cancelar
              </Button>
              <Button type="button" onClick={confirm}>
                Agregar al carrito
              </Button>
            </div>
          </>
        )}
      </div>
    </Modal>
  );
}
