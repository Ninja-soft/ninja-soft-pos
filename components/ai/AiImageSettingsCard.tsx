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
// Es el mismo ejemplo con el que se generaron las muestras de cada estilo
// (public/ia/estilos), así la vista previa y las imágenes coinciden.
const SAMPLE = {
  name: "Dulce de leche artesanal",
  type: "Producto",
  description: "Diseño de producto alimenticio: frasco de vidrio de dulce de leche artesanal con cuchara e ingredientes alrededor",
  business: "fábrica de alimentos",
};

// Paleta sugerida para el acento; "Otro" abre el selector nativo.
const ACCENT_PRESETS = ["#FF4B22", "#2563EB", "#0EA5A4", "#16A34A", "#CA8A04", "#9333EA", "#DB2777", "#334155"];

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
  const customAccent = Boolean(s.accent) && !ACCENT_PRESETS.some((c) => c.toLowerCase() === s.accent?.toLowerCase());

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
            : "Imágenes de portada para tus productos y servicios, en un estilo parejo para todo el catálogo."
        }
        actions={
          editable ? (
            <Button size="sm" onClick={save} loading={m.saveSettings.isPending} disabled={!dirty}>
              Guardar
            </Button>
          ) : undefined
        }
      >
        {/* Fila de interruptor: texto a la izquierda y el switch centrado a la derecha. */}
        <div className="flex items-center justify-between gap-4 px-5 py-4">
          <div className="min-w-0">
            <div className="text-sm font-medium text-foreground">Generar la portada automáticamente</div>
            <p className="mt-1 text-xs text-muted-foreground">Al crear un servicio, con el estilo elegido.</p>
            <p className="mt-0.5 text-xs text-muted-foreground">En productos usás Generar y Regenerar en Fotos.</p>
          </div>
          <Switch
            checked={s.auto_cover}
            disabled={!editable}
            onCheckedChange={(v) => setS({ ...s, auto_cover: v })}
            label="Generar automáticamente"
          />
        </div>
        <SettingRow label="Estilo" description="Se usa en todas las portadas nuevas. En cada producto o servicio se puede elegir otro." stacked>
          <div className="grid grid-cols-2 gap-2 lg:grid-cols-4" role="radiogroup" aria-label="Estilo">
            {COVER_STYLES.map((st) => (
              <button
                key={st.key}
                type="button"
                role="radio"
                aria-checked={s.style === st.key}
                disabled={!editable}
                onClick={() => setS({ ...s, style: st.key })}
                className={choiceClass(s.style === st.key, "overflow-hidden p-0")}
              >
                {/* Muestra real generada con Gemini (public/ia/estilos). */}
                {/* eslint-disable-next-line @next/next/no-img-element */}
                <img
                  src={`/ia/estilos/${st.key}.webp`}
                  alt=""
                  width={320}
                  height={320}
                  loading="lazy"
                  className="aspect-[4/3] w-full object-cover"
                />
                <span className="block px-3 pt-2 text-sm font-semibold">{st.name}</span>
                <span className="block px-3 pb-2.5 pt-0.5 text-xs text-muted-foreground">{st.description}</span>
              </button>
            ))}
          </div>
          <p className="mt-2 text-xs text-muted-foreground">
            Ejemplos generados con IA a partir de un mismo producto: &quot;{SAMPLE.name}&quot; ({SAMPLE.business}). Tus portadas usan el nombre y la descripción de cada producto.
          </p>
        </SettingRow>
        <SettingRow label="Color de acento" description="Opcional. En Automático el modelo elige la paleta según el estilo." stacked>
          <div className="flex flex-wrap items-center gap-2" role="radiogroup" aria-label="Color de acento">
            <button
              type="button"
              role="radio"
              aria-checked={!s.accent}
              disabled={!editable}
              onClick={() => setS({ ...s, accent: null })}
              className={choiceClass(!s.accent, "h-10 px-3 text-sm font-semibold")}
            >
              Automático
            </button>
            {ACCENT_PRESETS.map((c) => {
              const on = s.accent?.toLowerCase() === c.toLowerCase();
              return (
                <button
                  key={c}
                  type="button"
                  role="radio"
                  aria-checked={on}
                  aria-label={c}
                  title={c}
                  disabled={!editable}
                  onClick={() => setS({ ...s, accent: c })}
                  className={`grid h-10 w-10 place-items-center rounded-lg border transition-colors disabled:cursor-not-allowed disabled:opacity-50 ${
                    on ? "border-foreground" : "border-border hover:border-[color-mix(in_srgb,var(--foreground)_40%,transparent)]"
                  }`}
                >
                  <span className="h-6 w-6 rounded-md" style={{ background: c }} />
                </button>
              );
            })}
            <label
              className={`relative flex h-10 items-center gap-2 rounded-lg border px-2.5 text-sm ${
                customAccent ? "border-foreground" : "border-border"
              } ${editable ? "cursor-pointer" : "cursor-not-allowed opacity-50"}`}
            >
              <span
                className="h-6 w-6 rounded-md border border-border"
                style={{ background: customAccent ? s.accent ?? undefined : "transparent" }}
              />
              <span className="font-mono text-xs tabular-nums">{customAccent ? s.accent?.toUpperCase() : "Otro"}</span>
              <input
                type="color"
                disabled={!editable}
                value={s.accent ?? "#FF4B22"}
                onChange={(e) => setS({ ...s, accent: e.target.value })}
                className="absolute inset-0 h-full w-full cursor-pointer opacity-0 disabled:cursor-not-allowed"
                aria-label="Elegir otro color"
              />
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
        <SettingRow label="Vista previa del prompt final" description={`Ejemplo con el producto "${SAMPLE.name}".`} stacked>
          <p className="rounded-lg bg-fg-4 p-3 font-mono text-[12px] leading-relaxed text-muted-foreground">{preview}</p>
        </SettingRow>
      </SettingsCard>
    </div>
  );
}
