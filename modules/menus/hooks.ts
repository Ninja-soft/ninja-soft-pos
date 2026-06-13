"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  menusApi,
  type MenuInput,
  type MenuWindowInput,
} from "./api";

// Menús por horario (F13 · H47). CRUD + ventanas + asignación de productos +
// "menú activo ahora". Invalida la lista tras cada mutación.

export function useMenus() {
  return useQuery({ queryKey: ["menus", "list"], queryFn: () => menusApi.list() });
}

// Ids de los menús vigentes ahora (hora local AR). refetch cada minuto para que
// el cambio de franja (mediodía, etc.) se note sin recargar.
export function useActiveMenuIds() {
  return useQuery({
    queryKey: ["menus", "active"],
    queryFn: () => menusApi.activeIds(),
    refetchInterval: 60_000,
    staleTime: 30_000,
  });
}

export function useMenuProductIds(menuId: string | null) {
  return useQuery({
    queryKey: ["menus", "products", menuId],
    queryFn: () => menusApi.productIds(menuId as string),
    enabled: !!menuId,
  });
}

export function useMenuMutations() {
  const qc = useQueryClient();
  const invalidate = () => {
    qc.invalidateQueries({ queryKey: ["menus"] });
  };

  const create = useMutation({
    mutationFn: (input: MenuInput) => menusApi.create(input),
    onSuccess: invalidate,
  });

  const update = useMutation({
    mutationFn: ({ id, patch }: { id: string; patch: Partial<MenuInput> }) =>
      menusApi.update(id, patch),
    onSuccess: invalidate,
  });

  const remove = useMutation({
    mutationFn: (id: string) => menusApi.remove(id),
    onSuccess: invalidate,
  });

  const setWindows = useMutation({
    mutationFn: ({ menuId, windows }: { menuId: string; windows: MenuWindowInput[] }) =>
      menusApi.setWindows(menuId, windows),
    onSuccess: invalidate,
  });

  const setProducts = useMutation({
    mutationFn: ({ menuId, productIds }: { menuId: string; productIds: string[] }) =>
      menusApi.setProducts(menuId, productIds),
    onSuccess: invalidate,
  });

  return { create, update, remove, setWindows, setProducts };
}
