"use client";

import { useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { createClient } from "@/lib/supabase/client";
import { appOrigin } from "@/lib/site";
import { MlAppPanel, type MlSaveResult } from "@/components/internal/mercadolibre/MlAppPanel";
import {
  mlRedirectUri,
  mlWebhookDirectUrl,
  mlWebhookUrl,
  type MlAppStatus,
  type MlAppTestResult,
} from "@/lib/mercadolibre/appSetup";
import type { MlAppField } from "@/supabase/functions/_shared/mercadolibre/config";

// App de Mercado Libre de NinjaSoft (ADR-126). Como Pagos de plataforma: lee y
// guarda por la Edge set_platform_secret (key ml_app, service_role sólo ahí).
// La Clave secreta nunca vuelve al navegador: sólo "guardada" y los últimos 4
// caracteres. El resumen de cuentas y notificaciones también lo arma la Edge.
const KEY = "ml_app";

async function errorBody(error: unknown, data: unknown) {
  let body = (data ?? null) as { error?: string; fields?: Partial<Record<MlAppField, string>> } | null;
  const ctx = (error as { context?: Response } | null)?.context;
  if (error && ctx && typeof ctx.json === "function") {
    try {
      body = (await ctx.json()) as typeof body;
    } catch {
      /* cuerpo no JSON */
    }
  }
  return body;
}

export function MlAppCard() {
  const supabase = createClient();
  const qc = useQueryClient();
  const [test, setTest] = useState<MlAppTestResult | null>(null);
  const [testing, setTesting] = useState(false);

  const { data: status, isLoading, isError, refetch } = useQuery({
    queryKey: ["platform-ml-app-status"],
    queryFn: async (): Promise<MlAppStatus | null> => {
      const { data, error } = await supabase.functions.invoke("set_platform_secret", {
        body: { key: KEY, action: "status" },
      });
      if (error) throw error;
      return (data as { status?: MlAppStatus })?.status ?? null;
    },
  });

  async function onSave(fields: Partial<Record<MlAppField, string>>): Promise<MlSaveResult> {
    const { data, error } = await supabase.functions.invoke("set_platform_secret", {
      body: { key: KEY, secrets: fields },
    });
    const body = await errorBody(error, data);
    if (body?.error === "invalid_format" && body.fields) return { fieldErrors: body.fields };
    if (error || body?.error) throw new Error(body?.error ?? "save_failed");
    setTest(null);
    await qc.invalidateQueries({ queryKey: ["platform-ml-app-status"] });
  }

  async function onClear() {
    const { data, error } = await supabase.functions.invoke("set_platform_secret", {
      body: { key: KEY, action: "clear" },
    });
    const body = await errorBody(error, data);
    if (error || body?.error) throw new Error(body?.error ?? "clear_failed");
    setTest(null);
    await qc.invalidateQueries({ queryKey: ["platform-ml-app-status"] });
  }

  async function onTest() {
    setTesting(true);
    try {
      const { data, error } = await supabase.functions.invoke("set_platform_secret", {
        body: { key: KEY, action: "test" },
      });
      const r = (data ?? {}) as Omit<MlAppTestResult, "at">;
      setTest({ ...r, ok: !error && r.ok === true, error: error ? "ml_unreachable" : r.error, at: new Date().toISOString() });
    } finally {
      setTesting(false);
    }
  }

  return (
    <MlAppPanel
      status={status ?? null}
      loading={isLoading}
      loadError={isError}
      onRetry={() => void refetch()}
      test={test}
      testing={testing}
      webhookUrl={mlWebhookUrl()}
      webhookDirectUrl={mlWebhookDirectUrl(process.env.NEXT_PUBLIC_SUPABASE_URL)}
      redirectUri={mlRedirectUri(appOrigin())}
      onSave={onSave}
      onTest={onTest}
      onClear={onClear}
    />
  );
}
