"use client";

import { useEffect, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Sparkles, Check, Play, ExternalLink } from "lucide-react";
import { createClient } from "@/lib/supabase/client";
import { useToast } from "@/components/ui/Toast";
import { Card, CardContent } from "@/components/ui/Card";
import { Heading } from "@/components/ui/Typography";
import { Input } from "@/components/ui/Input";
import { Button } from "@/components/ui/Button";
import { Segmented } from "@/components/ui/Segmented";

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
  image_url: string | null;
  commercial_text: string | null;
  addon_price_ars: string | null;
  addon_trial_days: string | null;
};

// Modelo por defecto según proveedor.
const DEFAULT_MODEL: Record<Provider, string> = {
  gemini: "gemini-2.5-flash",
  claude: "claude-haiku-4-5-20251001",
};

// De dónde saca la API key cada proveedor (guía para el staff).
const KEY_HELP: Record<Provider, { label: string; url: string }> = {
  gemini: { label: "Google AI Studio → API keys", url: "https://aistudio.google.com/apikey" },
  claude: { label: "Anthropic Console → API keys", url: "https://console.anthropic.com/settings/keys" },
};

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
  // Campos públicos del addon (para el explicador de la burbuja).
  const [imageUrl, setImageUrl] = useState("");
  const [commercialText, setCommercialText] = useState("");
  const [priceArs, setPriceArs] = useState("");
  const [trialDays, setTrialDays] = useState("");
  // El usuario tocó el modelo manualmente → no lo pisamos al cambiar proveedor.
  const [modelTouched, setModelTouched] = useState(false);

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

  // Prefill de valores públicos (proveedor, modelo, beta email). Las api_key no
  // se devuelven nunca; solo sabemos si existen (status.*_api_key === true).
  useEffect(() => {
    if (!status) return;
    const p = (status.provider === "claude" ? "claude" : "gemini") as Provider;
    setProvider(p);
    setModel(status.model ?? DEFAULT_MODEL[p]);
    setBetaEmail(status.beta_owner_email ?? "");
    setImageUrl(status.image_url ?? "");
    setCommercialText(status.commercial_text ?? "");
    setPriceArs(status.addon_price_ars ?? "");
    setTrialDays(status.addon_trial_days ?? "");
    if (status.model) setModelTouched(true);
  }, [status]);

  // Al cambiar de proveedor: limpiamos la key tipeada (es de otro proveedor) y,
  // si el modelo no fue editado a mano, autocompletamos con el default nuevo.
  function onProviderChange(p: Provider) {
    setProvider(p);
    setApiKey("");
    if (!modelTouched) setModel(DEFAULT_MODEL[p]);
  }

  // ¿El proveedor seleccionado ya tiene una key guardada? Gemini acepta también
  // la key legacy (api_key) como fallback; Claude exige su propia key.
  const hasKey =
    provider === "claude"
      ? Boolean(status?.claude_api_key)
      : Boolean(status?.gemini_api_key || status?.api_key);

  const save = useMutation({
    mutationFn: async () => {
      const secrets: Record<string, string> = {
        provider,
        model: model.trim() || DEFAULT_MODEL[provider],
        beta_owner_email: betaEmail.trim().toLowerCase(),
      };
      // La key se guarda en el campo del proveedor seleccionado (no en un único
      // api_key compartido): así Claude no hereda la key de Gemini ni viceversa.
      if (apiKey.trim()) {
        secrets[provider === "claude" ? "claude_api_key" : "gemini_api_key"] = apiKey.trim();
      }
      // Campos públicos del addon: el merge del backend ignora los vacíos.
      if (imageUrl.trim()) secrets.image_url = imageUrl.trim();
      if (commercialText.trim()) secrets.commercial_text = commercialText.trim();
      if (priceArs.trim()) secrets.addon_price_ars = priceArs.trim();
      if (trialDays.trim()) secrets.addon_trial_days = trialDays.trim();
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
    },
    onError: () => toast({ title: "No se pudo guardar", variant: "error" }),
  });

  // Test: hace un ping al asistente con un mensaje mínimo. Requiere la config
  // ya guardada (la Edge Function lee la api_key de platform_secrets).
  const test = useMutation({
    mutationFn: async () => {
      const { data, error } = await supabase.functions.invoke("ai_assistant", {
        body: { messages: [{ role: "user", content: "ping" }] },
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
              al abrir la burbuja). image_url y texto comercial NO son secretos. */}
          <div className="mt-1 border-t border-border pt-4">
            <span className="block text-sm font-semibold text-foreground">
              Presentación del addon
            </span>
            <p className="mt-1 text-xs text-muted-foreground">
              Avatar y texto que ve un dueño sin el complemento al abrir la
              burbuja del asistente.
            </p>
          </div>

          <div className="flex items-end gap-3">
            <div className="flex-1">
              <Input
                label="Imagen del asistente (URL avatar/gif)"
                type="url"
                value={imageUrl}
                onChange={(e) => setImageUrl(e.target.value)}
                placeholder="https://…/asistente.gif"
              />
            </div>
            {imageUrl.trim() && (
              // eslint-disable-next-line @next/next/no-img-element
              <img
                src={imageUrl.trim()}
                alt="Previsualización del avatar"
                className="h-11 w-11 shrink-0 rounded-full border border-border object-cover"
                onError={(e) => {
                  (e.currentTarget as HTMLImageElement).style.visibility =
                    "hidden";
                }}
              />
            )}
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
              rows={4}
              placeholder="Qué ofrece el Asistente IA y cómo se contrata…"
              className="w-full resize-y rounded-lg border border-input bg-background p-3 text-sm text-foreground outline-none transition placeholder:text-muted-foreground focus:border-ninja-flameSoft focus:ring-2 focus:ring-ninja-flameSoft/20"
            />
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
