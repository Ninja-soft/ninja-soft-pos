"use client";

// Menús por horario / franja (F13 · H47). Un menú agrupa productos y vale en
// ventanas horarias (día + rango). El POS puede filtrar la carta al menú vigente
// (resolver active_menu_ids). CRUD por tabla directa con RLS (escritura sólo
// owner/manager, enforced server-side). Las tablas menus/menu_windows/
// product_menus no están en types/database.ts (no se regenera): tipado explícito
// + cast, igual que modules/dining/api.ts. La DB + RLS validan.

import { createClient } from "@/lib/supabase/client";

export interface MenuWindow {
  id: string;
  menu_id: string;
  weekday: number; // 0=domingo..6=sábado
  start_min: number; // minutos del día (hora local AR)
  end_min: number;
}

export interface Menu {
  id: string;
  name: string;
  is_active: boolean;
  sort: number;
  windows: MenuWindow[];
}

export interface MenuInput {
  name: string;
  is_active?: boolean;
  sort?: number;
}

export interface MenuWindowInput {
  weekday: number;
  start_min: number;
  end_min: number;
}

export const menusApi = {
  // Menús del tenant (no borrados) + sus ventanas. Dos lecturas (menus, windows)
  // ensambladas en cliente, para no depender de un embed tipado.
  list: async (): Promise<Menu[]> => {
    const supabase = createClient();
    const { data: menus, error } = await supabase
      .from("menus" as never)
      .select("id, name, is_active, sort")
      .is("deleted_at", null)
      .order("sort")
      .order("name");
    if (error) throw error;
    const rows = (menus ?? []) as unknown as Omit<Menu, "windows">[];
    if (rows.length === 0) return [];

    const { data: wins, error: werr } = await supabase
      .from("menu_windows" as never)
      .select("id, menu_id, weekday, start_min, end_min")
      .in(
        "menu_id",
        rows.map((m) => m.id),
      )
      .order("weekday")
      .order("start_min");
    if (werr) throw werr;
    const windows = (wins ?? []) as unknown as MenuWindow[];

    return rows.map((m) => ({
      ...m,
      windows: windows.filter((w) => w.menu_id === m.id),
    }));
  },

  create: async (input: MenuInput): Promise<string> => {
    const supabase = createClient();
    const { data, error } = await supabase
      .from("menus" as never)
      .insert({
        name: input.name.trim() || "Menú",
        is_active: input.is_active ?? true,
        sort: input.sort ?? 0,
      } as never)
      .select("id")
      .single();
    if (error) throw error;
    return (data as unknown as { id: string }).id;
  },

  update: async (
    id: string,
    patch: Partial<MenuInput>,
  ): Promise<void> => {
    const supabase = createClient();
    const payload: Record<string, unknown> = {};
    if (patch.name !== undefined) payload.name = patch.name.trim() || "Menú";
    if (patch.is_active !== undefined) payload.is_active = patch.is_active;
    if (patch.sort !== undefined) payload.sort = patch.sort;
    const { error } = await supabase
      .from("menus" as never)
      .update(payload as never)
      .eq("id", id);
    if (error) throw error;
  },

  // Baja lógica (principio: deleted_at, no DELETE físico).
  remove: async (id: string): Promise<void> => {
    const supabase = createClient();
    const { error } = await supabase
      .from("menus" as never)
      .update({ deleted_at: new Date().toISOString() } as never)
      .eq("id", id);
    if (error) throw error;
  },

  // Reemplaza TODAS las ventanas del menú (borra + inserta), igual que el editor
  // de modificadores reemplaza grupos. Simple y consistente.
  setWindows: async (
    menuId: string,
    windows: MenuWindowInput[],
  ): Promise<void> => {
    const supabase = createClient();
    const { error: derr } = await supabase
      .from("menu_windows" as never)
      .delete()
      .eq("menu_id", menuId);
    if (derr) throw derr;
    if (windows.length === 0) return;
    const { error } = await supabase.from("menu_windows" as never).insert(
      windows.map((w) => ({
        menu_id: menuId,
        weekday: w.weekday,
        start_min: w.start_min,
        end_min: w.end_min,
      })) as never,
    );
    if (error) throw error;
  },

  // Ids de los productos asignados a un menú.
  productIds: async (menuId: string): Promise<string[]> => {
    const supabase = createClient();
    const { data, error } = await supabase
      .from("product_menus" as never)
      .select("product_id")
      .eq("menu_id", menuId);
    if (error) throw error;
    return ((data ?? []) as unknown as { product_id: string }[]).map(
      (r) => r.product_id,
    );
  },

  // Reemplaza el set de productos del menú (borra + inserta).
  setProducts: async (menuId: string, productIds: string[]): Promise<void> => {
    const supabase = createClient();
    const { error: derr } = await supabase
      .from("product_menus" as never)
      .delete()
      .eq("menu_id", menuId);
    if (derr) throw derr;
    if (productIds.length === 0) return;
    const { error } = await supabase.from("product_menus" as never).insert(
      productIds.map((pid) => ({ product_id: pid, menu_id: menuId })) as never,
    );
    if (error) throw error;
  },

  // Menús vigentes AHORA (hora local AR). Resolver tenant-scoped por RLS.
  activeIds: async (): Promise<string[]> => {
    const supabase = createClient();
    const { data, error } = await supabase.rpc("active_menu_ids" as never, {} as never);
    if (error) throw error;
    // setof uuid → array de { active_menu_ids: uuid } o de strings según PostgREST.
    const rows = (data ?? []) as unknown as Array<string | { active_menu_ids: string }>;
    return rows.map((r) => (typeof r === "string" ? r : r.active_menu_ids));
  },
};
