"use client";

import { useEffect, useRef, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Sparkles, Check, Play, ExternalLink, ImagePlus, Link2 } from "lucide-react";
import { createClient } from "@/lib/supabase/client";
import { useToast } from "@/components/ui/Toast";
import { Card, CardContent } from "@/components/ui/Card";
import { Heading } from "@/components/ui/Typography";
import { Input } from "@/components/ui/Input";
import { Button } from "@/components/ui/Button";
import { Segmented } from "@/components/ui/Segmented";
import { Switch } from "@/components/ui/Switch";
import { resizeToWebp } from "@/lib/utils/image";

type Provider = "gemini" | "claude";

type Status = {
  updated_at: string | null;
  provider: string | null;
  model: string | null;
  beta_owner_email: string | null;
  // Legacy: api_key único (se mantiene como fallback de Gemini).
  api_key: boolean;
  // Keys por proveedor: se configura UNO a la vez, pero cada proveedor guarda
  // su propia key para que cambiar de proveedor no arrastre la key del otro.
  gemini_api_key: boolean;
  claude_api_key: boolean;
  // Imagen del asistente POR proveedor (la que ve el cliente con el addon en la
  // burbuja). image_url legacy se mantiene como fallback histórico de Gemini.
  image_url: string | null;
  gemini_image_url: string | null;
  claude_image_url: string | null;
  commercial_text: string | null;
  addon_price_ars: string | null;
  addon_trial_days: string | null;
  // Estado activo/inactivo del addon ("true"/"false"). null → se asume activo.
  active: string | null;
  // Tope mensual de tokens por negocio (número como string). null → default 500k.
  monthly_quota: string | null;
};

// Cuota mensual de tokens por defecto (espejo del DEFAULT_MONTHLY_TOKEN_CAP de
// la Edge Function ai_assistant). Si el campo queda vacío, la IA usa este tope.
const DEFAULT_MONTHLY_QUOTA = "500000";

// Modelo por defecto según proveedor.
const DEFAULT_MODEL: Record<Provider, string> = {
  gemini: "gemini-2.5-flash",
  claude: "claude-haiku-4-5-20251001",
};

// Imagen de marca por defecto si el proveedor no tiene una cargada. Son SVGs
// servidos por la app (public/ia/*.svg): el cliente los ve como avatar.
const DEFAULT_IMAGE: Record<Provider, string> = {
  gemini: "/ia/gemini.svg",
  claude: "/ia/claude.svg",
};

// De dónde saca la API key cada proveedor (guía para el staff).
const KEY_HELP: Record<Provider, { label: string; url: string }> = {
  gemini: { label: "Google AI Studio → API keys", url: "https://aistudio.google.com/apikey" },
  claude: { label: "Anthropic Console → API keys", url: "https://console.anthropic.com/settings/keys" },
};

// Bucket público para los avatares del asistente (globales, no scoped por
// tenant). Lo crea la migración 20260608330000 de forma idempotente.
const AI_ASSETS_BUCKET = "ai-assets";

// Texto comercial por defecto del explicador (sin addon). Pro, vendedor y
// rioplatense. La Edge Function ai_assistant tiene su propio default alineado.
const DEFAULT_COMMERCIAL_TEXT =
  "Sumá un asistente con IA a tu NinjaPos y tené tu negocio en la palma de la mano. " +
  "Preguntale en lenguaje natural y te responde al toque: cuánto vendiste hoy o esta " +
  "semana, cuáles son tus productos más vendidos, qué se está por quedar sin stock, " +
  "cómo viene la cuenta corriente de tus clientes y dónde está cada función del sistema.\n\n" +
  "Es como tener un encargado que conoce tus números y nunca se cansa: te ahorra tiempo, " +
  "te ayuda a decidir con datos reales y te saca las dudas de cómo usar cada pantalla.\n\n" +
  "Se activa al instante para todo tu equipo. Probalo y no vas a querer trabajar sin él.";

export function AiConfigCard() {
  const supabase = createClient();
  const qc = useQueryClient();
  const { toast } = useToast();

  const [provider, setProvider] = useState<Provider>("gemini");
  const [model, setModel] = useState("");
  // apiKey representa SIEMPRE la key del proveedor seleccionado. Al cambiar de
  // proveedor se limpia para no enviar la key de uno como la del otro.
  const [apiKey, setApiKey] = useState("");
  const [betaEmail, setBetaEmail] = useState("");
  // Imagen del asistente POR proveedor. La que ve el cliente con el addon es la
  // del proveedor ACTIVO; si está vacía, cae al SVG de marca por defecto.
  const [geminiImageUrl, setGeminiImageUrl] = useState("");
  const [claudeImageUrl, setClaudeImageUrl] = useState("");
  const [commercialText, setCommercialText] = useState("");
  const [priceArs, setPriceArs] = useState("");
  const [trialDays, setTrialDays] = useState("");
  // Cuota mensual de tokens por negocio. Vacío → la IA usa el default (500k).
  const [monthlyQuota, setMonthlyQuota] = useState("");
  // Toggle "Asistente IA activo". Default activo (null en config → true).
  const [active, setActive] = useState(true);
  // El usuario tocó el modelo manualmente → no lo pisamos al cambiar proveedor.
  const [modelTouched, setModelTouched] = useState(false);
  const [uploading, setUploading] = useState(false);
  const fileRef = useRef<HTMLInputElement>(null);

  const { data: status } = useQuery({
    queryKey: ["platform-ai-status"],
    queryFn: async (): Promise<Status | null> => {
      const { data, error } = await supabase.functions.invoke("set_platform_secret", {
        body: { key: "ai_config", action: "status" },
      });
      if (error) throw error;
      return (data as { status?: Status })?.status ?? null;
    },
  });

  // Prefill de valores públicos (proveedor, modelo, beta email, imágenes). Las
  // api_key no se devuelven nunca; solo sabemos si existen (status.*_api_key).
  useEffect(() => {
    if (!status) return;
    const p = (status.provider === "claude" ? "claude" : "gemini") as Provider;
    setProvider(p);
    setModel(status.model ?? DEFAULT_MODEL[p]);
    setBetaEmail(status.beta_owner_email ?? "");
    // Imagen por proveedor; Gemini hereda la legacy image_url si no tiene la suya.
    setGeminiImageUrl(status.gemini_image_url ?? status.image_url ?? "");
    setClaudeImageUrl(status.claude_image_url ?? "");
    setCommercialText(status.commercial_text ?? "");
    setPriceArs(status.addon_price_ars ?? "");
    setTrialDays(status.addon_trial_days ?? "");
    setMonthlyQuota(status.monthly_quota ?? "");
    // null/ausente → activo por defecto; solo "false" explícito lo apaga.
    setActive(status.active !== "false");
    if (status.model) setModelTouched(true);
  }, [status]);

  // Al cambiar de proveedor: limpiamos la key tipeada (es de otro proveedor) y
  // SIEMPRE seteamos el modelo por defecto del proveedor nuevo (reset del touch),
  // así pasar de Gemini a Claude no deja colgado "gemini-2.5-flash".
  function onProviderChange(p: Provider) {
    setProvider(p);
    setApiKey("");
    setModel(DEFAULT_MODEL[p]);
    setModelTouched(false);
  }

  // Imagen del proveedor seleccionado (estado actual del form) y su default.
  const imageUrl = provider === "claude" ? claudeImageUrl : geminiImageUrl;
  const setImageUrl = provider === "claude" ? setClaudeImageUrl : setGeminiImageUrl;
  const previewUrl = imageUrl.trim() || DEFAULT_IMAGE[provider];

  // ¿El proveedor seleccionado ya tiene una key guardada? Gemini acepta también
  // la key legacy (api_key) como fallback; Claude exige su propia key.
  const hasKey =
    provider === "claude"
      ? Boolean(status?.claude_api_key)
      : Boolean(status?.gemini_api_key || status?.api_key);

  // Subida de la imagen del proveedor activo: resize a WebP + upload al bucket
  // público ai-assets (mismo patrón que el editor de planes). Guarda la URL en
  // el campo del proveedor; se persiste al "Guardar".
  async function onPickImage(file: File | undefined) {
    if (!file) return;
    setUploading(true);
    try {
      const webp = await resizeToWebp(file, 256, 0.9);
      const path = `ai/${provider}-${crypto.randomUUID()}.webp`;
      const up = await supabase.storage
        .from(AI_ASSETS_BUCKET)
        .upload(path, webp, { contentType: "image/webp", upsert: false });
      if (up.error) throw up.error;
      const { data: pub } = supabase.storage
        .from(AI_ASSETS_BUCKET)
        .getPublicUrl(path);
      setImageUrl(pub.publicUrl);
      toast({ title: "Imagen cargada", variant: "success" });
    } catch (e) {
      toast({
        title: "No se pudo subir la imagen",
        description: e instanceof Error ? e.message : undefined,
        variant: "error",
      });
    } finally {
      setUploading(false);
      if (fileRef.current) fileRef.current.value = "";
    }
  }

  const save = useMutation({
    mutationFn: async () => {
      const secrets: Record<string, string> = {
        provider,
        model: model.trim() || DEFAULT_MODEL[provider],
        beta_owner_email: betaEmail.trim().toLowerCase(),
        // Estado del addon: siempre se envía ("true"/"false", nunca vacío) para
        // que el backend lo persista en cada guardado.
        active: active ? "true" : "false",
        // Imagen por proveedor: si el campo quedó vacío, persistimos el SVG de
        // marca por defecto para que el cliente (y ai_public_config) siempre
        // tengan un avatar del proveedor activo.
        gemini_image_url: geminiImageUrl.trim() || DEFAULT_IMAGE.gemini,
        claude_image_url: claudeImageUrl.trim() || DEFAULT_IMAGE.claude,
      };
      // La key se guarda en el campo del proveedor seleccionado (no en un único
      // api_key compartido): así Claude no hereda la key de Gemini ni viceversa.
      if (apiKey.trim()) {
        secrets[provider === "claude" ? "claude_api_key" : "gemini_api_key"] = apiKey.trim();
      }
      // Campos públicos del addon: el merge del backend ignora los vacíos.
      if (commercialText.trim()) secrets.commercial_text = commercialText.trim();
      if (priceArs.trim()) secrets.addon_price_ars = priceArs.trim();
      if (trialDays.trim()) secrets.addon_trial_days = trialDays.trim();
      // Cuota mensual: si lo dejan vacío, la IA cae al default (500k). Solo se
      // persiste si hay un valor (el merge del backend ignora los vacíos).
      if (monthlyQuota.trim()) secrets.monthly_quota = monthlyQuota.trim();
      const { data, error } = await supabase.functions.invoke("set_platform_secret", {
        body: { key: "ai_config", secrets },
      });
      if (error) throw error;
      if ((data as { error?: string })?.error)
        throw new Error((data as { error: string }).error);
    },
    onSuccess: () => {
      toast({ title: "Configuración guardada", variant: "success" });
      setApiKey("");
      qc.invalidateQueries({ queryKey: ["platform-ai-status"] });
      // La burbuja del cliente lee la imagen del proveedor activo vía RPC.
      qc.invalidateQueries({ queryKey: ["ai-public-config"] });
    },
    onError: () => toast({ title: "No se pudo guardar", variant: "error" }),
  });

  // Test: pinguea al proveedor activo en MODO INTERNO ({test:true}). La Edge
  // Function detecta al staff interno, saltea el guard de tenant/addon/cuota y
  // sólo verifica que la api_key del proveedor activo responda.
  const test = useMutation({
    mutationFn: async () => {
      const { data, error } = await supabase.functions.invoke("ai_assistant", {
        body: { messages: [{ role: "user", content: "ping" }], test: true },
      });
      if (error) throw error;
      const res = data as { reply?: string; error?: string; detail?: string };
      if (res?.error) throw new Error(res.detail || res.error);
      if (!res?.reply) throw new Error("sin_respuesta");
      return res.reply;
    },
    onSuccess: () =>
      toast({ title: "El asistente respondió OK", variant: "success" }),
    onError: (e) =>
      toast({
        title: "El test falló",
        description: e instanceof Error ? e.message : undefined,
        variant: "error",
      }),
  });

  const keyHelp = KEY_HELP[provider];
  const providerLabel = provider === "claude" ? "Claude" : "Gemini";

  return (
    <section>
      <Heading as="h2" className="flex items-center gap-2 text-base">
        <Sparkles size={18} /> Asistente IA
      </Heading>
      <p className="mt-1 max-w-2xl text-sm text-muted-foreground">
        Configurás <strong>un proveedor a la vez</strong> (Gemini o Claude) con su
        propia API key. La key se guarda cifrada y nunca se devuelve. Si cambiás de
        proveedor, pegá la API key de ese proveedor. El{" "}
        <strong>email de la beta</strong> habilita el asistente a ese dueño aunque no
        tenga el complemento contratado.
      </p>

      <Card className="mt-3">
        <CardContent className="grid max-w-2xl gap-4 p-5">
          <div className="flex items-center justify-between gap-4 rounded-lg border border-border bg-background/40 p-3">
            <div>
              <span className="block text-sm font-medium text-foreground">
                Asistente IA activo
              </span>
              <p className="mt-0.5 text-xs text-muted-foreground">
                Si lo desactivás, el asistente deja de responder mensajes (el
                explicador del addon se sigue mostrando).
              </p>
            </div>
            <Switch
              checked={active}
              onCheckedChange={setActive}
              label="Asistente IA activo"
            />
          </div>

          <div>
            <span className="mb-2 block text-sm font-medium text-muted-foreground">
              Proveedor activo
            </span>
            <Segmented<Provider>
              value={provider}
              onChange={onProviderChange}
              options={[
                { value: "gemini", label: "Gemini" },
                { value: "claude", label: "Claude" },
              ]}
            />
          </div>

          <Input
            label="Modelo"
            value={model}
            onChange={(e) => {
              setModel(e.target.value);
              setModelTouched(true);
            }}
            placeholder={DEFAULT_MODEL[provider]}
          />

          <div>
            <Input
              label={`API key de ${providerLabel}`}
              type="password"
              autoComplete="off"
              value={apiKey}
              onChange={(e) => setApiKey(e.target.value)}
              placeholder={hasKey ? `•••• guardada (${providerLabel})` : `Pegá la API key de ${providerLabel}`}
            />
            <a
              href={keyHelp.url}
              target="_blank"
              rel="noopener noreferrer"
              className="mt-1.5 inline-flex items-center gap-1 text-xs text-ninja-flameSoft hover:underline"
            >
              <ExternalLink size={12} /> ¿Cómo obtengo la key? {keyHelp.label}
            </a>
          </div>

          <Input
            label="Email de la beta (dueño con acceso)"
            type="email"
            value={betaEmail}
            onChange={(e) => setBetaEmail(e.target.value)}
            placeholder="tu-email@dominio.com"
          />

          {/* Presentación pública del addon (lo ve quien NO lo tiene contratado
              al abrir la burbuja). La imagen del proveedor activo es además el
              ícono del cliente con el addon. Nada de esto es secreto. */}
          <div className="mt-1 border-t border-border pt-4">
            <span className="block text-sm font-semibold text-foreground">
              Presentación del addon
            </span>
            <p className="mt-1 text-xs text-muted-foreground">
              Avatar del asistente (lo ve el cliente con el addon) y texto que ve
              un dueño sin el complemento al abrir la burbuja.
            </p>
          </div>

          {/* Imagen del asistente — POR proveedor (la del activo es la del
              cliente). Se puede subir un archivo o pegar una URL; vacío → SVG
              de marca por defecto. */}
          <div className="rounded-lg border border-border p-3">
            <div className="mb-2 flex items-center justify-between">
              <span className="text-sm font-medium text-muted-foreground">
                Imagen del asistente para {providerLabel}
              </span>
              {imageUrl.trim() && (
                <button
                  type="button"
                  onClick={() => setImageUrl("")}
                  className="inline-flex items-center gap-1 text-xs text-ninja-flameSoft transition hover:underline"
                >
                  Usar logo por defecto
                </button>
              )}
            </div>
            <div className="flex flex-wrap items-center gap-4">
              <span className="grid h-14 w-14 shrink-0 place-items-center overflow-hidden rounded-full border border-border bg-background">
                {previewUrl ? (
                  // eslint-disable-next-line @next/next/no-img-element
                  <img
                    src={previewUrl}
                    alt={`Avatar del asistente (${providerLabel})`}
                    className="h-full w-full object-cover"
                  />
                ) : (
                  <ImagePlus size={20} className="text-muted-foreground" />
                )}
              </span>
              <Button
                type="button"
                variant="secondary"
                size="sm"
                loading={uploading}
                onClick={() => fileRef.current?.click()}
              >
                {imageUrl.trim() ? "Cambiar imagen" : "Subir imagen"}
              </Button>
              <input
                ref={fileRef}
                type="file"
                accept="image/*"
                hidden
                onChange={(e) => onPickImage(e.target.files?.[0])}
              />
            </div>
            <div className="mt-3 flex items-center gap-2">
              <Link2 size={14} className="shrink-0 text-muted-foreground" />
              <Input
                placeholder="…o pegá una URL de imagen/gif"
                type="url"
                value={imageUrl}
                onChange={(e) => setImageUrl(e.target.value)}
                className="h-9"
              />
            </div>
            <p className="mt-2 text-xs text-muted-foreground">
              Se convierte a WebP (máx. 256px). Si la dejás vacía, se usa el logo
              de {providerLabel} por defecto. Cada proveedor tiene su propia imagen.
            </p>
          </div>

          <div>
            <label
              htmlFor="ai-commercial-text"
              className="mb-2 block text-sm font-medium text-muted-foreground"
            >
              Texto comercial (explicador sin addon)
            </label>
            <textarea
              id="ai-commercial-text"
              value={commercialText}
              onChange={(e) => setCommercialText(e.target.value)}
              rows={6}
              placeholder={DEFAULT_COMMERCIAL_TEXT}
              className="w-full resize-y rounded-lg border border-input bg-background p-3 text-sm text-foreground outline-none transition placeholder:text-muted-foreground focus:border-ninja-flameSoft focus:ring-2 focus:ring-ninja-flameSoft/20"
            />
            <button
              type="button"
              onClick={() => setCommercialText(DEFAULT_COMMERCIAL_TEXT)}
              className="mt-1.5 inline-flex items-center gap-1 text-xs text-ninja-flameSoft transition hover:underline"
            >
              <Sparkles size={12} /> Usar texto sugerido
            </button>
          </div>

          <div className="grid gap-4 sm:grid-cols-2">
            <Input
              label="Precio del addon (ARS / mes)"
              type="number"
              inputMode="numeric"
              min={0}
              value={priceArs}
              onChange={(e) => setPriceArs(e.target.value)}
              placeholder="5000"
            />
            <Input
              label="Días de prueba"
              type="number"
              inputMode="numeric"
              min={0}
              value={trialDays}
              onChange={(e) => setTrialDays(e.target.value)}
              placeholder="14"
            />
          </div>

          {/* Límite operativo de consumo (no es presentación): tope mensual de
              tokens por negocio. La IA corta con "cuota agotada" al superarlo. */}
          <div className="border-t border-border pt-4">
            <Input
              label="Cuota mensual de tokens por negocio"
              type="number"
              inputMode="numeric"
              min={0}
              step={1000}
              value={monthlyQuota}
              onChange={(e) => setMonthlyQuota(e.target.value)}
              placeholder={DEFAULT_MONTHLY_QUOTA}
            />
            <p className="mt-1.5 text-xs text-muted-foreground">
              Tope de tokens que cada negocio puede consumir por mes con el
              asistente. Al superarlo, la IA deja de responder hasta el mes
              siguiente. Si lo dejás vacío, se usa {DEFAULT_MONTHLY_QUOTA} por
              defecto.
            </p>
          </div>

          <div className="flex flex-wrap items-center gap-3">
            <Button disabled={save.isPending} onClick={() => save.mutate()}>
              {save.isPending ? "Guardando…" : "Guardar"}
            </Button>
            <Button
              variant="secondary"
              loading={test.isPending}
              disabled={save.isPending || (!hasKey && !apiKey.trim())}
              onClick={() => test.mutate()}
            >
              <Play size={15} /> Probar {providerLabel}
            </Button>
            {status?.updated_at && (
              <span className="inline-flex items-center gap-1 text-xs text-emerald-400">
                <Check size={13} /> Actualizado{" "}
                {new Date(status.updated_at).toLocaleString("es-AR")}
              </span>
            )}
          </div>
        </CardContent>
      </Card>
    </section>
  );
}
