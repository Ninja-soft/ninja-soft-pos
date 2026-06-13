"use client";

// Recetas / escandallo de producto (F13 · H50 — gastronomía).
// Un plato tiene una lista de INSUMOS (ingrediente + cantidad + unidad + costo
// unitario). El costo del plato = suma de qty*unit_cost; el margen = precio de
// venta − costo. Se configura en la ficha del producto. Esta capa NO descuenta
// stock al vender (follow-up): es la definición + el costo/margen estimado.
//
// types/database.ts no se regenera: product_recipes aún no está tipada. Tipamos
// explícito y casteamos el nombre de tabla / payload (mismo enfoque que
// modules/products/modifiers.ts). La DB + RLS validan.

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { createClient } from "@/lib/supabase/client";

export interface RecipeItem {
  id: string;
  product_id: string;
  ingredient: string;
  qty: number;
  unit: string | null;
  unit_cost: number;
  sort: number;
}

// Lo que se guarda (sin ids: se reemplaza todo el set del producto).
export interface RecipeItemInput {
  ingredient: string;
  qty: number;
  unit: string | null;
  unit_cost: number;
  sort: number;
}

export const recipesApi = {
  // Insumos de la receta de un producto, ordenados por sort.
  listForProduct: async (productId: string): Promise<RecipeItem[]> => {
    const supabase = createClient();
    const { data, error } = await supabase
      .from("product_recipes" as never)
      .select("id, product_id, ingredient, qty, unit, unit_cost, sort")
      .eq("product_id", productId)
      .order("sort")
      .order("ingredient");
    if (error) throw error;
    return (data ?? []) as unknown as RecipeItem[];
  },

  // Reemplaza la receta del producto (borra + inserta). Set chico por producto;
  // mismo criterio que kits/modificadores.
  saveForProduct: async (
    productId: string,
    items: RecipeItemInput[],
  ): Promise<void> => {
    const supabase = createClient();
    const del = await supabase
      .from("product_recipes" as never)
      .delete()
      .eq("product_id", productId);
    if (del.error) throw del.error;
    if (items.length === 0) return;
    const { error } = await supabase.from("product_recipes" as never).insert(
      items.map((it) => ({
        product_id: productId,
        ingredient: it.ingredient,
        qty: it.qty,
        unit: it.unit,
        unit_cost: it.unit_cost,
        sort: it.sort,
      })) as never,
    );
    if (error) throw error;
  },
};

export function useProductRecipe(productId: string | null, enabled: boolean) {
  return useQuery({
    queryKey: ["products", "recipe", productId],
    queryFn: () => recipesApi.listForProduct(productId as string),
    enabled: enabled && Boolean(productId),
  });
}

export function useSaveProductRecipe(productId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (items: RecipeItemInput[]) =>
      recipesApi.saveForProduct(productId, items),
    onSuccess: () =>
      qc.invalidateQueries({ queryKey: ["products", "recipe", productId] }),
  });
}

// ── Helpers puros (costo / margen) ───────────────────────────────────────────

// Costo de una línea de receta: cantidad × costo unitario (nunca negativo).
export function lineCost(qty: number, unitCost: number): number {
  const c = (Number(qty) || 0) * (Number(unitCost) || 0);
  return c > 0 ? c : 0;
}

// Costo total del plato: suma de las líneas.
export function recipeCost(items: { qty: number; unit_cost: number }[]): number {
  return items.reduce((acc, it) => acc + lineCost(it.qty, it.unit_cost), 0);
}

// Margen en dinero: precio de venta − costo (puede ser negativo si se vende
// por debajo del costo — se muestra en rojo en la UI).
export function marginAmount(salePrice: number, cost: number): number {
  return (Number(salePrice) || 0) - (Number(cost) || 0);
}

// Margen porcentual sobre el precio de venta: (precio − costo) / precio × 100.
// Con precio 0 devuelve null (no se puede calcular un %).
export function marginPct(salePrice: number, cost: number): number | null {
  const price = Number(salePrice) || 0;
  if (price <= 0) return null;
  return (marginAmount(price, cost) / price) * 100;
}
