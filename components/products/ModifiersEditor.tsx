"use client";

import { useEffect, useState } from "react";
import { Plus, Trash2 } from "lucide-react";
import { Button } from "@/components/ui/Button";
import { Input } from "@/components/ui/Input";
import { useToast } from "@/components/ui/Toast";
import {
  useProductModifiers,
  useSaveProductModifiers,
} from "@/modules/products/modifiers";
import {
  MODIFIER_PRESETS,
  findModifierPreset,
  type ModifierPreset,
} from "@/lib/gastro/modifierPresets";

// Fila editable de opción (en memoria mientras se edita).
interface OptionRow {
  key: string;
  name: string;
  price_delta: string; // string en el input; se castea al guardar
  is_active: boolean;
}

// Fila editable de grupo + sus opciones.
interface GroupRow {
  key: string;
  name: string;
  required: boolean;
  min_select: string;
  max_select: string; // "" = sin tope
  options: OptionRow[];
}

function uid(): string {
  return crypto.randomUUID();
}

function emptyOption(): OptionRow {
  return { key: uid(), name: "", price_delta: "0", is_active: true };
}

function emptyGroup(): GroupRow {
  return {
    key: uid(),
    name: "",
    required: false,
    min_select: "0",
    max_select: "1",
    options: [emptyOption()],
  };
}

// Materializa un preset gastronómico (H47) como un GroupRow editable: clona el
// grupo + sus opciones (con el precio sugerido). Tras insertarlo es un grupo más:
// el dueño lo ajusta y guarda con el flujo normal.
function presetToGroup(preset: ModifierPreset): GroupRow {
  return {
    key: uid(),
    name: preset.group.name,
    required: preset.group.required,
    min_select: String(preset.group.min_select),
    max_select: preset.group.max_select == null ? "" : String(preset.group.max_select),
    options: preset.group.options.map((o) => ({
      key: uid(),
      name: o.name,
      price_delta: String(o.price_delta ?? 0),
      is_active: true,
    })),
  };
}

// Editor de modificadores de un producto (H37). Mismo patrón de editor anidado
// del form que KitComponentsEditor / VariantsEditor: edita en memoria y persiste
// todo de un toque (reemplaza grupos+opciones del producto).
export function ModifiersEditor({ productId }: { productId: string }) {
  const { toast } = useToast();
  const { data: existing } = useProductModifiers(productId, true);
  const save = useSaveProductModifiers(productId);

  const [groups, setGroups] = useState<GroupRow[]>([]);
  const [hydrated, setHydrated] = useState(false);

  // Hidrata desde lo guardado una sola vez (no pisa lo que se está editando).
  useEffect(() => {
    if (!existing || hydrated) return;
    setGroups(
      existing.map((g) => ({
        key: g.id,
        name: g.name,
        required: g.required,
        min_select: String(g.min_select),
        max_select: g.max_select == null ? "" : String(g.max_select),
        options: g.options.map((o) => ({
          key: o.id,
          name: o.name,
          price_delta: String(o.price_delta),
          is_active: o.is_active,
        })),
      })),
    );
    setHydrated(true);
  }, [existing, hydrated]);

  function patchGroup(key: string, patch: Partial<GroupRow>) {
    setGroups((gs) => gs.map((g) => (g.key === key ? { ...g, ...patch } : g)));
  }
  function patchOption(gKey: string, oKey: string, patch: Partial<OptionRow>) {
    setGroups((gs) =>
      gs.map((g) =>
        g.key === gKey
          ? {
              ...g,
              options: g.options.map((o) =>
                o.key === oKey ? { ...o, ...patch } : o,
              ),
            }
          : g,
      ),
    );
  }

  function persist() {
    // Validación: cada grupo necesita nombre y al menos una opción con nombre.
    const cleaned = groups.map((g) => ({
      name: g.name.trim(),
      required: g.required,
      min: Math.max(0, Math.trunc(Number(g.min_select) || 0)),
      max: g.max_select.trim() === "" ? null : Math.trunc(Number(g.max_select)),
      options: g.options
        .filter((o) => o.name.trim() !== "")
        .map((o, i) => ({
          name: o.name.trim(),
          price_delta: Number(o.price_delta) || 0,
          sort: i,
          is_active: o.is_active,
        })),
    }));

    for (const g of cleaned) {
      if (g.name === "") {
        toast({ title: "Cada grupo necesita un nombre", variant: "error" });
        return;
      }
      if (g.options.length === 0) {
        toast({
          title: `El grupo “${g.name}” necesita al menos una opción`,
          variant: "error",
        });
        return;
      }
      if (g.max != null && g.max < 1) {
        toast({
          title: `El máximo de “${g.name}” debe ser 1 o más (o vacío)`,
          variant: "error",
        });
        return;
      }
      if (g.max != null && g.max < g.min) {
        toast({
          title: `En “${g.name}”, el máximo no puede ser menor que el mínimo`,
          variant: "error",
        });
        return;
      }
    }

    save.mutate(
      cleaned.map((g, i) => ({
        name: g.name,
        min_select: g.min,
        max_select: g.max,
        required: g.required,
        sort: i,
        options: g.options,
      })),
      {
        onSuccess: () => {
          setHydrated(false); // re-hidrata con ids reales
          toast({ title: "Modificadores guardados", variant: "success" });
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
        Modificadores (tamaños / sabores / toppings)
      </div>
      <p className="mb-3 text-xs text-muted-foreground">
        Agrupá opciones para vender sin crear un producto por combinación. Ej.
        “Tamaño” (elegir 1), “Sabores” (hasta 3), “Toppings” (con +precio). Al
        agregar el producto en el POS se piden estas opciones y el precio suma los
        ajustes.
      </p>

      <div className="space-y-3">
        {groups.length === 0 && (
          <p className="rounded-md border border-dashed border-border p-3 text-xs text-muted-foreground">
            Sin grupos de modificadores. Agregá uno abajo (ej. “Sabores”).
          </p>
        )}

        {groups.map((g) => (
          <div key={g.key} className="rounded-md border border-border bg-background p-3">
            <div className="flex items-start justify-between gap-2">
              <Input
                label="Grupo"
                placeholder="Sabores"
                value={g.name}
                onChange={(e) => patchGroup(g.key, { name: e.target.value })}
                className="flex-1"
              />
              <button
                type="button"
                onClick={() => setGroups((gs) => gs.filter((x) => x.key !== g.key))}
                className="mt-7 text-muted-foreground hover:text-destructive"
                title="Quitar grupo"
              >
                <Trash2 size={15} />
              </button>
            </div>

            <div className="mt-2 grid grid-cols-2 gap-2 sm:grid-cols-3">
              <Input
                label="Mínimo"
                type="number"
                min="0"
                step="1"
                value={g.min_select}
                onChange={(e) => patchGroup(g.key, { min_select: e.target.value })}
              />
              <Input
                label="Máximo"
                type="number"
                min="1"
                step="1"
                placeholder="sin tope"
                value={g.max_select}
                onChange={(e) => patchGroup(g.key, { max_select: e.target.value })}
              />
              <label className="flex items-center gap-2 self-end pb-2.5 text-sm text-foreground">
                <input
                  type="checkbox"
                  className="accent-ninja-flame"
                  checked={g.required}
                  onChange={(e) => patchGroup(g.key, { required: e.target.checked })}
                />
                Obligatorio
              </label>
            </div>

            {/* Opciones del grupo */}
            <div className="mt-3 space-y-2">
              <div className="text-xs font-medium text-muted-foreground">Opciones</div>
              {g.options.map((o) => (
                <div key={o.key} className="flex items-center gap-2">
                  <input
                    value={o.name}
                    onChange={(e) => patchOption(g.key, o.key, { name: e.target.value })}
                    placeholder="Frutilla"
                    className="h-9 min-w-0 flex-1 rounded-lg border border-input bg-background px-2 text-sm text-foreground outline-none focus:border-ninja-flameSoft"
                  />
                  <div className="flex items-center gap-1">
                    <span className="text-xs text-muted-foreground">+$</span>
                    <input
                      type="number"
                      step="0.01"
                      value={o.price_delta}
                      onChange={(e) =>
                        patchOption(g.key, o.key, { price_delta: e.target.value })
                      }
                      className="h-9 w-20 rounded-lg border border-input bg-background px-2 text-right text-sm text-foreground outline-none focus:border-ninja-flameSoft"
                    />
                  </div>
                  <label
                    className="flex items-center gap-1 text-xs text-muted-foreground"
                    title="Activa (se ofrece en el POS)"
                  >
                    <input
                      type="checkbox"
                      className="accent-ninja-flame"
                      checked={o.is_active}
                      onChange={(e) =>
                        patchOption(g.key, o.key, { is_active: e.target.checked })
                      }
                    />
                    Activa
                  </label>
                  <button
                    type="button"
                    onClick={() =>
                      patchGroup(g.key, {
                        options: g.options.filter((x) => x.key !== o.key),
                      })
                    }
                    className="text-muted-foreground hover:text-destructive"
                    title="Quitar opción"
                  >
                    <Trash2 size={14} />
                  </button>
                </div>
              ))}
              <Button
                type="button"
                variant="ghost"
                size="sm"
                onClick={() =>
                  patchGroup(g.key, { options: [...g.options, emptyOption()] })
                }
              >
                <Plus size={14} /> Agregar opción
              </Button>
            </div>
          </div>
        ))}
      </div>

      <div className="mt-3 flex flex-wrap items-center justify-between gap-2">
        <div className="flex flex-wrap items-center gap-2">
          <Button
            type="button"
            variant="secondary"
            size="sm"
            onClick={() => setGroups((gs) => [...gs, emptyGroup()])}
          >
            <Plus size={15} /> Agregar grupo
          </Button>
          {/* Presets gastronómicos (H47): insertan un grupo listo (punto de
              cocción, tipo de leche, sabores, extras…) para editar y guardar. */}
          <select
            aria-label="Agregar un preset gastronómico"
            value=""
            onChange={(e) => {
              const preset = findModifierPreset(e.target.value);
              if (preset) {
                setGroups((gs) => [...gs, presetToGroup(preset)]);
                toast({ title: `Preset “${preset.label}” agregado`, variant: "success" });
              }
              e.target.value = "";
            }}
            className="h-9 rounded-lg border border-input bg-background px-2 text-sm text-foreground outline-none transition focus:border-ninja-flameSoft"
          >
            <option value="">+ Preset gastronómico…</option>
            {MODIFIER_PRESETS.map((p) => (
              <option key={p.key} value={p.key}>
                {p.label} · {p.hint}
              </option>
            ))}
          </select>
        </div>
        <Button type="button" size="sm" onClick={persist} loading={save.isPending}>
          Guardar modificadores
        </Button>
      </div>
    </div>
  );
}
