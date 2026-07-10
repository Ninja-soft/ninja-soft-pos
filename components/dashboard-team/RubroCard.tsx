"use client";

import { useState } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { AlertTriangle, Sparkles, Store, Trash2 } from "lucide-react";
import { createClient } from "@/lib/supabase/client";
import { Card, CardContent } from "@/components/ui/Card";
import { Heading } from "@/components/ui/Typography";
import { Modal } from "@/components/ui/Modal";
import { Input } from "@/components/ui/Input";
import { Button } from "@/components/ui/Button";
import { useToast } from "@/components/ui/Toast";
import { ConfirmDialog } from "@/components/ui/ConfirmDialog";
import { cn } from "@/lib/utils/cn";
import { IndustryPresetButton } from "@/components/onboarding/IndustryPresetButton";
import { useMyTenant, useSetMyIndustry } from "@/modules/tenants/hooks";
import { useActiveProductCount, useEmptyCatalog } from "@/modules/products/hooks";
import { useDiningEnabled } from "@/modules/dining/hooks";
import { useDeliveryEnabled } from "@/modules/delivery/hooks";
import {
  usePresetSampleCount,
  useDeletePresetSamples,
} from "@/modules/onboarding/hooks";
import {
  VERTICALS,
  VERTICAL_LABELS,
  VERTICAL_DESCRIPTIONS,
  verticalFeatures,
} from "@/lib/verticals/config";

const FEATURE_LABELS: Record<string, string> = {
  quickSale: "Venta rápida",
  byWeight: "Por peso",
  combos: "Combos y promos",
  variants: "Variantes (talle/color)",
  tables: "Mesas y comandas",
};

// Verticales que usan la suite gastronómica (mesas/cocina/delivery). Al cambiar
// a un rubro que NO está acá, los flags operativos dining/delivery se apagan
// (si estaban prendidos): es lo que el dueño espera — "soy textil, no quiero ver
// Salón ni Delivery". Se pueden volver a prender en Operación y productos.
const GASTRO_VERTICALS = new Set(["restaurante", "heladeria", "cafeteria", "panaderia"]);

export function RubroCard() {
  const { toast } = useToast();
  const qc = useQueryClient();
  const { data: ctx } = useMyTenant();
  const setIndustry = useSetMyIndustry();
  const { data: productCount } = useActiveProductCount();
  const emptyCatalog = useEmptyCatalog();
  const { data: diningOn } = useDiningEnabled();
  const { data: deliveryOn } = useDeliveryEnabled();
  // Productos de muestra sembrados por presets: si hay, ofrecemos borrarlos.
  const { data: sampleCount } = usePresetSampleCount();
  const deleteSamples = useDeletePresetSamples();
  const [samplesOpen, setSamplesOpen] = useState(false);
  // Rubro pendiente de confirmar (el cambio pasa por un aviso, ver más abajo).
  const [pending, setPending] = useState<string | null>(null);
  // Vaciar catálogo: modal de confirmación que exige escribir VACIAR.
  const [emptyOpen, setEmptyOpen] = useState(false);
  const [confirmWord, setConfirmWord] = useState("");

  if (!ctx || !ctx.canManage) return null;
  const current = ctx.industry;
  const count = productCount ?? 0;

  function runEmptyCatalog() {
    emptyCatalog.mutate(undefined, {
      onSuccess: (n: number) => {
        setEmptyOpen(false);
        setConfirmWord("");
        toast({
          title: n > 0 ? `Catálogo vaciado (${n} productos)` : "El catálogo ya estaba vacío",
          variant: "success",
        });
      },
      onError: () => toast({ title: "No se pudo vaciar el catálogo", variant: "error" }),
    });
  }

  // Tap en un rubro distinto: NO cambia directo. Abre un aviso que aclara qué
  // hace (y qué NO hace) el cambio de rubro, porque es un punto que confunde:
  // cambiar de rubro sólo adapta las FUNCIONES del POS — los productos, precios y
  // categorías son independientes del rubro y NO se tocan.
  function choose(v: string) {
    if (v === current || setIndustry.isPending) return;
    setPending(v);
  }

  // Apaga los flags operativos de gastronomía (pos_settings). Se dispara al
  // confirmar un cambio a rubro NO gastronómico con mesas/delivery prendidos.
  const gastroOff = useMutation({
    mutationFn: async () => {
      if (!ctx) return;
      const supabase = createClient();
      const { error } = await supabase.from("pos_settings").upsert(
        {
          tenant_id: ctx.tenantId,
          dining_enabled: false,
          delivery_enabled: false,
        } as never,
        { onConflict: "tenant_id" },
      );
      if (error) throw error;
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["dining", "enabled"] });
      qc.invalidateQueries({ queryKey: ["delivery", "enabled"] });
    },
  });

  // ¿El cambio pendiente apaga la gastronomía? (rubro no gastro + algo prendido)
  const pendingTurnsGastroOff =
    pending !== null &&
    !GASTRO_VERTICALS.has(pending) &&
    Boolean(diningOn || deliveryOn);

  function confirmChange() {
    if (!pending) return;
    const v = pending;
    const turnOff = pendingTurnsGastroOff;
    setIndustry.mutate(v, {
      onSuccess: () => {
        setPending(null);
        if (turnOff) {
          gastroOff.mutate(undefined, {
            onSuccess: () =>
              toast({
                title: "Rubro actualizado",
                description:
                  "Mesas/cocina y delivery quedaron apagados. Podés reactivarlos en Operación y productos.",
                variant: "success",
              }),
            onError: () =>
              toast({
                title: "Rubro actualizado, pero no se pudo apagar la gastronomía",
                description: "Apagala a mano en Operación y productos.",
                variant: "error",
              }),
          });
        } else {
          toast({ title: "Rubro actualizado", variant: "success" });
        }
      },
      onError: () => toast({ title: "No se pudo actualizar", variant: "error" }),
    });
  }

  return (
    <Card className="mt-6">
      <CardContent className="space-y-6 p-5">
        <div className="flex items-center gap-3">
          <span className="grid h-10 w-10 place-items-center rounded-lg bg-ninja-flame/12 text-ninja-flameSoft">
            <Store size={18} />
          </span>
          <div>
            <Heading as="h3" className="text-base">
              Rubro del negocio
            </Heading>
            <p className="text-sm text-muted-foreground">
              Define qué funciones del POS se adaptan a tu actividad.
            </p>
          </div>
        </div>

        <div className="grid gap-3 sm:grid-cols-2">
          {VERTICALS.map((v) => {
            const active = current === v;
            return (
              <button
                key={v}
                type="button"
                onClick={() => choose(v)}
                disabled={setIndustry.isPending}
                className={cn(
                  "rounded-lg border p-3 text-left transition disabled:opacity-60",
                  active
                    ? "border-ninja-flame ring-2 ring-ninja-flame/30"
                    : "border-border hover:border-ninja-flameSoft/40",
                )}
              >
                <div className="flex items-center gap-2">
                  <span
                    className={cn(
                      "h-2 w-2 rounded-full",
                      active ? "bg-ninja-flame" : "bg-transparent",
                    )}
                  />
                  <span className="text-sm font-medium">{VERTICAL_LABELS[v]}</span>
                </div>
                <p className="mt-1 text-xs text-muted-foreground">
                  {VERTICAL_DESCRIPTIONS[v]}
                </p>
              </button>
            );
          })}
        </div>

        {current && verticalFeatures(current).length > 0 && (
          <div>
            <span className="mb-2 block text-sm font-medium text-muted-foreground">
              Funciones activas
            </span>
            <div className="flex flex-wrap gap-2">
              {verticalFeatures(current).map((f) => (
                <span
                  key={f}
                  className="rounded-full bg-ninja-flame/12 px-2.5 py-1 text-xs font-medium text-ninja-flameSoft"
                >
                  {FEATURE_LABELS[f] ?? f}
                </span>
              ))}
            </div>
          </div>
        )}

        {/* Configuración rápida por rubro (F12 · H35): siembra un catálogo de
            muestra y deja el negocio listo para cobrar sin Excel ni SQL. */}
        <div className="rounded-lg border border-ninja-flame/20 bg-ninja-flame/[0.05] p-4">
          <div className="flex items-start gap-2.5">
            <Sparkles size={16} className="mt-0.5 shrink-0 text-ninja-flameSoft" />
            <div className="min-w-0">
              <p className="text-sm font-semibold">¿Empezás de cero?</p>
              <p className="mt-0.5 text-xs text-muted-foreground">
                Elegí un preset de rubro (heladería, peluquería, cafetería,
                restaurante, rotisería…) y sembramos categorías y productos de
                muestra, listos como botones rápidos del POS. Los rubros
                gastronómicos además activan mesas/cocina o delivery. No duplica
                lo que ya tengas.
              </p>
            </div>
          </div>
          <div className="mt-3 flex flex-wrap items-center gap-2">
            <IndustryPresetButton size="sm" />
            {(sampleCount ?? 0) > 0 && (
              <Button
                variant="secondary"
                size="sm"
                onClick={() => setSamplesOpen(true)}
              >
                <Trash2 size={14} /> Borrar productos de prueba ({sampleCount})
              </Button>
            )}
          </div>
        </div>

        {/* Zona de peligro: vaciar catálogo. Pensado para arrancar de cero a mano
            (p. ej. al cambiar de rubro y querer otro catálogo). Da de baja TODOS
            los productos; el cambio de rubro por sí solo NO los toca. */}
        <div className="rounded-lg border border-destructive/30 bg-destructive/[0.04] p-4">
          <div className="flex items-start gap-2.5">
            <AlertTriangle size={16} className="mt-0.5 shrink-0 text-destructive" />
            <div className="min-w-0 flex-1">
              <p className="text-sm font-semibold">Vaciar catálogo</p>
              <p className="mt-0.5 text-xs text-muted-foreground">
                Da de baja <strong>todos tus productos</strong>
                {count > 0 ? ` (${count})` : ""} para empezar de cero. Se pierde del
                POS toda la información de cada producto (precios, stock, variantes,
                códigos, fotos…). Las ventas ya registradas no se tocan.
              </p>
              <Button
                variant="destructive"
                size="sm"
                className="mt-3"
                disabled={count === 0}
                onClick={() => {
                  setConfirmWord("");
                  setEmptyOpen(true);
                }}
              >
                <Trash2 size={14} /> Vaciar catálogo
              </Button>
              {count === 0 && (
                <p className="mt-2 text-xs text-muted-foreground">
                  No tenés productos cargados.
                </p>
              )}
            </div>
          </div>
        </div>
      </CardContent>

      {/* Aviso al cambiar de rubro: aclara que sólo se adaptan las funciones del
          POS y que el catálogo (productos/precios/categorías) NO se modifica.
          Resuelve la confusión de "cambiar de rubro me transfiere los productos":
          el rubro y el catálogo son independientes. */}
      <ConfirmDialog
        open={pending !== null}
        onOpenChange={(o) => !o && setPending(null)}
        title={
          pending
            ? `Cambiar a ${VERTICAL_LABELS[pending as keyof typeof VERTICAL_LABELS] ?? pending}`
            : "Cambiar de rubro"
        }
        description={
          "Cambiar de rubro sólo adapta las FUNCIONES del POS (mesas/comandas, " +
          "balanza, venta rápida, etc.). Tus productos, precios y categorías son " +
          "independientes del rubro y NO se modifican: tu catálogo queda intacto. " +
          "Si querés un catálogo distinto, agregá o eliminá productos a mano." +
          (pendingTurnsGastroOff
            ? " Como este rubro no es gastronómico, mesas/cocina y delivery se " +
              "apagan (los reactivás cuando quieras en Operación y productos)."
            : "")
        }
        confirmLabel="Cambiar rubro"
        loading={setIndustry.isPending}
        onConfirm={confirmChange}
      />

      {/* Borrar productos de prueba: baja lógica SOLO de los ítems sembrados por
          presets (from_preset != null). No toca los productos propios del dueño. */}
      <ConfirmDialog
        open={samplesOpen}
        onOpenChange={setSamplesOpen}
        title={`Borrar ${sampleCount ?? 0} producto${(sampleCount ?? 0) === 1 ? "" : "s"} de prueba`}
        description={
          "Da de baja únicamente los productos de muestra que sembró la " +
          "configuración rápida por rubro. Tus productos propios, ventas y " +
          "categorías no se tocan."
        }
        confirmLabel="Borrar productos de prueba"
        loading={deleteSamples.isPending}
        onConfirm={() =>
          deleteSamples.mutate(undefined, {
            onSuccess: (n) => {
              setSamplesOpen(false);
              toast({
                title:
                  n > 0
                    ? `Listo: ${n} producto${n === 1 ? "" : "s"} de prueba dado${n === 1 ? "" : "s"} de baja`
                    : "No había productos de prueba para borrar",
                variant: "success",
              });
            },
            onError: () =>
              toast({ title: "No se pudieron borrar", variant: "error" }),
          })
        }
      />

      {/* Confirmación de vaciar catálogo: acción irreversible desde la UI, así que
          se exige escribir VACIAR para habilitar el botón (evita accidentes). */}
      <Modal
        open={emptyOpen}
        onOpenChange={(o) => {
          if (!o) {
            setEmptyOpen(false);
            setConfirmWord("");
          }
        }}
        title="Vaciar catálogo"
        className="max-w-md"
      >
        <div className="space-y-4">
          <div className="flex items-start gap-2.5 rounded-lg border border-destructive/40 bg-destructive/10 p-3">
            <AlertTriangle size={18} className="mt-0.5 shrink-0 text-destructive" />
            <div className="text-sm">
              <p className="font-semibold text-destructive">
                Esto da de baja {count > 0 ? `${count} ` : "todos tus "}productos y no
                se puede deshacer desde acá.
              </p>
              <p className="mt-1 text-muted-foreground">
                Vas a perder del POS toda la información guardada de cada producto:
                precios, costo, stock, variantes, códigos de barras/SKU/PLU, fotos,
                modificadores, recetas y favoritos. Las <strong>ventas ya
                registradas</strong> y tus categorías/marcas no se tocan.
              </p>
            </div>
          </div>
          <Input
            label='Escribí "VACIAR" para confirmar'
            autoFocus
            value={confirmWord}
            onChange={(e) => setConfirmWord(e.target.value)}
            placeholder="VACIAR"
            onKeyDown={(e) => {
              if (
                e.key === "Enter" &&
                confirmWord.trim().toUpperCase() === "VACIAR" &&
                !emptyCatalog.isPending
              ) {
                runEmptyCatalog();
              }
            }}
          />
          <div className="flex justify-end gap-2">
            <Button
              variant="secondary"
              onClick={() => {
                setEmptyOpen(false);
                setConfirmWord("");
              }}
            >
              Cancelar
            </Button>
            <Button
              variant="destructive"
              loading={emptyCatalog.isPending}
              disabled={confirmWord.trim().toUpperCase() !== "VACIAR"}
              onClick={runEmptyCatalog}
            >
              <Trash2 size={14} /> Vaciar catálogo
            </Button>
          </div>
        </div>
      </Modal>
    </Card>
  );
}
