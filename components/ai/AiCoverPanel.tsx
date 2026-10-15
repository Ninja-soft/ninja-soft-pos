"use client";

// Portada con IA en el editor de un servicio o producto (ADR-122): Generar /
// Regenerar con el estilo elegido, historial de las últimas imágenes y "Usar
// esta" (pasa a la galería como foto principal). Sólo con el complemento
// Asistente IA; la Edge ai_cover_image y la base lo vuelven a validar.
import { useEffect, useState } from "react";
import { Check, ImagePlus, RefreshCw, Sparkles } from "lucide-react";
import { Button } from "@/components/ui/Button";
import { Select } from "@/components/ui/Select";
import { Spinner } from "@/components/ui/Spinner";
import { useToast } from "@/components/ui/Toast";
import {
  aiCoverError,
  useAiCoverMutations,
  useAiCoverStatus,
  useAiCoversEnabled,
  useAiGenerations,
  useAiImageSettings,
} from "@/modules/ai/covers";
import { COVER_STYLES, type CoverStyle } from "@/supabase/functions/_shared/aiCoverPrompt";
import { cn } from "@/lib/utils/cn";

export function AiCoverPanel({ productId, canManage }: { productId: string; canManage: boolean }) {
  const { toast } = useToast();
  const enabled = useAiCoversEnabled();
  const on = enabled === true && canManage;
  const { data: status } = useAiCoverStatus(on);
  const { data: settings } = useAiImageSettings(on);
  const { data: gens = [], isLoading } = useAiGenerations(productId, on);
  const m = useAiCoverMutations();
  const [style, setStyle] = useState<CoverStyle>("flat_icon");

  useEffect(() => {
    if (settings?.style) setStyle(settings.style);
  }, [settings?.style]);

  if (enabled === undefined || !canManage) return null;

  if (enabled === false) {
    return (
      <div className="flex items-start gap-3 rounded-lg bg-fg-4 p-3.5 text-sm">
        <Sparkles size={18} className="mt-0.5 shrink-0 text-ninja-flameSoft" aria-hidden />
        <p className="text-muted-foreground">
          Con el complemento <b className="text-foreground">Asistente IA</b> podés generar imágenes para tus productos y servicios en el estilo que
          elijas. Se activa desde el Panel del dueño, en Complementos.
        </p>
      </div>
    );
  }

  const notConfigured = status != null && !status.configured;
  const limitReached = status != null && status.used >= status.limit;
  const busy = m.generate.isPending;

  async function generate() {
    const r = await m.generate.mutateAsync({ productId, style });
    if (!r.ok) toast({ title: "No se generó la portada", description: aiCoverError(r.error), variant: "error" });
  }

  async function use(id: string) {
    try {
      await m.choose.mutateAsync({ generationId: id, productId });
      toast({ title: "Portada actualizada", variant: "success" });
    } catch (e) {
      toast({ title: "No se pudo usar la imagen", description: aiCoverError(e instanceof Error ? e.message : null), variant: "error" });
    }
  }

  return (
    <div className="space-y-3 rounded-lg border border-border p-3.5">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <p className="flex items-center gap-2 text-sm font-semibold">
          <Sparkles size={16} className="text-ninja-flameSoft" aria-hidden /> Portada con IA
        </p>
        {status && !notConfigured && (
          <span className="text-xs tabular-nums text-muted-foreground">
            Hoy: {status.used} de {status.limit}
          </span>
        )}
      </div>
      {notConfigured ? (
        <p className="text-sm text-muted-foreground">
          La generación de imágenes todavía no está configurada en NinjaSoft. Mientras tanto podés subir tus fotos.
        </p>
      ) : (
        <>
          <div className="flex flex-col gap-2 sm:flex-row sm:items-end">
            <Select<CoverStyle>
              label="Estilo"
              value={style}
              onChange={setStyle}
              options={COVER_STYLES.map((s) => ({ value: s.key, label: s.name, description: s.description }))}
            />
            <Button
              type="button"
              variant={gens.length ? "secondary" : "primary"}
              onClick={generate}
              loading={busy}
              disabled={limitReached}
              className="shrink-0"
            >
              {gens.length ? <RefreshCw size={15} /> : <ImagePlus size={15} />}
              {gens.length ? "Regenerar" : "Generar portada"}
            </Button>
          </div>
          {limitReached && <p className="text-xs text-warning">{aiCoverError("daily_limit")}</p>}
          {isLoading ? (
            <div className="grid h-20 place-items-center">
              <Spinner />
            </div>
          ) : gens.length > 0 ? (
            <div className="grid grid-cols-3 gap-2 sm:grid-cols-4">
              {busy && (
                <div className="grid aspect-square place-items-center rounded-lg bg-fg-4">
                  <Spinner size={20} />
                </div>
              )}
              {gens.map((g) => (
                <div key={g.id} className="group relative aspect-square overflow-hidden rounded-lg bg-white">
                  {g.url && (
                    // eslint-disable-next-line @next/next/no-img-element
                    <img src={g.url} alt="" loading="lazy" className="h-full w-full object-cover" />
                  )}
                  <button
                    type="button"
                    onClick={() => use(g.id)}
                    disabled={m.choose.isPending}
                    className={cn(
                      "absolute inset-x-1.5 bottom-1.5 flex h-8 items-center justify-center gap-1 rounded-md text-[11px] font-semibold",
                      g.chosen_at ? "bg-black/60 text-white" : "bg-white/90 text-neutral-900 hover:bg-white",
                    )}
                  >
                    {g.chosen_at ? (
                      <>
                        <Check size={13} /> Usada
                      </>
                    ) : (
                      "Usar esta"
                    )}
                  </button>
                </div>
              ))}
            </div>
          ) : (
            <p className="text-xs text-muted-foreground">
              Se genera a partir del nombre, el tipo y la descripción. Elegí el estilo; el prompt base se ajusta en Configuración, Imágenes con IA.
            </p>
          )}
        </>
      )}
    </div>
  );
}
