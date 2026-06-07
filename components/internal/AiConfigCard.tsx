"use client";

import { useEffect, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Sparkles, Check, Play } from "lucide-react";
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
  api_key: boolean;
};

// Modelo por defecto según proveedor.
const DEFAULT_MODEL: Record<Provider, string> = {
  gemini: "gemini-2.0-flash",
  claude: "claude-haiku-4-5-20251001",
};

export function AiConfigCard() {
  const supabase = createClient();
  const qc = useQueryClient();
  const { toast } = useToast();

  const [provider, setProvider] = useState<Provider>("gemini");
  const [model, setModel] = useState("");
  const [apiKey, setApiKey] = useState("");
  const [betaEmail, setBetaEmail] = useState("");
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

  // Prefill de valores públicos (proveedor, modelo, beta email). La api_key no
  // se devuelve nunca; solo sabemos si existe (status.api_key === true).
  useEffect(() => {
    if (!status) return;
    const p = (status.provider === "claude" ? "claude" : "gemini") as Provider;
    setProvider(p);
    setModel(status.model ?? DEFAULT_MODEL[p]);
    setBetaEmail(status.beta_owner_email ?? "");
    if (status.model) setModelTouched(true);
  }, [status]);

  // Al cambiar de proveedor, si el modelo no fue editado a mano, autocompletamos
  // con el default del nuevo proveedor.
  function onProviderChange(p: Provider) {
    setProvider(p);
    if (!modelTouched) setModel(DEFAULT_MODEL[p]);
  }

  const hasKey = status?.api_key ?? false;

  const save = useMutation({
    mutationFn: async () => {
      const secrets: Record<string, string> = {
        provider,
        model: (model.trim() || DEFAULT_MODEL[provider]),
        beta_owner_email: betaEmail.trim().toLowerCase(),
      };
      if (apiKey.trim()) secrets.api_key = apiKey.trim();
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

  return (
    <section>
      <Heading as="h2" className="flex items-center gap-2 text-base">
        <Sparkles size={18} /> Asistente IA
      </Heading>
      <p className="mt-1 max-w-2xl text-sm text-muted-foreground">
        Elegí el proveedor y cargá la API key del Asistente IA. La key se guarda
        cifrada y nunca se devuelve. El <strong>email de la beta</strong> habilita
        el asistente a ese dueño aunque no tenga el complemento contratado.
      </p>

      <Card className="mt-3">
        <CardContent className="grid max-w-2xl gap-4 p-5">
          <div>
            <span className="mb-2 block text-sm font-medium text-muted-foreground">
              Proveedor
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

          <Input
            label="API key"
            type="password"
            autoComplete="off"
            value={apiKey}
            onChange={(e) => setApiKey(e.target.value)}
            placeholder={hasKey ? "•••• guardada" : "Pegá la API key"}
          />

          <Input
            label="Email de la beta (dueño con acceso)"
            type="email"
            value={betaEmail}
            onChange={(e) => setBetaEmail(e.target.value)}
            placeholder="tu-email@dominio.com"
          />

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
              <Play size={15} /> Probar
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
