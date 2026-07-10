"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import {
  ArrowLeft,
  ArrowRight,
  Check,
  PartyPopper,
  ShoppingCart,
  Sparkles,
} from "lucide-react";
import { Modal } from "@/components/ui/Modal";
import { Button } from "@/components/ui/Button";
import { useToast } from "@/components/ui/Toast";
import { cn } from "@/lib/utils/cn";
import {
  PRESETS,
  PRESET_ENABLE_LABELS,
  SELLS_OPTIONS,
  presetsForSells,
  type ApplyPresetResult,
  type PresetDef,
  type PresetKey,
  type SellsMode,
} from "@/modules/onboarding/presets";
import { useApplyPreset } from "@/modules/onboarding/hooks";

// F12 · H35 — Wizard de configuración rápida por rubro. 3 pasos:
//   1. ¿Qué vendés? (productos / servicios / ambos)
//   2. Elegí un preset de rubro (tarjetas)
//   3. Aplicar → siembra catálogo + defaults (RPC idempotente, auditada)
// Reusa categorías/productos (favorito + track_stock de H36) y pos_settings: el
// preset sólo INSERTA datos por sus mecanismos. Reachable desde el onboarding y
// desde Configuración / Dashboard.

type Step = 1 | 2 | 3;

export function IndustryPresetWizard({
  open,
  onOpenChange,
}: {
  open: boolean;
  onOpenChange: (o: boolean) => void;
}) {
  const router = useRouter();
  const { toast } = useToast();
  const apply = useApplyPreset();

  const [step, setStep] = useState<Step>(1);
  const [sells, setSells] = useState<SellsMode | null>(null);
  const [preset, setPreset] = useState<PresetKey | null>(null);
  // ¿Precargar productos de muestra? El dueño lo decide en el paso 3 (default
  // sí). En "no", la RPC aplica defaults/gastronomía pero no siembra catálogo.
  const [seedCatalog, setSeedCatalog] = useState(true);
  const [result, setResult] = useState<ApplyPresetResult | null>(null);

  // Al abrir/cerrar, arrancamos siempre desde cero (sin arrastrar estado).
  useEffect(() => {
    if (!open) return;
    setStep(1);
    setSells(null);
    setPreset(null);
    setSeedCatalog(true);
    setResult(null);
  }, [open]);

  const visiblePresets: PresetDef[] = sells ? presetsForSells(sells) : PRESETS;
  const chosen = PRESETS.find((p) => p.key === preset) ?? null;

  function pickSells(v: SellsMode) {
    setSells(v);
    // Si el preset elegido ya no aplica al nuevo modo, lo limpiamos.
    if (preset && !presetsForSells(v).some((p) => p.key === preset)) {
      setPreset(null);
    }
    setStep(2);
  }

  function pickPreset(v: PresetKey) {
    setPreset(v);
    setStep(3);
  }

  async function onApply() {
    if (!preset || !sells) return;
    try {
      const res = await apply.mutateAsync({ preset, sells, seedCatalog });
      setResult(res);
      toast({
        title: seedCatalog ? "Catálogo listo" : "Configuración aplicada",
        description: !seedCatalog
          ? "No precargamos productos de muestra, como pediste."
          : res.items_created > 0
            ? `Sumamos ${res.items_created} ítem${res.items_created === 1 ? "" : "s"} y ${res.categories_created} categoría${res.categories_created === 1 ? "" : "s"}.`
            : "Ya tenías todo cargado: no duplicamos nada.",
        variant: "success",
      });
    } catch {
      toast({
        title: "No pudimos aplicar el preset",
        description: "Probá de nuevo en unos segundos.",
        variant: "error",
      });
    }
  }

  function goToPos() {
    onOpenChange(false);
    router.push("/pos");
  }

  return (
    <Modal
      open={open}
      onOpenChange={onOpenChange}
      title="Configuración rápida por rubro"
      description="Dejá tu negocio listo para cobrar en minutos. Sembramos categorías y productos de muestra que después editás a gusto."
      className="max-w-2xl"
    >
      {/* Indicador de pasos */}
      {!result && (
        <ol className="mb-6 flex items-center gap-2 text-xs font-medium">
          {[
            { n: 1 as Step, label: "Qué vendés" },
            { n: 2 as Step, label: "Rubro" },
            { n: 3 as Step, label: "Aplicar" },
          ].map((s, i) => {
            const active = step === s.n;
            const done = step > s.n;
            return (
              <li key={s.n} className="flex items-center gap-2">
                <span
                  className={cn(
                    "flex h-6 w-6 items-center justify-center rounded-full border tabular-nums",
                    active
                      ? "border-ninja-flame bg-ninja-flame/15 text-ninja-flameSoft"
                      : done
                        ? "border-ninja-flame/40 bg-ninja-flame/10 text-ninja-flameSoft"
                        : "border-border text-muted-foreground",
                  )}
                >
                  {done ? <Check size={13} strokeWidth={3} /> : s.n}
                </span>
                <span
                  className={cn(
                    active ? "text-foreground" : "text-muted-foreground",
                  )}
                >
                  {s.label}
                </span>
                {i < 2 && <span className="mx-1 h-px w-4 bg-border" />}
              </li>
            );
          })}
        </ol>
      )}

      {/* ── Éxito ──────────────────────────────────────────────────────────── */}
      {result ? (
        <div className="py-2 text-center">
          <span className="mx-auto mb-4 flex h-14 w-14 items-center justify-center rounded-full bg-ninja-flame/12 text-ninja-flameSoft">
            <PartyPopper size={26} />
          </span>
          <h3 className="font-display text-xl font-bold">¡Todo listo!</h3>
          <p className="mt-1 text-sm text-muted-foreground">
            {!seedCatalog ? (
              <>
                Aplicamos la configuración del rubro sin precargar productos de
                muestra, como pediste. Tu catálogo quedó intacto.
              </>
            ) : result.items_created > 0 ? (
              <>
                Cargamos{" "}
                <span className="font-semibold text-foreground">
                  {result.items_created}
                </span>{" "}
                ítem{result.items_created === 1 ? "" : "s"} de muestra en{" "}
                <span className="font-semibold text-foreground">
                  {result.categories_created}
                </span>{" "}
                categoría{result.categories_created === 1 ? "" : "s"}. Ya
                aparecen como botones rápidos en el POS.
              </>
            ) : (
              <>
                Tu catálogo ya tenía estos ítems, así que no duplicamos nada.
                {result.skipped > 0 ? ` (${result.skipped} ya existían.)` : ""}
              </>
            )}
          </p>
          <div className="mt-6 flex flex-col-reverse gap-2 sm:flex-row sm:justify-center">
            <Button variant="secondary" onClick={() => onOpenChange(false)}>
              Seguir configurando
            </Button>
            <Button onClick={goToPos}>
              <ShoppingCart size={16} /> Ir a cobrar
            </Button>
          </div>
        </div>
      ) : step === 1 ? (
        /* ── Paso 1: ¿Qué vendés? ───────────────────────────────────────────── */
        <div className="space-y-3">
          <p className="text-sm font-medium">¿Qué vendés?</p>
          <div className="grid gap-3 sm:grid-cols-3">
            {SELLS_OPTIONS.map((o) => {
              const active = sells === o.key;
              return (
                <button
                  key={o.key}
                  type="button"
                  onClick={() => pickSells(o.key)}
                  className={cn(
                    "rounded-lg border p-4 text-left transition",
                    active
                      ? "border-ninja-flame ring-2 ring-ninja-flame/30"
                      : "border-border hover:border-ninja-flameSoft/40 hover:bg-ninja-flame/[0.04]",
                  )}
                >
                  <span className="text-sm font-semibold">{o.label}</span>
                  <p className="mt-1 text-xs text-muted-foreground">{o.desc}</p>
                </button>
              );
            })}
          </div>
        </div>
      ) : step === 2 ? (
        /* ── Paso 2: Elegí un preset ────────────────────────────────────────── */
        <div className="space-y-3">
          <div className="flex items-center justify-between">
            <p className="text-sm font-medium">Elegí tu rubro</p>
            <button
              onClick={() => setStep(1)}
              className="inline-flex items-center gap-1 text-xs font-medium text-muted-foreground transition hover:text-foreground"
            >
              <ArrowLeft size={13} /> Cambiar qué vendés
            </button>
          </div>
          <div className="grid gap-3 sm:grid-cols-2">
            {visiblePresets.map((p) => {
              const Icon = p.icon;
              const active = preset === p.key;
              return (
                <button
                  key={p.key}
                  type="button"
                  onClick={() => pickPreset(p.key)}
                  className={cn(
                    "flex flex-col rounded-lg border p-4 text-left transition",
                    active
                      ? "border-ninja-flame ring-2 ring-ninja-flame/30"
                      : "border-border hover:border-ninja-flameSoft/40 hover:bg-ninja-flame/[0.04]",
                  )}
                >
                  <span className="flex items-center gap-2.5">
                    <span className="grid h-9 w-9 shrink-0 place-items-center rounded-lg bg-ninja-flame/12 text-ninja-flameSoft">
                      <Icon size={18} />
                    </span>
                    <span className="text-sm font-semibold">{p.label}</span>
                  </span>
                  <p className="mt-2 text-xs text-muted-foreground">{p.desc}</p>
                  <span className="mt-2 flex flex-wrap gap-1">
                    {p.categories.map((c) => (
                      <span
                        key={c}
                        className="rounded-full bg-muted px-2 py-0.5 text-[11px] font-medium text-muted-foreground"
                      >
                        {c}
                      </span>
                    ))}
                  </span>
                  {p.enables && p.enables.length > 0 && (
                    <span className="mt-2 flex flex-wrap gap-1">
                      {p.enables.map((e) => (
                        <span
                          key={e}
                          className="rounded-full bg-ninja-flame/12 px-2 py-0.5 text-[11px] font-medium text-ninja-flameSoft"
                        >
                          {PRESET_ENABLE_LABELS[e]}
                        </span>
                      ))}
                    </span>
                  )}
                </button>
              );
            })}
          </div>
        </div>
      ) : (
        /* ── Paso 3: Confirmar y aplicar ────────────────────────────────────── */
        chosen && (
          <div className="space-y-5">
            <div className="flex items-center justify-between">
              <p className="text-sm font-medium">Confirmá y aplicá</p>
              <button
                onClick={() => setStep(2)}
                className="inline-flex items-center gap-1 text-xs font-medium text-muted-foreground transition hover:text-foreground"
              >
                <ArrowLeft size={13} /> Cambiar rubro
              </button>
            </div>

            <div className="rounded-lg border border-border bg-card/60 p-4">
              <div className="flex items-center gap-3">
                <span className="grid h-10 w-10 shrink-0 place-items-center rounded-lg bg-ninja-flame/12 text-ninja-flameSoft">
                  <chosen.icon size={20} />
                </span>
                <div>
                  <p className="font-semibold">{chosen.label}</p>
                  <p className="text-xs text-muted-foreground">
                    {sells === "servicios"
                      ? "Servicios sin stock"
                      : sells === "productos"
                        ? "Productos con stock"
                        : "Productos y servicios"}
                  </p>
                </div>
              </div>

              <dl className="mt-4 grid gap-3 sm:grid-cols-2">
                <div>
                  <dt className="text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">
                    Categorías
                  </dt>
                  <dd className="mt-1 flex flex-wrap gap-1">
                    {chosen.categories.map((c) => (
                      <span
                        key={c}
                        className="rounded-full bg-muted px-2 py-0.5 text-xs font-medium"
                      >
                        {c}
                      </span>
                    ))}
                  </dd>
                </div>
                <div>
                  <dt className="text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">
                    Ejemplos de ítems
                  </dt>
                  <dd className="mt-1 text-xs text-muted-foreground">
                    {chosen.sampleItems.join(" · ")}…
                  </dd>
                </div>
                {chosen.enables && chosen.enables.length > 0 && (
                  <div className="sm:col-span-2">
                    <dt className="text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">
                      Operación gastronómica
                    </dt>
                    <dd className="mt-1 flex flex-wrap gap-1">
                      {chosen.enables.map((e) => (
                        <span
                          key={e}
                          className="rounded-full bg-ninja-flame/12 px-2 py-0.5 text-xs font-medium text-ninja-flameSoft"
                        >
                          {PRESET_ENABLE_LABELS[e]}
                        </span>
                      ))}
                    </dd>
                  </div>
                )}
              </dl>
            </div>

            {/* ¿Precargar productos de muestra? El dueño decide: con catálogo
                propio suele preferir sólo la configuración (defaults/gastronomía)
                sin ítems de prueba. */}
            <div className="space-y-2">
              <p className="text-sm font-medium">
                ¿Precargamos productos de muestra?
              </p>
              <div className="grid gap-2 sm:grid-cols-2">
                <button
                  type="button"
                  onClick={() => setSeedCatalog(true)}
                  className={cn(
                    "rounded-lg border p-3 text-left transition",
                    seedCatalog
                      ? "border-ninja-flame ring-2 ring-ninja-flame/30"
                      : "border-border hover:border-ninja-flameSoft/40",
                  )}
                >
                  <span className="text-sm font-semibold">Sí, precargar</span>
                  <p className="mt-1 text-xs text-muted-foreground">
                    Sembramos las categorías e ítems de muestra como botones
                    rápidos del POS. Los podés borrar después de un toque.
                  </p>
                </button>
                <button
                  type="button"
                  onClick={() => setSeedCatalog(false)}
                  className={cn(
                    "rounded-lg border p-3 text-left transition",
                    !seedCatalog
                      ? "border-ninja-flame ring-2 ring-ninja-flame/30"
                      : "border-border hover:border-ninja-flameSoft/40",
                  )}
                >
                  <span className="text-sm font-semibold">No, sólo configurar</span>
                  <p className="mt-1 text-xs text-muted-foreground">
                    Aplica los ajustes del rubro (y mesas/delivery si corresponde)
                    sin tocar tu catálogo.
                  </p>
                </button>
              </div>
            </div>

            {seedCatalog && (
              <div className="flex items-start gap-2 rounded-lg border border-ninja-flame/20 bg-ninja-flame/[0.06] p-3 text-xs text-muted-foreground">
                <Sparkles size={15} className="mt-0.5 shrink-0 text-ninja-flameSoft" />
                <p>
                  Se agregan como <span className="font-medium text-foreground">botones rápidos</span> del
                  POS. Si ya tenés productos o categorías con estos nombres, no se
                  duplican. Después editás precios, nombres y stock a gusto.
                </p>
              </div>
            )}

            <div className="flex flex-col-reverse gap-2 sm:flex-row sm:justify-end">
              <Button variant="secondary" onClick={() => onOpenChange(false)}>
                Cancelar
              </Button>
              <Button onClick={onApply} loading={apply.isPending}>
                <ArrowRight size={16} /> Aplicar a mi negocio
              </Button>
            </div>
          </div>
        )
      )}
    </Modal>
  );
}
