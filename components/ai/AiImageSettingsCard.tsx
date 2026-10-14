"use client";

// Imágenes con IA (ADR-122): portada automática al crear un servicio, estilo,
// color de acento y prompt base editable con la vista previa del prompt final
// (el mismo que arma la Edge ai_cover_image). Parte del complemento
// Asistente IA: sin él, la base rechaza guardar (trigger) y la Edge no genera.
import { useEffect, useMemo, useState } from "react";
import { Sparkles } from "lucide-react";
import { Button } from "@/components/ui/Button";
import { Switch } from "@/components/ui/Switch";
import { Callout } from "@/components/ui/Callout";
import { useToast } from "@/components/ui/Toast";
import { useMyTenant } from "@/modules/tenants/hooks";
import { choiceClass } from "@/components/ui/ChoiceCard";
import { SettingRow, SettingsCard } from "@/components/settings/Settings";
import {
  DEFAULT_AI_IMAGE_SETTINGS,
  aiCoverError,
  useAiCoverMutations,
  useAiCoverStatus,
  useAiCoversEnabled,
  useAiImageSettings,
  type AiImageSettings,
} from "@/modules/ai/covers";
import {
  BASE_PROMPT_MAX,
  COVER_STYLES,
  DEFAULT_BASE_PROMPT,
  buildCoverPrompt,
} from "@/supabase/functions/_shared/aiCoverPrompt";

// Muestra fija para la vista previa del prompt.
const SAMPLE = {
  name: "Análisis microbiológico de agua",
  type: "Análisis",
  description: "Recuento de aerobios mesófilos, coliformes totales y fecales, con informe firmado",
  business: "professional services firm",
};

export function AiImageSettingsCard() {
  const { toast } = useToast();
  const { data: me } = useMyTenant();
  const canEdit = Boolean(me?.canManage);
  const enabled = useAiCoversEnabled();
  const { data: settings } = useAiImageSettings(enabled === true);
  const { data: status } = useAiCoverStatus(enabled === true);
  const m = useAiCoverMutations();
  const [s, setS] = useState<AiImageSettings>(DEFAULT_AI_IMAGE_SETTINGS);
  useEffect(() => {
    if (settings) setS(settings);
  }, [settings]);
  const dirty = JSON.stringify(s) !== JSON.stringify(settings ?? DEFAULT_AI_IMAGE_SETTINGS);
  const preview = useMemo(
    () => buildCoverPrompt({ ...SAMPLE, style: s.style, accent: s.accent, basePrompt: s.base_prompt }),
    [s.style, s.accent, s.base_prompt],
  );
  const editable = canEdit && enabled === true;

  async function save() {
    try {
      await m.saveSettings.mutateAsync(s);
      toast({ title: "Imágenes con IA actualizadas", variant: "success" });
    } catch (e) {
      toast({ title: "No se pudo guardar", description: aiCoverError(e instanceof Error ? e.message : null), variant: "error" });
    }
  }

  return (
    <div className="space-y-4">
      {enabled === false && (
        <Callout tone="brand" icon={Sparkles} title="Parte del complemento Asistente IA">
          Con el Asistente IA activo generás portadas para tus servicios y productos con el modelo de imágenes de Google (Gemini).
          Se activa desde el Panel del dueño, en Complementos.
        </Callout>
      )}
      {enabled === true && status && !status.configured && (
        <Callout tone="warning" title="Todavía no está disponible">
          La generación de imágenes todavía no está configurada en NinjaSoft. Podés dejar todo listo: se usa apenas se active.
        </Callout>
      )}
      <SettingsCard
        title="Portadas con IA"
        description={
          status && status.configured
            ? `Hoy generaste ${status.used} de ${status.limit} imágenes.`
            : "Imágenes de portada para tus servicios, en un estilo parejo para todo el catálogo."
        }
        actions={
          editable ? (
            <Button size="sm" onClick={save} loading={m.saveSettings.isPending} disabled={!dirty}>
              Guardar
            </Button>
          ) : undefined
        }
      >
        <SettingRow
          label="Generar la portada automáticamente"
          description="Al crear un servicio se genera su portada con el estilo elegido. Apagado, tenés los botones Generar y Regenerar en Fotos."
        >
          <Switch checked={s.auto_cover} disabled={!editable} onCheckedChange={(v) => setS({ ...s, auto_cover: v })} label="Generar automáticamente" />
        </SettingRow>
        <SettingRow label="Estilo" description="Se usa en todas las portadas nuevas. En cada servicio se puede elegir otro." stacked>
          <div className="grid grid-cols-1 gap-2 sm:grid-cols-2 lg:grid-cols-4" role="radiogroup" aria-label="Estilo">
            {COVER_STYLES.map((st) => (
              <button
                key={st.key}
                type="button"
                role="radio"
                aria-checked={s.style === st.key}
                disabled={!editable}
                onClick={() => setS({ ...s, style: st.key })}
                className={choiceClass(s.style === st.key, "px-3 py-2.5")}
              >
                <span className="block text-sm font-semibold">{st.name}</span>
                <span className="mt-0.5 block text-xs text-muted-foreground">{st.description}</span>
              </button>
            ))}
          </div>
        </SettingRow>
        <SettingRow label="Color de acento" description="Opcional. Sin color, el modelo elige la paleta según el estilo." htmlFor="ai-accent">
          <div className="flex items-center gap-3">
            <input
              id="ai-accent"
              type="color"
              disabled={!editable || !s.accent}
              value={s.accent ?? "#FF4B22"}
              onChange={(e) => setS({ ...s, accent: e.target.value })}
              className="h-11 w-14 cursor-pointer rounded-lg border border-border bg-transparent p-1 disabled:cursor-not-allowed disabled:opacity-50"
            />
            <label className="flex items-center gap-2 text-sm">
              <Switch
                checked={Boolean(s.accent)}
                disabled={!editable}
                onCheckedChange={(v) => setS({ ...s, accent: v ? s.accent ?? "#FF4B22" : null })}
                label="Usar color de acento"
              />
              Usar un color de acento
            </label>
          </div>
        </SettingRow>
        <SettingRow
          label="Prompt base"
          description="Lo que se le pide al modelo. Usá {nombre}, {tipo}, {descripcion} y {rubro}. Las reglas de abajo (sin texto ni logos, cuadrada) se agregan siempre."
          htmlFor="ai-prompt"
          stacked
        >
          <textarea
            id="ai-prompt"
            disabled={!editable}
            value={s.base_prompt ?? ""}
            maxLength={BASE_PROMPT_MAX}
            onChange={(e) => setS({ ...s, base_prompt: e.target.value || null })}
            placeholder={DEFAULT_BASE_PROMPT}
            className="min-h-[88px] w-full rounded-lg border border-border bg-background/40 px-3 py-2 font-mono text-[13px] text-foreground outline-none placeholder:text-muted-foreground focus:border-[color-mix(in_srgb,var(--foreground)_30%,transparent)]"
          />
          <div className="mt-1.5 flex items-center justify-between gap-2 text-xs text-muted-foreground">
            <span className="tabular-nums">
              {(s.base_prompt ?? "").length} / {BASE_PROMPT_MAX}
            </span>
            {s.base_prompt && editable && (
              <button type="button" className="font-semibold text-ninja-flameSoft hover:underline" onClick={() => setS({ ...s, base_prompt: null })}>
                Volver al prompt base de NinjaSoft
              </button>
            )}
          </div>
        </SettingRow>
        <SettingRow label="Vista previa del prompt final" description={`Ejemplo con el servicio "${SAMPLE.name}".`} stacked>
          <p className="rounded-lg bg-fg-4 p-3 font-mono text-[12px] leading-relaxed text-muted-foreground">{preview}</p>
        </SettingRow>
      </SettingsCard>
    </div>
  );
}
