"use client";

import { useEffect, useMemo, useState } from "react";
import { Clock, Plus, Search, Trash2, Utensils } from "lucide-react";
import { Button } from "@/components/ui/Button";
import { Input } from "@/components/ui/Input";
import { useToast } from "@/components/ui/Toast";
import { ConfirmDialog } from "@/components/ui/ConfirmDialog";
import { useProducts } from "@/modules/products/hooks";
import {
  useMenus,
  useActiveMenuIds,
  useMenuProductIds,
  useMenuMutations,
} from "@/modules/menus/hooks";
import type { Menu } from "@/modules/menus/api";
import type { Product } from "@/modules/products/api";
import {
  WEEKDAYS,
  WEEKDAYS_SHORT,
  minToTime,
  timeToMin,
  isValidWindow,
} from "@/lib/gastro/menuTime";

// F13 · H47 — Administrador de menús por horario (daypart). El dueño define
// menús (Desayuno, Almuerzo, Cena, Happy hour…), sus ventanas horarias (día +
// rango) y qué productos incluye cada uno. El resolver `active_menu_ids` marca el
// menú vigente ahora. El POS consume esto para filtrar la carta (follow-up).
export function MenusManager() {
  const { toast } = useToast();
  const { data: menus, isLoading } = useMenus();
  const { data: activeIds } = useActiveMenuIds();
  const { create } = useMenuMutations();

  const activeSet = useMemo(() => new Set(activeIds ?? []), [activeIds]);
  const activeNames = useMemo(
    () =>
      (menus ?? [])
        .filter((m: Menu) => activeSet.has(m.id))
        .map((m: Menu) => m.name),
    [menus, activeSet],
  );

  async function addMenu() {
    try {
      await create.mutateAsync({ name: "Nuevo menú", sort: (menus ?? []).length });
      toast({ title: "Menú creado", variant: "success" });
    } catch (e) {
      toast({
        title: "No se pudo crear el menú",
        description: e instanceof Error ? e.message : undefined,
        variant: "error",
      });
    }
  }

  return (
    <div className="space-y-4">
      {/* Menú activo ahora (hora local AR) — valida el resolver en vivo. */}
      <div className="flex flex-wrap items-center gap-2 rounded-lg border border-border bg-muted/30 px-3 py-2 text-sm">
        <Clock size={15} className="text-ninja-flameSoft" />
        <span className="font-medium text-muted-foreground">Activo ahora:</span>
        {activeNames.length > 0 ? (
          activeNames.map((n: string) => (
            <span
              key={n}
              className="rounded-full bg-emerald-400/15 px-2 py-0.5 text-xs font-semibold text-emerald-300"
            >
              {n}
            </span>
          ))
        ) : (
          <span className="text-xs text-muted-foreground">
            {(menus ?? []).length === 0
              ? "Sin menús definidos."
              : "Ningún menú vigente en este horario."}
          </span>
        )}
      </div>

      {isLoading ? (
        <p className="py-4 text-center text-sm text-muted-foreground">Cargando…</p>
      ) : (menus ?? []).length === 0 ? (
        <p className="rounded-lg border border-dashed border-border p-5 text-center text-sm text-muted-foreground">
          Sin menús. Creá uno (ej. “Desayuno”, “Almuerzo”, “Happy hour”) y definí
          su horario y sus productos.
        </p>
      ) : (
        <div className="space-y-3">
          {(menus ?? []).map((m: Menu) => (
            <MenuCard key={m.id} menu={m} active={activeSet.has(m.id)} />
          ))}
        </div>
      )}

      <Button variant="secondary" size="sm" onClick={addMenu} loading={create.isPending}>
        <Plus size={15} /> Agregar menú
      </Button>
    </div>
  );
}

// Una tarjeta de menú: nombre + activo + ventanas horarias + productos. Maneja su
// propio estado local (cada menú se guarda por su cuenta).
function MenuCard({ menu, active }: { menu: Menu; active: boolean }) {
  const { toast } = useToast();
  const { update, remove, setWindows } = useMenuMutations();

  const [name, setName] = useState(menu.name);
  const [isActive, setIsActive] = useState(menu.is_active);
  const [windows, setLocalWindows] = useState(menu.windows);
  const [confirmDel, setConfirmDel] = useState(false);
  const [showProducts, setShowProducts] = useState(false);

  // Re-hidrata si el menú cambia desde el servidor (tras guardar).
  useEffect(() => {
    setName(menu.name);
    setIsActive(menu.is_active);
    setLocalWindows(menu.windows);
  }, [menu]);

  // Estado de la nueva ventana a agregar.
  const [newDay, setNewDay] = useState(1); // lunes por default
  const [newFrom, setNewFrom] = useState("09:00");
  const [newTo, setNewTo] = useState("12:00");

  async function saveMeta() {
    try {
      await update.mutateAsync({
        id: menu.id,
        patch: { name: name.trim() || "Menú", is_active: isActive },
      });
      toast({ title: "Menú guardado", variant: "success" });
    } catch (e) {
      toast({
        title: "No se pudo guardar",
        description: e instanceof Error ? e.message : undefined,
        variant: "error",
      });
    }
  }

  function addWindow() {
    const from = timeToMin(newFrom);
    const to = timeToMin(newTo);
    if (from == null || to == null || !isValidWindow(newDay, from, to)) {
      toast({
        title: "Horario inválido",
        description: "La hora de fin debe ser mayor que la de inicio.",
        variant: "error",
      });
      return;
    }
    setLocalWindows((ws) => [
      ...ws,
      { id: `tmp-${crypto.randomUUID()}`, menu_id: menu.id, weekday: newDay, start_min: from, end_min: to },
    ]);
  }

  async function saveWindows() {
    try {
      await setWindows.mutateAsync({
        menuId: menu.id,
        windows: windows.map((w) => ({
          weekday: w.weekday,
          start_min: w.start_min,
          end_min: w.end_min,
        })),
      });
      toast({ title: "Horarios guardados", variant: "success" });
    } catch (e) {
      toast({
        title: "No se pudieron guardar los horarios",
        description: e instanceof Error ? e.message : undefined,
        variant: "error",
      });
    }
  }

  async function doDelete() {
    try {
      await remove.mutateAsync(menu.id);
      toast({ title: "Menú eliminado", variant: "success" });
      setConfirmDel(false);
    } catch (e) {
      toast({
        title: "No se pudo eliminar",
        description: e instanceof Error ? e.message : undefined,
        variant: "error",
      });
    }
  }

  return (
    <div className="rounded-lg border border-border bg-card p-3">
      {/* Cabecera: nombre + activo + activo-ahora + borrar */}
      <div className="flex flex-wrap items-end gap-2">
        <Input
          label="Nombre del menú"
          value={name}
          onChange={(e) => setName(e.target.value)}
          placeholder="Ej. Almuerzo"
          className="min-w-[160px] flex-1"
        />
        <label className="flex items-center gap-2 pb-2.5 text-sm text-foreground">
          <input
            type="checkbox"
            className="accent-ninja-flame"
            checked={isActive}
            onChange={(e) => setIsActive(e.target.checked)}
          />
          Activo
        </label>
        {active && (
          <span className="mb-2 rounded-full bg-emerald-400/15 px-2 py-0.5 text-xs font-semibold text-emerald-300">
            Vigente ahora
          </span>
        )}
        <button
          type="button"
          onClick={() => setConfirmDel(true)}
          className="mb-1.5 ml-auto rounded-md p-1.5 text-muted-foreground transition hover:bg-muted hover:text-destructive"
          title="Eliminar menú"
        >
          <Trash2 size={16} />
        </button>
      </div>

      {/* Ventanas horarias */}
      <div className="mt-3">
        <div className="mb-1.5 text-xs font-semibold uppercase tracking-wide text-muted-foreground">
          Horarios
        </div>
        {windows.length === 0 ? (
          <p className="mb-2 text-xs text-muted-foreground">
            Sin horarios = disponible siempre. Agregá una franja para limitarlo.
          </p>
        ) : (
          <div className="mb-2 flex flex-wrap gap-1.5">
            {windows.map((w) => (
              <span
                key={w.id}
                className="inline-flex items-center gap-1 rounded-md border border-border bg-muted/40 px-2 py-1 text-xs"
              >
                {WEEKDAYS_SHORT[w.weekday]} · {minToTime(w.start_min)}–{minToTime(w.end_min)}
                <button
                  type="button"
                  onClick={() => setLocalWindows((ws) => ws.filter((x) => x.id !== w.id))}
                  className="text-muted-foreground hover:text-destructive"
                  title="Quitar franja"
                >
                  <Trash2 size={12} />
                </button>
              </span>
            ))}
          </div>
        )}

        {/* Agregar franja */}
        <div className="flex flex-wrap items-end gap-2">
          <label className="text-xs font-medium text-muted-foreground">
            Día
            <select
              value={newDay}
              onChange={(e) => setNewDay(Number(e.target.value))}
              className="ml-1 h-9 rounded-lg border border-input bg-background px-2 text-sm text-foreground outline-none focus:border-ninja-flameSoft"
            >
              {WEEKDAYS.map((d, i) => (
                <option key={i} value={i}>
                  {d}
                </option>
              ))}
            </select>
          </label>
          <label className="text-xs font-medium text-muted-foreground">
            Desde
            <input
              type="time"
              value={newFrom}
              onChange={(e) => setNewFrom(e.target.value)}
              className="ml-1 h-9 rounded-lg border border-input bg-background px-2 text-sm text-foreground outline-none focus:border-ninja-flameSoft"
            />
          </label>
          <label className="text-xs font-medium text-muted-foreground">
            Hasta
            <input
              type="time"
              value={newTo}
              onChange={(e) => setNewTo(e.target.value)}
              className="ml-1 h-9 rounded-lg border border-input bg-background px-2 text-sm text-foreground outline-none focus:border-ninja-flameSoft"
            />
          </label>
          <Button type="button" variant="ghost" size="sm" onClick={addWindow}>
            <Plus size={14} /> Agregar franja
          </Button>
        </div>
      </div>

      {/* Productos del menú (carga perezosa al expandir) */}
      <div className="mt-3">
        <button
          type="button"
          onClick={() => setShowProducts((s) => !s)}
          className="flex items-center gap-1.5 text-xs font-semibold uppercase tracking-wide text-ninja-flameSoft"
        >
          <Utensils size={13} /> {showProducts ? "Ocultar productos" : "Productos del menú"}
        </button>
        {showProducts && <MenuProducts menuId={menu.id} />}
      </div>

      {/* Acciones */}
      <div className="mt-3 flex flex-wrap items-center justify-end gap-2 border-t border-border pt-3">
        <Button
          type="button"
          variant="secondary"
          size="sm"
          onClick={saveWindows}
          loading={setWindows.isPending}
        >
          Guardar horarios
        </Button>
        <Button type="button" size="sm" onClick={saveMeta} loading={update.isPending}>
          Guardar menú
        </Button>
      </div>

      <ConfirmDialog
        open={confirmDel}
        onOpenChange={setConfirmDel}
        title={`Eliminar el menú “${menu.name}”`}
        description="Se da de baja el menú y sus horarios. Los productos no se borran (sólo dejan de pertenecer al menú)."
        confirmLabel="Eliminar menú"
        danger
        loading={remove.isPending}
        onConfirm={doDelete}
      />
    </div>
  );
}

// Asignación de productos al menú: buscador + checklist. Carga los ids asignados
// y permite togglear; guarda el set completo (reemplaza).
function MenuProducts({ menuId }: { menuId: string }) {
  const { toast } = useToast();
  const [search, setSearch] = useState("");
  const { data: products } = useProducts(search);
  const { data: assigned } = useMenuProductIds(menuId);
  const { setProducts } = useMenuMutations();

  // Set local de ids asignados (se siembra de lo guardado; se edita al togglear).
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [seeded, setSeeded] = useState(false);
  useEffect(() => {
    if (assigned && !seeded) {
      setSelected(new Set(assigned));
      setSeeded(true);
    }
  }, [assigned, seeded]);

  const list = useMemo(
    () => (products ?? []).filter((p: Product) => p.is_active),
    [products],
  );

  function toggle(id: string) {
    setSelected((s) => {
      const next = new Set(s);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  async function save() {
    try {
      await setProducts.mutateAsync({ menuId, productIds: [...selected] });
      toast({ title: "Productos del menú guardados", variant: "success" });
    } catch (e) {
      toast({
        title: "No se pudieron guardar los productos",
        description: e instanceof Error ? e.message : undefined,
        variant: "error",
      });
    }
  }

  return (
    <div className="mt-2 rounded-md border border-border bg-background p-2.5">
      <div className="relative mb-2">
        <Search
          size={15}
          className="pointer-events-none absolute left-2.5 top-1/2 -translate-y-1/2 text-muted-foreground"
        />
        <input
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          placeholder="Buscar producto…"
          className="h-9 w-full rounded-lg border border-input bg-background pl-8 pr-3 text-sm text-foreground outline-none focus:border-ninja-flameSoft"
        />
      </div>
      <p className="mb-2 text-xs text-muted-foreground">
        {selected.size} producto(s) en este menú.
      </p>
      <div className="max-h-56 space-y-1 overflow-y-auto">
        {list.length === 0 ? (
          <p className="p-2 text-center text-xs text-muted-foreground">
            {search ? "Sin resultados." : "Escribí para buscar productos."}
          </p>
        ) : (
          list.map((p: Product) => (
            <label
              key={p.id}
              className="flex cursor-pointer items-center gap-2 rounded-md px-2 py-1.5 text-sm hover:bg-muted"
            >
              <input
                type="checkbox"
                className="accent-ninja-flame"
                checked={selected.has(p.id)}
                onChange={() => toggle(p.id)}
              />
              <span className="min-w-0 flex-1 truncate text-foreground">{p.name}</span>
              {p.sku && <span className="shrink-0 text-xs text-muted-foreground">{p.sku}</span>}
            </label>
          ))
        )}
      </div>
      <div className="mt-2 flex justify-end">
        <Button type="button" size="sm" onClick={save} loading={setProducts.isPending}>
          Guardar productos
        </Button>
      </div>
    </div>
  );
}
